import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyLocalSetupWorkspaceConfig } from "../commands/onboard-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import type { LocalOnboardingState } from "../state/local-onboarding-state.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import { executeSystemAgentOperation as executeOperation } from "./operations.js";
import type { SystemAgentOverview } from "./overview.js";
import type { SystemAgentSetupApplyResult } from "./setup-apply.js";
import { applySystemAgentSetup } from "./setup-apply.js";
import { verifySetupInferenceConfig } from "./setup-inference.js";
import { loadLocalSetupRecovery } from "./setup-recovery.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";
import {
  expectSystemAgentAuditRecord as expectAuditRecord,
  expectTestRecordFields as expectRecordFields,
  installSystemAgentClaudeCliBackendTestFixture,
  createSystemAgentPluginMetadataTestSnapshot,
  readLastSystemAgentAuditEntry as readLastAuditEntry,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";

const model = "openai/gpt-5.5";
const previousModel = "anthropic/claude-sonnet-4-6";
const workspace = "/tmp/approved-workspace";
const configPath = "/tmp/openclaw.json";
vi.mock("./setup-apply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./setup-apply.js")>()),
  applySystemAgentSetup: vi.fn(),
}));
vi.mock("./setup-inference.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./setup-inference.js")>()),
  verifySetupInferenceConfig: vi.fn(),
}));
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
vi.mock("../state/local-onboarding-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/local-onboarding-state.js")>()),
  readLocalOnboardingState: localOnboarding.read,
  readLocalOnboardingStateForConfigAsync: localOnboarding.readForConfig,
  completeLocalOnboarding: localOnboarding.complete,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let metadata: SystemAgentPluginMetadataTestSnapshot;
let restoreBackend: () => void;
let runtime: ReturnType<typeof createSystemAgentTestRuntime>["runtime"];
let lines: string[];
type ApplySetup = typeof applySystemAgentSetup;
let applySetup: ReturnType<typeof vi.fn<ApplySetup>>;
type Verify = typeof verifySetupInferenceConfig;
type Options = NonNullable<Parameters<typeof executeOperation>[2]>;
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
      deps: { loadOverview: async () => overview(), ...options.deps },
    },
  );
}
function setModel(verify: Verify, options: Options = {}) {
  vi.mocked(verifySetupInferenceConfig).mockImplementation(verify);
  return run({ kind: "set-default-model", model }, options);
}
function setupWithVerifier(verifyInferenceConfig: Verify) {
  vi.mocked(verifySetupInferenceConfig).mockImplementation(verifyInferenceConfig);
  return setup();
}
async function expectRejectedSetup(result: ReturnType<typeof setup>, error: string) {
  await expect(result).rejects.toThrow(error);
  expect(applySetup).not.toHaveBeenCalled();
  expect(lines.join("\n")).not.toContain("[openclaw] running: openclaw.setup");
  expectNoAudit("openclaw.setup");
}
const verified = () => ({ ok: true as const, modelRef: model, latencyMs: 5 });
const withModel = (primary = model): OpenClawConfig => ({
  agents: { defaults: { model: { primary } }, entries: { main: {} } },
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
  const result = expect(setModel(verifyInferenceConfig, options)).rejects;
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
      entries: { main: {} },
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
function afterFirstAuthorization(effect: () => void) {
  let authorizations = 0;
  return vi.fn(() => {
    if (++authorizations > 1) {
      effect();
    }
  });
}
async function rejectsRecovery(
  pending: LocalOnboardingState,
  apply: ApplySetup = async () => setupResult(),
  error = "onboarding configuration changed before setup could complete",
  options: Options = {},
) {
  applySetup.mockImplementation(apply);
  await expect(setup(options)).rejects.toThrow(error);
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
  vi.mocked(applySystemAgentSetup)
    .mockReset()
    .mockImplementation((...args) => applySetup(...args));
  vi.mocked(verifySetupInferenceConfig)
    .mockReset()
    .mockImplementation(async () => verified());
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
  it("approves and audits setup-model setup while preserving concurrent edits", async () => {
    mockConfig.set({
      meta: { migrations: { utilityModelSeparation: true } },
      agents: {
        defaults: { utilityModel: model },
        entries: { main: {} },
      },
      gateway: { port: 18789 },
    });
    const deps = {
      loadOverview: async () => ({
        ...overview(),
        defaultModel: undefined,
        setupModel: model,
      }),
    };
    vi.mocked(verifySetupInferenceConfig).mockImplementation(async () => {
      mockConfig.set({ ...mockConfig.current(), gateway: { port: 19000 } });
      return { ...verified(), latencyMs: 12 };
    });
    const operation = { kind: "setup" as const, workspace, model, agentName: "robby" };
    const plan = await run(operation, { approved: false, deps });
    expectRecordFields(plan, { applied: false });
    expect(lines.join("\n")).toContain(`Model choice: keep verified setup ${model}.`);
    expect(applySetup).not.toHaveBeenCalled();
    expect(await run(operation, { auditDetails: { rescue: true }, deps })).toEqual({
      applied: true,
      bootstrapPending: true,
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
    expect(lines.join("\n")).toContain(`Setup model: ${model} (verified and kept)`);
    expectAuditRecord(
      readLastAuditEntry(),
      { operation: "openclaw.setup", summary: "Bootstrapped setup workspace" },
      {
        rescue: true,
        workspace,
        model,
        modelSource: "live-verified setup model",
        inferenceLatencyMs: 12,
      },
    );
  });

  it("rejects setup without a model before workspace or Gateway writes", async () => {
    mockConfig.set({ agents: { entries: { main: {} } } });
    await expectRejectedSetup(
      setup({
        deps: {
          setupSurface: "gateway",
          loadOverview: async () => ({ ...overview(), defaultModel: undefined }),
        },
      }),
      "requires working inference first",
    );
  });

  it("rejects setup when the current route fails live inference", async () => {
    await expectRejectedSetup(
      setupWithVerifier(async () => ({ ok: false, status: "auth", error: "not authenticated" })),
      "failed a live check",
    );
  });

  it("rejects setup route drift while preserving the concurrent edit", async () => {
    mockConfig.set({ ...withModel(), auth: { order: { openai: ["openai:old"] } } });

    await expect(
      setupWithVerifier(async () => {
        mockConfig.set({ ...withModel(), auth: { order: { openai: ["openai:new"] } } });
        return verified();
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
  it("live-verifies the selected model before commit, preserves unrelated settings, and publishes the binding", async () => {
    const oldModel = { primary: previousModel, fallbacks: ["openai/gpt-5.2"] };
    const nextModel = { ...oldModel, primary: model };
    const concurrent: OpenClawConfig = {
      gateway: { port: 18789 },
      auth: { profiles: { "google:other": { provider: "google", mode: "api_key" } } },
      models: {
        providers: {
          openai: { baseUrl: "https://api.openai.com/v1", models: [] },
          google: { baseUrl: "https://example.invalid", models: [] },
        },
      },
      agents: {
        defaults: {
          model: oldModel,
          systemAgent: { agentId: "main" },
          models: { "google/unrelated": { agentRuntime: { id: "openclaw" } } },
        },
        entries: { main: { workspace: "/tmp/main" }, work: { workspace: "/tmp/work" } },
      },
      channels: { telegram: { enabled: true } },
    };
    const reboundBinding = { execution: { agentId: "main" } } as never;
    const onVerifiedInferenceChanged = vi.fn();
    mockConfig.set(concurrent);
    const verifyInferenceConfig = vi.fn<Verify>(
      async ({ config, onVerifiedExecution, requireExecutionOwner }) => {
        expect(requireExecutionOwner).toBe(true);
        expect(config.agents?.defaults?.model).toEqual(nextModel);
        expect(mockConfig.current().agents?.defaults?.model).toEqual(oldModel);
        onVerifiedExecution?.(reboundBinding);
        return { ...verified(), latencyMs: 17 };
      },
    );
    expect(await setModel(verifyInferenceConfig, { onVerifiedInferenceChanged })).toEqual({
      applied: true,
    });
    expect(verifyInferenceConfig).toHaveBeenCalledOnce();
    expect(onVerifiedInferenceChanged).toHaveBeenCalledExactlyOnceWith(reboundBinding);
    expect(mockConfig.mutate).toHaveBeenCalledOnce();
    expect(mockConfig.current()).toEqual({
      ...concurrent,
      agents: {
        ...concurrent.agents,
        defaults: {
          ...concurrent.agents?.defaults,
          model: nextModel,
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

  it("keeps the working model when inference fails at the commit boundary", async () => {
    await rejectsModel(
      async () => ({ ok: false, status: "auth", error: "Provider authentication failed." }),
      "no longer passes live inference at the config commit boundary",
    );
    expect(mockConfig.mutate).toHaveBeenCalledOnce();
  });
  it("rejects a different model from the final commit-boundary probe", async () => {
    const verify = vi.fn<Verify>(async () => ({ ...verified(), modelRef: "openai/gpt-5.4" }));
    await rejectsModel(
      verify,
      "did not verify the exact model route at the config commit boundary",
    );
    expect(verify).toHaveBeenCalledOnce();
  });
  it("rechecks inference authority after the live probe", async () => {
    const verify = vi.fn<Verify>(async () => verified());
    const beforePersistentApply = vi.fn(() => {
      if (verify.mock.calls.length > 0) {
        throw new SystemAgentInferenceUnavailableError("conversation");
      }
    });
    await rejectsModel(verify, SystemAgentInferenceUnavailableError, { beforePersistentApply });
    expect(verify).toHaveBeenCalledOnce();
    expect(beforePersistentApply).toHaveBeenCalledTimes(2);
  });

  it("stages and persists model changes at the effective default-agent owner", async () => {
    mockConfig.set({
      agents: {
        defaults: { model: { primary: "anthropic/global-default" } },
        entries: { work: { model: { primary: "anthropic/work-default" } } },
      },
    });
    const verifyInferenceConfig = vi.fn<Verify>(async ({ config }) => {
      expect(config.agents?.defaults?.model).toEqual({ primary: "anthropic/global-default" });
      expect(config.agents?.entries?.work?.model).toEqual({ primary: model });
      return verified();
    });
    await setModel(verifyInferenceConfig);
    expect(mockConfig.current().agents).toMatchObject({
      defaults: { model: { primary: "anthropic/global-default" } },
      entries: { work: { model: { primary: model } } },
    });
  });
});

describe("local setup recovery", () => {
  it("completes a v2026.9.4 interrupted runtime-bearing roster at its approved root", async () => {
    const pending = pendingOwner();
    const main = {
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

  it.each(["completed receipt", "remote gateway", "gateway-hosted setup"])(
    "does not adopt workspace authority from a %s",
    async (kind) => {
      const pending = pendingOwner();
      if (kind === "completed receipt") {
        localOnboarding.states.set(configPath, {
          ...pending,
          status: "completed",
          completedAtMs: 2,
        });
      } else if (kind === "remote gateway") {
        mockConfig.set({ ...mockConfig.current(), gateway: { mode: "remote" } });
      }
      const before = localOnboarding.states.get(configPath);
      const deps = kind === "gateway-hosted setup" ? { setupSurface: "gateway" as const } : {};
      expect((await setup({ deps })).applied).toBe(true);
      expect(applySetup).toHaveBeenCalledWith(expect.not.objectContaining({ resume: true }), {
        beforePersistentApply: undefined,
      });
      expect(applySetup).toHaveBeenCalledWith(
        expect.not.objectContaining({ allowWorkspaceChange: true }),
        expect.anything(),
      );
      expect(localOnboarding.complete).not.toHaveBeenCalled();
      expect(localOnboarding.states.get(configPath)).toEqual(before);
      if (kind === "gateway-hosted setup") {
        expect(localOnboarding.readForConfig).not.toHaveBeenCalled();
      }
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

  it.each(["specialist workspace", "delegation targets"])(
    "keeps the team receipt pending after changing the %s",
    async (change) => {
      const pending = pendingOwner();
      const config = teamConfig(pending);
      mockConfig.set(config);
      await rejectsRecovery(pending, async () => {
        if (change === "specialist workspace") {
          config.agents.entries.writer!.workspace = `${workspace}/other`;
        } else {
          config.agents.entries.coordinator!.subagents.allowAgents = ["writer"];
          config.agents.entries.coordinator!.workspace = workspace;
        }
        mockConfig.set(config);
        return setupResult();
      });
    },
  );

  it("preserves recorded team intent when retry starts with a replaced coordinator", async () => {
    const pending = pendingOwner("coordinator");
    mockConfig.set(teamConfig(pending, "replacement"));
    await rejectsRecovery(pending);
  });

  it("restores the recorded first team after activation stops before roster creation", async () => {
    const pending = pendingOwner("project-lead");
    mockConfig.set({
      agents: { defaults: { model: { primary: model } } },
      wizard: { securityAcknowledgedAt: pending.securityAcknowledgedAt },
    });
    applySetup.mockImplementation(async () => {
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
    applySetup.mockImplementation(async () => {
      localOnboarding.states.set(configPath, replacement);
      return setupResult();
    });
    await expect(setup()).rejects.toThrow("Another onboarding run replaced this setup operation");
    expect(localOnboarding.complete).toHaveBeenCalledExactlyOnceWith({
      configPath,
      runId: pending.runId,
    });
    expect(localOnboarding.states.get(configPath)).toEqual(replacement);
    expect(lines.join("\n")).not.toContain("[openclaw] done: openclaw.setup");
  });

  it("rejects a replaced config identity at the setup config-write boundary", async () => {
    const pending = pendingOwner();
    const setupEffects = vi.fn();
    await rejectsRecovery(
      pending,
      async (params) => {
        recoveryConfig(pending, "2026-08-03T00:00:00.000Z");
        params.assertCommitPreconditions?.((await mockConfig.read()).sourceConfig);
        setupEffects();
        return setupResult();
      },
      "Another onboarding run replaced this setup operation",
    );
    expect(setupEffects).not.toHaveBeenCalled();
  });

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
      await rejectsRecovery(pending);
      expect(mockConfig.exclusive).toHaveBeenCalledOnce();
    },
  );

  it("rechecks setup authority immediately before completing onboarding", async () => {
    const pending = pendingOwner();
    const beforePersistentApply = afterFirstAuthorization(() => {
      throw new SystemAgentInferenceUnavailableError("conversation");
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
    const beforePersistentApply = afterFirstAuthorization(() =>
      recoveryConfig(pending, "2026-08-03T00:00:00.000Z"),
    );
    await rejectsRecovery(pending, undefined, undefined, { beforePersistentApply });
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
});
