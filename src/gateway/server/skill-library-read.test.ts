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
} from "../../../packages/gateway-protocol/src/index.js";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.js";
import { waitForGatewayStartup } from "../../../test/helpers/gateway-startup.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.js";
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
import { writeToolCallResponse } from "../gateway-provider-fixture.test-support.js";
import { startGatewayServer } from "../server.js";
import { startClaimedGateway } from "../test-helpers.listener.js";
import { buildMockOpenAiResponsesProvider } from "../test-openai-responses-model.js";

const scopes = ["operator.read", "operator.write"];
const revisionInstructions = ({ entry }: SkillsLibraryReceipt) =>
  path.join(skillLibraryRevisionDir(entry.skillId, entry.revision), "SKILL.md");

// The shared client owns challenge signing, RPC correlation, and socket cleanup.
async function connectProfile(
  port: number,
  email: string,
  identityPath: string,
  observer: Pick<Parameters<typeof acquireGatewayTestClient>[0], "onEvent" | "onClose"> = {},
) {
  const identity = loadOrCreateDeviceIdentity({ path: identityPath });
  const clientName = GATEWAY_CLIENT_NAMES.CONTROL_UI;
  const mode = GATEWAY_CLIENT_MODES.WEBCHAT;
  const origin = "https://control.example.test";
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
      edgeAuthHeaders: {
        "x-forwarded-for": "203.0.113.50",
        "x-forwarded-proto": "https",
        "x-forwarded-user": email,
      },
      deviceIdentity: identity,
      clientName,
      mode,
      clientVersion: "test",
      platform: "test",
      role: "operator",
      scopes,
      caps: [],
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      requestTimeoutMs: 45_000,
      ...observer,
    },
    {
      timeoutMs: 10_000,
      timeoutMessage: "Gateway fixture connect timed out",
      closeMessage: "Gateway closed during connect",
    },
  );
}
type Client = Awaited<ReturnType<typeof connectProfile>>;
const rpc = (client: Client, method: string, params: unknown) =>
  client.request<unknown>(method, params, { timeoutMs: 45_000 });

type PlannedCall = { id: string; name: string; args: Record<string, unknown> };
const readCall = (
  id: string,
  filePath: string,
  window: { offset?: number; limit?: number } = {},
): PlannedCall => ({
  id,
  name: "read",
  args: { path: filePath, ...window },
});
type ProviderRequest = {
  input?: Array<{
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    output?: unknown;
  }>;
  instructions?: string;
};

async function runProof(proof: "prepared compaction" | "chat.send") {
  const state = await createOpenClawTestState({
    layout: "home",
    prefix: "gateway-manual-library-",
    env: {
      // This regression must execute production snapshot preparation, not fast-test shortcuts.
      OPENCLAW_TEST_FAST: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      // The synthetic provider belongs to this process, not an inherited HTTP proxy.
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
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
  const clients: Client[] = [];
  const settled = createDeferred();
  void settled.promise.catch(() => {});
  let runId: string | undefined;
  const requests: ProviderRequest[] = [];
  const outputs = new Map<string, unknown>();
  const wireCalls = new Map<string, string>();
  const providerErrors: unknown[] = [];
  let plan: PlannedCall[] = [];
  let callIndex = 0;
  const handleProvider: Parameters<typeof withServer>[0] = (request, response) => {
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
      const item = {
        type: "function_call",
        id: `fc_${call.id}`,
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.args),
        status: "completed",
      };
      writeToolCallResponse(response, item, `resp_${call.id}`, 10, 10);
    })().catch((error: unknown) => {
      providerErrors.push(error);
      response.writeHead(500).end(String(error));
    });
  };
  const run = async (baseUrl: string) => {
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
        controlUi: { allowedOrigins: ["https://control.example.test"] },
        auth: {
          mode: "trusted-proxy",
          identityScopes: {
            "alice@example.test": scopes,
            "bob@example.test": scopes,
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
              scopes,
            },
          },
        },
      },
    };
    await state.writeConfig(cfg);
    const aliceProfile = ensureProfileForEmail("alice@example.test");
    ensureProfileForEmail("bob@example.test");
    const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    const { port } = portClaim;
    gateway = await startClaimedGateway(portClaim, () =>
      startGatewayServer(port, { bind: "loopback", controlUiEnabled: false }),
    );
    await gateway.startupSettled;
    await waitForGatewayStartup(port);
    const connect = async (name: string) => {
      const ws = await connectProfile(
        port,
        `${name}@example.test`,
        state.path(`${name}-device`, "client", "credentials.sqlite"),
        name === "alice"
          ? {
              onEvent: (frame) => {
                if (frame.event === "sessions.changed" && runId && !getAgentRunContext(runId)) {
                  settled.resolve();
                }
              },
              onClose: () => settled.reject(new Error("Gateway closed before settlement")),
            }
          : {},
      );
      clients.push(ws);
      return ws;
    };
    const alice = await connect("alice");
    const bob = await connect("bob");
    const save = async (
      ws: Client,
      slug: string,
      previous?: SkillsLibraryReceipt,
    ): Promise<SkillsLibraryReceipt> =>
      (await rpc(ws, "skills.library.save", {
        slug,
        ...(previous ? { skillId: previous.entry.skillId } : {}),
        expectedRevision: previous?.entry.revision ?? null,
        content: previous ? instructions.replaceAll("R1", "R2") : instructions,
        files: previous
          ? supporting.map((file) => ({
              ...file,
              content: file.content.replaceAll("R1", "R2"),
            }))
          : supporting,
      })) as SkillsLibraryReceipt;
    const saved = await save(alice, "manual-guide");
    expect(saved.entry.ownerProfileId).toBe(aliceProfile.id);
    const created = (await rpc(alice, "sessions.create", {
      agentId: "main",
      label: "Manual resource proof",
    })) as { key: string };
    const sessionKey = created.key;
    await rpc(alice, "skills.library.activate", {
      sessionKey,
      action: "attach",
      skillId: saved.entry.skillId,
      revision: saved.entry.revision,
    });
    const newer = await save(alice, "manual-guide", saved);
    const other = await save(bob, "other-guide");
    await expect(
      rpc(bob, "skills.library.read", { skillId: saved.entry.skillId }),
    ).rejects.toMatchObject({
      details: { code: "SKILL_LIBRARY_NOT_FOUND" },
    });
    const skillRoot = skillLibraryRevisionDir(saved.entry.skillId, saved.entry.revision);
    const instructionPath = path.join(skillRoot, "SKILL.md");
    const outside = state.path("unrelated.txt");
    await fs.writeFile(outside, "UNRELATED_PRIVATE_SENTINEL");
    plan = [
      readCall("instructions", instructionPath, { offset: 3, limit: 1 }),
      ...supporting.map((file, index) =>
        readCall(`support_${index}`, path.join(skillRoot, file.path)),
      ),
      readCall("other_profile", revisionInstructions(other)),
      readCall("unselected_revision", revisionInstructions(newer)),
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
      // Compaction rebuilds tools independently of the ordinary attempt. Exercise that real
      // preparation with the persisted session pin rather than copying a read-root list.
      const hydrated = (
        await resolveReusableWorkspaceSkillSnapshot({
          workspaceDir: state.workspaceDir,
          config: cfg,
          agentId: "main",
          librarySelections: entry!.skillLibrarySelections,
          existingSnapshot: entry!.skillsSnapshot,
          watch: false,
        })
      ).snapshot;
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
            path: revisionInstructions(newer),
          }),
        ).rejects.toThrow(/Path escapes sandbox root/i);
      } finally {
        compactionCleanup?.restoreSkillEnvironment();
        await compactionCleanup?.disposeToolRuntimes();
      }
      return;
    }
    await rpc(alice, "sessions.subscribe", {});
    const started = (await rpc(alice, "chat.send", {
      sessionKey,
      message: `/skill ${saved.entry.name} Read the pinned instructions and supporting files.`,
      idempotencyKey: randomUUID(),
    })) as { runId: string; status: string };
    expect(started.status).toBe("started");
    // Session settlement publishes after releasing the live run context. A completed
    // run must remain visible to its current session owner, but not another profile.
    runId = started.runId;
    if (!getAgentRunContext(runId)) {
      settled.resolve();
    }
    const [immediate, settlement] = await Promise.allSettled([
      rpc(alice, "agent.wait", { runId: started.runId, timeoutMs: 40_000 }),
      withTestTimeout(settled.promise, 45_000, "Gateway settlement event timed out"),
    ]);
    expect(settlement.status).toBe("fulfilled");
    const completed = await rpc(alice, "agent.wait", {
      runId: started.runId,
      timeoutMs: 40_000,
    });
    expect(immediate).toEqual({ status: "fulfilled", value: completed });
    await expect(
      rpc(bob, "agent.wait", { runId: started.runId, timeoutMs: 40_000 }),
    ).rejects.toThrow(/agent run was not found/);
    expect(completed).toMatchObject({ status: "ok" });
    expect(providerErrors).toEqual([]);
    const outputText = (id: string): string => {
      const raw = outputs.get(id);
      if (typeof raw !== "string") {
        throw new Error(`Missing observed tool output: ${id}`);
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === "object" &&
          "content" in parsed &&
          typeof parsed.content === "string"
        ) {
          return parsed.content;
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
      loadTranscriptEventsSync({
        agentId: "main",
        sessionKey,
        sessionId: entry!.sessionId,
      }),
    );
    expect(transcript).toContain("PINNED_RESOURCE_PROOF_COMPLETE");
    expect(transcript).toContain("R1 instructions");
  };
  try {
    await withServer(handleProvider, run);
  } finally {
    for (const client of clients) {
      await client.stopAndWait();
    }
    await gateway?.close({ reason: "manual library proof complete" });
    await state.cleanup();
  }
}

it.each(["prepared compaction", "chat.send"] as const)(
  "serves R1 after R2 publication without unrelated capabilities (%s)",
  { timeout: 120_000 },
  runProof,
);
