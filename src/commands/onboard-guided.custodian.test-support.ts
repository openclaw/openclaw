import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSuiteLogPathTracker } from "../logging/log-test-helpers.js";
import { resetLogger } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import type { RuntimeEnv } from "../runtime.js";
import type {
  beginLocalOnboarding,
  LocalOnboardingState,
} from "../state/local-onboarding-state.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  runGuidedOnboardingWithFixtures as runGuidedOnboardingImpl,
  type GuidedOrchestrationFixture as Deps,
} from "./onboard-guided-runtime.test-support.js";

const runGuidedOnboarding = (...[opts, ...rest]: Parameters<typeof runGuidedOnboardingImpl>) =>
  runGuidedOnboardingImpl({ agentName: "main", ...opts }, ...rest);

const restoreTerminalState = vi.hoisted(() => vi.fn());
const promptAuthChoiceGrouped = vi.hoisted(() => vi.fn());
const ensureAuthProfileStore = vi.hoisted(() =>
  vi.fn(() => ({ version: 1 as const, profiles: {} })),
);
const detectAvailableSetupProviderIds = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/restore.js", () => ({ restoreTerminalState }));

vi.mock("./auth-choice-prompt.js", () => ({ promptAuthChoiceGrouped }));

vi.mock("../agents/auth-profiles.runtime.js", () => ({ ensureAuthProfileStore }));
vi.mock("../plugins/provider-setup-availability.js", () => ({ detectAvailableSetupProviderIds }));

vi.mock("./onboard-interactive-runner.js", async (importActual) => {
  const actual = await importActual<typeof import("./onboard-interactive-runner.js")>();
  return { ...actual, hasInteractiveOnboardingTty: () => true };
});

const readConfigFileSnapshot = vi.hoisted(() =>
  vi.fn(async () => ({
    exists: false,
    valid: true,
    path: "/tmp/openclaw.json",
    issues: [] as Array<{ path?: string; message: string }>,
    config: {},
  })),
);
const localOnboarding = vi.hoisted(() => {
  const states = new Map<string, LocalOnboardingState>();
  const persisted = { config: undefined as OpenClawConfig | undefined };
  return {
    states,
    persisted,
    read: vi.fn((configPath: string) => states.get(configPath)),
    readForConfig: vi.fn((configPath: string, config: OpenClawConfig) => {
      const state = states.get(configPath);
      return state?.securityAcknowledgedAt === config.wizard?.securityAcknowledgedAt
        ? state
        : undefined;
    }),
    begin: vi.fn((params: Parameters<typeof beginLocalOnboarding>[0]) => {
      const existing = states.get(params.configPath);
      if (existing && (!params.replace || existing.runId !== params.expectedRunId)) {
        return existing;
      }
      const pending: LocalOnboardingState = {
        version: 1,
        status: "pending",
        runId: params.runId,
        configPath: params.configPath,
        workspace: params.workspace,
        ...(params.teamCoordinatorId ? { teamCoordinatorId: params.teamCoordinatorId } : {}),
        securityAcknowledgedAt: params.securityAcknowledgedAt,
        startedAtMs: 1,
      };
      states.set(params.configPath, pending);
      persisted.config = {
        ...persisted.config,
        agents: {
          ...persisted.config?.agents,
          defaults: { ...persisted.config?.agents?.defaults, workspace: pending.workspace },
        },
        wizard: {
          ...persisted.config?.wizard,
          securityAcknowledgedAt: pending.securityAcknowledgedAt,
        },
      };
      return pending;
    }),
    complete: vi.fn((params: { configPath: string; runId: string }) => {
      const current = states.get(params.configPath);
      if (current?.status !== "pending" || current.runId !== params.runId) {
        return false;
      }
      states.set(params.configPath, { ...current, status: "completed", completedAtMs: 2 });
      return true;
    }),
  };
});
const withConfigMutationExclusive = vi.hoisted(() =>
  vi.fn(
    async (effect: (config: OpenClawConfig) => Promise<unknown>) =>
      await effect(localOnboarding.persisted.config ?? {}),
  ),
);

const logPathTracker = createSuiteLogPathTracker("openclaw-guided-onboard-log-");

vi.mock("../config/config.js", () => ({ readConfigFileSnapshot, withConfigMutationExclusive }));
vi.mock("../wizard/setup.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wizard/setup.shared.js")>()),
  writeWizardConfigFile: vi.fn(async (config: OpenClawConfig) => {
    localOnboarding.persisted.config = config;
    return { nextConfig: config };
  }),
}));
vi.mock("../state/local-onboarding-state.js", () => ({
  readLocalOnboardingState: localOnboarding.read,
  readLocalOnboardingStateForConfig: localOnboarding.readForConfig,
  beginLocalOnboarding: localOnboarding.begin,
  completeLocalOnboarding: localOnboarding.complete,
}));
vi.mock("./onboard-agent.js", () => ({
  ensureOnboardingAgent: async ({ config }: { config: OpenClawConfig }) => ({
    config: {
      ...config,
      agents: { ...config.agents, entries: { main: {} } },
    },
    agentId: "main",
    bootstrapPending: true,
  }),
  validateFirstOnboardingAgentName: () => undefined,
}));

vi.mock("./onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/openclaw-workspace",
  printWizardHeader: vi.fn(),
}));

function makeRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

type RecordedCall = { mock: { invocationCallOrder: number[] } };

function expectCallOrder(...calls: Array<RecordedCall | number | undefined>) {
  const orders = calls.map((call) =>
    typeof call === "object" ? call.mock.invocationCallOrder[0] : call,
  );
  for (const [index, order] of orders.slice(1).entries()) {
    expect(orders[index]).toBeLessThan(order!);
  }
}

function expectNotCalled(...calls: unknown[]) {
  for (const call of calls) {
    expect(call).not.toHaveBeenCalled();
  }
}

function candidate(kind: "claude-cli" | "codex-cli", label: string) {
  return {
    kind,
    label,
    detail: "logged in",
    modelRef: kind === "claude-cli" ? "claude-cli/opus" : "openai/gpt-5.5",
    recommended: false,
    credentials: true,
  } as const;
}

function existingModelCandidate() {
  return {
    kind: "existing-model",
    label: "Current model",
    detail: "acme/workspace-model — already configured",
    modelRef: "acme/workspace-model",
    recommended: false,
    credentials: true,
  } as const;
}

function detection(overrides: Partial<Awaited<ReturnType<NonNullable<Deps["detect"]>>>> = {}) {
  return {
    candidates: [candidate("claude-cli", "Claude Code")],
    unavailableCandidates: [],
    manualProviders: [],
    authOptions: [],
    recommendedInstalls: [],
    workspace: "/tmp/openclaw-workspace",
    setupComplete: false,
    ...overrides,
  };
}

function setupApplyResult() {
  return {
    configPath: "/tmp/openclaw.json",
    configHashBefore: null,
    configHashAfter: null,
    bootstrapPending: false,
    workspaceReady: true,
    gateway: { status: "ready" as const, action: "installed" as const },
    lines: [],
  };
}

function pendingLocalSetup(params: {
  runId: string;
  workspace: string;
  securityAcknowledgedAt?: string;
}): LocalOnboardingState {
  const pending: LocalOnboardingState = {
    version: 1,
    status: "pending",
    configPath: "/tmp/openclaw.json",
    runId: params.runId,
    workspace: params.workspace,
    securityAcknowledgedAt: params.securityAcknowledgedAt ?? "2026-01-01T00:00:00.000Z",
    startedAtMs: 1,
  };
  localOnboarding.states.set(pending.configPath, pending);
  return pending;
}

function setupDeps(params: Omit<Deps, "createPrompter"> & { prompter?: WizardPrompter } = {}) {
  const {
    prompter = createWizardPrompter(),
    runSystemAgentChat,
    runSetupMemoryImportStep,
    ...overrides
  } = params;
  return {
    createPrompter: () => prompter,
    persistAccessMode: vi.fn(async () => undefined),
    applySetup: vi.fn(async () => setupApplyResult()),
    launchHatchTui: vi.fn<typeof import("../tui/tui-launch.js").launchTuiCli>(
      async () => undefined,
    ),
    runForegroundGateway: vi.fn(async () => undefined),
    listManualOptions: vi.fn(async () => ({
      manualProviders: [],
      authOptions: [],
      workspace: "/tmp/openclaw-workspace",
      setupComplete: false,
    })),
    detect: vi.fn(async () => detection()),
    activate: vi.fn<NonNullable<Deps["activate"]>>(async (activation) => {
      activation.onCommitStarted?.(localOnboarding.persisted.config ?? {});
      return {
        ok: true as const,
        modelRef: "claude-cli/opus",
        latencyMs: 1250,
        lines: ["Workspace: /tmp/work", "Gateway: running"],
      };
    }),
    persistRiskAcknowledgement: vi.fn(async (config: OpenClawConfig) => {
      localOnboarding.persisted.config = config;
      return config.wizard?.securityAcknowledgedAt;
    }),
    runMemorySetupFlow: vi.fn(async (config: OpenClawConfig) => config),
    runAppRecommendations: vi.fn(async ({ config }) => ({
      config,
      commitResult: vi.fn(async () => undefined),
    })),
    runBrowserHandoff: vi.fn(async () => false),
    observeHandoff: vi.fn(),
    ...overrides,
    runSystemAgentChat: vi.fn<NonNullable<Deps["runSystemAgentChat"]>>(
      runSystemAgentChat ?? (async () => {}),
    ),
    runSetupMemoryImportStep: vi.fn<NonNullable<Deps["runSetupMemoryImportStep"]>>(
      runSetupMemoryImportStep ?? (async () => ({ status: "skipped", providers: [] })),
    ),
  } satisfies Deps;
}

export function setupGuidedCustodianTestSuite() {
  beforeAll(() => logPathTracker.setup());

  beforeEach(() => {
    localOnboarding.states.clear();
    localOnboarding.persisted.config = undefined;
    localOnboarding.read.mockClear();
    localOnboarding.readForConfig.mockClear();
    localOnboarding.begin.mockClear();
    localOnboarding.complete.mockClear();
    withConfigMutationExclusive
      .mockReset()
      .mockImplementation(async (effect) => await effect(localOnboarding.persisted.config ?? {}));
    restoreTerminalState.mockClear();
    promptAuthChoiceGrouped
      .mockReset()
      .mockImplementation(
        async ({ additionalGroups }) => additionalGroups?.[0]?.options[0]?.value ?? "skip",
      );
    ensureAuthProfileStore.mockClear();
    detectAvailableSetupProviderIds.mockReset().mockResolvedValue(new Set());
    readConfigFileSnapshot.mockReset().mockImplementation(async () => ({
      exists: localOnboarding.persisted.config !== undefined,
      valid: true,
      path: "/tmp/openclaw.json",
      issues: [],
      config: localOnboarding.persisted.config ?? {},
    }));
  });

  afterEach(() => {
    loggingState.rawConsole = null;
    resetLogger();
  });

  afterAll(() => logPathTracker.cleanup());

  return {
    expectCallOrder,
    expectNotCalled,
    candidate,
    detection,
    existingModelCandidate,
    ensureAuthProfileStore,
    localOnboarding,
    makeRuntime,
    pendingLocalSetup,
    promptAuthChoiceGrouped,
    readConfigFileSnapshot,
    restoreTerminalState,
    runGuidedOnboarding,
    runGuidedOnboardingImpl,
    setupApplyResult,
    setupDeps,
    withConfigMutationExclusive,
  };
}
