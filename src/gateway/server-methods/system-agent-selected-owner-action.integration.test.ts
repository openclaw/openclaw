/**
 * Real delegation -> selected runtime owner -> operator approval -> config publication.
 * Synthetic model output proposes an action; the real writer mutates only owned temp state.
 */
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent-runner/run-orchestrator.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import {
  withPreparedModelRuntimePluginGenerationScope as scope,
  getPreparedModelRuntimePluginGeneration as current,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import {
  refreshPreparedModelRuntimeSnapshots,
  acquireAgentRunPreparedModelRuntime,
  acquirePublishedPreparedModelRuntime,
} from "../../agents/prepared-model-runtime.js";
import { preparedPluginGenerationReusesBase } from "../../agents/prepared-model-runtime.plugin-generation.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import type { PreparedModelRuntimePluginGeneration } from "../../agents/prepared-model-runtime.types.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createOpenClawDelegateToolsForRun } from "../../agents/tools/openclaw-delegate-tool.js";
import { createSystemAgentTool } from "../../agents/tools/system-agent-tool.js";
import * as configRuntime from "../../config/config.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.js";
import { withLocalGatewayRequestScope } from "../../gateway/local-request-context.js";
import type { SystemAgentChatSession } from "../../gateway/server-methods/system-agent.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { runSystemAgentTurnWithDeps } from "../../system-agent/agent-turn.test-support.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import type { SystemAgentOverview } from "../../system-agent/overview.js";
import { buildFacts } from "../../system-agent/runtime-admission.test-helpers.js";
import {
  readLastSystemAgentAuditEntry,
  createSystemAgentPluginMetadataTestSnapshot,
  createSystemAgentVerifiedInferenceTestFixture,
  type SystemAgentPluginMetadataTestSnapshot,
} from "../../system-agent/system-agent.test-helpers.js";
type RunEmbeddedAgentParams = Parameters<typeof runEmbeddedAgent>[0];

vi.mock(
  "../../agents/prepared-model-runtime.build.js",
  async () =>
    (await import("../../system-agent/runtime-admission.test-helpers.js"))
      .runtimeAdmissionBuildModule,
);
const state = vi.hoisted(() => ({
  admitted: 0,
  proposalCalls: 0,
  beforeWrite: 0,
  revokeAtWrite: false,
  revokeCurrent: undefined as (() => void) | undefined,
  selected: undefined as PreparedModelRuntimePluginGeneration | undefined,
}));
// Keep the real CLI/config writer, injecting only a deterministic revocation
// just before its publication guard. All guards and filesystem writes remain real.
vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    replaceConfigFile: (params: Parameters<typeof actual.replaceConfigFile>[0]) =>
      actual.replaceConfigFile({
        ...params,
        writeOptions: {
          ...params.writeOptions,
          beforeCommit: async () => {
            await params.writeOptions?.beforeCommit?.();
            state.beforeWrite++;
            if (state.revokeAtWrite) {
              state.revokeCurrent?.();
            }
          },
        },
      }),
  };
});
// This terminal is called by run-orchestrator AFTER REAL acquire and binding.
vi.mock("../../agents/embedded-agent-runner/run-loop.js", () => ({
  runPreparedEmbeddedLoop: async (
    ...[_refresh, p]: Parameters<
      typeof import("../../agents/embedded-agent-runner/run-loop.js").runPreparedEmbeddedLoop
    >
  ) => {
    expect(p.runParams.toolsAllow).toEqual(["openclaw"]);
    await expectDefined(p.runParams.preparedRunAdmission, "prepared admission").admit("embedded");
    state.admitted++;
    state.selected = current();
    const tool = createSystemAgentTool(expectDefined(p.runParams.systemAgentTool, "system tool"));
    await tool.execute("owned-fixture-proposal", {
      action: "config_set",
      path: "logging.level",
      value: "debug",
    });
    state.proposalCalls++;
    return completedResult();
  },
}));
const RESPONSE_TEXT = "Set the disposable fixture logging level.";
vi.mock("../../agents/embedded-agent-runner/cli-backend-dispatch.js", () => ({
  // This function is called inside run-orchestrator's admitted global-lane task.
  runEmbeddedAgentViaCliBackendIfEligible: async () => undefined,
}));
vi.mock("../../system-agent/transcript-store.js", () => ({
  appendTranscriptTurn: vi.fn(),
  appendTranscriptReset: vi.fn(),
  readTranscriptTail: vi.fn(() => []),
}));
vi.mock("../../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/providers.js")>()),
  resolveOwningPluginIdsForModelRefs: vi.fn(() => []),
  resolveOwningPluginIdsForProviderRef: vi.fn(() => []),
}));
vi.mock("../../agents/harness/runtime-plugin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/harness/runtime-plugin.js")>()),
  resolveAgentHarnessOwnerPluginIds: vi.fn(({ runtime }: { runtime: string }) =>
    runtime === "codex" ? ["codex"] : [],
  ),
}));

let metadata: SystemAgentPluginMetadataTestSnapshot;
const engines: SystemAgentChatEngine[] = [];

beforeAll(() => {
  metadata = createSystemAgentPluginMetadataTestSnapshot();
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const engine of engines.splice(0)) {
      await engine.dispose();
    }
    state.admitted = 0;
    state.proposalCalls = 0;
    state.beforeWrite = 0;
    state.revokeAtWrite = false;
    state.revokeCurrent = undefined;
    state.selected = undefined;
    buildFacts.derived = false;
    configRuntime.clearConfigCache();
    configRuntime.clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    await resetPreparedModelRuntimeSnapshotsForTest();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetCommandQueueStateForTest();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    cleanup();
  }),
);

function completedResult(): EmbeddedAgentRunResult {
  return {
    meta: { durationMs: 1, finalAssistantVisibleText: RESPONSE_TEXT },
  };
}

async function createConversation() {
  resetCommandQueueStateForTest();
  const root = tempDirs.make("openclaw-nested-inference-integration-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { coordinator: {}, researcher: {} },
      defaults: {
        systemAgent: { agentId: "coordinator" },
        model: "openai/gpt-5.5",
        models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
      },
    },
  };
  const configPath = path.join(root, "openclaw.json");
  const originalRaw = JSON.stringify(config);
  fs.writeFileSync(configPath, originalRaw);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  configRuntime.clearConfigCache();
  configRuntime.clearRuntimeConfigSnapshot();
  const proof = await metadata.run(
    () => createSystemAgentVerifiedInferenceTestFixture(config),
    config,
  );
  const readConfigFileSnapshot = async (): Promise<ConfigFileSnapshot> => ({
    exists: true,
    valid: true,
    path: configPath,
    hash: "synthetic-config-hash",
    config,
    runtimeConfig: config,
    sourceConfig: config,
    raw: JSON.stringify(config),
    parsed: config,
    resolved: config,
    issues: [],
    warnings: [],
    legacyIssues: [],
  });
  const overview: SystemAgentOverview = {
    config: {
      path: configPath,
      exists: true,
      valid: true,
      issues: [],
      hash: "synthetic-config-hash",
    },
    agents: [],
    defaultAgentId: "main",
    defaultModel: "openai/gpt-5.5",
    tools: {
      codex: { command: "codex", found: false },
      claude: { command: "claude", found: false },
      gemini: { command: "gemini", found: false },
      apiKeys: { openai: false, anthropic: false },
    },
    gateway: { url: "ws://127.0.0.1:18789", source: "test", reachable: false },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  };
  const deps = {
    ...proof.deps,
    readConfigFileSnapshot,
    loadOverview: async () => overview,
    runEmbeddedAgent: async (runnerParams: RunEmbeddedAgentParams) => {
      return await runEmbeddedAgent({
        ...runnerParams,
      });
    },
  };
  const sessionId = "nested-inference-integration-conversation";
  const sessions = new Map<string, SystemAgentChatSession>();
  const invoke = (signal?: AbortSignal) =>
    metadata.run(
      () =>
        withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => config }, () => {
          const context = expectDefined(
            getPluginRuntimeGatewayRequestScope()?.context,
            "local Gateway context",
          );
          const freshEngine = new SystemAgentChatEngine({
            surface: "gateway",
            verifiedInference: proof.binding,
            operatorApprovalOnly: true,
            deps,
            runAgentTurn: (params) => runSystemAgentTurnWithDeps(params, deps),
          });
          engines.push(freshEngine);
          sessions.set(sessionId, {
            engine: freshEngine,
            welcome: "Synthetic welcome",
            lastUsedAt: 1,
            ownerKey: JSON.stringify(["researcher", "agent:researcher:proof"]),
          });
          context.systemAgentSessions = sessions;
          const tool = createOpenClawDelegateToolsForRun({
            config,
            sessionAgentId: "researcher",
            runSessionKey: "agent:researcher:proof",
          })[0]!;
          const operationalRunInstance = createOperationalRunInstanceRef("proof-parent");
          const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
          state.revokeCurrent = () => releaseAgentRunDelegatedAuthority(authority);
          return withGatewayToolCallerIdentity(
            {
              agentId: "researcher",
              sessionKey: "agent:researcher:proof",
              operationalRunInstance,
              fullPermission: true,
              receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
            },
            () =>
              tool.execute(
                "synthetic-call",
                { sessionId, message: "Please change the logging level." },
                signal,
              ),
          ).finally(() => releaseAgentRunDelegatedAuthority(authority));
        }),
      config,
    );
  buildFacts.metadata = metadata.bindForConfig(config);
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
    pluginMetadataSnapshot: buildFacts.metadata,
  });
  const input = {
    config,
    agentId: "coordinator",
    agentDir: resolveAgentDir(config, "coordinator"),
    workspaceDir: resolveAgentWorkspaceDir(config, "coordinator"),
  };
  const published = await acquirePublishedPreparedModelRuntime(input);
  return { invoke, config, input, published, configPath, originalRaw };
}

describe("selected-owner delegation final action authority", () => {
  it.each([false, true])(
    "publishes only for a live caller (revoke before commit: %s)",
    async (revoke) => {
      const c = await createConversation();
      await using published = c.published;
      buildFacts.derived = true;
      await using parent = await acquireAgentRunPreparedModelRuntime(
        { ...c.input, workspaceDir: c.input.workspaceDir + "-derivative" },
        { pluginGeneration: published.pluginGeneration, catalogMode: "static" },
      );
      buildFacts.derived = false;
      expect(parent.pluginGeneration).not.toBe(published.pluginGeneration);
      expect(
        preparedPluginGenerationReusesBase(parent.pluginGeneration, published.pluginGeneration),
      ).toBe(true);
      state.revokeAtWrite = revoke;
      const result = await scope(
        parent.pluginGeneration,
        () => c.invoke(),
        () => parent.snapshot,
      ).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      expect(state.admitted, JSON.stringify(result)).toBe(1);
      expect(state.proposalCalls).toBe(1);
      expect(state.selected).toBe(published.pluginGeneration);
      expect(state.beforeWrite).toBe(1);
      if (revoke) {
        expect(result.error).toBeInstanceOf(Error);
        expect(String(result.error)).toMatch(/authority|closed|active/i);
        expect(result.value).toBeUndefined();
        expect(readLastSystemAgentAuditEntry()).toBeUndefined();
        expect(fs.readFileSync(c.configPath, "utf8")).toBe(c.originalRaw);
        expect(JSON.stringify(result)).not.toContain("done: config.set");
      } else {
        expect(result.error).toBeUndefined();
        expect(readLastSystemAgentAuditEntry()).toMatchObject({
          operation: "config.set",
          summary: "Set config logging.level",
        });
        expect(JSON.parse(fs.readFileSync(c.configPath, "utf8"))).toMatchObject({
          logging: { level: "debug" },
        });
        expect(JSON.stringify(result.value)).toContain("done: config.set");
      }
    },
  );
});
