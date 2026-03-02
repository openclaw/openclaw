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
export const getCliSessionIdMock = createMock();
export const updateSessionStoreMock = createMock();
export const resolveCronSessionMock = createMock();
export const logWarnMock = createMock();

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
  ensureAgentWorkspace: vi.fn().mockResolvedValue({ dir: "/tmp/workspace" }),
}));

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn().mockResolvedValue({ models: [] }),
}));

vi.mock("../../agents/model-selection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/model-selection.js")>();
  return {
    ...actual,
    getModelRefStatus: getModelRefStatusMock,
    isCliProvider: isCliProviderMock,
    resolveAllowedModelRef: resolveAllowedModelRefMock,
    resolveConfiguredModelRef: resolveConfiguredModelRefMock,
    resolveHooksGmailModel: resolveHooksGmailModelMock,
    resolveThinkingDefault: resolveThinkingDefaultMock,
  };
});

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: runWithModelFallbackMock,
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: runEmbeddedPiAgentMock,
}));

vi.mock("../../agents/context.js", () => ({
  lookupContextTokens: vi.fn().mockReturnValue(128000),
}));

vi.mock("../../agents/date-time.js", () => ({
  formatUserTime: vi.fn().mockReturnValue("2026-02-10 12:00"),
  resolveUserTimeFormat: vi.fn().mockReturnValue("24h"),
  resolveUserTimezone: vi.fn().mockReturnValue("UTC"),
}));

vi.mock("../../agents/timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn().mockReturnValue(60_000),
}));

vi.mock("../../agents/usage.js", () => ({
  deriveSessionTotalTokens: vi.fn().mockReturnValue(30),
  hasNonzeroUsage: vi.fn().mockReturnValue(false),
}));

vi.mock("../../agents/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: runCliAgentMock,
}));

vi.mock("../../agents/cli-session.js", () => ({
  getCliSessionId: getCliSessionIdMock,
  setCliSessionId: vi.fn(),
}));

vi.mock("../../auto-reply/thinking.js", () => ({
  normalizeThinkLevel: vi.fn().mockReturnValue(undefined),
  normalizeVerboseLevel: vi.fn().mockReturnValue("off"),
  supportsXHighThinking: vi.fn().mockReturnValue(false),
}));

vi.mock("../../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: vi.fn().mockReturnValue({}),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveAgentMainSessionKey: vi.fn().mockReturnValue("main:default"),
  resolveSessionTranscriptPath: vi.fn().mockReturnValue("/tmp/transcript.jsonl"),
  setSessionRuntimeModel: vi.fn(),
  updateSessionStore: updateSessionStoreMock,
}));

vi.mock("../../routing/session-key.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../routing/session-key.js")>();
  return {
    ...actual,
    buildAgentMainSessionKey: vi.fn().mockReturnValue("agent:default:cron:test"),
    normalizeAgentId: vi.fn((id: string) => id),
  };
});

vi.mock("../../infra/agent-events.js", () => ({
  registerAgentRunContext: vi.fn(),
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: vi.fn().mockReturnValue({}),
}));

vi.mock("../../logger.js", () => ({
  logWarn: (...args: unknown[]) => logWarnMock(...args),
}));

vi.mock("../../security/external-content.js", () => ({
  buildSafeExternalPrompt: vi.fn().mockReturnValue("safe prompt"),
  detectSuspiciousPatterns: vi.fn().mockReturnValue([]),
  getHookType: vi.fn().mockReturnValue("unknown"),
  isExternalHookSession: vi.fn().mockReturnValue(false),
}));

vi.mock("../delivery.js", () => ({
  resolveCronDeliveryPlan: vi.fn().mockReturnValue({ requested: false }),
}));

vi.mock("./delivery-target.js", () => ({
  resolveDeliveryTarget: vi.fn().mockResolvedValue({
    channel: "discord",
    to: undefined,
    accountId: undefined,
    error: undefined,
  }),
}));

vi.mock("./helpers.js", () => ({
  isHeartbeatOnlyResponse: vi.fn().mockReturnValue(false),
  pickLastDeliverablePayload: vi.fn().mockReturnValue(undefined),
  pickLastNonEmptyTextFromPayloads: vi.fn().mockReturnValue("test output"),
  pickSummaryFromOutput: vi.fn().mockReturnValue("summary"),
  pickSummaryFromPayloads: vi.fn().mockReturnValue("summary"),
  resolveHeartbeatAckMaxChars: vi.fn().mockReturnValue(100),
}));

vi.mock("./session.js", () => ({
  resolveCronSession: resolveCronSessionMock,
}));

vi.mock("../../agents/defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 128000,
  DEFAULT_MODEL: "gpt-4",
  DEFAULT_PROVIDER: "openai",
}));

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
  resolveThinkingDefaultMock.mockReturnValue(undefined);
  getModelRefStatusMock.mockReturnValue({ allowed: false });
  isCliProviderMock.mockReturnValue(false);

  runWithModelFallbackMock.mockReset();
  runWithModelFallbackMock.mockResolvedValue(makeDefaultModelFallbackResult());
  runEmbeddedPiAgentMock.mockReset();
  runEmbeddedPiAgentMock.mockResolvedValue(makeDefaultEmbeddedResult());

  runCliAgentMock.mockReset();
  getCliSessionIdMock.mockReturnValue(undefined);

  updateSessionStoreMock.mockReset();
  updateSessionStoreMock.mockResolvedValue(undefined);

  resolveCronSessionMock.mockReset();
  resolveCronSessionMock.mockReturnValue(makeCronSession());

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
