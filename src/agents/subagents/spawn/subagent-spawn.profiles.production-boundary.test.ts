/** Disk plugin -> command admission -> native Gateway spawn -> child policy and collection. */
// Preserve model-boundary setup before modules that consume it.
// oxfmt-ignore
import { cleanupPreparedModelRuntimeHarness, getPreparedModelRuntimeMocks, resetPreparedModelRuntimeHarness } from "../../prepared-model-runtime.test-harness.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  installPrivateUpdateHandoffStore,
  writePrivateUpdateHandoffChildGuard,
} from "../../../../test/helpers/private-update-handoff-store.js";
import { handlePluginCommand } from "../../../auto-reply/reply/commands-plugin.js";
import { buildCommandTestParams } from "../../../auto-reply/reply/commands.test-harness.js";
import { runWithCommandNativeSubagents } from "../../../auto-reply/reply/dispatch-native-subagent.js";
import { buildTestCtx } from "../../../auto-reply/reply/test-ctx.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/config.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../../gateway/agent-runtime-approval-authority.js";
import { callGateway } from "../../../gateway/call.js";
import { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import { createRequestGatewayMethodRegistry } from "../../../gateway/server-methods.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import {
  loadGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalog,
} from "../../../gateway/server-model-catalog.js";
import { clearPluginRegistryLoadCache, loadOpenClawPlugins } from "../../../plugins/loader.js";
import type { PluginRegistry } from "../../../plugins/registry-types.js";
import { disposePluginRegistryInstances } from "../../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import {
  readAdmittedRunOperatorAuthority,
  resolvePreparedRunAdmission,
} from "../../admitted-run-context.js";
import { createOpenClawCodingToolsInternalAsync } from "../../agent-tools.js";
import { refreshPreparedModelRuntimeSnapshots } from "../../prepared-model-runtime.js";
import { ModelRegistry } from "../../sessions/model-registry.js";
import { ToolSearchRuntime } from "../../tool-search-runtime.js";
import {
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
} from "../../tool-search.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { observeRootWork } from "../registry/subagent-registry.browser-cleanup.test-support.js";
import { settleSubagentRegistryPersistenceWork } from "../registry/subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "../registry/subagent-registry.test-helpers.js";
import { visibleResult } from "./subagent-spawn.fixtures.test-support.js";
import {
  createSpawnBoundaryParent,
  createSpawnOperatorSource,
  recordSpawnBoundaryFinal,
} from "./subagent-spawn.production-boundary.test-support.js";
import { createSpawnBoundaryConfig } from "./subagent-spawn.test-helpers.js";

vi.mock("../announce/subagent-announce.js", { spy: true });
vi.mock("../../../gateway/call.js", { spy: true });
const runEmbeddedAgent = vi.hoisted(() =>
  vi.fn<typeof import("../../embedded-agent.js").runEmbeddedAgent>(),
);
// Child tool assembly, command admission, native spawn and collection stay real.
// mock-isolation: Replace only the external embedded model producer with fixed replies.
vi.mock("../../embedded-agent.js", async () => {
  const { abortEmbeddedAgentRun } = await import("../../embedded-agent-runner/runs.js");
  const { waitForSessionRunEnd } =
    await import("../../../sessions/session-controller.native-runtime.js");
  const { isSessionRunActive } = await import("../../../sessions/session-controller.queries.js");
  return { abortEmbeddedAgentRun, isSessionRunActive, runEmbeddedAgent, waitForSessionRunEnd };
});

const pluginId = "profile-gateway-proof";
const parentSessionKey = "agent:main:subagent:profile-command-parent";
const parentRunId = "profile-command-parent";
const instructions = "PROFILE_REVIEWER_PINNED: inspect the change without modifying any files.\n";
const schema = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["approved"] } },
  required: ["verdict"],
  additionalProperties: false,
};
let state: OpenClawTestState;
let registry: PluginRegistry | undefined;
let settleRootWork: ReturnType<typeof observeRootWork>;

async function writeDiskPlugin() {
  const root = state.path("review-plugin");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "reviewer.md"), instructions);
  await fs.writeFile(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      configSchema: { type: "object", properties: {}, additionalProperties: false },
      contracts: { commandRuntimeCapabilities: ["subagents"], subagentProfiles: ["reviewer"] },
    }),
  );
  const entry = path.join(root, "index.cjs");
  // This fixture deliberately has no core imports or injected registry/runtime objects.
  await fs.writeFile(
    entry,
    `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
      if (!api.runtime.capabilities.includes("native-subagent-profiles-v1") ||
          typeof api.agent.registerSubagentProfile !== "function") {
        throw new Error("Native subagent profiles are unsupported");
      }
      api.agent.registerSubagentProfile({
        id: "reviewer", description: "Read-only reviewer", instructionsFile: "reviewer.md",
        tools: { deny: ["write"] }, outputSchema: ${JSON.stringify(schema)}
      });
      api.registerCommand({
        name: "profile-proof", description: "Exercise a native reviewer profile",
        requireAuth: true, runtimeCapabilities: ["subagents"],
        async handler(ctx) {
          const native = ctx.runtimeContext.subagents;
          let conflict;
          try {
            await native.spawn({ requestId: "conflict", task: "Must not launch",
              profile: "reviewer", outputSchema: { type: "string" } });
          } catch (error) { conflict = String(error); }
          if (!conflict) throw new Error("Caller replaced the profile output schema");
          const accepted = [];
          for (const requestId of ["valid", "invalid"]) {
            accepted.push(await native.spawn({ requestId, task: requestId + " profile result",
              profile: "reviewer", context: "isolated" }));
          }
          const collection = await native.collect({ ids: accepted.map(child => child.runId),
            awaitResults: true });
          return { text: JSON.stringify({ conflict, accepted, collection }) };
        }
      });
    } };`,
  );
  return { root, entry };
}

beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "disk-plugin-profiles",
    prepareProfileCatalog: true,
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  const tempDir = state.path("tmp");
  await fs.mkdir(tempDir);
  vi.stubEnv("TMPDIR", tempDir);
  const handoff = installPrivateUpdateHandoffStore(tempDir);
  const guarded = writePrivateUpdateHandoffChildGuard(handoff.databasePath, tempDir)(process.env);
  vi.stubEnv("NODE_OPTIONS", guarded.NODE_OPTIONS);
  handoff.assertDatabasePath(handoff.databasePath);
  await resetPreparedModelRuntimeHarness(state);
  runEmbeddedAgent.mockReset();
  await resetSubagentRegistryForTests({ persist: false });
  vi.mocked(runSubagentAnnounceFlow).mockResolvedValue("delivered");
  vi.mocked(callGateway).mockImplementation(
    async <T>(request: Parameters<typeof callGateway>[0]) => {
      if (request.method !== "agent.wait") {
        throw new Error(`Unexpected transport: ${request.method}`);
      }
      return { status: "pending" } as T;
    },
  );
  settleRootWork = observeRootWork();
});

afterEach(async ({ task }) => {
  await settleSubagentRegistryPersistenceWork(() => settleRootWork());
  const { closeSkillsWatchers } = await import("../../../skills/runtime/refresh.js");
  await closeSkillsWatchers(true);
  await resetSubagentRegistryForTests({ persist: false });
  if (registry) {
    await disposePluginRegistryInstances(registry);
  }
  registry = undefined;
  clearPluginRegistryLoadCache();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

it("enforces a disk-loaded command profile through real Gateway children and collection", async () => {
  const plugin = await writeDiskPlugin();
  const cfg = {
    ...createSpawnBoundaryConfig(state.workspaceDir),
    plugins: {
      allow: [pluginId],
      load: { paths: [plugin.entry] },
      slots: { memory: "none" },
    },
  };
  await state.writeConfig(cfg);
  clearConfigCache();
  setRuntimeConfigSnapshot(cfg);
  registry = loadOpenClawPlugins({ config: cfg, activate: false, cache: false });
  expect(
    registry.plugins.find((record) => record.id === pluginId),
    JSON.stringify(registry.diagnostics),
  ).toMatchObject({ status: "loaded" });
  // Registration pins the original bytes, not whatever is on disk at spawn time.
  await fs.writeFile(path.join(plugin.root, "reviewer.md"), "MUTATED_PROFILE_MUST_NOT_REACH_CHILD");

  const prepared = getPreparedModelRuntimeMocks();
  prepared.modelRegistry.fork.mockImplementation((authStorage) =>
    ModelRegistry.inMemory(authStorage),
  );
  const model = {
    api: "openai-completions" as const,
    baseUrl: "https://example.invalid/v1",
    contextWindow: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    id: "test-model",
    input: ["text" as const],
    maxTokens: 1024,
    name: "Test model",
    provider: "custom",
    reasoning: false,
  };
  prepared.configuredAgentIds = ["main"];
  prepared.configuredAgentDirs.set("main", state.agentDir("main"));
  prepared.configuredWorkspaces.set("main", state.workspaceDir);
  prepared.buildPreparedModelCatalogSnapshot.mockResolvedValue({
    entries: [model],
    routeVariants: [model],
  });
  prepared.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => registry);
  const source = createSpawnOperatorSource();
  const bound = await createSpawnBoundaryParent({
    stateDir: state.stateDir,
    parentSessionKey,
    parentRunId,
    operatorAuthority: source.authority,
  });
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: parentSessionKey },
    {
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["read", "write", "edit", "sessions_spawn", "agents_wait"],
      inheritedToolDeny: ["edit"],
    },
  );
  await refreshPreparedModelRuntimeSnapshots(cfg, {
    gatewayLifecycle: true,
    catalogMode: "static",
    defaultWorkspaceDir: state.workspaceDir,
  });
  const context = bound.context as unknown as GatewayRequestContext;
  context.addChatRun = context.chatRunState.registry.add;
  context.removeChatRun = context.chatRunState.registry.remove;
  context.loadGatewayModelCatalogSnapshot = (request) =>
    loadGatewayModelCatalogSnapshot({ ...request, getConfig: () => cfg });
  context.loadGatewayModelCatalog = async (request) =>
    (await context.loadGatewayModelCatalogSnapshot(request)).entries;
  context.readPreparedGatewayModelCatalog = (request) =>
    readPreparedGatewayModelCatalog({ ...request, getConfig: () => cfg });
  context.validateAgentRuntimeApprovalAuthority = createAgentRuntimeApprovalAuthorityValidator();
  const methods = createRequestGatewayMethodRegistry();
  const runtime = createGatewayInstanceRuntime({
    getContext: () => context,
    getMethodRegistry: () => methods,
    isDispatchAvailable: () => true,
  });
  context.createAgentTurnFacade = runtime.createAgentTurnFacade;
  context.recoveryRuntime = runtime.recovery;
  context.getGatewayMethodRegistry = () => methods;
  vi.spyOn(runtime.recovery, "waitForAgent").mockResolvedValue({ status: "pending" });

  const protectedFile = state.path("protected.txt");
  await fs.writeFile(protectedFile, "unchanged proof input");
  const modelObservations: string[] = [];
  runEmbeddedAgent.mockImplementation(async (params) => {
    const admitted = await resolvePreparedRunAdmission({
      runId: params.runId,
      runtimeKind: "embedded",
      admittedRunContext: params.admittedRunContext,
      preparedRunAdmission: params.preparedRunAdmission,
    });
    expect(readAdmittedRunOperatorAuthority(admitted)).toMatchObject({
      profileId: source.authority.profileId,
      scopes: source.authority.scopes,
    });
    expect(params).toMatchObject({ provider: "custom", model: "test-model" });
    expect(params.extraSystemPrompt).toContain(instructions);
    expect(params.extraSystemPrompt).not.toContain("MUTATED_PROFILE_MUST_NOT_REACH_CHILD");
    const childKey = expectDefined(params.sessionKey, "child session key");
    const child = expectDefined(
      loadSessionEntry({ storePath: bound.storePath, sessionKey: childKey }),
      "child",
    );
    expect(child).toMatchObject({
      spawnedBy: parentSessionKey,
      inheritedToolDeny: expect.arrayContaining(["edit", "write"]),
      inheritedToolAllow: expect.arrayContaining(["read"]),
    });
    expect(subagentRuns.get(params.runId)).toMatchObject({
      requesterSessionKey: parentSessionKey,
      requesterTurnRunId: parentRunId,
      subagentProfile: {
        pluginId,
        id: "reviewer",
        instructionsFile: "reviewer.md",
        instructionsSha256: createHash("sha256").update(instructions).digest("hex"),
      },
      outputSchema: schema,
    });
    expect(params.swarmOutputSchema).toEqual(schema);
    const tools = await createOpenClawCodingToolsInternalAsync({
      config: cfg,
      agentId: "main",
      sessionKey: childKey,
      sessionId: child.sessionId,
      runId: params.runId,
      workspaceDir: state.workspaceDir,
      swarmCollector: params.swarmCollector,
      swarmOutputSchema: params.swarmOutputSchema,
    });
    expect(tools.map((tool) => tool.name)).toContain("read");
    expect(tools.map((tool) => tool.name)).not.toContain("write");
    expect(tools.map((tool) => tool.name)).not.toContain("edit");
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef, tools, hookContext: { runId: params.runId } });
    const dispatcher = new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig());
    try {
      expect(await dispatcher.call("read", { path: protectedFile })).toMatchObject({
        result: {
          content: expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining("unchanged proof input") }),
          ]),
        },
      });
      for (const tool of ["write", "edit"]) {
        await expect(
          dispatcher.callExactId(`openclaw:core:${tool}`, {
            path: protectedFile,
            content: "must not write",
            oldText: "unchanged",
            newText: "changed",
          }),
        ).rejects.toThrow(/unknown tool|not found|unavailable/i);
      }
      expect(await fs.readFile(protectedFile, "utf8")).toBe("unchanged proof input");
    } finally {
      clearToolSearchCatalog({ catalogRef });
    }
    modelObservations.push(params.runId);
    const invalid = params.prompt.includes("invalid profile result");
    const output = expectDefined(
      tools.find((tool) => tool.name === "structured_output"),
      "collector result tool",
    );
    const value = { verdict: invalid ? "rejected" : "approved" };
    if (invalid) {
      await expect(output.execute("invalid-output", { result: value })).rejects.toThrow(
        "Retry once",
      );
      expect(await output.execute("invalid-retry", { result: value })).toMatchObject({
        details: { status: "rejected", success: false, schemaError: expect.any(String) },
      });
    } else {
      expect(await output.execute("valid-output", { result: value })).toMatchObject({
        details: { status: "recorded" },
      });
    }
    const text = JSON.stringify(value);
    await recordSpawnBoundaryFinal({
      storePath: bound.storePath,
      sessionKey: childKey,
      runId: params.runId,
      text,
    });
    return visibleResult(text);
  });

  try {
    const entry = expectDefined(
      loadSessionEntry({ storePath: bound.storePath, sessionKey: parentSessionKey }),
      "requester",
    );
    const ctx = buildTestCtx({
      Body: "/profile-proof",
      CommandBody: "/profile-proof",
      CommandAuthorized: true,
      SessionKey: parentSessionKey,
      InputProvenance: { kind: "external_user" },
    });
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "/profile-proof" },
      target: {
        agentId: "main",
        sessionKey: parentSessionKey,
        sessionId: entry.sessionId,
        sessionEntry: entry,
        storePath: bound.storePath,
        config: cfg,
      },
    });
    const invoke = (signal: AbortSignal) => {
      const nativeState: Parameters<typeof runWithCommandNativeSubagents>[0] = {
        cfg,
        ctx,
        sessionAgentId: "main",
        sessionKey: parentSessionKey,
        sessionStoreEntry: { sessionKey: parentSessionKey, entry },
        params: {
          replyOptions: {
            runId: parentRunId,
            operatorAuthority: source.authority,
            toolsAllow: ["sessions_spawn", "agents_wait", "read", "write", "edit"],
            userTurnTranscriptRecorder: recorder,
          },
        },
        getPreDispatchAbortSignal: () => undefined,
        getDispatchAbortSignal: () => signal,
        assertProgressCurrent: source.authority.assertCurrent,
        assertCurrentBindingRoute: async () => source.authority.assertCurrent(),
        turnAdoption: { assertCurrent: source.authority.assertCurrent, adopt: async () => {} },
      };
      const command = buildCommandTestParams("/profile-proof", cfg, ctx, {
        workspaceDir: state.workspaceDir,
      });
      command.sessionKey = parentSessionKey;
      command.sessionEntry = entry;
      command.storePath = bound.storePath;
      command.opts = {
        withCommandNativeSubagents: (binding, run) =>
          runWithCommandNativeSubagents(nativeState, binding, run),
      };
      return handlePluginCommand(command, true);
    };
    if (!bound.parent.registered) {
      throw new Error("Requester source was not registered");
    }
    const controllerInput = bound.parent.entry.input;
    const result = await withPluginRuntimeGatewayRequestScope(
      {
        context,
        pluginRegistry: registry,
        resolveGatewayContext: bound.resolveGatewayContext,
        isWebchatConnect: () => false,
      },
      () =>
        withSessionTurn(
          {
            sessionKey: parentSessionKey,
            sessionId: entry.sessionId,
            agentId: "main",
            storePath: bound.storePath,
            controllerInput,
          },
          async (_operation, ownerSignal) =>
            invoke(AbortSignal.any([bound.parent.controller.signal, ownerSignal])),
        ),
    );
    expect(result?.shouldContinue).toBe(false);
    const receipt = JSON.parse(expectDefined(result?.reply?.text, "plugin command response"));
    expect(receipt.conflict).toMatch(/outputSchema|schema/i);
    expect(receipt.accepted).toHaveLength(2);
    expect(modelObservations).toHaveLength(2);
    expect(receipt.collection).toMatchObject({
      pending: [],
      completed: [
        expect.objectContaining({ status: "done", structured: { verdict: "approved" } }),
        expect.objectContaining({ status: "failed", schemaError: expect.any(String) }),
      ],
    });
    expect(receipt.collection.completed[1].structured).toBeUndefined();
    expect(
      await loadTranscriptEvents({
        agentId: "main",
        storePath: bound.storePath,
        sessionKey: parentSessionKey,
        sessionId: entry.sessionId,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ role: "user", content: "/profile-proof" }),
        }),
      ]),
    );
  } finally {
    source.revoke();
    bound.execution.beginClose();
    await bound.execution.drain();
    runtime.close();
    bound.admission.close();
    bound.parent.cleanup();
    source.closeRequest();
  }
});
