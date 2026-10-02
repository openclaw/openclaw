import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyLocalSetupWorkspaceConfig } from "../commands/onboard-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import type { LocalOnboardingState } from "../state/local-onboarding-state.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import {
  executeSystemAgentOperation as executeOperation,
  type SystemAgentCommandDeps,
} from "./operations.js";
import type { SystemAgentOverview } from "./overview.js";
import type { SystemAgentSetupApplyResult } from "./setup-apply.js";
import { loadLocalSetupRecovery } from "./setup-recovery.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";
import {
  expectSystemAgentAuditRecord as expectAuditRecord,
  expectTestRecordFields as expectRecordFields,
  installSystemAgentClaudeCliBackendTestFixture,
  createSystemAgentPluginMetadataTestSnapshot,
  readLastSystemAgentAuditEntry as readLastAuditEntry,
  requireTestRecord as requireRecord,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";

const model = "openai/gpt-5.5";
const previousModel = "anthropic/claude-sonnet-4-6";
const workspace = "/tmp/approved-workspace";
const configPath = "/tmp/openclaw.json";
const localOnboarding = vi.hoisted(() => {
  const states = new Map<string, LocalOnboardingState>();
  return {
    states,
    read: vi.fn((file: string) => states.get(file)),
    readForConfig: vi.fn((file: string, config: OpenClawConfig) => {
      const state = states.get(file);
      return state?.securityAcknowledgedAt === config.wizard?.securityAcknowledgedAt
        ? state
        : undefined;
    }),
    complete: vi.fn(({ configPath: file, runId }: { configPath: string; runId: string }) => {
      const current = states.get(file);
      if (current?.status !== "pending" || current.runId !== runId) {
        return false;
      }
      states.set(file, { ...current, status: "completed", completedAtMs: Date.now() });
      return true;
    }),
  };
});
const mockConfig = vi.hoisted(() => {
  let config: OpenClawConfig = {};
  let exists = true;
  let hash = "mock-hash-0";
  let bind = (_config: OpenClawConfig) => {};
  const snapshot = () => {
    const copy = structuredClone(config);
    bind(copy);
    return {
      path: "/tmp/openclaw.json",
      exists,
      valid: exists,
      hash,
      raw: exists ? `${JSON.stringify(copy)}\n` : null,
      parsed: copy,
      sourceConfig: copy,
      sourceConfigBeforeMigrations: copy,
      resolved: copy,
      runtimeConfig: copy,
      config: copy,
      issues: exists ? [] : [{ path: "", message: "missing config" }],
      warnings: [],
      legacyIssues: [],
    };
  };
  const read = vi.fn(async () => snapshot());
  const exclusive = vi.fn(async (effect: (source: OpenClawConfig) => Promise<unknown>) =>
    effect(snapshot().sourceConfig),
  );
  const mutate = vi.fn(
    async (params: {
      writeOptions?: { preCommitRuntimePreflight?: (source: OpenClawConfig) => Promise<unknown> };
      mutate: (
        draft: OpenClawConfig,
        context: { snapshot: ReturnType<typeof snapshot> },
      ) => Promise<void> | void;
    }) => {
      const before = snapshot();
      const draft = structuredClone(config);
      await params.mutate(draft, { snapshot: before });
      bind(draft);
      await params.writeOptions?.preCommitRuntimePreflight?.(structuredClone(draft));
      config = draft;
      exists = true;
      hash = "mock-hash-1";
      bind(config);
      return {
        path: before.path,
        previousHash: before.hash,
        persistedHash: before.hash,
        snapshot: before,
        nextConfig: structuredClone(config),
        result: undefined,
      };
    },
  );
  return {
    read,
    exclusive,
    mutate,
    set: (value: OpenClawConfig) => {
      config = structuredClone(value);
      bind(config);
    },
    current: () => structuredClone(config),
    missing: () => {
      exists = false;
    },
    bind: (binder: typeof bind) => {
      bind = binder;
    },
    reset: () => {
      exists = true;
      hash = "mock-hash-0";
      read.mockClear();
      mutate.mockClear();
      exclusive.mockReset().mockImplementation(async (effect) => effect(snapshot().sourceConfig));
    },
  };
});
vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mockConfig.read,
  mutateConfigFile: mockConfig.mutate,
  withConfigMutationExclusive: mockConfig.exclusive,
}));
vi.mock("../state/local-onboarding-state.js", () => ({
  readLocalOnboardingState: localOnboarding.read,
  readLocalOnboardingStateForConfig: localOnboarding.readForConfig,
  completeLocalOnboarding: localOnboarding.complete,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let metadata: SystemAgentPluginMetadataTestSnapshot;
let restoreBackend: () => void;
let runtime: ReturnType<typeof createSystemAgentTestRuntime>["runtime"];
let lines: string[];
type Options = NonNullable<Parameters<typeof executeOperation>[2]>;
type ApplySetup = NonNullable<SystemAgentCommandDeps["applySetup"]>;
let applySetup: ReturnType<typeof vi.fn<ApplySetup>>;
type Verify = NonNullable<SystemAgentCommandDeps["verifyInferenceConfig"]>;
function run(operation: Parameters<typeof executeOperation>[0], options: Options = {}) {
  return metadata.run(() => executeOperation(operation, runtime, { approved: true, ...options }));
}
function setup(
  options: Options = {},
  operation: Partial<Extract<Parameters<typeof executeOperation>[0], { kind: "setup" }>> = {},
) {
  return run(
    { kind: "setup", workspace, ...operation },
    {
      ...options,
      deps: {
        applySetup,
        loadOverview: async () => overview(),
        verifyInferenceConfig: async () => verified(),
        ...options.deps,
      },
    },
  );
}
function setModel(options: Options) {
  return run({ kind: "set-default-model", model }, options);
}
const verified = () => ({ ok: true as const, modelRef: model, latencyMs: 5 });
const withModel = (primary = model): OpenClawConfig => ({
  agents: { defaults: { model: { primary } }, entries: { main: { default: true } } },
});
function overview(defaultModel: string | undefined = model): SystemAgentOverview {
  const command = { command: "unused", found: false, error: "not found" };
  return {
    defaultAgentId: "main",
    defaultModel,
    agents: [],
    config: { path: configPath, exists: true, valid: true, issues: [], hash: null },
    tools: {
      codex: command,
      claude: command,
      gemini: command,
      apiKeys: { openai: true, anthropic: false },
    },
    gateway: { url: "ws://127.0.0.1:18789", source: "local loopback", reachable: false },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  };
}
function setupResult(
  overrides: Partial<SystemAgentSetupApplyResult> = {},
): SystemAgentSetupApplyResult {
  return {
    configPath,
    configHashBefore: "mock-hash-0",
    configHashAfter: "mock-hash-1",
    bootstrapPending: true,
    workspaceReady: true,
    gateway: { status: "ready", action: "reused" },
    lines: [`Workspace: ${workspace}`],
    ...overrides,
  };
}
function expectNoAudit(operation: string) {
  expect(lines.join("\n")).not.toContain(`[openclaw] done: ${operation}`);
  expect(readLastAuditEntry()).toBeUndefined();
}
async function rejectsModel(
  verifyInferenceConfig: Verify,
  error: string | typeof SystemAgentInferenceUnavailableError,
  options: Options = {},
) {
  const original = withModel(previousModel);
  mockConfig.set(original);
  const result = expect(setModel({ deps: { verifyInferenceConfig }, ...options })).rejects;
  if (typeof error === "string") {
    await result.toThrow(error);
  } else {
    await result.toBeInstanceOf(error);
  }
  expect(mockConfig.current()).toEqual(original);
  expectNoAudit("config.setDefaultModel");
}
function pendingOwner(teamCoordinatorId?: string): LocalOnboardingState {
  const pending: LocalOnboardingState = {
    version: 1,
    status: "pending",
    configPath,
    workspace,
    runId: "guided-run",
    securityAcknowledgedAt: "2026-08-02T00:00:00.000Z",
    startedAtMs: 1,
    ...(teamCoordinatorId ? { teamCoordinatorId } : {}),
  };
  localOnboarding.states.set(configPath, pending);
  recoveryConfig(pending);
  return pending;
}
function recoveryConfig(
  pending: LocalOnboardingState,
  securityAcknowledgedAt = pending.securityAcknowledgedAt,
  approvedWorkspace = workspace,
) {
  mockConfig.set({
    agents: {
      defaults: { model: { primary: model }, workspace: approvedWorkspace },
      entries: { main: { default: true } },
    },
    gateway: { mode: "local" },
    wizard: { securityAcknowledgedAt },
  });
}
function teamConfig(pending: LocalOnboardingState, coordinator = "coordinator") {
  const specialists = ["researcher", "writer", "reviewer"];
  return {
    agents: {
      ownership: "explicit" as const,
      defaults: { model: { primary: model }, workspace, systemAgent: { agentId: coordinator } },
      entries: Object.fromEntries(
        [coordinator, ...specialists].map((id) => [
          id,
          {
            workspace: `${workspace}/${id}`,
            subagents:
              id === coordinator
                ? { allowAgents: specialists, delegationMode: "prefer" as const }
                : { allowAgents: [] },
          },
        ]),
      ),
    },
    gateway: { mode: "local" as const },
    wizard: { securityAcknowledgedAt: pending.securityAcknowledgedAt },
  } satisfies OpenClawConfig;
}
function expectPending(pending: LocalOnboardingState) {
  expect(localOnboarding.complete).not.toHaveBeenCalled();
  expect(localOnboarding.states.get(configPath)).toEqual(pending);
  expect(lines.join("\n")).not.toContain("[openclaw] done: openclaw.setup");
}
async function rejectsRecovery(
  pending: LocalOnboardingState,
  apply: ApplySetup,
  error = "onboarding configuration changed before setup could complete",
  options: Options = {},
) {
  await expect(setup({ deps: { applySetup: apply }, ...options })).rejects.toThrow(error);
  expectPending(pending);
}

beforeAll(() => {
  restoreBackend = installSystemAgentClaudeCliBackendTestFixture();
  metadata = createSystemAgentPluginMetadataTestSnapshot();
  mockConfig.bind((config) => metadata.bindForConfig(config));
});
afterAll(() => {
  mockConfig.bind(() => {});
  restoreBackend();
});
beforeEach(() => {
  applySetup = vi.fn<ApplySetup>(async () => setupResult());
  mockConfig.reset();
  mockConfig.set(withModel());
  localOnboarding.states.clear();
  localOnboarding.read.mockClear();
  localOnboarding.readForConfig.mockClear();
  localOnboarding.complete.mockClear();
  ({ runtime, lines } = createSystemAgentTestRuntime());
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-operations-setup-"));
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
});

describe("setup inference", () => {
  it.each(["default", "setup"] as const)(
    "approves and audits %s-model setup while preserving concurrent edits",
    async (role) => {
      mockConfig.set({
        meta: { migrations: { utilityModelSeparation: true } },
        agents: {
          defaults: role === "default" ? { model: { primary: model } } : { utilityModel: model },
          entries: { main: { default: true } },
        },
        gateway: { port: 18789 },
      });
      applySetup = vi.fn<ApplySetup>(async () =>
        setupResult({ bootstrapPending: role === "setup" }),
      );
      const deps = {
        applySetup,
        loadOverview: async () => ({
          ...overview(),
          defaultModel: role === "default" ? model : undefined,
          setupModel: role === "setup" ? model : undefined,
        }),
        verifyInferenceConfig: vi.fn(async () => {
          mockConfig.set({ ...mockConfig.current(), gateway: { port: 19000 } });
          return { ...verified(), latencyMs: 12 };
        }),
      };
      const operation = { kind: "setup" as const, workspace, model, agentName: "robby" };
      const plan = await run(operation, { approved: false, deps });
      expectRecordFields(plan, { applied: false });
      expect(lines.join("\n")).toContain(`Model choice: keep verified ${role} ${model}.`);
      expect(applySetup).not.toHaveBeenCalled();
      expect(await run(operation, { auditDetails: { rescue: true }, deps })).toEqual({
        applied: true,
        bootstrapPending: role === "setup",
      });
      expect(mockConfig.current().gateway?.port).toBe(19000);
      expect(mockConfig.mutate).not.toHaveBeenCalled();
      expect(applySetup).toHaveBeenCalledWith(
        {
          workspace,
          firstAgent: { name: "robby" },
          expectedInferenceRoute: expect.any(Object),
          surface: "cli",
          runtime,
        },
        { beforePersistentApply: undefined },
      );
      expect(lines.join("\n")).toContain("[openclaw] done: openclaw.setup");
      expect(lines.join("\n")).toContain(
        `${role === "default" ? "Default" : "Setup"} model: ${model} (verified and kept)`,
      );
      expectAuditRecord(
        readLastAuditEntry(),
        { operation: "openclaw.setup", summary: "Bootstrapped setup workspace" },
        {
          rescue: true,
          workspace,
          model,
          modelSource: `live-verified ${role} model`,
          inferenceLatencyMs: 12,
        },
      );
    },
  );

  it("rejects setup without a model before workspace or Gateway writes", async () => {
    mockConfig.set({ agents: { entries: { main: { default: true } } } });
    await expect(
      setup({
        deps: {
          applySetup,
          setupSurface: "gateway",
          loadOverview: async () => ({ ...overview(), defaultModel: undefined }),
        },
      }),
    ).rejects.toThrow("requires working inference first");
    expect(applySetup).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] running: openclaw.setup");
    expectNoAudit("openclaw.setup");
  });

  it("rejects setup when the current route fails live inference", async () => {
    await expect(
      setup({
        deps: {
          applySetup,
          verifyInferenceConfig: async () => ({
            ok: false,
            status: "auth",
            error: "not authenticated",
          }),
        },
      }),
    ).rejects.toThrow("failed a live check");
    expect(applySetup).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] running: openclaw.setup");
    expectNoAudit("openclaw.setup");
  });

  it("rejects setup route drift while preserving the concurrent edit", async () => {
    mockConfig.set({ ...withModel(), auth: { order: { openai: ["openai:old"] } } });

    await expect(
      setup({
        deps: {
          applySetup,
          verifyInferenceConfig: async () => {
            mockConfig.set({ ...withModel(), auth: { order: { openai: ["openai:new"] } } });
            return verified();
          },
        },
      }),
    ).rejects.toThrow("changed during setup verification");
    expect(applySetup).not.toHaveBeenCalled();
    expect(mockConfig.current().auth?.order).toEqual({ openai: ["openai:new"] });
  });

  it("rejects a setup model switch before writing", async () => {
    await expect(setup({}, { model: "acme/different" })).rejects.toThrow(
      "`openclaw onboard` on the machine running OpenClaw",
    );
    expect(applySetup).not.toHaveBeenCalled();
  });
});

describe("model changes", () => {
  it("live-verifies staged and final models, preserves concurrent edits, and publishes the binding", async () => {
    const original = {
      agents: {
        defaults: {
          model: { primary: previousModel, fallbacks: ["openai/gpt-5.2"] },
          systemAgent: { agentId: "main" },
        },
        entries: { main: { default: true, workspace: "/tmp/main" } },
      },
      gateway: { port: 18789 },
      models: { providers: { openai: { baseUrl: "https://api.openai.com/v1", models: [] } } },
    } satisfies OpenClawConfig;
    mockConfig.set(original);
    const concurrent: OpenClawConfig = {
      ...original,
      auth: { profiles: { "google:other": { provider: "google", mode: "api_key" } } },
      models: {
        providers: {
          ...original.models?.providers,
          google: {
            baseUrl: "https://example.invalid",
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          ...original.agents?.defaults,
          models: { "google/unrelated": { agentRuntime: { id: "openclaw" } } },
        },
        entries: { ...original.agents?.entries, work: { workspace: "/tmp/work" } },
      },
      channels: { telegram: { enabled: true } },
    };
    const reboundBinding = { execution: { agentId: "main" } } as never;
    const onVerifiedInferenceChanged = vi.fn();
    let calls = 0;
    const verifyInferenceConfig = vi.fn<Verify>(
      async ({ config, onVerifiedExecution, requireExecutionOwner }) => {
        expect(requireExecutionOwner).toBe(true);
        const stagedDefaults = requireRecord(
          requireRecord(config.agents, "agents").defaults,
          "defaults",
        );
        expect(stagedDefaults.model).toEqual({
          primary: model,
          fallbacks: ["openai/gpt-5.2"],
        });
        expect(mockConfig.current().agents?.defaults?.model).toEqual(
          original.agents?.defaults?.model,
        );
        if (++calls === 1) {
          mockConfig.set(concurrent);
        } else {
          onVerifiedExecution?.(reboundBinding);
        }
        return { ...verified(), latencyMs: 17 };
      },
    );
    expect(await setModel({ deps: { verifyInferenceConfig }, onVerifiedInferenceChanged })).toEqual(
      { applied: true },
    );
    expect(verifyInferenceConfig).toHaveBeenCalledTimes(2);
    expect(onVerifiedInferenceChanged).toHaveBeenCalledExactlyOnceWith(reboundBinding);
    expect(mockConfig.mutate).toHaveBeenCalledOnce();
    expect(mockConfig.current()).toEqual({
      ...concurrent,
      agents: {
        ...concurrent.agents,
        defaults: {
          ...concurrent.agents?.defaults,
          model: { primary: model, fallbacks: ["openai/gpt-5.2"] },
          models: { ...concurrent.agents?.defaults?.models, [model]: {} },
        },
      },
    });
    expect(lines.join("\n")).toContain(`Default model: ${model}`);
    expectAuditRecord(
      readLastAuditEntry(),
      { operation: "config.setDefaultModel", summary: `Set default model to ${model}` },
      {
        requestedModel: model,
        effectiveModel: model,
        inferenceVerified: true,
        inferenceLatencyMs: 17,
      },
    );
  });

  it("rejects concurrent runtime metadata changes to the verified model route", async () => {
    const routeConfig = (runtimeId: string): OpenClawConfig => ({
      agents: {
        ...withModel(previousModel).agents,
        defaults: {
          model: { primary: previousModel },
          models: { [previousModel]: { agentRuntime: { id: runtimeId } } },
        },
      },
    });
    mockConfig.set(routeConfig("claude-cli"));
    const verifyInferenceConfig = vi.fn(async () => {
      mockConfig.set(routeConfig("openclaw"));
      return verified();
    });
    await expect(setModel({ deps: { verifyInferenceConfig } })).rejects.toThrow(
      "inference route changed during verification",
    );
    expect(mockConfig.mutate).toHaveBeenCalledOnce();
    expectNoAudit("config.setDefaultModel");
  });

  it("keeps the working model when initial inference fails", async () => {
    await rejectsModel(
      async () => ({ ok: false, status: "auth", error: "Provider authentication failed." }),
      "The requested model failed a live inference test",
    );
    expect(mockConfig.mutate).not.toHaveBeenCalled();
  });
  it("writes nothing when inference fails at the commit boundary", async () => {
    const verify = vi
      .fn<Verify>()
      .mockResolvedValueOnce(verified())
      .mockResolvedValueOnce({ ok: false, status: "auth", error: "credential changed" });
    await rejectsModel(verify, "no longer passes live inference at the config commit boundary");
    expect(verify).toHaveBeenCalledTimes(2);
  });
  it("rejects an initial result from a different model before opening the write boundary", async () => {
    const verify = vi.fn<Verify>(async () => ({ ...verified(), modelRef: "openai/gpt-5.4" }));
    await rejectsModel(verify, "did not verify the exact model route");
    expect(verify).toHaveBeenCalledOnce();
    expect(mockConfig.mutate).not.toHaveBeenCalled();
  });
  it("rejects a different model from the final commit-boundary probe", async () => {
    const verify = vi
      .fn<Verify>()
      .mockResolvedValueOnce(verified())
      .mockResolvedValueOnce({ ...verified(), modelRef: "openai/gpt-5.4" });
    await rejectsModel(
      verify,
      "did not verify the exact model route at the config commit boundary",
    );
    expect(verify).toHaveBeenCalledTimes(2);
  });
  it.each([1, 2])("rechecks inference authority after live probe %s", async (revokedAt) => {
    let calls = 0;
    const verify = vi.fn<Verify>(async () => {
      calls++;
      return verified();
    });
    const beforePersistentApply = vi.fn(() => {
      if (calls === revokedAt) {
        throw new SystemAgentInferenceUnavailableError("conversation");
      }
    });
    await rejectsModel(verify, SystemAgentInferenceUnavailableError, { beforePersistentApply });
    expect(verify).toHaveBeenCalledTimes(revokedAt);
    expect(beforePersistentApply).toHaveBeenCalledTimes(revokedAt);
  });

  it("stages and persists model changes at the effective default-agent owner", async () => {
    mockConfig.set({
      agents: {
        defaults: { model: { primary: "anthropic/global-default" } },
        entries: { work: { default: true, model: { primary: "anthropic/work-default" } } },
      },
    });
    const verifyInferenceConfig = vi.fn<Verify>(async ({ config }) => {
      expect(config.agents?.defaults?.model).toEqual({ primary: "anthropic/global-default" });
      expect(config.agents?.entries?.work?.model).toEqual({ primary: model });
      return verified();
    });
    await setModel({ deps: { verifyInferenceConfig } });
    expect(mockConfig.current().agents).toMatchObject({
      defaults: { model: { primary: "anthropic/global-default" } },
      entries: { work: { model: { primary: model } } },
    });
  });
});

describe("local setup recovery", () => {
  it("resumes and completes the pending owner under its current authority", async () => {
    const pending = pendingOwner();
    applySetup = vi.fn<NonNullable<SystemAgentCommandDeps["applySetup"]>>(async (params) => {
      params.assertCommitPreconditions?.((await mockConfig.read()).sourceConfig);
      return setupResult();
    });
    const beforePersistentApply = vi.fn();
    const result = await setup({ beforePersistentApply }, { workspace: undefined });
    expect(result.applied).toBe(true);
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ workspace, resume: true, surface: "cli" }),
      { beforePersistentApply },
    );
    expect(localOnboarding.complete).toHaveBeenCalledExactlyOnceWith({
      configPath,
      runId: pending.runId,
    });
    expect(localOnboarding.states.get(configPath)).toMatchObject({
      status: "completed",
      runId: pending.runId,
    });
    expect(beforePersistentApply).toHaveBeenCalledTimes(2);
  });

  it("completes a v2026.9.4 interrupted runtime-bearing roster at its approved root", async () => {
    const pending = pendingOwner();
    const main = {
      default: true,
      models: { "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } } },
    };
    const released: OpenClawConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-opus-5" } }, entries: { main } },
      wizard: { securityAcknowledgedAt: pending.securityAcknowledgedAt },
    };
    mockConfig.set(released);
    const recovery = await loadLocalSetupRecovery();
    recovery.applyOptions?.assertCommitPreconditions(released);
    mockConfig.set(
      applyLocalSetupWorkspaceConfig(released, recovery.workspace, {
        allowWorkspaceChange: recovery.applyOptions?.allowWorkspaceChange,
      }),
    );
    await recovery.complete(configPath, async (effect) => effect());
    expect(mockConfig.current().agents).toMatchObject({
      defaults: { workspace, model: released.agents?.defaults?.model },
      entries: { main },
    });
    expect(mockConfig.current().agents?.entries).toEqual({ main });
    expect(localOnboarding.complete).toHaveBeenCalledExactlyOnceWith({
      configPath,
      runId: pending.runId,
    });
    expect(localOnboarding.states.get(configPath)).toMatchObject({
      status: "completed",
      runId: pending.runId,
      workspace,
      securityAcknowledgedAt: pending.securityAcknowledgedAt,
    });
  });

  it.each(["completed receipt", "remote gateway"])(
    "does not adopt workspace authority from a %s",
    async (kind) => {
      const pending = pendingOwner();
      if (kind === "completed receipt") {
        localOnboarding.states.set(configPath, {
          ...pending,
          status: "completed",
          completedAtMs: 2,
        });
      } else {
        mockConfig.set({ ...mockConfig.current(), gateway: { mode: "remote" } });
      }
      const before = localOnboarding.states.get(configPath);

      expect((await setup()).applied).toBe(true);
      expect(applySetup).toHaveBeenCalledWith(expect.not.objectContaining({ resume: true }), {
        beforePersistentApply: undefined,
      });
      expect(applySetup).toHaveBeenCalledWith(
        expect.not.objectContaining({ allowWorkspaceChange: true }),
        expect.anything(),
      );
      expect(localOnboarding.complete).not.toHaveBeenCalled();
      expect(localOnboarding.states.get(configPath)).toEqual(before);
    },
  );

  it("completes a team receipt at its approved root with a custom coordinator", async () => {
    const pending = pendingOwner();
    mockConfig.set(teamConfig(pending, "project-lead"));

    expect((await setup({}, { workspace: undefined })).applied).toBe(true);
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ workspace, resume: true }),
      expect.anything(),
    );
    expect(localOnboarding.states.get(configPath)).toMatchObject({
      status: "completed",
      runId: pending.runId,
    });
  });

  it.each([
    "specialist workspace",
    "missing specialist",
    "delegation targets",
    "single-agent child workspace",
  ])("keeps the team receipt pending after changing the %s", async (change) => {
    const pending = pendingOwner();
    const config = teamConfig(pending);
    mockConfig.set(config);
    await rejectsRecovery(pending, async () => {
      if (change === "specialist workspace") {
        config.agents.entries.writer!.workspace = `${workspace}/other`;
      } else if (change === "missing specialist") {
        delete config.agents.entries.writer;
      } else if (change === "delegation targets") {
        config.agents.entries.coordinator!.subagents.allowAgents = ["writer"];
        config.agents.entries.coordinator!.workspace = workspace;
      } else {
        config.agents.entries = {
          coordinator: { workspace: `${workspace}/coordinator`, subagents: { allowAgents: [] } },
        };
      }
      mockConfig.set(config);
      return setupResult();
    });
  });

  it.each(["damaged roster", "replaced coordinator"])(
    "preserves recorded team intent when retry starts with a %s",
    async (change) => {
      const pending = pendingOwner("coordinator");
      const config = teamConfig(
        pending,
        change === "replaced coordinator" ? "replacement" : "coordinator",
      );
      if (change === "damaged roster") {
        delete config.agents.entries.writer;
        config.agents.entries.coordinator!.workspace = workspace;
      }
      mockConfig.set(config);
      await rejectsRecovery(pending, async () => setupResult());
    },
  );

  it("restores the recorded first team after activation stops before roster creation", async () => {
    const pending = pendingOwner("project-lead");
    mockConfig.set({
      agents: { defaults: { model: { primary: model } } },
      wizard: { securityAcknowledgedAt: pending.securityAcknowledgedAt },
    });
    applySetup = vi.fn<ApplySetup>(async () => {
      mockConfig.set(teamConfig(pending, pending.teamCoordinatorId));
      return setupResult();
    });
    expect((await setup({}, { workspace: undefined })).applied).toBe(true);
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({
        firstAgent: { name: "project-lead", team: true },
        teamCoordinatorId: "project-lead",
      }),
      expect.anything(),
    );
    expect(localOnboarding.states.get(configPath)).toMatchObject({ status: "completed" });
  });

  it.each([
    {
      label: "workspace preparation",
      overrides: { workspaceReady: false },
      error: "workspace could not be prepared",
    },
    {
      label: "gateway installation",
      overrides: { gateway: { status: "failed", error: "service install failed" } },
      error: "service install failed",
    },
  ] satisfies { label: string; overrides: Partial<SystemAgentSetupApplyResult>; error: string }[])(
    "keeps onboarding pending when $label fails",
    async ({ overrides, error }) => {
      await rejectsRecovery(pendingOwner(), async () => setupResult(overrides), error);
    },
  );

  it("never completes a competing onboarding owner after setup succeeds", async () => {
    const pending = pendingOwner();
    const replacement = { ...pending, runId: "replacement-run" };
    await rejectsRecovery(
      replacement,
      async () => {
        localOnboarding.states.set(configPath, replacement);
        return setupResult();
      },
      "Another onboarding run replaced this setup operation",
    );
  });

  it.each(["owner", "config identity"])(
    "rejects replacement %s at the setup config-write boundary",
    async (changed) => {
      const pending = pendingOwner();
      const replacement = changed === "owner" ? { ...pending, runId: "replacement-run" } : pending;
      const setupEffects = vi.fn();
      await rejectsRecovery(
        replacement,
        async (params) => {
          if (changed === "owner") {
            localOnboarding.states.set(configPath, replacement);
          } else {
            recoveryConfig(pending, "2026-08-03T00:00:00.000Z");
          }
          params.assertCommitPreconditions?.((await mockConfig.read()).sourceConfig);
          setupEffects();
          return setupResult();
        },
        "Another onboarding run replaced this setup operation",
      );
      expect(setupEffects).not.toHaveBeenCalled();
    },
  );

  it("keeps onboarding pending when its configuration disappears after setup", async () => {
    await rejectsRecovery(pendingOwner(), async () => {
      mockConfig.missing();
      return setupResult();
    });
  });

  it.each(["installation identity", "effective workspace"])(
    "rejects %s changed before acquiring the completion lock",
    async (change) => {
      const pending = pendingOwner();
      mockConfig.exclusive.mockImplementationOnce(async (effect) => {
        recoveryConfig(
          pending,
          change === "installation identity"
            ? "2026-08-03T00:00:00.000Z"
            : pending.securityAcknowledgedAt,
          change === "effective workspace" ? "/tmp/changed-before-lock" : workspace,
        );
        return effect((await mockConfig.read()).sourceConfig);
      });
      await rejectsRecovery(pending, async () => setupResult());
      expect(mockConfig.exclusive).toHaveBeenCalledOnce();
    },
  );

  it("rechecks setup authority immediately before completing onboarding", async () => {
    const pending = pendingOwner();
    let authorizations = 0;
    const beforePersistentApply = vi.fn(() => {
      if (++authorizations > 1) {
        throw new SystemAgentInferenceUnavailableError("conversation");
      }
    });
    await expect(setup({ beforePersistentApply })).rejects.toBeInstanceOf(
      SystemAgentInferenceUnavailableError,
    );
    expect(applySetup).toHaveBeenCalledOnce();
    expect(beforePersistentApply).toHaveBeenCalledTimes(2);
    expectPending(pending);
  });

  it("reads final config only after the completion authority check", async () => {
    const pending = pendingOwner();
    let authorizations = 0;
    const beforePersistentApply = vi.fn(() => {
      if (++authorizations > 1) {
        recoveryConfig(pending, "2026-08-03T00:00:00.000Z");
      }
    });
    await rejectsRecovery(pending, async () => setupResult(), undefined, { beforePersistentApply });
    expect(beforePersistentApply).toHaveBeenCalledTimes(2);
  });

  it("rejects setup for a workspace owned by another onboarding run", async () => {
    const pending = pendingOwner();
    await expect(setup({}, { workspace: "/tmp/another-workspace" })).rejects.toThrow(
      "Another onboarding run owns a different workspace",
    );
    expect(applySetup).not.toHaveBeenCalled();
    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(localOnboarding.states.get(configPath)).toEqual(pending);
  });

  it("does not adopt local onboarding from a gateway-hosted setup", async () => {
    const pending = pendingOwner();
    const result = await setup({ deps: { setupSurface: "gateway" } });
    expect(result.applied).toBe(true);
    expect(applySetup).toHaveBeenCalledWith(expect.not.objectContaining({ resume: true }), {
      beforePersistentApply: undefined,
    });
    expect(localOnboarding.readForConfig).not.toHaveBeenCalled();
    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(localOnboarding.states.get(configPath)).toEqual(pending);
  });
});
