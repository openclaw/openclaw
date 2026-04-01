import { vi, type Mock } from "vitest";

type CronSessionEntry = {
  sessionId: string;
  updatedAt: number;
  systemSent: boolean;
  skillsSnapshot: unknown;
  model?: string;
  modelProvider?: string;
  [key: string]: unknown;
};

type CronSession = {
  storePath: string;
  store: Record<string, unknown>;
  sessionEntry: CronSessionEntry;
  systemSent: boolean;
  isNewSession: boolean;
  [key: string]: unknown;
};

function createMock(): Mock {
  return vi.fn();
}

function normalizeModelSelectionForTest(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const primary = (value as { primary?: unknown }).primary;
  return typeof primary === "string" && primary.trim() ? primary.trim() : undefined;
}

export const buildWorkspaceSkillSnapshotMock = createMock();
export const resolveAgentConfigMock = createMock();
export const resolveAgentModelFallbacksOverrideMock = createMock();
export const resolveAgentSkillsFilterMock = createMock();
export const getModelRefStatusMock = createMock();
export const isCliProviderMock = createMock();
export const resolveAllowedModelRefMock = createMock();
export const resolveConfiguredModelRefMock = createMock();
export const resolveHooksGmailModelMock = createMock();
export const resolveThinkingDefaultMock = createMock();
export const runWithModelFallbackMock = createMock();
export const runEmbeddedPiAgentMock = createMock();
export const runCliAgentMock = createMock();
export const lookupCachedContextTokensMock = createMock();
export const getCliSessionIdMock = createMock();
export const updateSessionStoreMock = createMock();
export const resolveCronSessionMock = createMock();
export const logWarnMock = createMock();
export const countActiveDescendantRunsMock = createMock();
export const listDescendantRunsForRequesterMock = createMock();
export const pickLastNonEmptyTextFromPayloadsMock = createMock();
export const resolveCronPayloadOutcomeMock = createMock();
export const resolveCronDeliveryPlanMock = createMock();
export const resolveDeliveryTargetMock = createMock();
export const resolveSessionAuthProfileOverrideMock = createMock();

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: resolveAgentConfigMock,
  resolveAgentDir: vi.fn().mockReturnValue("/tmp/agent-dir"),
  resolveAgentModelFallbacksOverride: resolveAgentModelFallbacksOverrideMock,
  resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/workspace"),
  resolveDefaultAgentId: vi.fn().mockReturnValue("default"),
  resolveAgentSkillsFilter: resolveAgentSkillsFilterMock,
}));

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: buildWorkspaceSkillSnapshotMock,
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  getSkillsSnapshotVersion: vi.fn().mockReturnValue(42),
}));

vi.mock("../../agents/workspace.js", () => ({
  DEFAULT_IDENTITY_FILENAME: "IDENTITY.md",
  ensureAgentWorkspace: vi.fn().mockResolvedValue({ dir: "/tmp/workspace" }),
}));

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn().mockResolvedValue({ models: [] }),
}));

vi.mock("../../agents/model-selection.js", () => ({
  getModelRefStatus: getModelRefStatusMock,
  isCliProvider: isCliProviderMock,
  normalizeModelSelection: normalizeModelSelectionForTest,
  resolveAllowedModelRef: resolveAllowedModelRefMock,
  resolveConfiguredModelRef: resolveConfiguredModelRefMock,
  resolveHooksGmailModel: resolveHooksGmailModelMock,
  resolveThinkingDefault: resolveThinkingDefaultMock,
}));

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: runWithModelFallbackMock,
}));

vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthProfileOverride: resolveSessionAuthProfileOverrideMock,
}));

vi.mock("../../agents/live-model-switch-error.js", async (importOriginal) => {
  return await importOriginal<typeof import("../../agents/live-model-switch-error.js")>();
});

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: runEmbeddedPiAgentMock,
}));

vi.mock("../../agents/context-cache.js", () => ({
  lookupCachedContextTokens: lookupCachedContextTokensMock,
}));

vi.mock("../../agents/date-time.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/date-time.js")>();
  return {
    ...actual,
    formatUserTime: vi.fn().mockReturnValue("2026-02-10 12:00"),
    resolveUserTimeFormat: vi.fn().mockReturnValue("24h"),
    resolveUserTimezone: vi.fn().mockReturnValue("UTC"),
  };
});

vi.mock("../../agents/timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn().mockReturnValue(60_000),
}));

vi.mock("../../agents/usage.js", () => ({
  deriveSessionTotalTokens: vi.fn().mockReturnValue(30),
  hasNonzeroUsage: vi.fn().mockReturnValue(false),
}));

vi.mock("../../agents/subagent-announce.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/subagent-announce.js")>();
  return {
    ...actual,
    runSubagentAnnounceFlow: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("../../agents/subagent-registry.js", () => ({
  countActiveDescendantRuns: countActiveDescendantRunsMock,
  listDescendantRunsForRequester: listDescendantRunsForRequesterMock,
}));

vi.mock("../../agents/cli-runner.runtime.js", () => ({
  runCliAgent: runCliAgentMock,
  getCliSessionId: getCliSessionIdMock,
  setCliSessionId: vi.fn(),
}));

vi.mock("../../auto-reply/thinking.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/thinking.js")>();
  return {
    ...actual,
    normalizeThinkLevel: vi.fn().mockReturnValue(undefined),
    normalizeVerboseLevel: vi.fn().mockReturnValue("off"),
    supportsXHighThinking: vi.fn().mockReturnValue(false),
  };
});

vi.mock("../../cli/outbound-send-deps.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../cli/outbound-send-deps.js")>();
  return {
    ...actual,
    createOutboundSendDeps: vi.fn().mockReturnValue({}),
  };
});

vi.mock("../../config/sessions/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/paths.js")>();
  return {
    ...actual,
    resolveSessionTranscriptPath: vi.fn().mockReturnValue("/tmp/transcript.jsonl"),
  };
});

vi.mock("../../config/sessions/store.runtime.js", () => ({
  updateSessionStore: updateSessionStoreMock,
}));

vi.mock("../../config/sessions/types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/types.js")>();
  return {
    ...actual,
    setSessionRuntimeModel: vi.fn(),
  };
});

vi.mock("../../routing/session-key.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../routing/session-key.js")>();
  return {
    ...actual,
    buildAgentMainSessionKey: vi.fn().mockReturnValue("agent:default:cron:test"),
    normalizeAgentId: vi.fn((id: string) => id),
  };
});

vi.mock("../../infra/agent-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/agent-events.js")>();
  return {
    ...actual,
    registerAgentRunContext: vi.fn(),
  };
});

vi.mock("../../infra/outbound/deliver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/outbound/deliver.js")>();
  return {
    ...actual,
    deliverOutboundPayloads: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../infra/skills-remote.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/skills-remote.js")>();
  return {
    ...actual,
    getRemoteSkillEligibility: vi.fn().mockReturnValue({}),
  };
});

vi.mock("../../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logger.js")>();
  return {
    ...actual,
    logWarn: (...args: unknown[]) => logWarnMock(...args),
  };
});

vi.mock("../../security/external-content.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../security/external-content.js")>();
  return {
    ...actual,
    buildSafeExternalPrompt: vi.fn().mockReturnValue("safe prompt"),
    detectSuspiciousPatterns: vi.fn().mockReturnValue([]),
    getHookType: vi.fn().mockReturnValue("unknown"),
    isExternalHookSession: vi.fn().mockReturnValue(false),
  };
});

vi.mock("../delivery.js", () => ({
  resolveCronDeliveryPlan: resolveCronDeliveryPlanMock,
}));

vi.mock("./delivery-target.js", () => ({
  resolveDeliveryTarget: resolveDeliveryTargetMock,
}));

vi.mock("./helpers.js", () => ({
  isHeartbeatOnlyResponse: vi.fn().mockReturnValue(false),
  pickLastDeliverablePayload: vi.fn().mockReturnValue(undefined),
  pickLastNonEmptyTextFromPayloads: pickLastNonEmptyTextFromPayloadsMock,
  pickSummaryFromOutput: vi.fn().mockReturnValue("summary"),
  pickSummaryFromPayloads: vi.fn().mockReturnValue("summary"),
  resolveCronPayloadOutcome: resolveCronPayloadOutcomeMock,
  resolveHeartbeatAckMaxChars: vi.fn().mockReturnValue(100),
}));

vi.mock("./session.js", () => ({
  resolveCronSession: resolveCronSessionMock,
}));

vi.mock("../../agents/defaults.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/defaults.js")>();
  return {
    ...actual,
    DEFAULT_CONTEXT_TOKENS: 128000,
    DEFAULT_MODEL: "gpt-4",
    DEFAULT_PROVIDER: "openai",
  };
});

export function makeCronSessionEntry(overrides?: Record<string, unknown>): CronSessionEntry {
  return {
    sessionId: "test-session-id",
    updatedAt: 0,
    systemSent: false,
    skillsSnapshot: undefined,
    ...overrides,
  };
}

export function makeCronSession(overrides?: Record<string, unknown>): CronSession {
  return {
    storePath: "/tmp/store.json",
    store: {},
    sessionEntry: makeCronSessionEntry(),
    systemSent: false,
    isNewSession: true,
    ...overrides,
  } as CronSession;
}

function makeDefaultModelFallbackResult() {
  return {
    result: {
      payloads: [{ text: "test output" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    },
    provider: "openai",
    model: "gpt-4",
  };
}

function makeDefaultEmbeddedResult() {
  return {
    payloads: [{ text: "test output" }],
    meta: { agentMeta: { usage: { input: 10, output: 20 } } },
  };
}

export function mockRunCronFallbackPassthrough(): void {
  runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
    const result = await run(provider, model);
    return { result, provider, model, attempts: [] };
  });
}

export function resetRunCronIsolatedAgentTurnHarness(): void {
  vi.clearAllMocks();

  buildWorkspaceSkillSnapshotMock.mockReturnValue({
    prompt: "<available_skills></available_skills>",
    resolvedSkills: [],
    version: 42,
  });
  resolveAgentConfigMock.mockReturnValue(undefined);
  resolveAgentModelFallbacksOverrideMock.mockReturnValue(undefined);
  resolveAgentSkillsFilterMock.mockReturnValue(undefined);

  resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-4" });
  resolveAllowedModelRefMock.mockReturnValue({ ref: { provider: "openai", model: "gpt-4" } });
  resolveHooksGmailModelMock.mockReturnValue(null);
  resolveThinkingDefaultMock.mockReturnValue("off");
  getModelRefStatusMock.mockReturnValue({ allowed: false });
  isCliProviderMock.mockReturnValue(false);

  runWithModelFallbackMock.mockReset();
  runWithModelFallbackMock.mockResolvedValue(makeDefaultModelFallbackResult());
  runEmbeddedPiAgentMock.mockReset();
  runEmbeddedPiAgentMock.mockResolvedValue(makeDefaultEmbeddedResult());

  runCliAgentMock.mockReset();
  lookupCachedContextTokensMock.mockReset();
  lookupCachedContextTokensMock.mockReturnValue(undefined);
  getCliSessionIdMock.mockReturnValue(undefined);

  updateSessionStoreMock.mockReset();
  updateSessionStoreMock.mockResolvedValue(undefined);

  resolveCronSessionMock.mockReset();
  resolveCronSessionMock.mockReturnValue(makeCronSession());

  countActiveDescendantRunsMock.mockReset();
  countActiveDescendantRunsMock.mockReturnValue(0);
  listDescendantRunsForRequesterMock.mockReset();
  listDescendantRunsForRequesterMock.mockReturnValue([]);
  pickLastNonEmptyTextFromPayloadsMock.mockReset();
  pickLastNonEmptyTextFromPayloadsMock.mockReturnValue("test output");
  resolveCronPayloadOutcomeMock.mockReset();
  resolveCronPayloadOutcomeMock.mockImplementation(
    ({ payloads }: { payloads: Array<{ isError?: boolean }> }) => {
      const outputText = pickLastNonEmptyTextFromPayloadsMock(payloads);
      const synthesizedText = outputText?.trim() || "summary";
      const hasFatalErrorPayload = payloads.some((payload) => payload?.isError === true);
      return {
        summary: "summary",
        outputText,
        synthesizedText,
        deliveryPayload: undefined,
        deliveryPayloads: synthesizedText ? [{ text: synthesizedText }] : [],
        deliveryPayloadHasStructuredContent: false,
        hasFatalErrorPayload,
        embeddedRunError: hasFatalErrorPayload
          ? "cron isolated run returned an error payload"
          : undefined,
      };
    },
  );
  resolveCronDeliveryPlanMock.mockReset();
  resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "none" });
  resolveDeliveryTargetMock.mockReset();
  resolveDeliveryTargetMock.mockResolvedValue({
    channel: "discord",
    to: undefined,
    accountId: undefined,
    error: undefined,
  });
  resolveSessionAuthProfileOverrideMock.mockReset();
  resolveSessionAuthProfileOverrideMock.mockResolvedValue(undefined);

  logWarnMock.mockReset();
}

export function clearFastTestEnv(): string | undefined {
  const previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
  delete process.env.OPENCLAW_TEST_FAST;
  return previousFastTestEnv;
}

export function restoreFastTestEnv(previousFastTestEnv: string | undefined): void {
  if (previousFastTestEnv == null) {
    delete process.env.OPENCLAW_TEST_FAST;
    return;
  }
  process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
}

export async function loadRunCronIsolatedAgentTurn() {
  const { runCronIsolatedAgentTurn } = await import("./run.js");
  return runCronIsolatedAgentTurn;
}
