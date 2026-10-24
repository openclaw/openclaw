import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
  sqliteMethods,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { sanitizeAgentRunTerminalReply } from "../../agents/agent-run-terminal-reply.js";
import { buildEmbeddedRunPayloads } from "../../agents/embedded-agent-runner/run/payloads.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../../agents/failover/user-copy.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig, TypingMode } from "../../config/types.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import {
  buildHandledBeforeAgentReplyPayloads,
  runBeforeAgentReplyForTurn,
} from "../../plugins/before-agent-reply.js";
import {
  createReplyOperation,
  type ReplyOperation,
  getSessionControllerOperation,
} from "../../sessions/session-controller.js";
import { captureSessionControllerSettlement } from "../../sessions/session-controller.lifecycle.js";
import { captureCurrentReplyMessageInjectionTarget } from "../../sessions/session-controller.message-injection.js";
import { clearReplyRunForResetBySessionId } from "../../sessions/session-controller.stop-runtime.js";
import { testing as controllerTesting } from "../../sessions/session-controller.test-support.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type {
  UserTurnInput,
  UserTurnTranscriptTarget,
} from "../../sessions/user-turn-transcript.types.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import type { TemplateContext } from "../templating.js";
import { createReplyAgentRestartRecoveryController } from "./agent-runner-restart-recovery.js";
import { successfulPolicyRetryCases } from "./agent-runner.policy-retry.test-fixtures.js";
import { registerReasoningFallbackTests } from "./agent-runner.reasoning-fallback.test-support.js";
import { registerReplyAdmissionCases } from "./agent-runner.runreplyagent.admission.cases.js";
import { registerReplyCompactionCases } from "./agent-runner.runreplyagent.compaction.cases.js";
import { registerImmediateFailurePolicyCases } from "./agent-runner.runreplyagent.failure-policy.cases.js";
import {
  createReplyAgentSessionFixture,
  runSuccessfulReplyModelFixture,
} from "./agent-runner.runreplyagent.fixture.test-support.js";
import { registerFollowupDrainCases } from "./agent-runner.runreplyagent.followup-drain.cases.js";
import { createReplyQueueFixture } from "./agent-runner.runreplyagent.queue.test-support.js";
import { registerRequiredReplyCompletionCases } from "./agent-runner.runreplyagent.required-reply.cases.js";
import { registerSteeringReceiptCases } from "./agent-runner.runreplyagent.steering-receipts.cases.js";
import { registerTranscriptClaimCases } from "./agent-runner.runreplyagent.transcript-claim.cases.js";
import { registerWaitingStatusCases } from "./agent-runner.runreplyagent.waiting-status.cases.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import {
  enqueueFollowupRun,
  scheduleFollowupDrain,
  type FollowupRun,
  type QueueSettings,
} from "./queue.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { resolveReplyOperationAgentTurn } from "./reply-operation-run-state.test-support.js";
import { bindReplyOperationTyping } from "./reply-run-typing.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { consumeReplyUsageState } from "./reply-usage-state.js";
import { createReplyRecoveryActorFixture } from "./restart-recovery-claim.test-support.js";
import { buildChannelSourceTurnId, setChannelSourceTurnId } from "./source-turn-id.js";
import { createMockTypingController } from "./test-helpers.js";

type AgentRunParams = {
  onPartialReply?: (payload: { text?: string }) => Promise<boolean | void> | boolean | void;
  onBlockReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
    isReasoning?: boolean;
    isCommentary?: boolean;
  }) => Promise<void> | void;
  onBlockReplyFlush?: () => Promise<void>;
  onToolResult?: (payload: ReplyPayload) => Promise<void> | void;
  shouldEmitToolResult?: () => boolean;
  shouldEmitToolOutput?: () => boolean;
};

const state = vi.hoisted(() => ({
  beforeAgentReplyHasHooksMock: vi.fn(),
  beforeAgentReplyRunMock: vi.fn(),
  compactEmbeddedAgentSessionMock: vi.fn(),
  getChannelPluginMock: vi.fn(),
  backendQueueMessageMock: vi.fn(),
  activeBackendCancelMock: vi.fn(),
  runEmbeddedAgentMock: vi.fn(),
}));
const parkedSteer = createReplyQueueFixture();
const { requireScheduledFollowupRunner } = parkedSteer;

const { tempDirs, sessionKeys, createSessionStoreFile } = createReplyAgentSessionFixture();
afterEach(async () => await parkedSteer.settle());

const requireRecord = createRequireRecord("record", "expected-label-object");

function mockCallArgs(mock: ReturnType<typeof vi.fn>, label: string, callIndex = 0): unknown[] {
  return expectDefined(mock.mock.calls[callIndex], `${label} mock call ${callIndex}`);
}

function requireStoredSessionEntry(storePath: string, sessionKey = "main"): SessionEntry {
  return expectDefined(
    loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" }),
    `stored session entry for ${sessionKey}`,
  );
}

function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeOperation(overrides: Partial<Parameters<typeof createReplyOperation>[0]> = {}) {
  return createReplyOperation({
    sessionKey: "main",
    sessionId: "session",
    resetTriggered: false,
    ...overrides,
  });
}

function makeRunningOperation(overrides?: Parameters<typeof makeOperation>[0]) {
  const operation = makeOperation(overrides);
  operation.setPhase("running");
  return operation;
}

function modelReply(text = "final") {
  return {
    payloads: [{ text }],
    meta: { agentMeta: { usage: { input: 1, output: 1 } } },
  };
}

async function makeSessionFixture<SessionKey extends string = "main">(
  overrides: Partial<SessionEntry> = {},
  sessionKey: SessionKey = "main" as SessionKey,
): Promise<{
  sessionEntry: SessionEntry;
  sessionStore: Record<SessionKey, SessionEntry>;
  storePath: string;
}> {
  const sessionEntry = makeSessionEntry(overrides);
  const sessionStore = { [sessionKey]: sessionEntry } as Record<SessionKey, SessionEntry>;
  const storePath = await createSessionStoreFile(sessionEntry, sessionKey);
  return { sessionEntry, sessionStore, storePath };
}

async function readStoredMainSession(storePath: string): Promise<SessionEntry> {
  return requireStoredSessionEntry(storePath);
}

let modelFallbackModule: typeof import("../../agents/model-fallback-runner.js");
let onAgentEvent: typeof import("../../infra/agent-events.js").onAgentEvent;

function makeCompletedFallbackRunner(
  overrides: {
    provider?: string;
    model?: string;
    attempts?: Awaited<
      ReturnType<typeof modelFallbackModule.runWithModelFallback<unknown>>
    >["attempts"];
  } = {},
) {
  const provider = overrides.provider ?? "openai";
  const model = overrides.model ?? "gpt-5.5";
  const attempts = overrides.attempts ?? [
    {
      provider: "lmstudio",
      model: "gemma-4-e4b-it",
      error: "Connection error.",
      reason: "timeout",
    },
  ];
  return async <T>(params: TestModelFallbackRunnerParams<T>) => ({
    outcome: "completed" as const,
    result: await runFallbackModelAttempt(
      params,
      provider,
      model,
      attempts.at(-1)?.reason ?? "unknown",
    ),
    provider,
    model,
    attempts,
  });
}

let runReplyAgentPromise:
  | Promise<(typeof import("./agent-runner-run.js"))["runReplyAgent"]>
  | undefined;

async function getRunReplyAgent() {
  if (!runReplyAgentPromise) {
    runReplyAgentPromise = import("./agent-runner-run.js").then((m) => m.runReplyAgent);
  }
  return await runReplyAgentPromise;
}

vi.mock("../../agents/model-fallback-runner.js", () => ({
  runWithModelFallback: async (params: TestModelFallbackRunnerParams) => ({
    outcome: "completed" as const,
    result: await runInitialModelFallbackAttempt(params),
    provider: params.provider,
    model: params.model,
    attempts: [],
  }),
}));

vi.mock("../../agents/model-fallback-attempt.js", () => ({
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("../../agents/runtime-plan/build.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/runtime-plan/build.js")>()),
  buildAgentRuntimeDeliveryPlan: () => ({
    resolveFollowupRoute: () => undefined,
  }),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: state.beforeAgentReplyHasHooksMock,
    runBeforeAgentReply: state.beforeAgentReplyRunMock,
  }),
}));

vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: (params: unknown) => state.compactEmbeddedAgentSessionMock(params),
  runEmbeddedAgent: (params: unknown) => state.runEmbeddedAgentMock(params),
}));

vi.mock("../../channels/plugins/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/index.js")>()),
  getChannelPlugin: (channel: unknown) => state.getChannelPluginMock(channel),
}));

vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  enqueueFollowupRun: vi.fn(),
  reserveSteerCandidate: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
}));

beforeAll(async () => {
  modelFallbackModule = await import("../../agents/model-fallback-runner.js");
  ({ onAgentEvent } = await import("../../infra/agent-events.js"));
  await getRunReplyAgent();
});

beforeEach(() => {
  clearSessionQueues(["main"]);
  controllerTesting.resetSessionControllerForTest();
  state.compactEmbeddedAgentSessionMock.mockReset();
  state.compactEmbeddedAgentSessionMock.mockResolvedValue({
    ok: true,
    compacted: false,
    reason: "test-default",
  });
  state.runEmbeddedAgentMock.mockReset();
  state.runEmbeddedAgentMock.mockResolvedValue(modelReply());
  state.backendQueueMessageMock.mockReset();
  state.activeBackendCancelMock.mockReset();
  state.beforeAgentReplyHasHooksMock.mockReset().mockReturnValue(false);
  state.beforeAgentReplyRunMock.mockReset();
  state.backendQueueMessageMock.mockReturnValue(false);
  state.getChannelPluginMock.mockReset();
  parkedSteer.reset();
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
});

function createMinimalRun(params?: {
  opts?: InternalGetReplyOptions;
  resolvedVerboseLevel?: "off" | "on";
  sessionStore?: Record<string, SessionEntry>;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
  typingMode?: TypingMode;
  blockStreamingEnabled?: boolean;
  isActive?: boolean;
  isRunActive?: () => boolean;
  shouldSteer?: boolean;
  shouldFollowup?: boolean;
  resolvedQueueMode?: string;
  replyOperation?: ReplyOperation;
  currentInboundEventKind?: FollowupRun["currentInboundEventKind"];
  sessionCtx?: Partial<TemplateContext>;
  sourceTurnId?: string;
  runOverrides?: Partial<FollowupRun["run"]>;
  bindActiveAuthority?: boolean;
  attachSteerBackend?: boolean;
  activeBackendRunId?: string;
  runtimePolicySessionKey?: string;
}) {
  const typing = createMockTypingController();
  const opts = params?.opts;
  const sessionCtx = {
    Provider: "whatsapp",
    SenderId: "sender-42",
    MessageSid: "msg",
    ...params?.sessionCtx,
  } as unknown as TemplateContext;
  const sourceTurnId =
    params?.sourceTurnId ??
    buildChannelSourceTurnId({
      provider: sessionCtx.Provider,
      accountId: sessionCtx.AccountId,
      conversationId: sessionCtx.OriginatingTo,
      messageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
    });
  setChannelSourceTurnId(sessionCtx, sourceTurnId);
  const resolvedQueue = {
    mode: params?.resolvedQueueMode ?? "interrupt",
    debounceMs: 0,
  } as unknown as QueueSettings;
  const sessionKey = params?.sessionKey ?? "main";
  const config = params?.runOverrides?.config ?? {};

  const followupRun = {
    prompt: "hello",
    sourceTurnId,
    abortSignal: opts?.abortSignal,
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    turnAdoptionLifecycle: opts?.turnAdoptionLifecycle,
    currentInboundEventKind: params?.currentInboundEventKind,
    originatingChannel: sessionCtx.OriginatingChannel ?? sessionCtx.Provider,
    originatingTo: sessionCtx.OriginatingTo,
    originatingChatId: sessionCtx.NativeChannelId ?? sessionCtx.ChatId,
    run: {
      agentId: "main",
      sessionId: params?.sessionEntry?.sessionId ?? "session",
      sessionKey,
      messageProvider: "whatsapp",
      senderId: sessionCtx.SenderId,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkingCatalog: [
        { provider: "anthropic", id: "claude", input: ["text"] },
        { provider: "anthropic", id: "claude-opus-4-7", input: ["text"] },
        { provider: "openai", id: "gpt-5.5", input: ["text"] },
        { provider: "openai", id: "gpt-5.6-sol", input: ["text"] },
        { provider: "google", id: "gemini-2.5-flash", input: ["text"] },
        { provider: "deepinfra", id: "moonshotai/Kimi-K2.5", input: ["text"] },
        { provider: "lmstudio", id: "gemma-4-e4b-it", input: ["text"] },
      ],
      thinkLevel: "low",
      verboseLevel: params?.resolvedVerboseLevel ?? "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      skipProviderRuntimeHints: process.env.OPENCLAW_TEST_FAST === "1",
      ...params?.runOverrides,
      // Mailbox admission and persistence must select the same physical store.
      config: params?.storePath
        ? { ...config, session: { ...config.session, store: params.storePath } }
        : config,
    },
  } as unknown as FollowupRun;
  sessionKeys.add(sessionKey);
  parkedSteer.track(followupRun);
  const activeOperation = getSessionControllerOperation(sessionKey);
  const activeAuthority =
    activeOperation && params?.isActive && params.bindActiveAuthority !== false
      ? prepareReplyToolAuthority(followupRun)
      : undefined;

  return {
    followupRun,
    sourceTurnId,
    typing,
    opts,
    run: async () => {
      setRuntimeConfigSnapshot(followupRun.run.config);
      if (activeOperation && activeAuthority) {
        await activeOperation.bindToolAuthoritySnapshotAsync(activeAuthority);
      }
      const runReplyAgent = await getRunReplyAgent();
      const operation = getSessionControllerOperation(sessionKey);
      if (operation && params?.attachSteerBackend !== false) {
        operation.attachBackend({
          kind: "embedded",
          runId: params?.activeBackendRunId,
          cancel: state.activeBackendCancelMock,
          supportsTranscriptCommitWait: true,
          messageInjectionV2: {
            version: 2,
            isAvailable: () => true,
            claimPendingUserInputAnswer: async (prompt, options, assertCurrent) => {
              assertCurrent();
              const result = (await state.backendQueueMessageMock(
                operation.sessionId,
                prompt,
                options,
              )) as boolean | { queued: boolean };
              return result === true || (typeof result === "object" && result.queued);
            },
            queueMessage: async (prompt, options, assertCurrent) => {
              assertCurrent();
              const result = (await state.backendQueueMessageMock(
                operation.sessionId,
                prompt,
                options,
              )) as
                | boolean
                | {
                    queued: boolean;
                    reason?: string;
                    transcriptCommit?: "unconfirmed";
                    errorMessage?: string;
                  };
              if (result === false || (typeof result === "object" && !result.queued)) {
                throw new Error(typeof result === "object" ? result.reason : "queue rejected");
              }
              return typeof result === "object" && result.transcriptCommit === "unconfirmed"
                ? {
                    transcriptCommit: result.transcriptCommit,
                    errorMessage: result.errorMessage ?? "commit unconfirmed",
                  }
                : undefined;
            },
          },
        });
      }
      return runReplyAgent({
        commandBody: "hello",
        followupRun,
        queueKey: sessionKey,
        resolvedQueue,
        shouldSteer: params?.shouldSteer ?? false,
        shouldFollowup: params?.shouldFollowup ?? false,
        isActive: params?.isActive ?? false,
        isRunActive: params?.isRunActive,
        opts,
        typing,
        sessionEntry: params?.sessionEntry,
        sessionStore: params?.sessionStore,
        sessionKey,
        runtimePolicySessionKey: params?.runtimePolicySessionKey,
        storePath: params?.storePath,
        sessionCtx,
        defaultModel: "anthropic/claude-opus-4-6",
        resolvedVerboseLevel: params?.resolvedVerboseLevel ?? "off",
        isNewSession: false,
        blockStreamingEnabled: params?.blockStreamingEnabled ?? false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: params?.typingMode ?? "instant",
        replyOperation: params?.replyOperation,
      });
    },
  };
}

function createDiscordFallbackRun() {
  return createMinimalRun({
    runOverrides: {
      provider: "lmstudio",
      model: "gemma-4-e4b-it",
      messageProvider: "discord",
    },
    sessionCtx: {
      Provider: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:C1",
      AccountId: "primary",
      MessageSid: "1503645939964055592",
    },
  });
}

type MinimalRunOptions = NonNullable<Parameters<typeof createMinimalRun>[0]>;
type SessionFixture = Awaited<ReturnType<typeof makeSessionFixture>>;
const activeSteer = { isActive: true, shouldSteer: true, resolvedQueueMode: "steer" } as const;

function createSessionRun(
  fixture: SessionFixture,
  options: MinimalRunOptions = {},
  sourceText?: string,
) {
  const result = createMinimalRun({ ...fixture, ...options });
  if (sourceText !== undefined) {
    attachSourceTurnRecorder({ ...fixture, ...result, text: sourceText });
  }
  return result;
}

function discordContext(MessageSid: string, extra: Partial<TemplateContext> = {}) {
  return {
    Provider: "discord",
    OriginatingChannel: "discord",
    OriginatingTo: "channel:24680",
    MessageSid,
    ...extra,
  };
}

function enableReplyHook(result?: Awaited<ReturnType<typeof runBeforeAgentReplyForTurn>>) {
  state.beforeAgentReplyHasHooksMock.mockImplementation((name) => name === "before_agent_reply");
  state.beforeAgentReplyRunMock.mockResolvedValue(result);
}

function expectUnset<T>(value: T, keys: readonly (keyof T)[]) {
  for (const key of keys) {
    expect(value[key], String(key)).toBeUndefined();
  }
}

async function runHookBackedEmbeddedAgent(params: {
  agentId?: string;
  prompt: string;
  runId: string;
  sessionId: string;
  sessionKey?: string;
  trigger?: string;
  workspaceDir: string;
}) {
  const hookResult = await runBeforeAgentReplyForTurn({
    runId: params.runId,
    trigger: params.trigger,
    event: { cleanedBody: params.prompt },
    context: {
      runId: params.runId,
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      trigger: params.trigger,
      workspaceDir: params.workspaceDir,
    },
  });
  return hookResult?.handled
    ? {
        payloads: buildHandledBeforeAgentReplyPayloads(hookResult.reply),
        meta: {
          agentMeta: {},
          terminalReply: hookResult.reply
            ? sanitizeAgentRunTerminalReply(hookResult.reply.text ?? "")
            : { disposition: "silent" as const },
          providerStarted: false,
        },
      }
    : {
        payloads: [{ text: "model reply" }],
        meta: { agentMeta: {} },
      };
}

function createSourceRecorder(
  fixture: SessionFixture,
  input: UserTurnInput,
  target: Partial<UserTurnTranscriptTarget> = {},
) {
  return createUserTurnTranscriptRecorder({
    input,
    target: {
      agentId: "main",
      cwd: "/tmp",
      sessionEntry: fixture.sessionEntry,
      sessionStore: fixture.sessionStore,
      storePath: fixture.storePath,
      sessionId: fixture.sessionEntry.sessionId,
      sessionKey: "main",
      ...target,
    },
  });
}

function attachSourceTurnRecorder(params: {
  followupRun: FollowupRun;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sourceTurnId: string | undefined;
  storePath: string;
  text: string;
}): void {
  if (!params.sourceTurnId) {
    throw new Error("test source turn id required");
  }
  params.followupRun.userTurnTranscriptRecorder = createSourceRecorder(
    params,
    { text: params.text, idempotencyKey: params.sourceTurnId },
    { config: {}, sessionId: "session", sessionKey: params.followupRun.run.sessionKey ?? "main" },
  );
}

function requireBuiltChannelSourceTurnId(
  params: Parameters<typeof buildChannelSourceTurnId>[0],
): string {
  return expectDefined(buildChannelSourceTurnId(params), "test channel source turn id");
}

describe("runReplyAgent active steering", () => {
  it("keeps the replacement source when retired admission completes", async ({ signal }) => {
    const fixture = await makeSessionFixture();
    const { sessionEntry, sessionStore, storePath } = fixture;
    const sourceContext = discordContext("first-source-message");
    const { followupRun } = createMinimalRun({ sessionCtx: sourceContext });
    const first = makeRunningOperation();
    const createController = async (
      operation: ReplyOperation,
      initialEntry: SessionEntry,
      sourceTurnId: string,
    ) => {
      let entry = initialEntry;
      const actor = createReplyRecoveryActorFixture({
        agentId: "main",
        storePath,
        sessionKey: "main",
        getSessionId: () => operation.sessionId,
        operation,
      });
      await actor.bind();
      const controller = createReplyAgentRestartRecoveryController({
        activeSessionStore: sessionStore,
        cfg: {},
        followupRun: {
          ...followupRun,
          run: { ...followupRun.run, sessionId: operation.sessionId },
        },
        getActiveSessionEntry: () => entry,
        opts: undefined,
        replyOperation: operation,
        restartRecoverySourceTurnId: sourceTurnId,
        runtimePolicySessionKey: undefined,
        sessionCtx: sourceContext,
        sessionKey: "main",
        setActiveSessionEntry: (nextEntry) => {
          entry = nextEntry;
        },
        storePath,
      });
      return Object.assign(controller, {
        releaseActor: () => actor.release(),
        [Symbol.asyncDispose]: () => actor[Symbol.asyncDispose](),
      });
    };
    await using firstController = await createController(first, sessionEntry, "source-first");
    attachSourceTurnRecorder({
      followupRun,
      sessionEntry,
      sessionStore,
      sourceTurnId: "source-first",
      storePath,
      text: "first source input",
    });
    const recorder = followupRun.userTurnTranscriptRecorder;
    if (!recorder) {
      throw new Error("expected the source recorder");
    }
    const committed = createDeferred();
    const returnAdmission = createDeferred();
    const persistApproved = recorder.persistApproved.bind(recorder);
    const persistence = vi
      .spyOn(recorder, "persistApproved")
      .mockImplementation(async (...args) => {
        const result = await persistApproved(...args);
        committed.resolve();
        await returnAdmission.promise;
        return result;
      });
    const firstAdmission = firstController.admitUserTurn(recorder);
    // A retired admission may reject; its successor must keep the same source either way.
    let firstAdmissionReturned = false;
    const firstSettled = firstAdmission
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        firstAdmissionReturned = true;
      });
    let replacement: ReplyOperation | undefined;
    try {
      await withinTest(committed.promise, signal);
      expect(requireStoredSessionEntry(storePath).restartRecoveryDeliverySourceRunId).toBe(
        "source-first",
      );
      clearReplyRunForResetBySessionId("session");
      // The write has committed; only this fixture's response wrapper remains held.
      // Its manually created operation has no execution callback to release its owner.
      await withinTest(firstController.releaseActor(), signal);
      first.complete();
      const replacementEntry = makeSessionEntry({ sessionId: "replacement-session" });
      await replaceSessionEntry({ storePath, sessionKey: "main" }, replacementEntry);
      sessionStore.main = replacementEntry;
      replacement = makeRunningOperation({
        sessionId: "replacement-session",
        resetTriggered: true,
      });
      replacement.attachBackend({
        kind: "embedded",
        runId: "replacement-backend",
        cancel: vi.fn(),
        messageInjection: {
          isAvailable: () => true,
          queueMessage: async () => {},
        },
      });
      const replacementRecorder = createSourceRecorder(
        { sessionEntry: replacementEntry, sessionStore, storePath },
        { text: "replacement source input", idempotencyKey: "source-replacement" },
        { config: {} },
      );
      await using replacementController = await createController(
        replacement,
        replacementEntry,
        "source-replacement",
      );
      await replacementController.admitUserTurn(replacementRecorder);
      expect(captureCurrentReplyMessageInjectionTarget("main")).toMatchObject({
        sourceTurnId: "source-replacement",
      });

      expect(firstAdmissionReturned).toBe(false);
      returnAdmission.resolve();
      await firstSettled;

      expect(getSessionControllerOperation("main")).toBe(replacement);
      expect(captureCurrentReplyMessageInjectionTarget("main")).toMatchObject({
        sourceTurnId: "source-replacement",
      });
    } finally {
      returnAdmission.resolve();
      await firstSettled;
      persistence.mockRestore();
      first.complete();
      replacement?.complete();
    }
  });

  registerSteeringReceiptCases({
    createMinimalRun,
    makeSessionEntry,
    makeSessionFixture,
    state,
  });

  it("offers a route-only mismatch to the pending-input owner", async () => {
    state.backendQueueMessageMock.mockReturnValueOnce(true);
    const activeRoute = { provider: "openai", model: "gpt-fallback" };
    const { followupRun, run } = createMinimalRun({
      ...activeSteer,
      bindActiveAuthority: false,
    });
    const active = makeOperation();
    await active.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(followupRun));
    await active.bindToolAuthorityRouteAsync(activeRoute);
    active.setPhase("running");

    await expect(run()).resolves.toBeUndefined();

    expect(state.backendQueueMessageMock).toHaveBeenCalledWith(
      "session",
      "hello",
      expect.objectContaining({
        pendingInputAuthorityFingerprint: active.toolAuthorityFingerprint,
      }),
    );
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    active.complete();
  });

  it("drains an authority-mismatched turn after its provided operation clears", async () => {
    const provided = makeOperation({ sessionId: "provided-session" });
    const { followupRun, run } = createMinimalRun({
      ...activeSteer,
      replyOperation: provided,
      bindActiveAuthority: false,
      runOverrides: {
        thinkingCatalog: [{ provider: "anthropic", id: "claude", input: ["text", "image"] }],
      },
    });
    await provided.bindToolAuthoritySnapshotAsync({
      requesterPrincipalKey: prepareReplyToolAuthority(followupRun).requesterPrincipalKey,
      fingerprint: () => "different-authority",
      project: () => "different-authority",
    });
    provided.setPhase("running");
    const image = { type: "image" as const, data: "queued", mimeType: "image/png" };
    followupRun.images = [image];

    await expect(run()).resolves.toBeUndefined();

    expect(state.backendQueueMessageMock).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(parkedSteer.fallback).toHaveBeenCalledOnce();
    expect(parkedSteer.consume).not.toHaveBeenCalled();
    expect(vi.mocked(scheduleFollowupDrain)).not.toHaveBeenCalled();
    provided.complete();
    expect(vi.mocked(scheduleFollowupDrain)).toHaveBeenCalledOnce();
    await requireScheduledFollowupRunner()(followupRun);
    expect(mockCallArgs(state.runEmbeddedAgentMock, "queued image drain")[0]).toMatchObject({
      images: [image],
      modelHasVision: true,
    });
  });

  it("keeps the continuing Telegram task's typing alive after an accepted steer", async () => {
    state.backendQueueMessageMock.mockReturnValueOnce(true);
    const active = makeRunningOperation();
    const taskTyping = createMockTypingController({ isActive: vi.fn(() => true) });
    bindReplyOperationTyping(active, taskTyping);
    const { run, typing } = createMinimalRun({
      ...activeSteer,
      sessionCtx: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "123",
        NativeChannelId: "123",
        MessageSid: "steer-telegram",
      },
      runOverrides: { agentId: "main", messageProvider: "telegram" },
    });

    await expect(run()).resolves.toBeUndefined();

    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(taskTyping.startTypingLoop).toHaveBeenCalledOnce();
    expect(taskTyping.cleanup).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledOnce();

    active.complete();

    expect(taskTyping.cleanup).toHaveBeenCalledOnce();
  });

  it("injects a steer without claiming a new agent reply", async () => {
    const runState: ReplyOperationRunState = {};
    const active = makeRunningOperation();
    enableReplyHook({
      handled: true,
      reply: { text: "claimed steer" },
    });
    state.backendQueueMessageMock.mockReturnValueOnce(true);
    const { run } = createMinimalRun({
      opts: { [REPLY_OPERATION_RUN_STATE]: runState },
      ...activeSteer,
      sessionCtx: discordContext("steer-declined", {
        NativeChannelId: "24680",
        SenderId: "sender-42",
      }),
      runOverrides: {
        agentId: "main",
        messageProvider: "discord",
        senderId: "sender-42",
      },
    });

    try {
      await expect(run()).resolves.toBeUndefined();

      expect(runState.admission).toEqual({ status: "accepted", mode: "steer" });
      expect(state.beforeAgentReplyRunMock).not.toHaveBeenCalled();
      expect(state.backendQueueMessageMock).toHaveBeenCalledExactlyOnceWith(
        "session",
        "hello",
        expect.objectContaining({ steeringMode: "all" }),
      );
      expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(getSessionControllerOperation("main")).toBe(active);
      expect(active.phase).toBe("running");
      expect(active.result).toBeNull();
    } finally {
      active.complete();
    }
  });

  it("replays a declined steer without dispatching its hook twice", async () => {
    const fixture = await makeSessionFixture();
    const onAdopted = vi.fn();
    const onBlockReply = vi.fn();
    const active = makeRunningOperation();
    enableReplyHook(undefined);
    state.backendQueueMessageMock.mockReturnValueOnce(false);
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params) => {
      expect(
        (await readStoredMainSession(fixture.storePath)).restartRecoveryBeforeAgentReplyState,
      ).toBeUndefined();
      return runHookBackedEmbeddedAgent(params);
    });
    const { followupRun, run } = createSessionRun(
      fixture,
      {
        activeBackendRunId: "active-run-1",
        opts: { runId: "incoming-run-1", onBlockReply, turnAdoptionLifecycle: { onAdopted } },
        ...activeSteer,
        shouldFollowup: true,
        sessionCtx: discordContext("steer-fallback"),
        runOverrides: { agentId: "main", messageProvider: "discord" },
      },
      "steering rejected before admission",
    );

    await expect(run()).resolves.toBeUndefined();

    expect(state.beforeAgentReplyRunMock).not.toHaveBeenCalled();
    expect(state.backendQueueMessageMock).toHaveBeenCalledOnce();
    expect(parkedSteer.fallback).toHaveBeenCalledOnce();
    expect(parkedSteer.consume).not.toHaveBeenCalled();
    expect(onAdopted).not.toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(scheduleFollowupDrain).not.toHaveBeenCalled();
    active.complete();
    await requireScheduledFollowupRunner()(followupRun);
    expect(onAdopted).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(state.beforeAgentReplyRunMock).toHaveBeenCalledOnce();
  });

  it("durably records an adopted steer once with the active run id for transcript projection", async () => {
    const fixture = await makeSessionFixture();
    const { storePath } = fixture;
    const active = makeRunningOperation();
    const recorder = createSourceRecorder(fixture, {
      text: "use the monochrome version instead",
      idempotencyKey: "matrix:$explicit-steer",
      sender: { id: "user-42", name: "Ada" },
    });
    const events: string[] = [];
    state.backendQueueMessageMock.mockImplementationOnce(
      async (_sessionId: string, _prompt: string, options: unknown) => {
        expect(requireRecord(options, "embedded queue options")).toMatchObject({
          steeringMode: "all",
          isInboundUserMessage: true,
          waitForTranscriptCommit: true,
          queueIdentity: expect.any(String),
          userTurnTranscriptRecorder: recorder,
        });
        events.push("transcript-committed");
        await recorder.persistApproved();
        return true;
      },
    );
    const onAdopted = vi.fn(() => {
      events.push("adopted");
    });
    const { followupRun, run } = createSessionRun(fixture, {
      activeBackendRunId: "active-run",
      ...activeSteer,
      opts: { turnAdoptionLifecycle: { onAdopted } },
    });
    followupRun.prompt = "use the monochrome version instead";
    followupRun.userTurnTranscriptRecorder = recorder;

    await expect(run()).resolves.toBeUndefined();

    expect(events).toEqual(["transcript-committed", "adopted"]);
    expect(onAdopted).toHaveBeenCalledOnce();
    expect(parkedSteer.consume).toHaveBeenCalledOnce();
    expect(parkedSteer.fallback).not.toHaveBeenCalled();
    const transcript = await loadTranscriptEvents({
      agentId: "main",
      sessionId: "session",
      sessionKey: "main",
      storePath,
    });
    const projectedUserRows = transcript
      .map(readTranscriptEventMessage)
      .filter((message) => message?.role === "user" && message.content === followupRun.prompt);
    expect(projectedUserRows).toHaveLength(1);
    expect(projectedUserRows[0]).toMatchObject({
      __openclaw: {
        senderId: "user-42",
        senderName: "Ada",
        steerTargetRunId: "active-run",
      },
    });
    expect(recorder.getPersistedMessage?.()).toMatchObject({
      __openclaw: { steerTargetRunId: "active-run" },
    });
    active.complete();
  });

  it("queues and drains a steer whose pre-resolved owner has disappeared", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(runHookBackedEmbeddedAgent);
    const runState: ReplyOperationRunState = {};
    const { followupRun, run } = createMinimalRun({
      ...activeSteer,
      shouldFollowup: true,
      sessionCtx: { SenderId: "bob" },
      opts: { [REPLY_OPERATION_RUN_STATE]: runState },
    });
    followupRun.prompt = "finish with a table";

    await expect(run()).resolves.toBeUndefined();

    expect(getSessionControllerOperation("main")).toBeUndefined();
    expect(state.backendQueueMessageMock).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledOnce();
    expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1]).toBe(followupRun);
    expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1]).toMatchObject({
      originatingChannel: "whatsapp",
      run: { senderId: "bob" },
    });
    expect(runState.admission).toEqual({
      status: "accepted",
      mode: "followup",
      reason: "steering-unavailable",
    });
    expect(parkedSteer.fallback).not.toHaveBeenCalled();
    expect(parkedSteer.consume).not.toHaveBeenCalled();
    expect(vi.mocked(scheduleFollowupDrain)).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    await requireScheduledFollowupRunner()(followupRun);
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({ senderId: "bob" });
  });

  it("steers against the session's registered run owner, not a source-keyed reservation", async () => {
    // A native command continuation whose target-slot adoption was skipped
    // (#104844) still carries its slash-source reservation; steering must
    // target the operation that owns this session's run slot.
    state.backendQueueMessageMock.mockReturnValueOnce(true);
    const targetOwner = makeRunningOperation({ sessionId: "target-active-session" });
    const sourceReservation = makeOperation({
      sessionKey: "agent:main:telegram:slash:steer-user",
      sessionId: "source-reservation-session",
    });
    const { run } = createMinimalRun({
      ...activeSteer,
      replyOperation: sourceReservation,
    });

    await expect(run()).resolves.toBeUndefined();

    expect(state.backendQueueMessageMock).toHaveBeenCalledWith(
      "target-active-session",
      "hello",
      expect.objectContaining({ steeringMode: "all" }),
    );

    targetOwner.complete();
    sourceReservation.complete();
  });

  it("waits for transcript commit and keeps a rejected adoption finalizer irrevocably adopted", async () => {
    const active = makeRunningOperation();
    const finalizerError = new Error("dedupe finalizer failed");
    const events: string[] = [];
    state.backendQueueMessageMock.mockImplementationOnce(
      (_sessionId: string, _prompt: string, options: unknown) => {
        expect(requireRecord(options, "embedded queue options")).toMatchObject({
          steeringMode: "all",
          waitForTranscriptCommit: true,
        });
        events.push("transcript-committed");
        return true;
      },
    );
    const onAdopted = vi.fn(async () => {
      events.push("adoption-finalizer");
      throw finalizerError;
    });
    const { run, typing } = createMinimalRun({
      opts: { turnAdoptionLifecycle: { onAdopted } },
      ...activeSteer,
    });

    await expect(run()).resolves.toBeUndefined();

    expect(events).toEqual(["transcript-committed", "adoption-finalizer"]);
    expect(onAdopted).toHaveBeenCalledTimes(1);
    expect(parkedSteer.consume).toHaveBeenCalledOnce();
    expect(parkedSteer.fallback).not.toHaveBeenCalled();
    active.complete();
    expect(state.backendQueueMessageMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it("adopts and consumes non-handoff unconfirmed steering without replay", async () => {
    const runState: ReplyOperationRunState = {};
    const active = makeRunningOperation();
    state.backendQueueMessageMock.mockReturnValueOnce({
      queued: true,
      sessionId: "session",
      target: "embedded_run",
      gatewayHealth: "live",
      transcriptCommit: "unconfirmed",
      errorMessage: "receipt unavailable",
    });
    const onAdopted = vi.fn();
    const { run, typing } = createMinimalRun({
      opts: {
        [REPLY_OPERATION_RUN_STATE]: runState,
        turnAdoptionLifecycle: { onAdopted },
      },
      ...activeSteer,
      shouldFollowup: true,
    });

    await expect(run()).resolves.toMatchObject({ isError: true, text: "receipt unavailable" });

    expect(onAdopted).toHaveBeenCalledOnce();
    expect(state.activeBackendCancelMock).not.toHaveBeenCalled();
    expect(runState.admission).toMatchObject({ reason: "question-response-indeterminate" });
    expect(runState.messageInjectionAborted).toBeUndefined();
    expect(parkedSteer.consume).toHaveBeenCalledOnce();
    expect(parkedSteer.fallback).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledOnce();
    active.complete();
  });

  it("retains an unconfirmed steer until its producer returns without cancelling a successor", async () => {
    const active = makeRunningOperation({ sessionId: "session-a" });
    const activeAbortByUser = vi.spyOn(active, "abortByUser");
    state.backendQueueMessageMock.mockImplementationOnce(() => {
      active.complete();
      // The native injection still owns its source even after the active turn returns.
      expect(() => makeOperation({ sessionId: "session-b" })).toThrow();
      return {
        queued: true,
        sessionId: "session-a",
        target: "embedded_run",
        gatewayHealth: "live",
        transcriptCommit: "unconfirmed",
        errorMessage: "receipt unavailable",
      };
    });
    const { run, followupRun } = createMinimalRun({
      ...activeSteer,
      shouldFollowup: true,
    });
    await expect(run()).resolves.toMatchObject({ isError: true, text: "receipt unavailable" });
    await followupRun.controllerInput?.settlement.promise;
    const successor = makeRunningOperation({ sessionId: "session-b" });
    const successorAbortByUser = vi.spyOn(successor, "abortByUser");
    try {
      expect(successorAbortByUser).not.toHaveBeenCalled();
      expect(activeAbortByUser).not.toHaveBeenCalled();
      expect(getSessionControllerOperation("main")).toBe(successor);
    } finally {
      active.complete();
      successor.complete();
    }
  });
});

describe("runReplyAgent admission and cleanup", () => {
  it("drops an aborted caller before queue or model work", async () => {
    const runState: ReplyOperationRunState = {};
    const abortController = new AbortController();
    abortController.abort();
    const { run, typing } = createMinimalRun({
      opts: { abortSignal: abortController.signal, [REPLY_OPERATION_RUN_STATE]: runState },
      resolvedQueueMode: "collect",
    });
    expect(await run()).toBeUndefined();
    expect(state.backendQueueMessageMock).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
    expect(runState.admission).toEqual({ status: "skipped", reason: "aborted" });
  });

  registerReplyAdmissionCases({
    createMinimalRun,
    makeSessionFixture,
    runEmbeddedAgentMock: state.runEmbeddedAgentMock,
    queueEmbeddedAgentMessageMock: state.backendQueueMessageMock,
  });

  it("records queue-cap rejection while cleaning up typing", async () => {
    vi.mocked(enqueueFollowupRun).mockImplementationOnce((...args) => {
      args[1].onQueueDisposition?.("queue-cap-new");
      return false;
    });
    const runState: ReplyOperationRunState = {};
    const { run, typing } = createMinimalRun({
      opts: { [REPLY_OPERATION_RUN_STATE]: runState },
      isActive: true,
      isRunActive: () => true,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
    });

    const result = await run();

    expect(result).toBeUndefined();
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleFollowupDrain)).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
    expect(runState.admission).toEqual({ status: "skipped", reason: "queue-cap" });
  });

  it("keeps queued typing alive and the drain dormant until the active owner clears", async () => {
    const active = makeOperation();
    const { run, typing } = createMinimalRun({
      isActive: true,
      isRunActive: () => true,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
    });

    const result = await run();

    expect(result).toBeUndefined();
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleFollowupDrain)).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
    expect(typing.refreshTypingTtl).toHaveBeenCalledTimes(1);
    expect(typing.cleanup).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[5]).toBe(false);
    active.complete();
    expect(vi.mocked(scheduleFollowupDrain)).toHaveBeenCalledTimes(1);
  });

  it("starts draining after enqueue when the reply lane owner is already gone", async () => {
    const { run, typing } = createMinimalRun({
      isActive: true,
      isRunActive: () => false,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
    });

    const result = await run();

    expect(result).toBeUndefined();
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[5]).toBe(false);
    expect(vi.mocked(scheduleFollowupDrain)).toHaveBeenCalledTimes(1);
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each<{
    label: string;
    kind: "partial" | "empty" | "block";
    callbackResult?: boolean;
    sessionCtx?: Partial<TemplateContext>;
    text?: string;
    lane?: "reasoning" | "commentary";
  }>([
    { label: "legacy direct partial", kind: "partial" },
    { label: "accepted direct partial", kind: "partial", callbackResult: true },
    { label: "rejected direct partial", kind: "partial", callbackResult: false },
    {
      label: "legacy void in a group chat",
      kind: "partial",
      sessionCtx: {
        ChatType: "group" as const,
        SessionKey: "agent:test:telegram:group:-100123",
      },
    },
    { label: "no partial delivery", kind: "empty" },
    { label: "a partial without visible content", kind: "empty", text: "   " },
    { label: "visible reasoning-only block streaming", kind: "block", lane: "reasoning" },
    { label: "visible commentary-only block streaming", kind: "block", lane: "commentary" },
  ])("handles terminal accounting failure after $label", async (testCase) => {
    const accounting = await import("./agent-runner-result-accounting.js");
    using _ = vi
      .spyOn(accounting, "accountAgentTurn")
      .mockRejectedValueOnce(new Error("persist exploded"));
    const partial = testCase.kind === "partial";
    const block = testCase.kind === "block";
    const runState: ReplyOperationRunState = {};
    const onPartialReply = partial ? vi.fn(async () => testCase.callbackResult) : vi.fn();
    const onBlockReply = vi.fn();
    let observedCallbackResult: boolean | void = undefined;
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      if (block) {
        await params.onBlockReply?.({
          text: `internal ${testCase.lane}`,
          ...(testCase.lane === "reasoning" ? { isReasoning: true } : { isCommentary: true }),
        });
      } else if (partial || testCase.text !== undefined) {
        observedCallbackResult = await params.onPartialReply?.({
          text: partial ? "partial answer" : testCase.text,
        });
      }
      return modelReply(
        testCase.kind === "empty" && testCase.text === undefined ? "ok" : "final answer",
      );
    });
    const { run } = createMinimalRun({
      blockStreamingEnabled: block,
      opts: partial
        ? { onPartialReply, preserveProgressCallbackStartOrder: true }
        : block
          ? {
              onBlockReply,
              [REPLY_OPERATION_RUN_STATE]: runState,
              reasoningPayloadsEnabled: testCase.lane === "reasoning",
              commentaryPayloadsEnabled: testCase.lane === "commentary",
            }
          : {
              onPartialReply: testCase.text === undefined ? undefined : onPartialReply,
              [REPLY_OPERATION_RUN_STATE]: runState,
            },
      sessionCtx: testCase.sessionCtx,
    });
    if (testCase.kind === "empty" || (partial && testCase.callbackResult === false)) {
      await expect(run()).rejects.toThrow("persist exploded");
    } else if (block) {
      await expect(run()).resolves.toMatchObject({
        text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
        isError: true,
      });
    } else {
      const result = await run();
      const payload = Array.isArray(result) ? result[0] : result;
      expect(payload).toMatchObject({
        text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
        isError: true,
      });
    }
    if (partial) {
      expect(onPartialReply).toHaveBeenCalledWith({ text: "partial answer", mediaUrls: undefined });
      expect(observedCallbackResult).toBe(testCase.callbackResult);
    } else if (block) {
      expect(resolveReplyOperationAgentTurn(runState)).toBe("failed");
      expect(onBlockReply).toHaveBeenCalledWith(
        expect.objectContaining({ text: `internal ${testCase.lane}` }),
        expect.any(Object),
      );
    } else if (testCase.text === undefined) {
      expect(resolveReplyOperationAgentTurn(runState)).toBe("failed");
      expect(vi.mocked(scheduleFollowupDrain)).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ["accepted answer", { text: "answer block" }],
    ["in-flight answer", { text: "answer block" }],
    ["queued answer", { text: "answer block" }],
    ["aborted answer", { text: "answer block" }],
    ["reasoning", { text: "internal reasoning", isReasoning: true }],
    ["commentary", { text: "working on it", isCommentary: true }],
    ["rejected answer", { text: "answer block" }],
  ])("settles optional provider failure after %s block delivery", async (label, payload) => {
    const runState: ReplyOperationRunState = {};
    const replyOperation = label === "aborted answer" ? makeOperation() : undefined;
    const deliveryStarted = createDeferred();
    let blockFlush: Promise<void> | undefined;
    const onBlockReply = vi.fn(async () => {
      deliveryStarted.resolve();
      if (label === "in-flight answer" || replyOperation) {
        await setImmediate();
        if (replyOperation) {
          expect(replyOperation.abortByUser()).toBe(true);
        }
      }
      if (label === "rejected answer") {
        throw new Error("transport rejected the block");
      }
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onBlockReply?.(payload);
      blockFlush = label === "queued answer" ? undefined : params.onBlockReplyFlush?.();
      if (label !== "queued answer") {
        await deliveryStarted.promise;
      }
      if (label !== "in-flight answer" && label !== "queued answer") {
        await blockFlush;
      }
      throw new Error("model stream failed after block delivery");
    });
    const { run } = createMinimalRun({
      replyOperation,
      blockStreamingEnabled: true,
      opts: {
        onBlockReply,
        reasoningPayloadsEnabled: true,
        commentaryPayloadsEnabled: true,
        [REPLY_OPERATION_RUN_STATE]: runState,
      },
      sessionCtx: { ChatType: "group" },
      runOverrides: { terminalReplyExpectation: "optional" },
    });

    try {
      const result = await run();
      await blockFlush;
      const reply = Array.isArray(result) ? result[0] : result;

      if (label === "aborted answer" || label === "rejected answer") {
        expect(reply?.text?.trim() ?? "").toBe("");
      } else {
        expect(reply).toMatchObject({ isError: true, text: expect.any(String) });
        expect(reply?.text).not.toBe("NO_REPLY");
      }
      if (label !== "aborted answer") {
        expect(resolveReplyOperationAgentTurn(runState)).toBe("failed");
      }
    } finally {
      replyOperation?.complete();
      await blockFlush;
    }
  });

  it("keeps user aborts silent after a delivered partial", async () => {
    const replyOperation = makeOperation();
    const onPartialReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onPartialReply?.({ text: "partial answer" });
      replyOperation.abortByUser();
      throw new Error("run stopped");
    });

    const { run } = createMinimalRun({
      blockStreamingEnabled: false,
      opts: { onPartialReply },
      replyOperation,
    });
    try {
      const result = await run();

      expect(result).toEqual({});
    } finally {
      replyOperation.complete();
      await replyOperation.ownerSettlement;
    }
  });
});

registerReplyCompactionCases({ createMinimalRun, makeSessionFixture, tempDirs, state });

describe("runReplyAgent pending final delivery capture", () => {
  it("delivers an authenticated channel reply through the explicitly selected agent", async () => {
    const config = {
      agents: {
        entries: { ops: {}, worker: {} },
        defaults: { compaction: { memoryFlush: {} } },
      },
    } satisfies OpenClawConfig;
    const sessionEntry = makeSessionEntry();
    const sessionStore = { main: sessionEntry };
    const storePath = join(
      tempDirs.make("openclaw-custom-default-agent-"),
      "agents",
      "ops",
      "sessions",
      "sessions.json",
    );
    await replaceSessionEntry(
      { agentId: "ops", defaultAgentId: "ops", sessionKey: "main", storePath },
      sessionEntry,
    );
    const sessionCtx = discordContext("custom-default-source-message", {
      SenderId: "sender-42",
      SenderName: "Ada",
    });
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "custom default agent reply" }],
      meta: {},
    });
    const { followupRun, run, sourceTurnId } = createMinimalRun({
      sessionCtx,
      runOverrides: {
        agentId: "ops",
        config,
        messageProvider: "discord",
      },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    followupRun.userTurnTranscriptRecorder = createSourceRecorder(
      { sessionEntry, sessionStore, storePath },
      {
        text: "custom default agent request",
        idempotencyKey: expectDefined(sourceTurnId, "test channel source turn id"),
        sender: { id: "sender-42", name: "Ada" },
      },
      { agentId: "ops", config },
    );

    setRuntimeConfigSnapshot(config, config);
    try {
      await expect(run()).resolves.toEqual(
        expect.objectContaining({ text: "custom default agent reply" }),
      );

      expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
      expect(
        await loadTranscriptEvents({
          agentId: "ops",
          sessionId: "session",
          sessionKey: "main",
          storePath,
        }),
      ).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            role: "user",
            content: "custom default agent request",
          }),
        }),
      );
      expect(await readStoredMainSession(storePath)).toMatchObject({
        pendingFinalDelivery: {
          kind: "replayable",
          text: "custom default agent reply",
          context: { channel: "discord", to: "channel:24680" },
        },
        restartRecoveryTerminalRunIds: [sourceTurnId],
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it.each([
    {
      label: "message-tool-only",
      opts: { sourceReplyDeliveryMode: "message_tool_only" as const },
      entry: {},
    },
    { label: "sendPolicy-denied", opts: undefined, entry: { sendPolicy: "deny" as const } },
  ])("does not persist $label final replies for durable replay", async ({ opts, entry }) => {
    const fixture = await makeSessionFixture(entry);
    const { storePath } = fixture;
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "private final" }],
      meta: {},
    });

    const { run } = createSessionRun(fixture, {
      opts,
    });

    await run();

    const stored = await readStoredMainSession(storePath);
    expect(stored.pendingFinalDelivery).toBeUndefined();
  });

  it("fails closed and retires an unknown terminal receipt when the live run returns", async () => {
    const fixture = await makeSessionFixture();
    const { storePath } = fixture;
    const expectedSourceTurnId = requireBuiltChannelSourceTurnId({
      provider: "discord",
      conversationId: "channel:24680",
      messageId: "discord-message-unknown",
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      const current = await readStoredMainSession(storePath);
      await replaceSessionEntry(
        { storePath, sessionKey: "main" },
        {
          ...current,
          restartRecoveryDeliveryReceiptState: "terminal-pending",
          restartRecoveryDeliveryToolCallId: "message-call-unknown",
          updatedAt: Date.now(),
        },
      );
      return { payloads: [{ text: "fallback final" }], meta: {} };
    });

    const { run, sourceTurnId } = createSessionRun(
      fixture,
      {
        sessionCtx: discordContext("discord-message-unknown"),
        runOverrides: { messageProvider: "discord" },
      },
      "maybe send a terminal reply",
    );

    expect(sourceTurnId).toBe(expectedSourceTurnId);

    await run();

    expect(await readStoredMainSession(storePath)).toMatchObject({
      status: "failed",
      abortedLastRun: true,
      restartRecoveryTerminalRunIds: [expectedSourceTurnId],
    });
    const stored = await readStoredMainSession(storePath);
    expectUnset(stored, [
      "pendingFinalDelivery",
      "restartRecoveryDeliveryReceiptState",
      "restartRecoveryDeliveryToolCallId",
      "restartRecoveryDeliveryRunId",
      "restartRecoveryDeliverySourceRunId",
    ]);
  });

  it("rejects channel recovery admission without a source-keyed user turn", async () => {
    const fixture = await makeSessionFixture();
    const { storePath } = fixture;
    const { run } = createSessionRun(fixture, {
      sessionCtx: discordContext("discord-message-without-recorder"),
      runOverrides: { messageProvider: "discord" },
    });

    await expect(run()).rejects.toThrow(
      "channel restart recovery requires source-keyed user-turn admission",
    );

    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(await readStoredMainSession(storePath)).not.toMatchObject({
      restartRecoveryDeliveryRunId: expect.any(String),
    });
  });

  it.each([
    "Done.",
    Array(6).fill("The requested deployment is complete and the service is healthy.").join(" "),
  ])(
    "admits one stranded delivery retry after its parent source is terminal: %s",
    async (finalText) => {
      const fixture = await makeSessionFixture();
      const { sessionEntry, sessionStore, storePath } = fixture;
      const first = createSessionRun(fixture, {
        opts: { sourceReplyDeliveryMode: "message_tool_only" },
        sessionCtx: discordContext("stranded-parent", { ChatType: "group" }),
        runOverrides: {
          agentId: "main",
          messageProvider: "discord",
          sourceReplyDeliveryMode: "message_tool_only",
          terminalReplyExpectation: "required",
          config: { messages: { visibleReplies: "message_tool" } },
        },
      });
      first.followupRun.messageId = "stranded-parent";
      attachSourceTurnRecorder({
        followupRun: first.followupRun,
        sessionEntry,
        sessionStore,
        sourceTurnId: first.sourceTurnId,
        storePath,
        text: "Send the result.",
      });
      state.runEmbeddedAgentMock
        .mockResolvedValueOnce({
          payloads: [{ text: finalText }],
          meta: {
            finalAssistantVisibleText: finalText,
            terminalReply: { disposition: "visible", text: finalText },
          },
        })
        .mockImplementation(async () => {
          const admitted = await readStoredMainSession(storePath);
          expect(admitted.restartRecoveryDeliverySourceRunId).toBe(first.sourceTurnId);
          expect(admitted.restartRecoveryTerminalRunIds).toContain(first.sourceTurnId);
          return {
            payloads: [],
            meta: {
              finalAssistantVisibleText: "",
              terminalReply: { disposition: "silent" },
            },
          };
        });

      await first.run();
      const retry = vi.mocked(enqueueFollowupRun).mock.calls.at(-1)?.[1];
      expect(retry?.strandedReplyRetry).toBe(true);
      expect(retry?.userTurnTranscriptRecorder).toBeUndefined();
      expect((await readStoredMainSession(storePath)).restartRecoveryTerminalRunIds).toContain(
        first.sourceTurnId,
      );
      const drain = requireScheduledFollowupRunner();
      await drain(expectDefined(retry, "stranded retry"));
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);

      await drain(expectDefined(retry, "duplicate stranded retry"));
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
      await drain({
        ...expectDefined(retry, "redelivered parent source"),
        strandedReplyRetry: undefined,
      });
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
      const messages = (await loadTranscriptEvents({ storePath, sessionId: "session" })).filter(
        (event) => readTranscriptEventMessage(event)?.role === "user",
      );
      expect(messages).toHaveLength(1);
      expect((await readStoredMainSession(storePath)).restartRecoveryTerminalRunIds).toContain(
        first.sourceTurnId,
      );
    },
  );

  it("drops a redelivered terminal channel source before hooks or model work", async () => {
    const fixture = await makeSessionFixture();
    const { storePath } = fixture;
    const sessionCtx = discordContext("redelivered-terminal-message");
    const first = createSessionRun(
      fixture,
      {
        sessionCtx,
        runOverrides: { messageProvider: "discord" },
      },
      "execute once",
    );

    await first.run();

    const completedEntry = await readStoredMainSession(storePath);
    expect(completedEntry.restartRecoveryTerminalRunIds).toEqual([first.sourceTurnId]);
    state.runEmbeddedAgentMock.mockClear();
    const onAdopted = vi.fn();
    const completedStore = { main: completedEntry };
    const duplicate = createMinimalRun({
      opts: { turnAdoptionLifecycle: { onAdopted } },
      sessionCtx,
      runOverrides: { messageProvider: "discord" },
      sessionEntry: completedEntry,
      sessionStore: completedStore,
      sessionKey: "main",
      storePath,
    });
    attachSourceTurnRecorder({
      followupRun: duplicate.followupRun,
      sessionEntry: completedEntry,
      sessionStore: completedStore,
      sourceTurnId: duplicate.sourceTurnId,
      storePath,
      text: "execute once",
    });

    // Retire the completed turn's automatic maintenance before observing cold redelivery.
    const database = toDatabaseOptions(resolveSqliteScope({ storePath, sessionKey: "main" }));
    await closeOpenClawAgentDatabaseByPathAsync(
      resolveOpenClawAgentSqlitePath(database),
      database.agentId,
    );
    const observer = observeParentSqlite();
    try {
      const calibration = openNodeSqliteDatabase(":memory:");
      calibration.exec("CREATE TABLE calibration (value INTEGER)");
      calibration.prepare("INSERT INTO calibration VALUES (?)").run(7);
      const query = calibration.prepare("SELECT value FROM calibration");
      expect(query.get()).toEqual({ value: 7 });
      expect(query.all()).toEqual([{ value: 7 }]);
      expect([...query.iterate()]).toEqual([{ value: 7 }]);
      calibration.close();
      sqliteMethods.forEach((method) => expect(observer.counts[method], method).toBeGreaterThan(0));
      observer.reset();
      await expect(duplicate.run()).resolves.toBeUndefined();
      expect(observer.counts).toEqual(emptySqliteCounts());
    } finally {
      observer.restore();
    }

    expect(onAdopted).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect((await readStoredMainSession(storePath)).restartRecoveryTerminalRunIds).toEqual([
      first.sourceTurnId,
    ]);
  });

  it("drops a redelivered active channel source before hooks or queue work", async () => {
    const sessionCtx = discordContext("redelivered-active-message");
    const sourceTurnId = requireBuiltChannelSourceTurnId({
      provider: "discord",
      conversationId: "channel:24680",
      messageId: "redelivered-active-message",
    });
    const fixture = await makeSessionFixture({
      restartRecoveryDeliveryRunId: "active-recovery-run",
      restartRecoveryDeliverySourceRunId: sourceTurnId,
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "channel:24680",
      },
    });
    const { storePath } = fixture;
    const onAdopted = vi.fn();
    const duplicate = createSessionRun(
      fixture,
      {
        isActive: true,
        shouldSteer: true,
        opts: { turnAdoptionLifecycle: { onAdopted } },
        sessionCtx,
        runOverrides: { messageProvider: "discord" },
      },
      "execute once",
    );

    await expect(duplicate.run()).resolves.toBeUndefined();

    expect(duplicate.sourceTurnId).toBe(sourceTurnId);
    expect(onAdopted).not.toHaveBeenCalled();
    expect(state.backendQueueMessageMock).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    const stored = await readStoredMainSession(storePath);
    expect(stored.status).toBeUndefined();
    expect(stored).toMatchObject({
      restartRecoveryDeliveryRunId: "active-recovery-run",
      restartRecoveryDeliverySourceRunId: sourceTurnId,
    });
  });

  registerTranscriptClaimCases({
    createMinimalRun,
    makeSessionFixture,
    readStoredMainSession,
    runEmbeddedAgentMock: state.runEmbeddedAgentMock,
  });

  it("rejects a transcript-only claim already aborted for restart", async () => {
    const fixture = await makeSessionFixture({
      abortedLastRun: true,
      restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
      restartRecoveryDeliveryRunId: "msg",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      status: "interrupted",
    });
    const { storePath } = fixture;
    const onAdopted = vi.fn();
    const { run } = createSessionRun(fixture, {
      opts: { turnAdoptionLifecycle: { onAdopted } },
      sessionCtx: {
        Provider: "webchat",
        OriginatingChannel: "webchat",
      },
      runOverrides: { messageProvider: "webchat" },
    });

    try {
      await expect(run()).resolves.toBeDefined();

      expect(onAdopted).not.toHaveBeenCalled();
      expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(await readStoredMainSession(storePath)).toMatchObject({
        abortedLastRun: true,
        restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
        restartRecoveryDeliveryRunId: "msg",
        restartRecoveryDeliverySourceRunId: "control-ui-run",
        status: "interrupted",
      });
    } finally {
      // The rejected turn releases its durable recovery owner after run() settles.
      await captureSessionControllerSettlement({ scope: storePath, identities: ["main"] });
    }
  });

  it.each([
    ["model reply", false, "message_tool_only", "done"],
    ["hook reply", true, "automatic", "failed"],
    ["suppressed hook reply", true, "message_tool_only", undefined],
  ] as const)(
    "durably admits %s before adoption and execution",
    async (_label, handled, sourceReplyDeliveryMode, priorStatus) => {
      const previousSource = "previous-source";
      const fixture = await makeSessionFixture(
        priorStatus
          ? {
              status: priorStatus,
              abortedLastRun: priorStatus === "failed",
              restartRecoveryTerminalRunIds: [previousSource],
              ...(priorStatus === "done"
                ? {
                    restartRecoveryDeliveryContext: { channel: "webchat", to: "stale-client" },
                    restartRecoveryDeliveryRunId: "stale-run",
                    restartRecoveryDeliverySourceRunId: previousSource,
                  }
                : {}),
            }
          : {},
      );
      const { storePath } = fixture;
      const sourceTurnId = requireBuiltChannelSourceTurnId({
        provider: "discord",
        accountId: "work",
        conversationId: "channel:24680",
        messageId: "hook-source",
      });
      const deliveryContext = {
        channel: "discord",
        to: "channel:24680",
        accountId: "work",
        threadId: "hook-source",
      };
      const receipt: ReplyOperationRunState = {};
      const events: string[] = [];
      state.getChannelPluginMock.mockReturnValue({
        threading: { buildToolContext: () => ({ sameChannelThreadRequired: true }) },
      });
      const onAdopted = vi.fn(async () => {
        const stored = await readStoredMainSession(storePath);
        expect(stored).toMatchObject({
          restartRecoveryDeliveryContext: deliveryContext,
          restartRecoveryDeliveryRunId: expect.any(String),
          restartRecoveryDeliverySourceRunId: sourceTurnId,
          restartRecoveryRequesterAccountId: "work",
          restartRecoveryRequesterSenderId: "discord-user",
          restartRecoverySourceIngress: "channel",
          restartRecoverySourceReplyDeliveryMode: sourceReplyDeliveryMode,
          restartRecoverySameChannelThreadRequired: true,
        });
        expect(
          (await loadTranscriptEvents({ storePath, sessionId: "session" })).at(-1),
        ).toMatchObject({
          message: { role: "user", content: "hook-owned request" },
        });
        expect(stored.status).toBeUndefined();
        expect(stored.abortedLastRun).toBe(false);
        expect(stored.restartRecoveryDeliveryRunId).not.toBe("stale-run");
        expect(stored.restartRecoveryTerminalRunIds ?? []).toEqual(
          priorStatus ? [previousSource] : [],
        );
        events.push("adopted");
      });
      state.beforeAgentReplyHasHooksMock.mockImplementation(
        (name) => handled && name === "before_agent_reply",
      );
      state.beforeAgentReplyRunMock.mockImplementation(async (_event, context) => {
        expect(context.sessionId).toBe("session");
        const stored = await readStoredMainSession(storePath);
        expect(stored.status).toBeUndefined();
        expect(stored).toMatchObject({
          restartRecoveryDeliverySourceRunId: sourceTurnId,
          restartRecoveryBeforeAgentReplyState: "pending",
        });
        events.push("hook");
        return { handled: true, reply: { text: "hook reply" } };
      });
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params) => {
        events.push("agent-run");
        return handled
          ? runHookBackedEmbeddedAgent(params)
          : { payloads: [{ text: "visible final" }], meta: {} };
      });
      const { run } = createSessionRun(
        fixture,
        {
          opts: {
            turnAdoptionLifecycle: { onAdopted },
            sourceReplyDeliveryMode,
            [REPLY_OPERATION_RUN_STATE]: receipt,
          },
          sessionCtx: discordContext("hook-source", {
            AccountId: "work",
            SenderId: "discord-user",
            MessageThreadId: "hook-source",
          }),
          runOverrides: { messageProvider: "discord" },
        },
        "hook-owned request",
      );
      await expect(run()).resolves.toEqual(
        expect.objectContaining({ text: handled ? "hook reply" : "visible final" }),
      );
      expect(onAdopted).toHaveBeenCalledOnce();
      expect(events).toEqual(handled ? ["adopted", "agent-run", "hook"] : ["adopted", "agent-run"]);
      expect(state.beforeAgentReplyRunMock).toHaveBeenCalledTimes(handled ? 1 : 0);
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
      expect(resolveReplyOperationAgentTurn(receipt)).toBe("ok");
      const stored = await readStoredMainSession(storePath);
      if (handled && sourceReplyDeliveryMode === "automatic") {
        expect(stored).toMatchObject({
          pendingFinalDelivery: { kind: "replayable", text: "hook reply" },
          restartRecoveryBeforeAgentReplyState: "handled-reply",
          restartRecoveryForceSafeTools: true,
          restartRecoverySourceIngress: "channel",
        });
      } else if (handled) {
        expect(stored).toMatchObject({
          status: "done",
          abortedLastRun: false,
          restartRecoveryTerminalRunIds: [sourceTurnId],
        });
      } else {
        expectUnset(stored, [
          "restartRecoverySourceIngress",
          "restartRecoverySourceReplyDeliveryMode",
          "restartRecoveryRequesterAccountId",
          "restartRecoveryRequesterSenderId",
          "restartRecoverySameChannelThreadRequired",
        ]);
      }
    },
  );

  it("settles an omitted hook reply silently after checkpointing", async () => {
    enableReplyHook({ handled: true });
    state.runEmbeddedAgentMock.mockImplementationOnce(runHookBackedEmbeddedAgent);
    const receipt: ReplyOperationRunState = {};
    const { run } = createMinimalRun({
      opts: { [REPLY_OPERATION_RUN_STATE]: receipt },
      runOverrides: { terminalReplyExpectation: "result-required" },
    });

    await expect(run()).resolves.toBeUndefined();
    expect(resolveReplyOperationAgentTurn(receipt)).toBe("ok");
  });

  it("checkpoints an unhandled hook after replacing stale handled-reply state", async () => {
    const fixture = await makeSessionFixture({
      restartRecoveryBeforeAgentReplyState: "handled-reply",
    });
    const { storePath } = fixture;
    state.beforeAgentReplyHasHooksMock.mockImplementation(
      (hookName) => hookName === "before_agent_reply",
    );
    state.beforeAgentReplyRunMock.mockImplementation(async () => {
      expect((await readStoredMainSession(storePath)).restartRecoveryBeforeAgentReplyState).toBe(
        "pending",
      );
      return undefined;
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params) => {
      const result = await runHookBackedEmbeddedAgent(params);
      expect(
        (await readStoredMainSession(storePath)).restartRecoveryBeforeAgentReplyState,
      ).toBeUndefined();
      return result;
    });
    const { run } = createSessionRun(
      fixture,
      {
        sessionCtx: discordContext("discord-message-2"),
        runOverrides: { messageProvider: "discord" },
      },
      "model-owned request",
    );

    await expect(run()).resolves.toEqual(expect.objectContaining({ text: "model reply" }));

    expect(state.beforeAgentReplyRunMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(await readStoredMainSession(storePath)).toMatchObject({
      pendingFinalDelivery: {
        kind: "replayable",
        text: "model reply",
        context: { channel: "discord" },
        intentId: expect.any(String),
        createdAt: expect.any(Number),
      },
      restartRecoverySourceIngress: "channel",
    });
    expect(
      (await readStoredMainSession(storePath)).restartRecoveryBeforeAgentReplyState,
    ).toBeUndefined();
  });

  it("fires onAdopted for suppressed-delivery runs before the agent turn", async () => {
    const fixture = await makeSessionFixture();
    const { storePath } = fixture;
    const events: string[] = [];
    const onAdopted = vi.fn(async () => {
      const storedAtAdoption = await readStoredMainSession(storePath);
      expectUnset(storedAtAdoption, [
        "restartRecoveryDeliveryContext",
        "restartRecoveryDeliveryRunId",
      ]);
      events.push("adopted");
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      events.push("agent-run");
      return { payloads: [{ text: "ambient final" }], meta: {} };
    });

    const { run } = createSessionRun(fixture, {
      opts: {
        turnAdoptionLifecycle: { onAdopted },
        sourceReplyDeliveryMode: "message_tool_only",
      },
      sessionCtx: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:123",
        AccountId: "default",
        MessageSid: "42",
        InboundEventKind: "room_event",
      },
      runOverrides: { messageProvider: "telegram" },
      currentInboundEventKind: "room_event",
    });

    await run();

    expect(onAdopted).toHaveBeenCalledOnce();
    expect(events).toEqual(["adopted", "agent-run"]);
  });
});

function policyRetry(provider: string, model: string) {
  return makeCompletedFallbackRunner({
    provider,
    model,
    attempts: [
      {
        provider: "openai",
        model: "gpt-5.6-sol",
        error: "OpenAI cyber policy refusal",
        reason: "unknown",
        code: "OPENAI_CYBER_POLICY_REFUSAL",
      },
    ],
  });
}

function terminalFailure(payloads: ReplyPayload[] = []) {
  return {
    payloads,
    meta: { error: { kind: "tool_result_mismatch", message: "Terminal error before delivery." } },
  };
}

describe("runReplyAgent typing", () => {
  registerRequiredReplyCompletionCases({
    createMinimalRun,
    state,
  });

  it("forwards approval tool results and starts typing on their visible text", async () => {
    const payload = {
      text: "Approval required.\n\n```txt\n/approve 117ba06d allow-once\n```",
      channelData: {
        execApproval: {
          approvalId: "117ba06d-1111-2222-3333-444444444444",
          approvalSlug: "117ba06d",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        },
      },
    };
    const onToolResult = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onToolResult?.(payload);
      return {
        payloads: [{ text: "final" }],
        meta: {
          terminalReply: { disposition: "visible", text: "final" },
        },
      };
    });
    const { run, typing } = createMinimalRun({ typingMode: "message", opts: { onToolResult } });
    await run();
    expect(typing.startTypingOnText).toHaveBeenCalledWith(payload.text);
    expect(onToolResult).toHaveBeenCalledExactlyOnceWith(payload);
  });
  it("enables channel-owned tool summaries when default tool messages are suppressed", async () => {
    const onToolResult = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      expect(params.shouldEmitToolResult?.()).toBe(true);
      expect(params.shouldEmitToolOutput?.()).toBe(false);
      await params.onToolResult?.({ text: "🛠️ `run ruby`", mediaUrls: [] });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run } = createMinimalRun({
      opts: {
        suppressDefaultToolProgressMessages: true,
        forceToolResultProgress: true,
        onToolResult,
      },
      resolvedVerboseLevel: "off",
    });
    await run();

    expect(onToolResult).toHaveBeenCalledWith({
      text: "🛠️ `run ruby`",
      mediaUrls: [],
    });
  });

  it.each([
    [
      "transient HTTP failures",
      "502 Bad Gateway",
      true,
      "message",
      ["The AI service is having trouble"],
      undefined,
    ],
    [
      "Bun socket error payloads",
      "TypeError: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      false,
      "instant",
      ["Lost the connection to the AI service", "openclaw logs --follow"],
      "socket connection was closed unexpectedly",
    ],
  ] as const)(
    "returns friendly text without retrying %s",
    async (_label, error, thrown, typingMode, expected, hidden) => {
      if (thrown) {
        state.runEmbeddedAgentMock.mockRejectedValueOnce(new Error(error));
      } else {
        state.runEmbeddedAgentMock.mockResolvedValueOnce({
          payloads: [{ text: error, isError: true }],
          meta: {},
        });
      }
      const { run } = createMinimalRun({ typingMode });
      const result = await run();
      const payloads = Array.isArray(result) ? result : [result];

      expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
      expect(payloads).toHaveLength(1);
      for (const text of expected) {
        expect(payloads[0]?.text).toContain(text);
      }
      if (hidden) {
        expect(payloads[0]?.text).not.toContain(hidden);
      }
    },
  );

  it("does not report an exhausted fallback candidate as a successful winner", async () => {
    const fixture = await makeSessionFixture({ traceLevel: "raw" });
    const runId = "run-exhausted-trace";
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Terminal tool summary", isError: true }],
      meta: {
        error: {
          kind: "incomplete_turn",
          message: "Agent ended incomplete",
          fallbackSafe: true,
          terminalPresentation: true,
        },
        executionTrace: {
          winnerProvider: "anthropic",
          winnerModel: "claude",
          attempts: [{ provider: "anthropic", model: "claude", result: "success" }],
          fallbackUsed: false,
          runner: "embedded",
        },
        agentMeta: {
          sessionId: "session",
          provider: "anthropic",
          model: "claude",
          usage: { input: 10, output: 2 },
        },
      },
    });
    vi.spyOn(modelFallbackModule, "runWithModelFallback").mockImplementationOnce(async (args) => ({
      outcome: "exhausted",
      result: await runInitialModelFallbackAttempt(args, "anthropic", "claude"),
      provider: "anthropic",
      model: "claude",
      attempts: [
        {
          provider: "anthropic",
          model: "claude",
          error: "Agent ended incomplete",
          reason: "format",
        },
      ],
    }));

    const { run } = createSessionRun(fixture, {
      opts: { runId },
      runOverrides: {
        sessionFile: join(fixture.storePath, "..", "session.jsonl"),
        traceAuthorized: true,
      },
    });
    const result = await run();
    const text = (Array.isArray(result) ? result : [result])
      .map((payload) => payload?.text ?? "")
      .join("\n");

    expect(text).not.toContain("winner=anthropic/claude");
    expect(text).not.toContain("result=success");
    expect(text).toContain("Summary: fallback=yes attempts=1");
    expect(consumeReplyUsageState(runId)?.resolvedRef).toBeUndefined();
  });

  it("drains pending tool delivery before returning an empty terminal-run failure", async () => {
    const toolResultStarted = createDeferred();
    const toolResultReleased = createDeferred();
    let toolResultDelivered = false;
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      void params.onToolResult?.({ text: "late tool result" });
      return terminalFailure();
    });
    const { run } = createMinimalRun({
      opts: {
        onToolResult: async () => {
          toolResultStarted.resolve();
          await toolResultReleased.promise;
          toolResultDelivered = true;
        },
      },
    });

    const pendingResult = run();
    await toolResultStarted.promise;
    expect(toolResultDelivered).toBe(false);
    toolResultReleased.resolve();
    const result = await pendingResult;
    const payload = Array.isArray(result) ? result[0] : result;

    expect(toolResultDelivered).toBe(true);
    expect(payload).toMatchObject({
      text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
      isError: true,
    });
  });

  registerFollowupDrainCases({
    runHookBackedEmbeddedAgent,
    state,
    createMinimalRun,
    runEmbeddedAgentMock: state.runEmbeddedAgentMock,
    requireScheduledFollowupRunner,
  });

  it("delivers a queued provider error after a private settled-tool completion", async () => {
    const helperStarted = createDeferred();
    const finishHelper = createDeferred();
    const privatePartial = "Private unfinished work before the provider request failed.";
    const providerFailure = "400 Synthetic provider failure for delivery proof.";
    const failedAssistant = makeAssistantMessageFixture({
      content: [],
      errorMessage: providerFailure,
      errorType: "invalid_request_error",
      errorBody: JSON.stringify({
        type: "invalid_request_error",
        message: "Synthetic provider failure for delivery proof.",
      }),
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      helperStarted.resolve();
      await finishHelper.promise;
      return {
        payloads: [{ text: "The tool run finished, but no final summary was produced." }],
        meta: { durationMs: 0, stopReason: "stop", intentionalTerminalCompletion: "tool-batch" },
      } satisfies EmbeddedAgentRunResult;
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      return {
        payloads: buildEmbeddedRunPayloads({
          assistantTexts: [privatePartial],
          lastAssistant: failedAssistant,
          currentAssistant: failedAssistant,
          sourceReplyDeliveryMode: "message_tool_only",
          sessionKey: "main",
          isCronTrigger: false,
          verboseLevel: "off",
          reasoningLevel: "off",
          toolResultFormat: "plain",
        }),
        meta: {
          durationMs: 0,
          error: {
            kind: "incomplete_turn",
            message: providerFailure,
            fallbackSafe: false,
            terminalPresentation: false,
          },
          finalAssistantVisibleText: privatePartial,
          toolSummary: { calls: 1, tools: ["exec"] },
        },
      } satisfies EmbeddedAgentRunResult;
    });
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    const shared = {
      opts: { sourceReplyDeliveryMode: "message_tool_only", onBlockReply },
      sessionCtx: { Provider: "telegram", ChatType: "group" },
      runOverrides: {
        messageProvider: "telegram",
        chatType: "group",
        sourceReplyDeliveryMode: "message_tool_only",
        config: { messages: { groupChat: { visibleReplies: "message_tool" } } },
      },
    } satisfies NonNullable<Parameters<typeof createMinimalRun>[0]>;
    const helper = createMinimalRun(shared).run();
    await helperStarted.promise;
    const queued = createMinimalRun({
      ...shared,
      sessionCtx: { ...shared.sessionCtx, MessageSid: "queued-message" },
      isActive: true,
      bindActiveAuthority: false,
      isRunActive: () => true,
      shouldFollowup: true,
      resolvedQueueMode: "followup",
    });
    queued.followupRun.originatingChatType = "group";
    try {
      await queued.run();
      expect(enqueueFollowupRun).toHaveBeenCalledOnce();
      expect(scheduleFollowupDrain).not.toHaveBeenCalled();
      finishHelper.resolve();
      const helperReply = await helper;
      const helperPayload = Array.isArray(helperReply) ? helperReply[0] : helperReply;
      expect(helperPayload?.text).toBe("The tool run finished, but no final summary was produced.");
      expect(
        getReplyPayloadMetadata(helperPayload ?? {})?.deliverDespiteSourceReplySuppression,
      ).not.toBe(true);
      expect(onBlockReply).not.toHaveBeenCalled();

      await requireScheduledFollowupRunner()(queued.followupRun);

      expect(onBlockReply).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          text: "LLM request rejected: Synthetic provider failure for delivery proof\\.",
          isError: true,
        }),
      );
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    } finally {
      finishHelper.resolve();
      await helper;
    }
  });

  registerImmediateFailurePolicyCases({ createMinimalRun, state });

  registerReasoningFallbackTests({
    runEmbeddedAgentMock: state.runEmbeddedAgentMock,
    createMinimalRun,
  });

  registerWaitingStatusCases({
    createMinimalRun,
    runEmbeddedAgentMock: state.runEmbeddedAgentMock,
  });

  it.each([
    { label: "silent completion", payloads: [], disposition: "silent" },
    {
      label: "non-answer lanes",
      payloads: [
        { text: "internal reasoning", isReasoning: true },
        { text: "internal commentary", isCommentary: true },
        { text: "[[reply_to_current]]" },
      ],
      disposition: "empty",
    },
  ])("replaces filtered $label after a terminal failure", async ({ payloads, disposition }) => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads,
      meta: {
        terminalReply: { disposition },
        error: {
          kind: "tool_result_mismatch",
          message: "Agent run reached a terminal error before visible reply delivery.",
        },
      },
    });
    const { run } = createMinimalRun({
      runOverrides: { config: { channels: { whatsapp: { replyToMode: "first" } } } },
    });
    expect(await run()).toMatchObject({
      text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
      isError: true,
      replyToId: "msg",
    });
  });

  it.each([
    ["coarse message-tool evidence", { didSendViaMessagingTool: true }, false],
    ["source-reply", { didDeliverSourceReplyViaMessageTool: true }, true],
  ] as const)("settles an empty terminal failure using %s", async (_label, delivery, sent) => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({ ...terminalFailure(), ...delivery });

    const { run } = createMinimalRun();
    const result = await run();

    if (sent) {
      expect(result).toBeUndefined();
    } else {
      expect(result).toMatchObject({ isError: true });
    }
  });

  it("does not duplicate an empty terminal failure after an accepted answer block", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onBlockReply?.({ text: "complete answer" });
      return terminalFailure();
    });
    const { run } = createMinimalRun({
      blockStreamingEnabled: true,
      opts: { onBlockReply },
      sessionCtx: { ChatType: "group" },
    });

    expect(await run()).toBeUndefined();
    expect(onBlockReply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "complete answer" }),
      expect.any(Object),
    );
  });

  it("keeps internal fallback out of persisted session models and visible supplements", async () => {
    const selected = { modelProvider: "openai", model: "gpt-5.5" };
    const fixture = await makeSessionFixture({ ...selected, responseUsage: "tokens" });
    state.runEmbeddedAgentMock.mockResolvedValueOnce(modelReply("subagent timed out"));
    using _ = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementationOnce(async (args) => {
        await args.onFallbackStep?.({
          fallbackStepType: "fallback_step",
          fallbackStepFromModel: "openai/gpt-5.5",
          fallbackStepToModel: "google/gemini-2.5-flash",
          fallbackStepFromFailureReason: "timeout",
          fallbackStepFinalOutcome: "succeeded",
        });
        return makeCompletedFallbackRunner({
          provider: "google",
          model: "gemini-2.5-flash",
          attempts: [
            {
              provider: "openai",
              model: "gpt-5.5",
              error: "codex app-server attempt timed out",
              reason: "timeout",
            },
          ],
        })(args);
      });
    const result = await createSessionRun(fixture, {
      runOverrides: {
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:codex:subagent:c34fca91",
          sourceChannel: "__internal__",
          sourceTool: "subagent_announce",
        },
      },
    }).run();
    for (const entry of [fixture.sessionEntry, requireStoredSessionEntry(fixture.storePath)]) {
      expect(entry).toMatchObject(selected);
      expectUnset(entry, [
        "providerOverride",
        "modelOverride",
        "modelOverrideSource",
        "fallbackNotice",
      ]);
    }
    const text = (Array.isArray(result) ? result : result ? [result] : [])
      .map((p) => p.text ?? "")
      .join("\n");
    expect(text).not.toContain("Model Fallback:");
    expect(text).not.toContain("Usage:");
  });

  it("keeps persisted automatic fallback silence intentional", async () => {
    const onAgentRunTerminalOutcome = vi.fn();
    const sessionEntry = makeSessionEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "lmstudio",
      modelOverrideFallbackOriginModel: "gemma-4-e4b-it",
    });
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: { terminalReply: { disposition: "silent" } },
    });
    const result = await createMinimalRun({
      opts: { onAgentRunTerminalOutcome },
      sessionEntry,
      sessionStore: { main: sessionEntry },
      runOverrides: { provider: "openai", model: "gpt-5.5" },
      sessionCtx: { Provider: "discord", OriginatingChannel: "discord", MessageSid: "persisted" },
    }).run();
    const payload = Array.isArray(result) ? result[0] : result;
    expect(payload?.text?.trim() ?? "").toBe("");
    expect(payload?.isError).not.toBe(true);
    expect(onAgentRunTerminalOutcome).not.toHaveBeenCalledWith("failed");
  });

  it.each([
    [
      "a messaging tool",
      {
        payloads: [{ text: "already sent" }],
        messagingToolSentTexts: ["already sent"],
        messagingToolSentTargets: [{ tool: "message", provider: "discord", to: "channel:C1" }],
      },
    ],
    ["an approval prompt", { payloads: [], didSendDeterministicApprovalPrompt: true }],
  ] as const)(
    "announces fallback without silence failure after %s delivery",
    async (_label, result) => {
      state.runEmbeddedAgentMock.mockResolvedValueOnce({ ...result, meta: {} });
      using _ = vi
        .spyOn(modelFallbackModule, "runWithModelFallback")
        .mockImplementationOnce(makeCompletedFallbackRunner());
      const { run } = createDiscordFallbackRun();
      const res = await run();
      const payload = Array.isArray(res) ? res[0] : res;

      expect(payload?.isError).not.toBe(true);
      expect(payload?.text).toContain("Model Fallback:");
      expect(payload?.text).not.toContain("no visible reply");
    },
  );
  it.each([
    [
      "whitespace-only evidence",
      {
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["  "],
        messagingToolSentMediaUrls: ["\t"],
        messagingToolSentTargets: [
          { tool: "message", provider: "discord", to: "channel:C1", text: "  " },
        ],
      },
    ],
    ["only a cron side effect", { successfulCronAdds: 1 }],
    ["did-send-only evidence", { didSendViaMessagingTool: true }],
    [
      "target-only evidence",
      {
        messagingToolSentTargets: [{ tool: "message", provider: "discord", to: "channel:C1" }],
      },
    ],
  ] as const)(
    "surfaces a missing required answer after fallback with %s",
    async (_label, result) => {
      state.runEmbeddedAgentMock.mockResolvedValueOnce({
        ...result,
        payloads: [],
        meta: { terminalReply: { disposition: "empty" } },
      });
      using _ = vi
        .spyOn(modelFallbackModule, "runWithModelFallback")
        .mockImplementationOnce(makeCompletedFallbackRunner());

      const { run } = createDiscordFallbackRun();

      const res = await run();
      const payload = Array.isArray(res) ? res[0] : res;

      expect(payload).toMatchObject({ isError: true, text: expect.any(String) });
      expect(payload?.text).not.toContain("NO_REPLY");
      expect(payload?.text).toContain("configured model backend lmstudio/gemma-4-e4b-it");
      expect(payload?.text).toContain("Fallback used openai/gpt-5.5");
    },
  );

  it.each([
    ["direct chats", "direct", true, "on"],
    ["direct chats with verbosity off", "direct", true, "off"],
    ["group chats", "group", false, "on"],
    ["channels", "channel", false, "on"],
  ] as const)(
    "controls fallback notices for %s without changing state or lifecycle",
    async (_label, chatType, noticeVisible, verbose) => {
      const selected = {
        providerOverride: "anthropic",
        modelOverride: "claude",
        modelOverrideSource: "user" as const,
        modelProvider: "anthropic",
        model: "claude",
      };
      const { sessionStore, storePath } = await makeSessionFixture(selected);
      let callCount = 0;

      const onBlockReply = vi.fn();
      state.runEmbeddedAgentMock.mockImplementation(async (params) => {
        if (callCount !== 5) {
          return runSuccessfulReplyModelFixture(params);
        }
        await params.onBlockReply?.({ text: "streamed answer" });
        return { payloads: [], meta: {} };
      });
      using _ = vi
        .spyOn(modelFallbackModule, "runWithModelFallback")
        .mockImplementation(async (params) => {
          const { provider, model } = params;
          callCount += 1;
          if (callCount === 1) {
            expect({ provider, model }).toEqual({ provider: "anthropic", model: "claude" });
            await params.onFallbackStep?.({
              fallbackStepType: "fallback_step",
              fallbackStepFromModel: "anthropic/claude",
              fallbackStepToModel: "deepinfra/moonshotai/Kimi-K2.5",
              fallbackStepFromFailureReason: "rate_limit",
              fallbackStepFinalOutcome: "succeeded",
            });
          }
          if (callCount <= 2 || callCount === 5) {
            return makeCompletedFallbackRunner({
              provider: "deepinfra",
              model: "moonshotai/Kimi-K2.5",
              attempts: [
                {
                  provider: "fireworks",
                  model: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
                  error: "Provider fireworks is in cooldown (all profiles unavailable)",
                  reason: "rate_limit",
                },
              ],
            })(params);
          }
          return {
            outcome: "completed" as const,
            result: await runInitialModelFallbackAttempt(params),
            provider,
            model,
            attempts: [],
          };
        });

      let turnIndex = 0;
      const run = () =>
        createMinimalRun({
          resolvedVerboseLevel: verbose,
          blockStreamingEnabled: true,
          opts: { onBlockReply },
          sessionEntry: sessionStore.main,
          sessionStore,
          sessionKey: "main",
          storePath,
          sessionCtx: { ChatType: chatType, MessageSid: `fallback-${++turnIndex}` },
          runOverrides: { config: { channels: { whatsapp: { replyToMode: "first" } } } },
        }).run();
      const phases: string[] = [];
      const off = onAgentEvent((evt) => {
        const phase = typeof evt.data?.phase === "string" ? evt.data.phase : null;
        if (evt.stream === "lifecycle" && phase) {
          phases.push(phase);
        }
      });
      const first = await run();
      const activeFallback = {
        kind: "active" as const,
        selectedModel: "anthropic/claude",
        activeModel: "deepinfra/moonshotai/Kimi-K2.5",
        reason: "rate limit",
      };
      expect(sessionStore.main.fallbackNotice).toEqual(activeFallback);
      expect(requireStoredSessionEntry(storePath).fallbackNotice).toEqual(activeFallback);
      expect(requireStoredSessionEntry(storePath)).toMatchObject(selected);
      expect(phases.filter((phase) => phase === "fallback_step")).toHaveLength(1);
      if (noticeVisible) {
        expect(first).toEqual([
          expect.objectContaining({
            text: expect.stringContaining("Model Fallback:"),
            replyToId: "fallback-1",
          }),
          expect.objectContaining({ text: "final", replyToId: "fallback-1" }),
        ]);
      }
      const repeated = await run();
      const second = await run();
      const third = await run();

      const firstText = Array.isArray(first) ? first[0]?.text : first?.text;
      const secondText = Array.isArray(second) ? second[0]?.text : second?.text;
      const thirdText = Array.isArray(third) ? third[0]?.text : third?.text;
      expect(firstText?.includes("Model Fallback:")).toBe(noticeVisible);
      expect((Array.isArray(repeated) ? repeated[0] : repeated)?.text).not.toContain(
        "Model Fallback:",
      );
      expect(secondText?.includes("Model Fallback cleared:")).toBe(noticeVisible);
      expect(thirdText).not.toContain("Model Fallback cleared:");
      if (!noticeVisible) {
        expect(firstText).toBe("final");
        expect(secondText).toBe("final");
      }
      expect(phases.filter((phase) => phase === "fallback").length).toBe(1);
      expect(phases.filter((phase) => phase === "fallback_cleared").length).toBe(1);
      expect(sessionStore.main.fallbackNotice).toBeUndefined();
      expect(requireStoredSessionEntry(storePath).fallbackNotice).toBeUndefined();
      const resumed = await run();
      off();
      expect(
        (Array.isArray(resumed) ? resumed[0] : resumed)?.text?.includes("Model Fallback:"),
      ).toBe(noticeVisible);
      expect(phases.filter((phase) => phase === "fallback")).toHaveLength(2);
      expect(onBlockReply).toHaveBeenCalledWith(
        expect.objectContaining({ text: "streamed answer" }),
        expect.any(Object),
      );
      const resumedPayloads = Array.isArray(resumed) ? resumed : resumed ? [resumed] : [];
      expect(resumedPayloads).toHaveLength(noticeVisible ? 1 : 0);
      expect(resumedPayloads.some((payload) => payload.text?.includes("streamed answer"))).toBe(
        false,
      );
    },
  );

  it.each(successfulPolicyRetryCases)(
    "delivers successful policy retry notices to $label",
    async ({ chatType, retryProvider, retryModel, expectedNotice }) => {
      const fixture = await makeSessionFixture({
        modelProvider: "openai",
        model: "gpt-5.6-sol",
      });

      state.runEmbeddedAgentMock.mockResolvedValue({
        payloads: [{ text: "final" }],
        meta: {
          executionTrace: {
            winnerProvider: retryProvider,
            winnerModel: retryModel,
            providerPolicyRetry: {
              category: "cyber",
              provider: retryProvider,
              model: retryModel,
            },
          },
        },
      });
      using _ = vi
        .spyOn(modelFallbackModule, "runWithModelFallback")
        .mockImplementation(policyRetry(retryProvider, retryModel));

      const { run } = createSessionRun(fixture, {
        resolvedVerboseLevel: "on",
        sessionCtx: { ChatType: chatType },
      });

      const result = await run();
      expect(result).toEqual([
        expect.objectContaining({
          text: expectedNotice,
          isFallbackNotice: true,
        }),
        expect.objectContaining({ text: "final" }),
      ]);
    },
  );

  it("does not report an interrupted policy retry as successful", async () => {
    const fixture = await makeSessionFixture({
      modelProvider: "openai",
      model: "gpt-5.6-sol",
    });

    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "interrupted output" }],
      meta: { aborted: true },
    });
    using _ = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementation(policyRetry("openai", "gpt-5.5"));

    const { run } = createSessionRun(fixture, {
      resolvedVerboseLevel: "on",
      sessionCtx: { ChatType: "direct" },
    });

    const result = await run();
    const text = Array.isArray(result)
      ? result.map((payload) => payload.text).join("\n")
      : result?.text;
    expect(text).not.toContain("Retried on");
  });

  it("clears native fallback state without attributing finalizer response usage to the native model", async () => {
    const runtimeModelSelection = { provider: "openai", model: "gpt-5.6-sol" };
    const response = { provider: "google", model: "gemini-2.5-flash" };
    const selectedModelRef = `${runtimeModelSelection.provider}/${runtimeModelSelection.model}`;
    const responseModelRef = `${response.provider}/${response.model}`;
    const runId = "native-fallback-cleared";
    const usage = { input: 120, output: 8 };
    const fixture = await makeSessionFixture({
      modelProvider: runtimeModelSelection.provider,
      model: runtimeModelSelection.model,
      fallbackNotice: {
        kind: "active",
        selectedModel: selectedModelRef,
        activeModel: responseModelRef,
        reason: "timeout",
      },
    });
    const { storePath } = fixture;
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "finalized answer" }],
      meta: {
        agentMeta: {
          sessionId: "session",
          ...response,
          agentHarnessId: "codex",
          runtimeModelSelection,
          usage,
        },
      },
    });
    const { run } = createSessionRun(fixture, {
      opts: { runId },
      runOverrides: runtimeModelSelection,
      sessionCtx: { ChatType: "direct" },
    });
    const fallbackEvents: Array<Record<string, unknown>> = [];
    const off = onAgentEvent((event) => {
      if (
        event.runId === runId &&
        event.stream === "lifecycle" &&
        (event.data.phase === "fallback" || event.data.phase === "fallback_cleared")
      ) {
        fallbackEvents.push(event.data);
      }
    });
    try {
      const result = await run();
      const text = (Array.isArray(result) ? result : [result])
        .map((payload) => payload?.text ?? "")
        .join("\n");

      expect(requireStoredSessionEntry(storePath).fallbackNotice).toBeUndefined();
      expect(fallbackEvents).toEqual([
        expect.objectContaining({
          phase: "fallback_cleared",
          selectedProvider: runtimeModelSelection.provider,
          selectedModel: runtimeModelSelection.model,
          activeProvider: runtimeModelSelection.provider,
          activeModel: runtimeModelSelection.model,
          previousActiveModel: responseModelRef,
        }),
      ]);
      expect(text).toContain(`Model Fallback cleared: ${selectedModelRef}`);
      expect(text).toContain("finalized answer");
      expect(consumeReplyUsageState(runId)).toMatchObject({ ...response, usage });
    } finally {
      off();
    }
  });
});

import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
