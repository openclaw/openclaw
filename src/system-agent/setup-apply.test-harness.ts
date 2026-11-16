import path from "node:path";
import { vi } from "vitest";
import { resolveAgentEntry } from "../agents/agent-scope-config.js";
import * as configModule from "../config/config.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import { materializeRuntimeConfig } from "../config/materialize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { RuntimeEnv } from "../runtime.js";

type ConfigSnapshot = {
  exists: boolean;
  valid: boolean;
  path: string;
  hash: string | null;
  parsed: unknown;
  sourceConfigBeforeMigrations?: OpenClawConfigWithLegacyRoster;
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
  issues: Array<{ path?: string; message: string }>;
};

export type CommitTransform = (
  currentConfig: OpenClawConfig,
  context: {
    previousHash: string | null;
    snapshot: ConfigSnapshot;
    attempt: number;
  },
) =>
  | { nextConfig: OpenClawConfig; result?: unknown }
  | Promise<{ nextConfig: OpenClawConfig; result?: unknown }>;

const mocks = vi.hoisted(() => ({
  state: {
    initialSnapshot: {} as ConfigSnapshot,
    commitConfig: {} as OpenClawConfig,
    commitSnapshot: {} as ConfigSnapshot,
    commitPreviousHash: "probe" as string | null,
    persistedConfig: undefined as OpenClawConfig | undefined,
  },
  events: [] as string[],
  readSnapshot: vi.fn<() => Promise<ConfigSnapshot>>(),
  readVerifiedSnapshot: vi.fn<() => Promise<ConfigSnapshot>>(),
  readVerifiedSnapshotWithPluginMetadata: vi.fn(),
  commit: vi.fn(),
  configureGateway: vi.fn(),
  ensureWorkspace: vi.fn(),
  ensureGatewayService: vi.fn(),
  waitForGatewayReachable: vi.fn<() => Promise<{ ok: boolean; detail?: string }>>(),
  updateExecApprovals: vi.fn(),
  ensureOnboardingAgent: vi.fn(),
  verifySetupInferenceConfig: vi.fn(),
}));

vi.mock("../commands/onboard-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/onboard-agent.js")>()),
  ensureOnboardingAgent: mocks.ensureOnboardingAgent,
}));

vi.mock("./setup-inference.js", () => ({
  verifySetupInferenceConfig: mocks.verifySetupInferenceConfig,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readVerifiedSnapshot,
  readConfigFileSnapshotWithPluginMetadata: mocks.readVerifiedSnapshotWithPluginMetadata,
}));

vi.mock("../wizard/setup.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wizard/setup.shared.js")>()),
  readSetupConfigFileSnapshot: mocks.readSnapshot,
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  applyWizardMetadata: (config: OpenClawConfig) => ({
    ...config,
    wizard: {
      ...config.wizard,
      lastRunAt: "2026-07-10T00:00:00.000Z",
      lastRunVersion: "test",
      lastRunCommand: "onboard",
      lastRunMode: "local",
    },
  }),
  ensureWorkspaceAndSessions: mocks.ensureWorkspace,
  resolveLocalControlUiProbeLinks: ({ port }: { port: number }) => ({
    wsUrl: `ws://127.0.0.1:${port}`,
  }),
  waitForGatewayReachable: mocks.waitForGatewayReachable,
}));

vi.mock("../plugins/install-record-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/install-record-commit.js")>()),
  transformConfigWithPendingPluginInstalls: mocks.commit,
}));

vi.mock("../wizard/setup.gateway-config.js", () => ({
  configureGatewayForSetup: mocks.configureGateway,
}));

vi.mock("../wizard/setup.finalize.js", () => ({
  ensureGatewayServiceForOnboarding: mocks.ensureGatewayService,
}));

vi.mock("../infra/exec-approvals.js", () => ({
  updateExecApprovals: mocks.updateExecApprovals,
}));

vi.mock("../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-scope.js")>()),
  resolveAgentDir: (config: OpenClawConfig, agentId: string) =>
    resolveAgentEntry(config, agentId)?.agentDir ?? `/agents/${agentId}`,
}));

export function getSetupApplyMocks() {
  return mocks;
}

export const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

export function snapshot(
  hash: string | null,
  sourceConfig: OpenClawConfigWithLegacyRoster,
  runtimeConfig: OpenClawConfig = materializeRuntimeConfig(sourceConfig, {
    manifestRegistry: { plugins: [] },
  }),
): ConfigSnapshot {
  return {
    exists: hash !== null,
    valid: true,
    path: "/tmp/openclaw.json",
    hash,
    parsed: structuredClone(sourceConfig),
    sourceConfigBeforeMigrations: structuredClone(sourceConfig),
    config: runtimeConfig,
    sourceConfig,
    runtimeConfig,
    issues: [],
  };
}

export function codexPluginMetadataSnapshot(homeScope: "agent" | "user") {
  return createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "codex",
        origin: "global",
        settingsFiles: [],
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            codexDynamicToolsLoading: { type: "string", default: "searchable" },
            appServer: {
              type: "object",
              additionalProperties: false,
              properties: {
                transport: { type: "string", default: "stdio" },
                homeScope: { type: "string", default: homeScope },
                requestTimeoutMs: { type: "number", default: 60_000 },
              },
            },
          },
        },
      },
    ],
  });
}

export function snapshotSequence(...snapshots: Array<ConfigSnapshot | (() => ConfigSnapshot)>) {
  let index = 0;
  return async () => {
    const next = snapshots[Math.min(index++, snapshots.length - 1)]!;
    return typeof next === "function" ? next() : next;
  };
}

export function transformAttempt(transform: CommitTransform, current: ConfigSnapshot, attempt = 0) {
  return transform(current.sourceConfig, {
    previousHash: current.hash,
    snapshot: current,
    attempt,
  });
}

export function committed(
  result: Awaited<ReturnType<CommitTransform>>,
  previousHash: string | null,
  config = result.nextConfig,
) {
  mocks.state.persistedConfig = config;
  return {
    nextConfig: config,
    path: "/tmp/openclaw.json",
    previousHash,
    persistedHash: "persisted",
    result: result.result,
  };
}

export function materializePluginDefaults(
  config: OpenClawConfig,
  pluginMetadataSnapshot: ReturnType<typeof codexPluginMetadataSnapshot>,
): OpenClawConfig {
  const result = configModule.validateConfigObjectWithPlugins(config, { pluginMetadataSnapshot });
  if (!result.ok) {
    throw new Error(result.issues[0]?.message ?? "test config failed validation");
  }
  return result.config;
}

export function baseParams(
  overrides: Partial<Parameters<typeof import("./setup-apply.js").applySystemAgentSetup>[0]> = {},
) {
  return {
    workspace: "/tmp/openclaw-workspace",
    surface: "gateway" as const,
    runtime,
    ...overrides,
  };
}

export function mainAgentModelConfig(model = "openai/gpt-5.5"): OpenClawConfig {
  return { agents: { defaults: { model }, entries: { main: {} } } };
}

export function setSetupCommitState(config: OpenClawConfig, initialSnapshot: ConfigSnapshot): void {
  mocks.state.initialSnapshot = initialSnapshot;
  mocks.state.commitConfig = config;
  mocks.state.commitSnapshot = initialSnapshot;
}

export function resetSetupApplyMocks(): void {
  vi.resetAllMocks();
  mocks.events.length = 0;
  const config: OpenClawConfig = {
    agents: {
      defaults: { model: { primary: "openai/gpt-5.5" } },
      entries: { main: {} },
    },
  };
  setSetupCommitState(structuredClone(config), snapshot("probe", config));
  mocks.state.commitPreviousHash = "probe";
  mocks.state.persistedConfig = undefined;
  mocks.ensureOnboardingAgent.mockImplementation(
    async ({ config: current, firstAgent, workspace }) => {
      const name = firstAgent?.name ?? "main";
      const id = name.toLowerCase();
      const team = firstAgent?.team === true;
      const createdAgentIds = team ? [id, "researcher", "writer", "reviewer"] : [id];
      const next = {
        ...current,
        agents: {
          ...current.agents,
          ...(team
            ? {
                ownership: "explicit" as const,
                defaults: { ...current.agents?.defaults, systemAgent: { agentId: id } },
              }
            : {}),
          entries: Object.fromEntries(
            createdAgentIds.map((agentId) => [
              agentId,
              {
                workspace: team ? path.join(workspace, agentId) : workspace,
                agentDir: `/agents/${agentId}`,
                ...(team
                  ? {
                      subagents:
                        agentId === id
                          ? {
                              allowAgents: createdAgentIds.slice(1),
                              delegationMode: "prefer" as const,
                            }
                          : { allowAgents: [] },
                    }
                  : {}),
              },
            ]),
          ),
        },
      };
      mocks.state.persistedConfig = next;
      setSetupCommitState(next, snapshot("agent-create", next));
      mocks.state.commitPreviousHash = "agent-create";
      mocks.events.push("agent-create");
      return {
        config: next,
        agentId: id,
        bootstrapPending: true,
        createdAgent: true,
        createdAgentIds,
        configHash: "agent-create",
      };
    },
  );
  mocks.readSnapshot.mockImplementation(async () => mocks.state.initialSnapshot);
  mocks.readVerifiedSnapshot.mockImplementation(async () => mocks.state.initialSnapshot);
  mocks.readVerifiedSnapshotWithPluginMetadata.mockImplementation(async () => ({
    snapshot: await mocks.readVerifiedSnapshot(),
  }));
  mocks.commit.mockImplementation(async (params: { transform: CommitTransform }) => {
    const currentConfig = structuredClone(mocks.state.commitConfig);
    const result = await params.transform(currentConfig, {
      previousHash: mocks.state.commitPreviousHash,
      snapshot: mocks.state.commitSnapshot,
      attempt: 0,
    });
    mocks.events.push("commit");
    mocks.state.initialSnapshot = snapshot("persisted", result.nextConfig);
    return committed(result, mocks.state.commitPreviousHash);
  });
  mocks.configureGateway.mockImplementation(
    async ({
      nextConfig,
      quickstartGateway,
    }: Parameters<
      typeof import("../wizard/setup.gateway-config.js").configureGatewayForSetup
    >[0]) => ({
      nextConfig,
      settings: {
        authMode: quickstartGateway.authMode,
        bind: quickstartGateway.bind,
        customBindHost: quickstartGateway.customBindHost,
        gatewayToken: quickstartGateway.token,
        port: quickstartGateway.port,
      },
    }),
  );
  mocks.ensureWorkspace.mockImplementation(async () => {
    mocks.events.push("workspace");
    return { bootstrapPending: true };
  });
  mocks.ensureGatewayService.mockResolvedValue({
    gateway: { status: "skipped", reason: "explicit" },
    containerWithoutUserSystemd: false,
  });
  mocks.waitForGatewayReachable.mockResolvedValue({ ok: true });
  mocks.updateExecApprovals.mockResolvedValue(undefined);
  mocks.verifySetupInferenceConfig.mockResolvedValue({
    ok: true,
    modelRef: "openai/gpt-5.5",
    latencyMs: 1,
  });
}
