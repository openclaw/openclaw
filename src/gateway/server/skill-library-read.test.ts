import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import { isDeepStrictEqual } from "node:util";
import { expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  type SkillsLibraryReceipt,
  type SkillLibrarySelection,
} from "../../../packages/gateway-protocol/src/index.js";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../test/helpers/openai-responses-sse.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
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
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
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
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import type { GatewayClient, GatewayClientOptions } from "../client.js";
import { startGatewayServer } from "../server.js";
import { KERNEL_TEST_ENV } from "../test-helpers.env.js";
import { startClaimedGateway } from "../test-helpers.listener.js";
import { buildMockOpenAiResponsesProvider } from "../test-openai-responses-model.js";

const scopes = ["operator.read", "operator.write"];
const origin = "https://control.example.test";
const aliceEmail = "alice@example.test";
const bobEmail = "bob@example.test";
const writer = { sessions: { others: "none" as const }, agents: "*" as const, scopes };

async function connectProfile(
  port: number,
  email: string,
  identityPath: string,
  observer: Pick<GatewayClientOptions, "onEvent" | "onClose"> = {},
) {
  const identity = loadOrCreateDeviceIdentity({ path: identityPath });
  const clientName = GATEWAY_CLIENT_NAMES.CONTROL_UI;
  const mode = GATEWAY_CLIENT_MODES.WEBCHAT;
  const pairing = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    role: "operator",
    scopes,
    clientId: clientName,
    clientMode: mode,
    platform: "test",
    browserOrigin: origin,
    silent: false,
  });
  expect(
    (await approveDevicePairing(pairing.request.requestId, { callerScopes: scopes }))?.status,
  ).toBe("approved");
  return acquireGatewayTestClient(
    {
      url: `ws://127.0.0.1:${port}`,
      origin,
      clientName,
      mode,
      clientVersion: "test",
      platform: "test",
      role: "operator",
      scopes,
      caps: [],
      deviceIdentity: identity,
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      requestTimeoutMs: 45_000,
      edgeAuthHeaders: {
        "x-forwarded-for": "203.0.113.50",
        "x-forwarded-proto": "https",
        "x-forwarded-user": email,
      },
      ...observer,
    },
    {
      timeoutMs: 10_000,
      timeoutMessage: "Gateway fixture connection timed out",
      closeMessage: "Gateway closed before authentication",
    },
  );
}

type PlannedCall = { id: string; name: string; args: Record<string, unknown> };
const readCall = (
  id: string,
  resource: string,
  range: { offset?: number; limit?: number } = {},
): PlannedCall => ({ id, name: "read", args: { path: resource, ...range } });
const instructionFile = (receipt: SkillsLibraryReceipt) =>
  path.join(skillLibraryRevisionDir(receipt.entry.skillId, receipt.entry.revision), "SKILL.md");
async function saveLibrary(ws: GatewayClient, slug: string, previous?: SkillsLibraryReceipt) {
  const revision = (text: string) => (previous ? text.replaceAll("R1", "R2") : text);
  return ws.request<SkillsLibraryReceipt>("skills.library.save", {
    slug,
    content: revision(instructions),
    files: supporting.map((file) => ({ ...file, content: revision(file.content) })),
    expectedRevision: previous?.entry.revision ?? null,
    ...(previous ? { skillId: previous.entry.skillId } : {}),
  });
}
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

it.each(["prepared compaction", "chat.send"] as const)(
  "serves R1 after R2 publication without unrelated capabilities (%s)",
  { timeout: 120_000 },
  async (proof) => {
    const state = await createOpenClawTestState({
      layout: "home",
      prefix: "gateway-manual-library-",
      env: {
        ...KERNEL_TEST_ENV,
        // This regression must execute production snapshot preparation, not fast-test shortcuts.
        OPENCLAW_TEST_FAST: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        // The synthetic provider belongs to this process, not an inherited HTTP proxy.
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
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
    const clients: GatewayClient[] = [];
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
            // Match arguments because the provider sees normalized call IDs.
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
          const provider = buildMockOpenAiResponsesProvider(`${baseUrl}/v1`, "manual-library-test");
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
              controlUi: { allowedOrigins: [origin] },
              auth: {
                mode: "trusted-proxy",
                identityScopes: { [aliceEmail]: scopes, [bobEmail]: scopes },
                trustedProxy: {
                  userHeader: "x-forwarded-user",
                  requiredHeaders: ["x-forwarded-proto"],
                  allowLoopback: true,
                },
              },
              roles: { default: "writer", definitions: { writer } },
            },
          };
          await state.writeConfig(cfg);
          const aliceProfile = ensureProfileForEmail(aliceEmail);
          expect(aliceProfile.id).not.toBe(ensureProfileForEmail(bobEmail).id);
          const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
          const { port } = portClaim;
          gateway = await startClaimedGateway(portClaim, () =>
            startGatewayServer(port, { bind: "loopback", controlUiEnabled: false }),
          );
          await gateway.startupSettled;
          const settlement = createDeferred();
          void settlement.promise.catch(() => {});
          const awaitedRun: { id?: string } = {};
          const alice = await connectProfile(port, aliceEmail, state.path("alice-device.sqlite"), {
            onEvent: (frame) => {
              if (
                frame.event === "sessions.changed" &&
                awaitedRun.id &&
                !getAgentRunContext(awaitedRun.id)
              ) {
                settlement.resolve();
              }
            },
            onClose: () => settlement.reject(new Error("Gateway closed before settlement")),
          });
          clients.push(alice);
          const bob = await connectProfile(port, bobEmail, state.path("bob-device.sqlite"));
          clients.push(bob);
          const saved = await saveLibrary(alice, "manual-guide");
          const pin = { skillId: saved.entry.skillId, revision: saved.entry.revision };
          expect(saved.entry.ownerProfileId).toBe(aliceProfile.id);
          const { key: sessionKey } = await alice.request<{ key: string }>("sessions.create", {
            agentId: "main",
            label: "Manual resource proof",
          });
          const attached = await alice.request<{ selections: SkillLibrarySelection[] }>(
            "skills.library.activate",
            { sessionKey, action: "attach", ...pin },
          );
          expect(attached.selections).toContainEqual(expect.objectContaining(pin));
          const newer = await saveLibrary(alice, "manual-guide", saved);
          const other = await saveLibrary(bob, "other-guide");
          await expect(
            bob.request("skills.library.read", { skillId: saved.entry.skillId }),
          ).rejects.toMatchObject({ details: { code: "SKILL_LIBRARY_NOT_FOUND" } });
          const skillRoot = skillLibraryRevisionDir(pin.skillId, pin.revision);
          const instructionPath = path.join(skillRoot, "SKILL.md");
          const outside = state.path("unrelated.txt");
          await fs.writeFile(outside, "UNRELATED_PRIVATE_SENTINEL");
          plan = [
            readCall("instructions", instructionPath, { offset: 3, limit: 1 }),
            ...supporting.map((file, index) =>
              readCall(`support_${index}`, path.join(skillRoot, file.path)),
            ),
            readCall("other_profile", instructionFile(other)),
            readCall("unselected_revision", instructionFile(newer)),
            readCall("unrelated", outside),
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
            // Compaction independently rebuilds tools from the persisted session pin.
            const runtime = { config: cfg, agentId: "main", workspaceDir: state.workspaceDir };
            const { snapshot: hydrated } = await resolveReusableWorkspaceSkillSnapshot({
              ...runtime,
              librarySelections: entry!.skillLibrarySelections,
              existingSnapshot: entry!.skillsSnapshot,
              watch: false,
            });
            const preparedModelRuntime = await prepareModelRuntimeSnapshot({
              ...runtime,
              agentDir: state.agentDir(),
            });
            const prepared = await prepareDirectCompactionAttempt({
              sessionId: entry!.sessionId,
              sessionKey,
              sessionFile: sessionKey,
              ...runtime,
              provider: provider.providerId,
              model: provider.modelId,
              skillsSnapshot: hydrated,
              sessionEntry: entry,
              preparedModelRuntime,
            });
            expect(prepared.ok).toBe(true);
            if (!prepared.ok) {
              throw new Error(prepared.result.reason);
            }
            let compactionCleanup: PreparedCompactionCleanup | undefined;
            try {
              const compaction = await buildPreparedCompactionRuntime(prepared.value, (cleanup) => {
                compactionCleanup = cleanup;
              });
              const read = compaction.effectiveTools.find((tool) => tool.name === "read")!;
              const result = await read.execute("compaction-pinned-read", {
                path: instructionPath,
                limit: 1,
              });
              expect(getTextContent(result)).toBe(instructions);
              await expect(
                read.execute("compaction-unselected", { path: instructionFile(newer) }),
              ).rejects.toThrow(/Path escapes sandbox root/i);
            } finally {
              compactionCleanup?.restoreSkillEnvironment();
              await compactionCleanup?.disposeToolRuntimes();
            }
            return;
          }
          await alice.request("sessions.subscribe", {});
          const started = await alice.request<{ runId: string; status: string }>("chat.send", {
            sessionKey,
            message: `/skill ${saved.entry.name} Read the pinned instructions and supporting files.`,
            idempotencyKey: randomUUID(),
          });
          expect(started.status).toBe("started");
          // Settlement follows live-context release; retained results still enforce profile ownership.
          awaitedRun.id = started.runId;
          const wait = { runId: started.runId, timeoutMs: 40_000 };
          const settled = getAgentRunContext(started.runId)
            ? withTestTimeout(settlement.promise, 45_000, "Gateway fixture settlement timed out")
            : Promise.resolve();
          const [immediate, settledResult] = await Promise.allSettled([
            alice.request("agent.wait", wait),
            settled,
          ]);
          expect(settledResult.status).toBe("fulfilled");
          const completed = await alice.request("agent.wait", wait);
          expect(immediate).toEqual({ status: "fulfilled", value: completed });
          await expect(bob.request("agent.wait", wait)).rejects.toThrow(/agent run was not found/);
          expect(completed).toMatchObject({ status: "ok" });
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
          expect(requests[0]?.instructions ?? "").not.toContain(`<name>${saved.entry.name}</name>`);
          const transcript = JSON.stringify(
            loadTranscriptEventsSync({ agentId: "main", sessionKey, sessionId: entry!.sessionId }),
          );
          expect(transcript).toContain("PINNED_RESOURCE_PROOF_COMPLETE");
          expect(transcript).toContain("R1 instructions");
        },
      );
    } finally {
      for (const client of clients) {
        await client.stopAndWait();
      }
      await gateway?.close({ reason: "manual library proof complete" });
      await state.cleanup();
    }
  },
);
