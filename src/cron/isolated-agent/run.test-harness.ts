import { vi, type Mock } from "vitest";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch.js";

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
export const countActiveDescendantRunsMock = createMock();
export const listDescendantRunsForRequesterMock = createMock();
export const pickLastNonEmptyTextFromPayloadsMock = createMock();
export const resolveCronPayloadOutcomeMock = createMock();
export const resolveCronDeliveryPlanMock = createMock();
export const resolveDeliveryTargetMock = createMock();
export const resolveSessionAuthProfileOverrideMock = createMock();
const resolveAgentDirMock = vi.fn().mockReturnValue("/tmp/agent-dir");
const resolveAgentWorkspaceDirMock = vi.fn().mockReturnValue("/tmp/workspace");
const resolveDefaultAgentIdMock = vi.fn().mockReturnValue("default");
const getSkillsSnapshotVersionMock = vi.fn().mockReturnValue(42);
const ensureAgentWorkspaceMock = vi.fn().mockResolvedValue({ dir: "/tmp/workspace" });
const loadModelCatalogMock = vi.fn().mockResolvedValue({ models: [] });
const normalizeModelSelectionMock = vi.fn((value: unknown) =>
  typeof value === "string" ? value.trim() || undefined : undefined,
);
const lookupContextTokensMock = vi.fn().mockReturnValue(128000);
const resolveCronStyleNowMock = vi
  .fn()
  .mockReturnValue({
    formattedTime: "2026-02-10 12:00",
    timeLine: "Current time: 2026-02-10 12:00 UTC",
  });
const resolveAgentTimeoutMsMock = vi.fn().mockReturnValue(60_000);
const deriveSessionTotalTokensMock = vi.fn().mockReturnValue(30);
const hasNonzeroUsageMock = vi.fn().mockReturnValue(false);
const normalizeThinkLevelMock = vi.fn().mockReturnValue(undefined);
const normalizeVerboseLevelMock = vi.fn().mockReturnValue("off");
const supportsXHighThinkingMock = vi.fn().mockReturnValue(false);
const resolveSessionTranscriptPathMock = vi.fn().mockReturnValue("/tmp/transcript.jsonl");
const setSessionRuntimeModelMock = vi.fn();
const registerAgentRunContextMock = vi.fn();
const buildSafeExternalPromptMock = vi.fn().mockReturnValue("safe prompt");
const detectSuspiciousPatternsMock = vi.fn().mockReturnValue([]);
const isExternalHookSessionMock = vi.fn().mockReturnValue(false);
const mapHookExternalContentSourceMock = vi.fn().mockReturnValue("unknown");
const resolveHookExternalContentSourceMock = vi.fn().mockReturnValue(undefined);
const estimateUsageCostMock = vi.fn().mockReturnValue(undefined);
const resolveModelCostConfigMock = vi.fn().mockReturnValue(undefined);
const resolveBootstrapWarningSignaturesSeenMock = vi.fn().mockReturnValue([]);
const resolveFastModeStateMock = vi.fn().mockReturnValue({ enabled: false });
const resolveNestedAgentLaneMock = vi.fn((lane: string | undefined) => lane);

vi.mock("./run.runtime.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 128000,
  DEFAULT_MODEL: "gpt-4",
  DEFAULT_PROVIDER: "openai",
  LiveSessionModelSwitchError,
  buildSafeExternalPrompt: buildSafeExternalPromptMock,
  buildWorkspaceSkillSnapshot: buildWorkspaceSkillSnapshotMock,
  countActiveDescendantRuns: countActiveDescendantRunsMock,
  deriveSessionTotalTokens: deriveSessionTotalTokensMock,
  detectSuspiciousPatterns: detectSuspiciousPatternsMock,
  ensureAgentWorkspace: ensureAgentWorkspaceMock,
  estimateUsageCost: estimateUsageCostMock,
  getCliSessionId: getCliSessionIdMock,
  getModelRefStatus: getModelRefStatusMock,
  getRemoteSkillEligibility: vi.fn().mockReturnValue({}),
  getSkillsSnapshotVersion: getSkillsSnapshotVersionMock,
  hasNonzeroUsage: hasNonzeroUsageMock,
  isCliProvider: isCliProviderMock,
  isExternalHookSession: isExternalHookSessionMock,
  listDescendantRunsForRequester: listDescendantRunsForRequesterMock,
  loadModelCatalog: loadModelCatalogMock,
  logWarn: (...args: unknown[]) => logWarnMock(...args),
  lookupContextTokens: lookupContextTokensMock,
  mapHookExternalContentSource: mapHookExternalContentSourceMock,
  normalizeAgentId: vi.fn((id: string) => id),
  normalizeModelSelection: normalizeModelSelectionMock,
  normalizeThinkLevel: normalizeThinkLevelMock,
  normalizeVerboseLevel: normalizeVerboseLevelMock,
  registerAgentRunContext: registerAgentRunContextMock,
  resolveAgentConfig: resolveAgentConfigMock,
  resolveAgentDir: resolveAgentDirMock,
  resolveAgentModelFallbacksOverride: resolveAgentModelFallbacksOverrideMock,
  resolveAgentSkillsFilter: resolveAgentSkillsFilterMock,
  resolveAgentTimeoutMs: resolveAgentTimeoutMsMock,
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  resolveAllowedModelRef: resolveAllowedModelRefMock,
  resolveBootstrapWarningSignaturesSeen: resolveBootstrapWarningSignaturesSeenMock,
  resolveConfiguredModelRef: resolveConfiguredModelRefMock,
  resolveCronStyleNow: resolveCronStyleNowMock,
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
  resolveFastModeState: resolveFastModeStateMock,
  resolveHookExternalContentSource: resolveHookExternalContentSourceMock,
  resolveHooksGmailModel: resolveHooksGmailModelMock,
  resolveModelCostConfig: resolveModelCostConfigMock,
  resolveNestedAgentLane: resolveNestedAgentLaneMock,
  resolveSessionAuthProfileOverride: resolveSessionAuthProfileOverrideMock,
  resolveSessionTranscriptPath: resolveSessionTranscriptPathMock,
  resolveThinkingDefault: resolveThinkingDefaultMock,
  runCliAgent: runCliAgentMock,
  runEmbeddedPiAgent: runEmbeddedPiAgentMock,
  runWithModelFallback: runWithModelFallbackMock,
  setCliSessionId: vi.fn(),
  setSessionRuntimeModel: setSessionRuntimeModelMock,
  supportsXHighThinking: supportsXHighThinkingMock,
  updateSessionStore: updateSessionStoreMock,
}));

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
