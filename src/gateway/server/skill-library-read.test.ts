import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import { isDeepStrictEqual } from "node:util";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  type SkillsLibraryReceipt,
  type SkillLibrarySelection,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  acquireGatewayTestWebSocket,
  closeGatewayTestWebSocket,
} from "../../../test/helpers/gateway-websocket.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../test/helpers/openai-responses-sse.js";
import { prepareDirectCompactionAttempt } from "../../agents/embedded-agent-runner/direct-compaction-preparation.js";
import {
  buildPreparedCompactionRuntime,
  type PreparedCompactionCleanup,
} from "../../agents/embedded-agent-runner/prepared-compaction-runtime.js";
import { prepareModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import { getTextContent } from "../../agents/test-helpers/agent-tools-fs-helpers.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../../infra/device-identity.js";
import { approveDevicePairing } from "../../infra/device-pairing-approval.js";
import { requestDevicePairing } from "../../infra/device-pairing.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { skillLibraryRevisionDir } from "../../skills/library/bundle.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import {
  manualLibraryInstructions as instructions,
  manualLibraryFiles as supporting,
} from "../../skills/test-support/manual-library.test-support.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { setTestEnvValue } from "../../test-utils/env.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { buildDeviceAuthPayloadV3 } from "../device-auth.js";
import { startGatewayServer } from "../server.js";
import { getGatewayE2ePortBlock } from "../test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../test-openai-responses-model.js";

type Frame = {
  type?: string;
  id?: string;
  event?: string;
  ok?: boolean;
  payload?: unknown;
  error?: { message?: string };
};
function waitForFrame(ws: WebSocket, matches: (frame: Frame) => boolean): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => onError(new Error("Gateway closed before its RPC response"));
    const onMessage = (data: WebSocket.RawData) => {
      const frame = JSON.parse(rawDataToString(data)) as Frame;
      if (matches(frame)) {
        cleanup();
        resolve(frame);
      }
    };
    const timer = setTimeout(() => onError(new Error("Gateway fixture RPC timed out")), 45_000);
    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}
async function rpc(ws: WebSocket, method: string, params: unknown): Promise<unknown> {
  const id = randomUUID();
  const response = waitForFrame(ws, (frame) => frame.type === "res" && frame.id === id);
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  const frame = await response;
  if (!frame.ok) {
    throw new Error(`${method}: ${JSON.stringify(frame.error)}`);
  }
  return frame.payload;
}

// Synthetic trusted-proxy headers stand in for human authentication. No production OAuth is used.
async function connectProfile(port: number, email: string, identityPath: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: {
      origin: "https://control.example.test",
      "x-forwarded-for": "203.0.113.50",
      "x-forwarded-proto": "https",
      "x-forwarded-user": email,
    },
  });
  const challenge = waitForFrame(ws, (frame) => frame.event === "connect.challenge");
  void challenge.catch(() => {});
  return await acquireGatewayTestWebSocket(ws, 10_000, async () => {
    const frame = await challenge;
    const nonce = (frame.payload as { nonce: string }).nonce;
    const identity = loadOrCreateDeviceIdentity({ path: identityPath });
    const scopes = ["operator.read", "operator.write"];
    const client = {
      id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      version: "test",
      platform: "test",
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    };
    // Same test-only pre-pairing contract as server.auth.presence-audience.test.ts.
    // Approval is scoped to this disposable state, not a production sign-in.
    const pairing = await requestDevicePairing({
      deviceId: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      role: "operator",
      scopes,
      clientId: client.id,
      clientMode: client.mode,
      platform: client.platform,
      browserOrigin: "https://control.example.test",
      silent: false,
    });
    expect(
      (await approveDevicePairing(pairing.request.requestId, { callerScopes: scopes }))?.status,
    ).toBe("approved");
    const signedAtMs = Date.now();
    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: client.id,
      clientMode: client.mode,
      role: "operator",
      scopes,
      signedAtMs,
      token: null,
      nonce,
      platform: client.platform,
    });
    await rpc(ws, "connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client,
      role: "operator",
      scopes,
      caps: [],
      device: {
        id: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        signature: signDevicePayload(identity.privateKeyPem, payload),
        signedAt: signedAtMs,
        nonce,
      },
    });
  });
}

type PlannedCall = { id: string; name: string; args: Record<string, unknown> };
type ProviderRequest = {
  input?: Array<{
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    output?: unknown;
  }>;
  tools?: Array<{ name?: string }>;
  instructions?: string;
};

describe("Gateway pinned manual library read", () => {
  it.each(["prepared compaction", "chat.send"] as const)(
    "serves R1 after R2 publication without unrelated capabilities (%s)",
    { timeout: 120_000 },
    async (proof) => {
      const state = await createOpenClawTestState({
        layout: "home",
        prefix: "gateway-manual-library-",
        env: {
          // This regression must execute production snapshot preparation, not fast-test shortcuts.
          OPENCLAW_TEST_FAST: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        },
      });
      const emptyPlugins = state.path("empty-bundled-plugins");
      await fs.mkdir(emptyPlugins);
      setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", emptyPlugins);
      // Keep repository discovery inside this synthetic workspace, not its enclosing test checkout.
      execFileSync("git", ["init", "--quiet", state.workspaceDir]);
      let gateway: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
      const sockets: WebSocket[] = [];
      const requests: ProviderRequest[] = [];
      const outputs = new Map<string, unknown>();
      const wireCalls = new Map<string, string>();
      const providerErrors: unknown[] = [];
      let plan: PlannedCall[] = [];
      let callIndex = 0;
      try {
        await withServer(
          (request, response) => {
            void (async () => {
              const body = JSON.parse(await readText(request)) as ProviderRequest;
              requests.push(body);
              // The provider sees normalized call IDs. Correlate the observed wire call,
              // rather than assuming our synthetic response ID survives normalization.
              for (const input of body.input ?? []) {
                if (input.type === "function_call" && input.call_id && input.arguments) {
                  const args: unknown = JSON.parse(input.arguments);
                  const planned = plan.find(
                    (call) => call.name === input.name && isDeepStrictEqual(call.args, args),
                  );
                  if (planned) {
                    wireCalls.set(input.call_id, planned.id);
                  }
                }
              }
              for (const input of body.input ?? []) {
                if (input.type === "function_call_output" && input.call_id) {
                  const plannedId = wireCalls.get(input.call_id);
                  if (plannedId) {
                    outputs.set(plannedId, input.output);
                  }
                }
              }
              const call = plan[callIndex++];
              if (!call) {
                writeOpenAiResponsesText(response, {
                  text: "PINNED_RESOURCE_PROOF_COMPLETE",
                  messageId: randomUUID(),
                  responseId: randomUUID(),
                });
                return;
              }
              expect(body.tools?.map((tool) => tool.name)).toContain(call.name);
              const item = {
                type: "function_call",
                id: `fc_${call.id}`,
                call_id: call.id,
                name: call.name,
                arguments: JSON.stringify(call.args),
                status: "completed",
              };
              writeOpenAiResponsesSse(response, [
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: { ...item, status: "in_progress", arguments: "" },
                },
                {
                  type: "response.function_call_arguments.done",
                  item_id: item.id,
                  output_index: 0,
                  arguments: item.arguments,
                },
                { type: "response.output_item.done", output_index: 0, item },
                {
                  type: "response.completed",
                  response: {
                    id: `resp_${call.id}`,
                    status: "completed",
                    output: [item],
                    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
                  },
                },
              ]);
            })().catch((error: unknown) => {
              providerErrors.push(error);
              response.writeHead(500).end(String(error));
            });
          },
          async (baseUrl) => {
            const provider = buildMockOpenAiResponsesProvider(
              `${baseUrl}/v1`,
              "manual-library-test",
            );
            const cfg: OpenClawConfig = {
              agents: {
                defaults: {
                  workspace: state.workspaceDir,
                  skipBootstrap: true,
                  model: { primary: provider.modelRef },
                  models: {
                    [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                  },
                  compaction: { memoryFlush: { enabled: false } },
                },
              },
              models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
              plugins: { slots: { memory: "none" } },
              skills: { allowBundled: [], load: { watch: false } },
              tools: {
                allow: ["read", "write", "edit", "ls"],
                fs: { workspaceOnly: true },
                codeMode: false,
              },
              gateway: {
                trustedProxies: ["127.0.0.1"],
                controlUi: { allowedOrigins: ["https://control.example.test"] },
                auth: {
                  mode: "trusted-proxy",
                  identityScopes: {
                    "alice@example.test": ["operator.read", "operator.write"],
                    "bob@example.test": ["operator.read", "operator.write"],
                  },
                  trustedProxy: {
                    userHeader: "x-forwarded-user",
                    requiredHeaders: ["x-forwarded-proto"],
                    allowLoopback: true,
                  },
                },
                roles: {
                  default: "writer",
                  definitions: {
                    writer: {
                      sessions: { others: "none" },
                      agents: "*",
                      scopes: ["operator.read", "operator.write"],
                    },
                  },
                },
              },
            };
            await state.writeConfig(cfg);
            const aliceProfile = ensureProfileForEmail("alice@example.test");
            const bobProfile = ensureProfileForEmail("bob@example.test");
            expect(aliceProfile.id).not.toBe(bobProfile.id);
            const port = await getGatewayE2ePortBlock();
            gateway = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
            await gateway.startupSettled;
            const alice = await connectProfile(
              port,
              "alice@example.test",
              state.path("alice-device.sqlite"),
            );
            sockets.push(alice);
            const bob = await connectProfile(
              port,
              "bob@example.test",
              state.path("bob-device.sqlite"),
            );
            sockets.push(bob);
            const saved = (await rpc(alice, "skills.library.save", {
              slug: "manual-guide",
              content: instructions,
              files: supporting,
              expectedRevision: null,
            })) as SkillsLibraryReceipt;
            expect(saved.entry.ownerProfileId).toBe(aliceProfile.id);
            const created = (await rpc(alice, "sessions.create", {
              agentId: "main",
              label: "Manual resource proof",
            })) as { key: string };
            const sessionKey = created.key;
            const attached = (await rpc(alice, "skills.library.activate", {
              sessionKey,
              action: "attach",
              skillId: saved.entry.skillId,
              revision: saved.entry.revision,
            })) as { selections: SkillLibrarySelection[] };
            expect(attached.selections).toContainEqual(
              expect.objectContaining({
                skillId: saved.entry.skillId,
                revision: saved.entry.revision,
              }),
            );
            const newer = (await rpc(alice, "skills.library.save", {
              slug: "manual-guide",
              skillId: saved.entry.skillId,
              expectedRevision: saved.entry.revision,
              content: instructions.replaceAll("R1", "R2"),
              files: supporting.map((file) => ({
                ...file,
                content: file.content.replaceAll("R1", "R2"),
              })),
            })) as SkillsLibraryReceipt;
            const other = (await rpc(bob, "skills.library.save", {
              slug: "other-guide",
              content: instructions,
              files: supporting,
              expectedRevision: null,
            })) as SkillsLibraryReceipt;
            await expect(
              rpc(bob, "skills.library.read", { skillId: saved.entry.skillId }),
            ).rejects.toThrow(/SKILL_LIBRARY_NOT_FOUND/);
            const skillRoot = skillLibraryRevisionDir(saved.entry.skillId, saved.entry.revision);
            const instructionPath = path.join(skillRoot, "SKILL.md");
            const outside = state.path("unrelated.txt");
            await fs.writeFile(outside, "UNRELATED_PRIVATE_SENTINEL");
            plan = [
              {
                id: "instructions",
                name: "read",
                args: { path: instructionPath, offset: 3, limit: 1 },
              },
              ...supporting.map((file, index) => ({
                id: `support_${index}`,
                name: "read",
                args: { path: path.join(skillRoot, file.path) },
              })),
              {
                id: "other_profile",
                name: "read",
                args: {
                  path: path.join(
                    skillLibraryRevisionDir(other.entry.skillId, other.entry.revision),
                    "SKILL.md",
                  ),
                },
              },
              {
                id: "unselected_revision",
                name: "read",
                args: {
                  path: path.join(
                    skillLibraryRevisionDir(newer.entry.skillId, newer.entry.revision),
                    "SKILL.md",
                  ),
                },
              },
              { id: "unrelated", name: "read", args: { path: outside } },
              { id: "list", name: "ls", args: { path: skillRoot } },
              { id: "write", name: "write", args: { path: instructionPath, content: "REPLACED" } },
              {
                id: "edit",
                name: "edit",
                args: { path: instructionPath, edits: [{ oldText: "R1", newText: "REPLACED" }] },
              },
            ];
            if (proof === "prepared compaction") {
              const entry = loadSessionEntry({ agentId: "main", sessionKey });
              // Compaction rebuilds tools independently of the ordinary attempt. Exercise that real
              // preparation with the persisted session pin rather than copying a read-root list.
              const hydrated = resolveReusableWorkspaceSkillSnapshot({
                workspaceDir: state.workspaceDir,
                config: cfg,
                agentId: "main",
                librarySelections: entry!.skillLibrarySelections,
                existingSnapshot: entry!.skillsSnapshot,
                watch: false,
              }).snapshot;
              const preparedModelRuntime = await prepareModelRuntimeSnapshot({
                config: cfg,
                agentId: "main",
                agentDir: state.agentDir(),
                workspaceDir: state.workspaceDir,
              });
              const compactionPreparation = await prepareDirectCompactionAttempt({
                sessionId: entry!.sessionId,
                sessionKey,
                sessionFile: sessionKey,
                agentId: "main",
                workspaceDir: state.workspaceDir,
                config: cfg,
                provider: provider.providerId,
                model: provider.modelId,
                skillsSnapshot: hydrated,
                sessionEntry: entry,
                preparedModelRuntime,
              });
              expect(compactionPreparation.ok).toBe(true);
              if (!compactionPreparation.ok) {
                throw new Error(compactionPreparation.result.reason);
              }
              let compactionCleanup: PreparedCompactionCleanup | undefined;
              try {
                const compaction = await buildPreparedCompactionRuntime(
                  compactionPreparation.value,
                  (cleanup) => {
                    compactionCleanup = cleanup;
                  },
                );
                const read = compaction.effectiveTools.find((tool) => tool.name === "read")!;
                expect(
                  getTextContent(
                    await read.execute("compaction-pinned-read", {
                      path: instructionPath,
                      limit: 1,
                    }),
                  ),
                ).toBe(instructions);
                await expect(
                  read.execute("compaction-unselected", {
                    path: path.join(
                      skillLibraryRevisionDir(newer.entry.skillId, newer.entry.revision),
                      "SKILL.md",
                    ),
                  }),
                ).rejects.toThrow(/Path escapes sandbox root/i);
              } finally {
                compactionCleanup?.restoreSkillEnvironment();
                await compactionCleanup?.disposeToolRuntimes();
              }
              console.info("Prepared compaction normal-read R1 instruction proof", instructions);
              return;
            }
            const started = (await rpc(alice, "chat.send", {
              sessionKey,
              message: `/skill ${saved.entry.name} Read the pinned instructions and supporting files.`,
              idempotencyKey: randomUUID(),
            })) as { runId: string; status: string };
            expect(started.status).toBe("started");
            const completed = await rpc(alice, "agent.wait", {
              runId: started.runId,
              timeoutMs: 40_000,
            });
            expect(
              completed,
              JSON.stringify({
                requests: requests.length,
                callIndex,
                errors: providerErrors.map(String),
                outputs: Object.fromEntries(outputs),
              }),
            ).toMatchObject({ status: "ok" });
            expect(providerErrors).toEqual([]);
            expect(callIndex).toBe(plan.length + 1);
            const outputText = (id: string): string => {
              const raw = outputs.get(id);
              if (typeof raw !== "string") {
                throw new Error(`Missing observed tool output: ${id}`);
              }
              try {
                const parsed: unknown = JSON.parse(raw);
                if (parsed && typeof parsed === "object" && "content" in parsed) {
                  if (typeof parsed.content === "string") {
                    return parsed.content;
                  }
                }
              } catch {
                // Plain-text tool content is also a valid Responses output.
              }
              return raw;
            };
            expect(outputText("instructions")).toBe(instructions);
            for (const [index, file] of supporting.entries()) {
              expect(outputText(`support_${index}`)).toBe(file.content);
            }
            for (const id of [
              "other_profile",
              "unselected_revision",
              "unrelated",
              "list",
              "write",
              "edit",
            ]) {
              expect(outputText(id), id).toMatch(/Path escapes sandbox root|outside-workspace/i);
            }
            expect(await fs.readFile(instructionPath, "utf8")).toBe(instructions);
            const entry = loadSessionEntry({ agentId: "main", sessionKey });
            expect(entry?.skillLibrarySelections).toContainEqual(
              expect.objectContaining({ revision: saved.entry.revision }),
            );
            expect(entry?.skillsSnapshot?.prompt).not.toContain(saved.entry.name);
            expect(JSON.stringify(requests[0])).toContain(instructionPath);
            expect(requests[0]?.instructions ?? "").not.toContain(
              `<name>${saved.entry.name}</name>`,
            );
            const transcript = JSON.stringify(
              loadTranscriptEventsSync({
                agentId: "main",
                sessionKey,
                sessionId: entry!.sessionId,
              }),
            );
            expect(transcript).toContain("PINNED_RESOURCE_PROOF_COMPLETE");
            expect(transcript).toContain("R1 instructions");
            console.info(
              "Synthetic Gateway normal-read proof (mock provider; not production OAuth)",
              Object.fromEntries(outputs),
            );
          },
        );
      } finally {
        for (const ws of sockets) {
          await closeGatewayTestWebSocket(ws);
        }
        await gateway?.close({ reason: "manual library proof complete" });
        await state.cleanup();
      }
    },
  );
});
