import { vi, type Mock } from "vitest";
import { resolveFastModeState as resolveFastModeStateImpl } from "../../agents/fast-mode.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import { resolveAgentModelFallbackValues } from "../../config/model-input.js";

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
export const resolveEffectiveModelFallbacksMock = createMock();
export const resolveAgentModelFallbacksOverrideMock = createMock();
export const resolveAgentSkillsFilterMock = createMock();
export const getModelRefStatusMock = createMock();
export const resolveAllowedModelRefMock = createMock();
export const resolveConfiguredModelRefMock = createMock();
export const resolveHooksGmailModelMock = createMock();
export const resolveThinkingDefaultMock = createMock();
export const runWithModelFallbackMock = createMock();
export const runEmbeddedPiAgentMock = createMock();
export const lookupContextTokensMock = createMock();
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
export const resolveFastModeStateMock = createMock();

const resolveBootstrapWarningSignaturesSeenMock = createMock();
const resolveCronStyleNowMock = createMock();
const resolveNestedAgentLaneMock = createMock();
const resolveAgentTimeoutMsMock = createMock();
const deriveSessionTotalTokensMock = createMock();
const hasNonzeroUsageMock = createMock();
const ensureAgentWorkspaceMock = createMock();
const normalizeThinkLevelMock = createMock();
const normalizeVerboseLevelMock = createMock();
const supportsXHighThinkingMock = createMock();
const resolveSessionTranscriptPathMock = createMock();
const setSessionRuntimeModelMock = createMock();
const registerAgentRunContextMock = createMock();
const buildSafeExternalPromptMock = createMock();
const detectSuspiciousPatternsMock = createMock();
const mapHookExternalContentSourceMock = createMock();
const isExternalHookSessionMock = createMock();
const resolveHookExternalContentSourceMock = createMock();
const getSkillsSnapshotVersionMock = createMock();
const loadModelCatalogMock = createMock();
const getRemoteSkillEligibilityMock = createMock();

vi.mock("./run.runtime.js", () => ({
  resolveAgentConfig: resolveAgentConfigMock,
  resolveAgentDir: vi.fn().mockReturnValue("/tmp/agent-dir"),
  resolveAgentModelFallbacksOverride: resolveAgentModelFallbacksOverrideMock,
  resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/workspace"),
  resolveDefaultAgentId: vi.fn().mockReturnValue("default"),
  resolveAgentSkillsFilter: resolveAgentSkillsFilterMock,
  resolveSessionAuthProfileOverride: resolveSessionAuthProfileOverrideMock,
  lookupContextTokens: lookupContextTokensMock,
  resolveCronStyleNow: resolveCronStyleNowMock,
  DEFAULT_CONTEXT_TOKENS: 128000,
  DEFAULT_MODEL: "gpt-4",
  DEFAULT_PROVIDER: "openai",
  loadModelCatalog: loadModelCatalogMock,
  getModelRefStatus: getModelRefStatusMock,
  normalizeModelSelection: normalizeModelSelectionForTest,
  resolveAllowedModelRef: resolveAllowedModelRefMock,
  resolveConfiguredModelRef: resolveConfiguredModelRefMock,
  resolveHooksGmailModel: resolveHooksGmailModelMock,
  resolveThinkingDefault: resolveThinkingDefaultMock,
  buildWorkspaceSkillSnapshot: buildWorkspaceSkillSnapshotMock,
  getSkillsSnapshotVersion: getSkillsSnapshotVersionMock,
  resolveAgentTimeoutMs: resolveAgentTimeoutMsMock,
  deriveSessionTotalTokens: deriveSessionTotalTokensMock,
  hasNonzeroUsage: hasNonzeroUsageMock,
  DEFAULT_IDENTITY_FILENAME: "IDENTITY.md",
  ensureAgentWorkspace: ensureAgentWorkspaceMock,
  normalizeThinkLevel: normalizeThinkLevelMock,
  supportsXHighThinking: supportsXHighThinkingMock,
  setSessionRuntimeModel: setSessionRuntimeModelMock,
  setCliSessionId: vi.fn(),
  logWarn: (...args: unknown[]) => logWarnMock(...args),
  normalizeAgentId: vi.fn((id: string) => id),
  buildSafeExternalPrompt: buildSafeExternalPromptMock,
  detectSuspiciousPatterns: detectSuspiciousPatternsMock,
  mapHookExternalContentSource: mapHookExternalContentSourceMock,
  isExternalHookSession: isExternalHookSessionMock,
  resolveHookExternalContentSource: resolveHookExternalContentSourceMock,
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
}));

vi.mock("./run-execution.runtime.js", () => ({
  resolveEffectiveModelFallbacks: resolveEffectiveModelFallbacksMock,
  resolveBootstrapWarningSignaturesSeen: resolveBootstrapWarningSignaturesSeenMock,
  resolveFastModeState: resolveFastModeStateMock,
  resolveNestedAgentLane: resolveNestedAgentLaneMock,
  LiveSessionModelSwitchError,
  runWithModelFallback: runWithModelFallbackMock,
  runEmbeddedPiAgent: runEmbeddedPiAgentMock,
  countActiveDescendantRuns: countActiveDescendantRunsMock,
  listDescendantRunsForRequester: listDescendantRunsForRequesterMock,
  normalizeVerboseLevel: normalizeVerboseLevelMock,
  resolveSessionTranscriptPath: resolveSessionTranscriptPathMock,
  registerAgentRunContext: registerAgentRunContextMock,
  logWarn: (...args: unknown[]) => logWarnMock(...args),
}));

vi.mock("../../config/sessions/store.runtime.js", () => ({
  updateSessionStore: updateSessionStoreMock,
}));

vi.mock("../delivery-plan.js", () => ({
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

function resetRunConfigMocks(): void {
  buildWorkspaceSkillSnapshotMock.mockReturnValue({
    prompt: "<available_skills></available_skills>",
    resolvedSkills: [],
    version: 42,
  });
  resolveAgentConfigMock.mockReturnValue(undefined);
  resolveEffectiveModelFallbacksMock.mockReset();
  resolveEffectiveModelFallbacksMock.mockImplementation(
    ({ cfg, agentId, hasSessionModelOverride }) => {
      const agentFallbacksOverride = resolveAgentModelFallbacksOverrideMock(cfg, agentId) as
        | string[]
        | undefined;
      if (!hasSessionModelOverride) {
        return agentFallbacksOverride;
      }
      const defaultFallbacks = resolveAgentModelFallbackValues(cfg?.agents?.defaults?.model);
      return agentFallbacksOverride ?? defaultFallbacks;
    },
  );
  resolveAgentModelFallbacksOverrideMock.mockReturnValue(undefined);
  resolveAgentSkillsFilterMock.mockReturnValue(undefined);
  resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-4" });
  resolveAllowedModelRefMock.mockReturnValue({ ref: { provider: "openai", model: "gpt-4" } });
  resolveHooksGmailModelMock.mockReturnValue(null);
  resolveThinkingDefaultMock.mockReturnValue("off");
  getModelRefStatusMock.mockReturnValue({ allowed: false });
  resolveCronStyleNowMock.mockReturnValue({
    formattedTime: "2026-02-10 12:00",
    timeLine: "Current time: 2026-02-10 12:00 UTC",
  });
  resolveAgentTimeoutMsMock.mockReturnValue(60_000);
  deriveSessionTotalTokensMock.mockReturnValue(30);
  hasNonzeroUsageMock.mockReturnValue(true);
  ensureAgentWorkspaceMock.mockResolvedValue({ dir: "/tmp/workspace" });
  normalizeThinkLevelMock.mockImplementation((value: unknown) => value);
  supportsXHighThinkingMock.mockReturnValue(false);
  buildSafeExternalPromptMock.mockImplementation(
    ({ message }: { message?: string }) => message ?? "",
  );
  detectSuspiciousPatternsMock.mockReturnValue([]);
  mapHookExternalContentSourceMock.mockReturnValue("unknown");
  isExternalHookSessionMock.mockReturnValue(false);
  resolveHookExternalContentSourceMock.mockReturnValue(undefined);
  getSkillsSnapshotVersionMock.mockReturnValue(42);
  loadModelCatalogMock.mockResolvedValue({ models: [] });
  getRemoteSkillEligibilityMock.mockResolvedValue({ remoteSkillsEnabled: false });
}

function resetRunExecutionMocks(): void {
  resolveBootstrapWarningSignaturesSeenMock.mockReturnValue(new Set());
  resolveFastModeStateMock.mockImplementation((params) => resolveFastModeStateImpl(params));
  resolveNestedAgentLaneMock.mockReturnValue(undefined);
  normalizeVerboseLevelMock.mockImplementation((value: unknown) => value ?? "off");
  resolveSessionTranscriptPathMock.mockReturnValue("/tmp/transcript.jsonl");
  registerAgentRunContextMock.mockReturnValue(undefined);
  runWithModelFallbackMock.mockReset();
  runWithModelFallbackMock.mockResolvedValue(makeDefaultModelFallbackResult());
  runEmbeddedPiAgentMock.mockReset();
  runEmbeddedPiAgentMock.mockResolvedValue(makeDefaultEmbeddedResult());
  countActiveDescendantRunsMock.mockReset();
  countActiveDescendantRunsMock.mockReturnValue(0);
  listDescendantRunsForRequesterMock.mockReset();
  listDescendantRunsForRequesterMock.mockReturnValue([]);
}

function resetRunOutcomeMocks(): void {
  lookupContextTokensMock.mockReset();
  lookupContextTokensMock.mockReturnValue(undefined);
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
}

function resetRunSessionMocks(): void {
  updateSessionStoreMock.mockReset();
  updateSessionStoreMock.mockResolvedValue(undefined);
  resolveCronSessionMock.mockReset();
  resolveCronSessionMock.mockReturnValue(makeCronSession());
}

export function resetRunCronIsolatedAgentTurnHarness(): void {
  vi.clearAllMocks();
  resetRunConfigMocks();
  resetRunExecutionMocks();
  resetRunOutcomeMocks();
  resetRunSessionMocks();
  setSessionRuntimeModelMock.mockReturnValue(undefined);
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
