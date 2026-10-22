// Shared mocks and fixtures for agent-runner execution tests.
import path from "node:path";
import { afterEach, beforeEach, expect, onTestFinished, vi } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { FailoverError, type FallbackAttemptRecord } from "../../agents/failover-error.js";
import { AUTH_INVALID_TOKEN_USER_TEXT } from "../../agents/failover/user-copy.js";
import { model as createModelFixture } from "../../agents/model-catalog-fixtures.test-support.js";
import {
  initialModelFallbackAttemptOptions,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { getRawExecuteAgentTurnForTest } from "./agent-runner-execution-admission.test-support.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import type {
  buildEmbeddedRunExecutionParams,
  mintReplyMessageActionTurnCapability,
} from "./agent-runner-utils.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";
import type { FollowupRun } from "./queue.js";
import type { TypingSignaler } from "./typing-mode.js";

type RunEntryParams = Parameters<typeof runEmbeddedAgentEntry<EmbeddedAgentRunResult>>[0];
type RunEntryResult = Awaited<ReturnType<typeof runEmbeddedAgentEntry<EmbeddedAgentRunResult>>>;
type RunEntryDelegate = (params: RunEntryParams) => Promise<RunEntryResult>;
type RunCliAgent = typeof import("../../agents/cli-runner.js").runCliAgent;

export { getRawExecuteAgentTurnForTest } from "./agent-runner-execution-admission.test-support.js";

export const PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE = `⚠️ ${AUTH_INVALID_TOKEN_USER_TEXT}`;
export { createMockReplyOperation } from "./test-helpers.js";
export const PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE =
  "⚠️ The AI service can't accept more requests right now. Wait a few minutes, then try again. If it continues, check your account's usage and billing limits.";
export const PROVIDER_INTERNAL_ERROR_USER_MESSAGE =
  "⚠️ The model provider returned a temporary internal error before replying. Try again in a moment, or switch to another model if it keeps happening.";

type TestFallbackAttempt = FallbackAttemptRecord & { authMode?: string };

export function createTestFallbackSummaryError(params: {
  message: string;
  attempts: TestFallbackAttempt[];
  soonestCooldownExpiry?: number | null;
  cause?: unknown;
}): FailoverError {
  const lastAttempt = params.attempts.at(-1);
  return new FailoverError(params.message, {
    reason: lastAttempt?.reason ?? "unknown",
    provider: lastAttempt?.provider,
    model: lastAttempt?.model,
    attempts: params.attempts,
    soonestCooldownExpiry: params.soonestCooldownExpiry ?? null,
    cause: params.cause,
  });
}

const state = vi.hoisted(() => ({
  runEmbeddedAgentMock: vi.fn(),
  runEmbeddedAgentEntryMock: vi.fn(),
  runCliAgentMock: vi.fn(),
  runWithModelFallbackMock: vi.fn(),
  isCliProviderMock: vi.fn((_provider: unknown) => false),
  isInternalMessageChannelMock: vi.fn((_channel: unknown) => false),
  createBlockReplyDeliveryHandlerMock: vi.fn(),
  isCompactionFailureErrorMock: vi.fn((_message: string | undefined) => false),
  isContextOverflowErrorMock: vi.fn((_message: string | undefined) => false),
  isLikelyContextOverflowErrorMock: vi.fn((_message: string | undefined) => false),
  updateSessionStoreMock: vi.fn(),
  resolveCurrentTurnImagesMock: vi.fn(),
  peekSessionMcpRuntimeMock: vi.fn(),
  recordMessageToolRunOutcomeMock: vi.fn(),
  mintReplyMessageActionTurnCapabilityMock: vi.fn<typeof mintReplyMessageActionTurnCapability>(),
}));
const productionBuilder = vi.hoisted(() => ({
  current: undefined as typeof buildEmbeddedRunExecutionParams | undefined,
}));

export const GENERIC_RUN_FAILURE_TEXT =
  "⚠️ OpenClaw couldn't finish this request. Check the conversation before trying again. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow`.";
export function makeTestModel(id: string, contextTokens: number) {
  return createModelFixture(id, id, {
    contextWindow: contextTokens,
    contextTokens,
    maxTokens: 4096,
  });
}

vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: (params: unknown) => state.runEmbeddedAgentMock(params),
}));

vi.mock("../../agents/embedded-agent-runner/run-entry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../agents/embedded-agent-runner/run-entry.js")>();
  return {
    ...actual,
    runEmbeddedAgentEntry: (params: RunEntryParams) =>
      state.runEmbeddedAgentEntryMock(params, actual.runEmbeddedAgentEntry as RunEntryDelegate),
  };
});

vi.mock("../../agents/agent-bundle-mcp-manager-api.js", () => ({
  peekSessionMcpRuntime: (params: unknown) => state.peekSessionMcpRuntimeMock(params),
}));
vi.mock("../../agents/agent-bundle-mcp-manager-cleanup.js", () => ({
  completeDeferredSessionMcpRuntimeRetirement: async () => false,
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (params: unknown) => state.runCliAgentMock(params),
}));

// mock-isolation: Supply controlled fallback outcomes without invoking provider or auth runtimes.
vi.mock("../../agents/model-fallback-runner.js", () => ({
  runWithModelFallback: async (params: unknown) => {
    const wrap = (candidate: unknown) =>
      candidate && typeof candidate === "object" && "result" in candidate
        ? candidate
        : { result: candidate };
    const input = params as {
      classifyResult?: (classification: { result: unknown; [key: string]: unknown }) => unknown;
      [key: string]: unknown;
    };
    const adapted = input.classifyResult
      ? {
          ...input,
          classifyResult: (classification: { result: unknown; [key: string]: unknown }) =>
            input.classifyResult?.({ ...classification, result: wrap(classification.result) }),
        }
      : input;
    const resolved = (await state.runWithModelFallbackMock(adapted)) as {
      outcome?: "completed" | "exhausted";
      result?: unknown;
      [key: string]: unknown;
    };
    return {
      ...resolved,
      outcome: resolved.outcome ?? "completed",
      result: wrap(resolved?.result),
    };
  },
}));

vi.mock("../../agents/model-fallback-attempt.js", () => ({
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("../../agents/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/model-selection.js")>()),
  isCliProvider: (provider: unknown) => state.isCliProviderMock(provider),
}));

vi.mock("../../agents/bootstrap-budget.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/bootstrap-budget.js")>()),
  resolveBootstrapWarningSignaturesSeen: () => [],
}));

vi.mock(
  "../../agents/embedded-agent-helpers/context-overflow-observation.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../agents/embedded-agent-helpers/context-overflow-observation.js")
    >()),
    isCompactionFailureError: (message?: string) => state.isCompactionFailureErrorMock(message),
  }),
);

vi.mock("../../agents/failover/context-overflow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/failover/context-overflow.js")>()),
  isContextOverflowError: (message?: string) => state.isContextOverflowErrorMock(message),
  isLikelyContextOverflowError: (message?: string) =>
    state.isLikelyContextOverflowErrorMock(message),
}));

vi.mock("../../config/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions.js")>()),
  resolveGroupSessionKey: vi.fn(() => null),
  resolveSessionStorePathCore: vi.fn(() => "/tmp/mock-sessions.json"),
  resolveSessionTranscriptPath: vi.fn(),
  updateSessionStore: state.updateSessionStoreMock,
}));

vi.mock("../../globals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../globals.js")>()),
  logVerbose: vi.fn(),
}));

vi.mock("../../infra/agent-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/agent-events.js")>();
  const emitAgentEvent = vi.fn((...args: Parameters<typeof actual.emitAgentEvent>) =>
    actual.emitAgentEvent(...args),
  );
  return {
    ...actual,
    clearAgentRunContext: vi.fn(),
    emitAgentEvent,
    registerAgentRunContext: vi.fn(),
  };
});
vi.mock("../../infra/agent-run-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/agent-run-registry.js")>()),
  clearAgentRunContext: vi.fn(),
  registerAgentRunContext: vi.fn(),
}));

vi.mock("../../infra/message-tool-run-outcome-store.js", () => ({
  recordMessageToolRunOutcome: (params: unknown) => state.recordMessageToolRunOutcomeMock(params),
}));

vi.mock("../../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runtime.js")>();
  return {
    ...actual,
    defaultRuntime: {
      ...actual.defaultRuntime,
      error: vi.fn(),
      log: vi.fn(),
    },
  };
});

vi.mock("../../utils/message-channel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/message-channel.js")>()),
  isMarkdownCapableMessageChannel: () => true,
  resolveMessageChannel: () => "whatsapp",
  isInternalMessageChannel: (value: unknown) => state.isInternalMessageChannelMock(value),
}));

vi.mock("../heartbeat.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../heartbeat.js")>()),
  stripHeartbeatToken: (text: string) => ({ text, didStrip: false, shouldSkip: false }),
}));

vi.mock("./current-turn-images.js", () => ({
  resolveCurrentTurnImages: (params: unknown) => state.resolveCurrentTurnImagesMock(params),
}));

vi.mock("./agent-runner-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-utils.js")>()),
  mintReplyMessageActionTurnCapability: state.mintReplyMessageActionTurnCapabilityMock,
  buildEmbeddedRunExecutionParams: (
    params: Parameters<typeof buildEmbeddedRunExecutionParams>[0],
  ) =>
    // Most execution tests isolate fallback policy from config/channel discovery. Ownership
    // regressions opt into the production builder so queue metadata must cross the real boundary.
    productionBuilder.current
      ? productionBuilder.current(params)
      : {
          ...params.run,
          messageProvider: params.replyRoute?.originatingChannel,
          messageTo: params.replyRoute?.originatingTo,
          agentAccountId:
            params.replyRoute?.originatingAccountId ??
            params.sessionCtx.AccountId ??
            params.run.agentAccountId,
          chatType:
            params.replyRoute?.originatingChatType ??
            params.sessionCtx.ChatType ??
            params.run.chatType,
          runId: params.runId,
          provider: params.provider,
          model: params.model,
          thinkLevel: params.run.thinkLevel,
          authProfileId:
            params.provider === params.run.provider ? params.run.authProfileId : undefined,
          authProfileIdSource:
            params.provider === params.run.provider ? params.run.authProfileIdSource : undefined,
        },
  resolveQueuedReplyRuntimeConfig: <T>(config: T) => config,
  resolveModelFallbackOptions: vi.fn(
    (run: { provider?: string; model?: string; config?: unknown; agentDir?: string }) => ({
      provider: run.provider,
      model: run.model,
      cfg: run.config,
      agentDir: run.agentDir,
    }),
  ),
  resolveRunFastModeForFallbackCandidate: (params: {
    run: { fastMode?: unknown; fastModeAutoOnSeconds?: unknown };
  }) => ({
    fastMode: params.run.fastMode,
    fastModeAutoOnSeconds: params.run.fastModeAutoOnSeconds,
  }),
}));

vi.mock("./reply-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply-delivery.js")>()),
  createBlockReplyDeliveryHandler: (params: unknown) =>
    state.createBlockReplyDeliveryHandlerMock(params),
}));

vi.mock("./reply-media-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply-media-paths.js")>()),
  createReplyMediaContext: () => ({ normalizePayload: (payload: unknown) => payload }),
  createReplyMediaPathNormalizer: () => (payload: unknown) => payload,
}));

export async function getExecuteAgentTurnForTest() {
  const execute = await getRawExecuteAgentTurnForTest();
  return async (...args: Parameters<typeof execute>) => {
    const execution = await execute(...args);
    const outcome = execution.outcome;
    if (outcome.kind === "settled") {
      return {
        kind: "success" as const,
        runId: execution.runId,
        runResult: outcome.result,
        fallbackProvider: outcome.resolved.provider,
        fallbackModel: outcome.resolved.model,
        ...(outcome.fallback.exhausted ? { fallbackExhausted: true as const } : {}),
        fallbackAttempts: outcome.fallback.attempts,
        autoCompactionCount: outcome.autoCompactionCount,
        hasDirectlySentBlockReply: outcome.hasDirectlySentBlockReply,
        directBlockDeliveries: outcome.directBlockDeliveries,
        terminalFailurePayload: outcome.terminalFailurePayload,
        postCompactionModelFailure: outcome.postCompactionModelFailure,
      };
    }
    if (outcome.kind === "rejected") {
      return {
        kind: "final" as const,
        payload: outcome.payload,
        postCompactionModelFailure: outcome.postCompactionModelFailure,
      };
    }
    const payload: ReplyPayload = {};
    return { kind: "final" as const, payload };
  };
}

export async function useProductionEmbeddedRunExecutionParamsForTest(): Promise<void> {
  const actual =
    await vi.importActual<typeof import("./agent-runner-utils.js")>("./agent-runner-utils.js");
  productionBuilder.current = actual.buildEmbeddedRunExecutionParams;
}

export async function loadActualRunCliAgentForTest(): Promise<RunCliAgent> {
  return (
    await vi.importActual<typeof import("../../agents/cli-runner.js")>("../../agents/cli-runner.js")
  ).runCliAgent;
}

export type FallbackRunnerParams = TestModelFallbackRunnerParams & {
  sessionId?: string;
  abortSignal?: AbortSignal;
  classifyResult?: (params: {
    result: { payloads?: Array<{ text?: string; isError?: boolean; isReasoning?: boolean }> };
    provider: string;
    model: string;
    attempt: number;
    total: number;
  }) => Promise<unknown>;
};

export {
  fallbackModelAttemptOptions as fallbackAttemptOptions,
  initialModelFallbackAttemptOptions as initialFallbackAttemptOptions,
  runInitialModelFallbackAttempt as runInitialFallbackAttempt,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";

export type EmbeddedAgentParams = Pick<
  RunEmbeddedAgentInternalParams,
  | "currentInboundContext"
  | "onDeferredLifecycleOwner"
  | "onCompactionAccounting"
  | "onExecutionStarted"
  | "onExecutionPhase"
  | "onLaneWait"
  | "onAssistantMessageStart"
  | "onAutoCompactionSucceeded"
  | "onReasoningStream"
  | "onReasoningEnd"
  | "onAgentEvent"
> & {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  prompt?: string;
  transcriptPrompt?: string;
  lifecycleGeneration?: string;
  onBlockReply?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  onItemEvent?: (
    payload: Parameters<NonNullable<GetReplyOptions["onItemEvent"]>>[0],
  ) => Promise<void> | void;
};

export function createMockTypingSignaler(): TypingSignaler {
  return {
    mode: "message",
    shouldStartImmediately: false,
    shouldStartOnMessageStart: true,
    shouldStartOnText: true,
    shouldStartOnReasoning: false,
    signalRunStart: vi.fn(async () => {}),
    signalMessageStart: vi.fn(async () => {}),
    signalTextDelta: vi.fn(async () => {}),
    signalReasoningDelta: vi.fn(async () => {}),
    signalToolStart: vi.fn(async () => {}),
    signalExecutionActivity: vi.fn(async () => {}),
  };
}

export function createFollowupRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun {
  const followup = createTestFollowupRun({
    // Missing fixture modalities trigger real provider catalog discovery during execution.
    thinkingCatalog: [
      { provider: "anthropic", id: "claude", input: ["text"] },
      { provider: "anthropic", id: "claude-opus-4-7", input: ["text", "image"] },
      { provider: "claude-cli", id: "sonnet-4.6", input: ["text", "image"] },
      { provider: "claude-cli", id: "claude-sonnet-4-6", input: ["text", "image"] },
      { provider: "claude-cli", id: "claude-opus-4-6", input: ["text", "image"] },
      { provider: "claude-cli", id: "claude-opus-4-7", input: ["text", "image"] },
      { provider: "claude-cli", id: "claude-opus-5", input: ["text", "image"] },
      { provider: "claude-cli", id: "claude-opus-4-8", input: ["text", "image"] },
      { provider: "codex-cli", id: "gpt-5.4", input: ["text", "image"] },
      { provider: "codex-cli", id: "gpt-5.5", input: ["text", "image"] },
    ],
  });
  // Execution fixtures exercise runtime hints and select thinking themselves.
  delete followup.run.thinkLevel;
  delete followup.run.skipProviderRuntimeHints;
  Object.assign(followup.run, overrides);
  return followup;
}

export function createRunResult(
  text = "final",
  meta: EmbeddedAgentRunResult["meta"] = { durationMs: 0 },
) {
  return { payloads: [{ text }], meta };
}

export async function runFallbackCandidate(
  params: FallbackRunnerParams,
  provider = params.provider,
  model = params.model,
  options = initialModelFallbackAttemptOptions(params),
) {
  return { result: await params.run(provider, model, options), provider, model, attempts: [] };
}

export function createCliFollowupRun(provider: string, model: string): FollowupRun {
  state.isCliProviderMock.mockReturnValue(true);
  state.runWithModelFallbackMock.mockImplementationOnce((params: FallbackRunnerParams) =>
    runFallbackCandidate(params, provider, model),
  );
  return createFollowupRun({ provider, model });
}

export const requireRecord = createRequireRecord("object", "label-not-object");

export function expectRecordFields(
  record: Record<string, unknown>,
  fields: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

export function requireMockCall(mock: unknown, index: number, label: string): unknown[] {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.[index];
  if (!call) {
    throw new Error(`missing ${label} call ${index + 1}`);
  }
  return call;
}

export function expectMockCallArgFields(
  mock: unknown,
  index: number,
  label: string,
  fields: Record<string, unknown>,
) {
  expectRecordFields(requireRecord(requireMockCall(mock, index, label)[0], label), fields);
}

export function expectNoMockCallWithFields(mock: unknown, fields: Record<string, unknown>) {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls ?? [];
  const hasMatchingCall = calls.some((call) => {
    const value = call[0];
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return Object.entries(fields).every(([key, expected]) => record[key] === expected);
  });
  expect(hasMatchingCall).toBe(false);
}

export function expectBlockReplyCall(
  onBlockReply: unknown,
  index: number,
  fields: Record<string, unknown>,
) {
  expectMockCallArgFields(onBlockReply, index, "block reply payload", fields);
}

/**
 * Session-store paths reach production resolution, which derives a real agent
 * SQLite file from the store's directory. A shared /tmp path would therefore
 * open the machine-wide agent database and make unrelated suites depend on it.
 */
export function makeTestSessionStorePath(): string {
  return path.join(
    useAutoCleanupTempDirTracker(onTestFinished).make("openclaw-agent-execution-store-"),
    "sessions.json",
  );
}

export function createAgentTurnExecutionDefaults() {
  return {
    blockReplyPipeline: null,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    applyReplyToMode: (payload) => payload,
    shouldEmitToolResult: () => true,
    shouldEmitToolOutput: () => false,
    pendingToolTasks: new Set<Promise<void>>(),

    sessionKey: "main",
    getActiveSessionEntry: () => undefined,
    resolvedVerboseLevel: "off",
  } satisfies Partial<AgentTurnParams>;
}

export function createRunAgentTurnParams(followupRun: FollowupRun): AgentTurnParams {
  return {
    ...createMinimalRunAgentTurnParams({ followupRun }),
    commandBody: "hello",
  };
}

export function createMinimalRunAgentTurnParams(
  overrides?: Partial<
    Pick<
      AgentTurnParams,
      "followupRun" | "opts" | "replyOperation" | "sessionCtx" | "typingSignals"
    >
  >,
): AgentTurnParams {
  return {
    commandBody: "fix it",
    followupRun: overrides?.followupRun ?? createFollowupRun(),
    sessionCtx: overrides?.sessionCtx ?? { Provider: "whatsapp", MessageSid: "msg" },
    opts: overrides?.opts ?? ({} satisfies GetReplyOptions),
    replyOperation: overrides?.replyOperation,
    typingSignals: overrides?.typingSignals ?? createMockTypingSignaler(),
    ...createAgentTurnExecutionDefaults(),
  };
}

export const NON_DIRECT_FAILURE_SURFACE_CASES = [
  { label: "Discord group", provider: "discord", chatType: "group" },
  { label: "Discord channel", provider: "discord", chatType: "channel" },
  { label: "Slack channel", provider: "slack", chatType: "channel" },
  { label: "Telegram group", provider: "telegram", chatType: "group" },
  { label: "WhatsApp group", provider: "whatsapp", chatType: "group" },
  { label: "Microsoft Teams channel", provider: "msteams", chatType: "channel" },
] as const;

export function createNonDirectFailureSessionCtx(
  testCase: (typeof NON_DIRECT_FAILURE_SURFACE_CASES)[number],
): TemplateContext {
  return {
    Provider: testCase.provider,
    Surface: testCase.provider,
    ChatType: testCase.chatType,
    GroupSubject: `${testCase.label} fixture`,
    GroupChannel: "#general",
    MessageSid: "msg",
  } as unknown as TemplateContext;
}

export async function setupAgentRunnerExecutionTestState() {
  // Each suite awaits collection readiness after its imported mock harnesses register.
  // Hook timeouts cannot cancel imports; cleanup must not overtake module readiness.
  await getExecuteAgentTurnForTest();

  beforeEach(() => {
    vi.useRealTimers();
    for (const mock of Object.values(state)) {
      mock.mockReset();
    }
    state.runEmbeddedAgentEntryMock.mockImplementation(
      (params: RunEntryParams, delegate: RunEntryDelegate) => delegate(params),
    );
    state.isCliProviderMock.mockReturnValue(false);
    state.isInternalMessageChannelMock.mockReturnValue(false);
    state.createBlockReplyDeliveryHandlerMock.mockReturnValue(undefined);
    state.isCompactionFailureErrorMock.mockReturnValue(false);
    state.isContextOverflowErrorMock.mockReturnValue(false);
    state.isLikelyContextOverflowErrorMock.mockReturnValue(false);
    state.peekSessionMcpRuntimeMock.mockReturnValue(undefined);
    productionBuilder.current = undefined;
    state.resolveCurrentTurnImagesMock.mockImplementation(
      async (params: { images?: unknown[]; imageOrder?: unknown[] }) => ({
        images: params.images,
        imageOrder: params.imageOrder,
      }),
    );
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => ({
      result: await params.run("anthropic", "claude", initialModelFallbackAttemptOptions(params)),
      provider: "anthropic",
      model: "claude",
      attempts: [],
    }));
  });

  afterEach(() => {
    // Fake-timer tests must not leak into --isolate=false peers.
    vi.useRealTimers();
    cliBackendsTesting.resetDepsForTest();
    clearRuntimeConfigSnapshot();
    vi.clearAllMocks();
  });

  return state;
}
