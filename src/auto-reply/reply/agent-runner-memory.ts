import crypto from "node:crypto";
import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveEffectiveCompactionReserveTokens } from "../../agents/agent-compaction-constants.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import { MemoryFlushToolsUnavailableError } from "../../agents/agent-tools.memory-flush.js";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { isBenignCompactionSkipResult } from "../../agents/embedded-agent-runner/compact-reasons.js";
import type { AcceptedCompactionSuccessor } from "../../agents/embedded-agent-runner/compaction-successor.js";
import { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import { createDeferredEmbeddedRunLifecycleManager } from "../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox.js";
import { withSandboxRuntimeStatusInWorker } from "../../agents/sandbox/runtime-status.js";
import {
  resolvePersistedSessionRuntimeId,
  resolveSessionRuntimeOverrideForProvider,
} from "../../agents/session-runtime-compat.js";
import type { CompactionRequestBudget } from "../../agents/sessions/compaction/request-budget.js";
import {
  resolveAgentIdFromSessionKey,
  resolveFreshSessionTotalTokens,
  resolveSessionStorePathCore,
  SESSION_TOTAL_TOKENS_VERSION,
  type InternalSessionEntry as SessionEntry,
} from "../../config/sessions.js";
import {
  persistCompactionBoundaryWithSessionEntryAsync,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveMaxActiveTranscriptBytes,
  refreshTranscriptByteCompactionLatch,
} from "../../context-engine/transcript-byte-limit.js";
import { logVerbose } from "../../globals.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { emitAgentRunStatusEvent } from "../../infra/agent-run-status-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isMemoryFlushPlanNativeProviderOwned } from "../../plugins/memory-state.js";
import { CommandLane } from "../../process/lanes.js";
import { isIncognitoSessionKey, isUnscopedSessionKeySentinel } from "../../routing/session-key.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { VerboseLevel } from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  defersTokenCompactionToChatGPTBoundary,
  followupOwnsNativeCompaction,
  followupUsesCliRuntime,
  resolveFollowupAgentRuntimeId,
  resolveFollowupContextTokens,
} from "./agent-runner-memory-runtime.js";
import {
  estimatePromptTokensFromSessionTranscript,
  readSessionLogSnapshot,
  type TranscriptTokenEstimate,
} from "./agent-runner-memory-transcript-context.js";
import { buildRunEntrySelection } from "./agent-runner-run-params.js";
import {
  buildEmbeddedRunExecutionParams,
  buildModelResolveContext,
  resolveRunThinkingLevelForFallbackCandidate,
} from "./agent-runner-utils.js";
import {
  resolveCompactionCompletionNotice,
  type CompactionNoticePhase,
} from "./compaction-notice.js";
import {
  buildVisibleMemoryFlushFailure,
  resolveVisibleMemoryFlushErrorPayloads,
  truncateMemoryFlushErrorMessage,
} from "./memory-flush-errors.js";
import {
  isToolsMemoryFlushPlan,
  memoryFlushResultIsSilent,
  resolveMemoryFlushPlanForRun,
  type MemoryFlushPlanForRunResolution,
} from "./memory-flush-plan.js";
import {
  estimatePromptTokensForMemoryFlush,
  hasAlreadyFlushedForCurrentCompaction,
  resolveCompactionThreshold,
  resolveEffectivePromptTokens,
  resolveResponsesServerCompactionThreshold,
  shouldRunMemoryFlush,
  shouldRunPreflightCompaction,
} from "./memory-flush.js";
import { appendPostCompactionRefreshPrompt } from "./post-compaction-context.js";
import { refreshQueuedFollowupSession, type FollowupRun } from "./queue.js";
import { startFollowupRunPreAdoptionHeartbeat } from "./queue/lifecycle.js";
import { resolveFollowupAbortSignal } from "./queue/types.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { acknowledgeReplySessionTransition } from "./reply-run-registry.state.js";
import { incrementCompactionCount } from "./session-updates.js";

const MAX_FLUSH_FAILURES = 3;
const preflightCompactionLog = createSubsystemLogger("auto-reply/preflight-compaction");
const memoryFlushLog = createSubsystemLogger("auto-reply/memory-flush");

const embeddedAgentRuntimeLoader = createLazyImportLoader(
  () => import("../../agents/embedded-agent.js"),
);
const memoryFlushPreparationLoader = createLazyImportLoader(
  () => import("./memory-flush-prepare.js"),
);

// Leave room for large assistant outputs when checking near-threshold usage.
const TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS = 8192;

function projectPromptTokens(
  persistedPromptTokens: number | undefined,
  promptTokenEstimate: number | undefined,
  transcript: TranscriptTokenEstimate | undefined,
): number {
  const project = (promptTokens: number | undefined, outputTokens: number | undefined) =>
    typeof promptTokens === "number"
      ? resolveEffectivePromptTokens(promptTokens, outputTokens, promptTokenEstimate)
      : 0;
  return Math.max(
    project(persistedPromptTokens, transcript?.outputTokens),
    project(
      transcript?.promptTokens,
      transcript?.promptIncludesOutput ? undefined : transcript?.outputTokens,
    ),
  );
}

/** Compacts session context before a reply or after a completed direct command. */
export async function runSessionCompactionIfNeeded(params: {
  replyOperation?: ReplyOperation;
  pendingUserEntryId?: string;
  compactionRequestBudget?: CompactionRequestBudget;
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  promptForEstimate?: string;
  defaultModel: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  storePath?: string;

  /** Completed commands carry the actual harness, not the originally requested runtime. */
  agentHarnessId?: string;
  abortSignal?: AbortSignal;
  authorize?: () => boolean;
  beforeCompaction?: (entry: SessionEntry) => Promise<SessionEntry | undefined>;
  onCompactionStart?: () => void;
  onCompactionCommitted?: (accepted: AcceptedCompactionSuccessor) => void;
  onSessionIdChanged?: (sessionId: string) => void;
  onCompactionNotice?: (phase: CompactionNoticePhase, text?: string) => Promise<void> | void;
}): Promise<SessionEntry | undefined> {
  const operatorAuthority = params.followupRun.operatorAuthority;
  const assertActive = () => {
    params.abortSignal?.throwIfAborted();
    operatorAuthority?.assertCurrent();
    if (params.authorize?.() === false) {
      throw new Error("Session compaction maintenance is no longer active");
    }
  };
  if (!params.sessionKey) {
    return params.sessionEntry;
  }

  let entry = params.sessionEntry ?? params.sessionStore?.[params.sessionKey];
  if (!entry?.sessionId) {
    return entry;
  }

  const runtimeParams = { ...params, sessionEntry: entry };
  assertActive();
  const runtimeId = resolveFollowupAgentRuntimeId(runtimeParams);
  const isCli = followupUsesCliRuntime(runtimeParams, runtimeId);
  const ownsNativeCompaction = followupOwnsNativeCompaction(runtimeParams, runtimeId);
  if (isCli || ownsNativeCompaction) {
    return entry;
  }
  const isCodexRuntime = normalizeLowercaseStringOrEmpty(runtimeId) === "codex";

  const compactionSessionKey = params.sessionKey;
  const configuredAgentId = params.followupRun.run.agentId ?? resolveDefaultAgentId(params.cfg);
  const compactionAgentId = isUnscopedSessionKeySentinel(compactionSessionKey)
    ? configuredAgentId
    : resolveAgentIdFromSessionKey(compactionSessionKey, configuredAgentId);
  const compactionStorePath = resolveSessionStorePathForScope({
    agentId: compactionAgentId,
    sessionKey: compactionSessionKey,
    storePath:
      params.storePath ??
      resolveSessionStorePathCore(params.cfg.session?.store, { agentId: compactionAgentId }),
  });
  const compactionStore = params.sessionStore ?? { [compactionSessionKey]: entry };
  const compactionTarget = {
    agentId: compactionAgentId,
    sessionKey: compactionSessionKey,
    storePath: compactionStorePath,
  };
  const readTranscriptSize = (sessionId: string) =>
    readSessionLogSnapshot({
      ...compactionTarget,
      sessionId,
      includeByteSize: true,
      includeUsage: false,
      abortSignal: params.abortSignal,
    });

  const contextWindowTokens = resolveFollowupContextTokens(params, runtimeId);
  const memoryFlushPlan = resolveMemoryFlushPlanForRun({
    cfg: params.cfg,
    contextWindowTokens,
  })?.plan;
  const reserveTokensFloor =
    memoryFlushPlan?.reserveTokensFloor ??
    resolveEffectiveCompactionReserveTokens({
      contextTokenBudget: contextWindowTokens,
      reserveTokens: 20_000,
    });
  const freshPersistedTokens = resolveFreshSessionTotalTokens(entry);
  const promptTokenEstimate = estimatePromptTokensForMemoryFlush(
    params.promptForEstimate ?? params.followupRun.prompt,
  );
  const responsesServerCompactionThreshold = resolveResponsesServerCompactionThreshold({
    contextWindowTokens,
    cfg: params.cfg,
    provider: params.followupRun.run.provider,
    modelId: params.followupRun.run.model ?? params.defaultModel,
  });
  const threshold = resolveCompactionThreshold({
    contextWindowTokens,
    reserveTokensFloor,
    minimumThresholdTokens: responsesServerCompactionThreshold,
  });
  const freshNeedsOutputRead =
    typeof freshPersistedTokens === "number" &&
    typeof promptTokenEstimate === "number" &&
    threshold > 0 &&
    freshPersistedTokens + promptTokenEstimate >= threshold - TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS;
  const maxActiveTranscriptBytes = resolveMaxActiveTranscriptBytes(params.cfg);
  const shouldCheckActiveTranscriptBytes = typeof maxActiveTranscriptBytes === "number";
  const transcriptUsageTokens =
    isCodexRuntime || (typeof freshPersistedTokens === "number" && !freshNeedsOutputRead)
      ? undefined
      : await estimatePromptTokensFromSessionTranscript({
          ...compactionTarget,
          abortSignal: params.abortSignal,
          sessionId: entry.sessionId,
          contextWindowTokens,
        });
  const transcriptSizeSnapshot =
    shouldCheckActiveTranscriptBytes && transcriptUsageTokens?.transcriptByteSize === undefined
      ? await readTranscriptSize(entry.sessionId)
      : undefined;
  assertActive();
  const activeTranscriptBytes =
    transcriptUsageTokens?.transcriptByteSize ?? transcriptSizeSnapshot?.byteSize;
  const exceedsTranscriptByteThreshold =
    typeof activeTranscriptBytes === "number" &&
    typeof maxActiveTranscriptBytes === "number" &&
    activeTranscriptBytes >= maxActiveTranscriptBytes;
  let terminalCompactionNoticeSent = false;
  const notifyCompaction = async (phase: CompactionNoticePhase, text?: string) => {
    terminalCompactionNoticeSent = phase !== "start";
    try {
      await params.onCompactionNotice?.(phase, text);
    } catch (err) {
      logVerbose(`preflightCompaction notice delivery failed: ${String(err)}`);
    }
  };
  const latch = entry.transcriptByteCompactionLatch;
  // Codex still re-evaluates its native rollout fuse every turn; this only latches host-byte retries.
  const refreshedTranscriptByteCompactionLatch = refreshTranscriptByteCompactionLatch(
    latch,
    entry.sessionId,
    maxActiveTranscriptBytes,
    activeTranscriptBytes,
  );
  const transcriptByteCompactionLatched =
    exceedsTranscriptByteThreshold && refreshedTranscriptByteCompactionLatch !== undefined;
  if (refreshedTranscriptByteCompactionLatch !== latch) {
    const compactionCount = await incrementCompactionCount({
      ...compactionTarget,
      amount: 0,
      expectedSession: entry,
      sessionStore: compactionStore,
      transcriptByteCompactionLatch: refreshedTranscriptByteCompactionLatch ?? null,
    });
    assertActive();
    if (compactionCount === undefined) {
      throw new Error("Session changed before byte-compaction progress could be cleared");
    }
    entry = compactionStore[compactionSessionKey] ?? entry;
  }
  const shouldCompactByTranscriptBytes =
    exceedsTranscriptByteThreshold && !transcriptByteCompactionLatched;
  if (transcriptByteCompactionLatched) {
    await notifyCompaction("context_bounded");
    assertActive();
  }
  if (isCodexRuntime && !shouldCompactByTranscriptBytes) {
    // Codex owns native-thread token pressure; OpenClaw owns the host transcript byte fuse
    // that bounds fresh-thread bootstrap seeds.
    logVerbose(
      `preflightCompaction skipped: sessionKey=${params.sessionKey} runtime=codex ` +
        `reason=codex_native_auto_compaction ` +
        `activeTranscriptBytes=${activeTranscriptBytes ?? "undefined"} ` +
        `maxActiveTranscriptBytes=${maxActiveTranscriptBytes ?? "undefined"}`,
    );
    return entry;
  }
  const transcriptPromptTokens = transcriptUsageTokens?.promptTokens;
  const projectedTokenCount = projectPromptTokens(
    freshPersistedTokens,
    promptTokenEstimate,
    transcriptUsageTokens,
  );
  const tokenCountForCompaction = asPositiveFiniteNumber(projectedTokenCount);

  logVerbose(
    `preflightCompaction check: sessionKey=${params.sessionKey} ` +
      `tokenCount=${tokenCountForCompaction ?? freshPersistedTokens ?? "undefined"} ` +
      `contextWindow=${contextWindowTokens} threshold=${threshold} ` +
      `responsesServerCompactionThreshold=${responsesServerCompactionThreshold ?? "undefined"} ` +
      `isCli=${isCli} ` +
      `persistedFresh=${entry?.totalTokensFresh === true} ` +
      `transcriptPromptTokens=${transcriptPromptTokens ?? "undefined"} ` +
      `transcriptPromptSource=${transcriptUsageTokens?.promptTokenSource ?? "undefined"} ` +
      `promptTokensEst=${promptTokenEstimate ?? "undefined"} ` +
      `activeTranscriptBytes=${activeTranscriptBytes ?? "undefined"} ` +
      `maxActiveTranscriptBytes=${maxActiveTranscriptBytes ?? "undefined"} ` +
      `sizeTrigger=${shouldCompactByTranscriptBytes} ` +
      `sizeTriggerLatched=${transcriptByteCompactionLatched}`,
  );

  const shouldCompactByTokens = shouldRunPreflightCompaction({
    entry,
    tokenCount: tokenCountForCompaction,
    threshold,
  });
  if (!shouldCompactByTokens && !shouldCompactByTranscriptBytes) {
    return entry;
  }

  if (params.beforeCompaction) {
    const refreshed = await params.beforeCompaction(entry);
    assertActive();
    // Memory checkpointing may refresh source usage; replan once without repeating it.
    return runSessionCompactionIfNeeded({
      ...params,
      sessionEntry: refreshed,
      beforeCompaction: undefined,
    });
  }

  if (
    shouldCompactByTokens &&
    !shouldCompactByTranscriptBytes &&
    (await defersTokenCompactionToChatGPTBoundary(params.followupRun.run))
  ) {
    assertActive();
    return entry;
  }

  const compactionTrigger = shouldCompactByTranscriptBytes ? "transcript_bytes" : "tokens";
  logVerbose(
    `preflightCompaction triggered: sessionKey=${params.sessionKey} ` +
      `tokenCount=${tokenCountForCompaction ?? freshPersistedTokens ?? "undefined"} ` +
      `threshold=${threshold} trigger=${compactionTrigger} ` +
      `activeTranscriptBytes=${activeTranscriptBytes ?? "undefined"} ` +
      `maxActiveTranscriptBytes=${maxActiveTranscriptBytes ?? "undefined"}`,
  );

  assertActive();
  params.onCompactionStart?.();
  // Provider work can outlive the caller; never account against a replacement session row.
  let expectedSession = entry;
  let admissionTransition: AcceptedCompactionSuccessor["admissionTransition"];
  let hostAccountingCommitted = false;
  const recordCompactionAccounting = async (
    acceptedEntry: SessionEntry,
    tokensAfter: number | undefined,
    compactionKind: Parameters<typeof incrementCompactionCount>[0]["compactionKind"],
    amount = 1,
  ) => {
    const postCompactionBytes = exceedsTranscriptByteThreshold
      ? (await readTranscriptSize(acceptedEntry.sessionId)).byteSize
      : undefined;
    assertActive();
    const transcriptByteCompactionLatch =
      typeof postCompactionBytes === "number" &&
      typeof maxActiveTranscriptBytes === "number" &&
      postCompactionBytes >= maxActiveTranscriptBytes
        ? {
            activeBytes: postCompactionBytes,
            sessionId: acceptedEntry.sessionId,
            maxBytes: maxActiveTranscriptBytes,
          }
        : undefined;
    const compactionCount = await incrementCompactionCount({
      ...compactionTarget,
      sessionStore: compactionStore,
      amount,
      tokensAfter,
      compactionKind,
      expectedSession: acceptedEntry,
      transcriptByteCompactionLatch: transcriptByteCompactionLatch ?? null,
      authorize: () => {
        assertActive();
        return true;
      },
    });
    if (compactionCount === undefined) {
      throw new Error("Session changed before compaction maintenance could be recorded");
    }
  };
  const stopHeartbeat = startFollowupRunPreAdoptionHeartbeat(
    params.followupRun.turnAdoptionLifecycle,
    params.abortSignal,
  );
  try {
    await notifyCompaction("start");
    assertActive();
    const runtime = await embeddedAgentRuntimeLoader.load();
    const result = await runtime.compactEmbeddedAgentSession(
      {
        sessionId: entry.sessionId,
        sessionKey: compactionSessionKey,
        sessionTarget: { ...compactionTarget, sessionId: entry.sessionId },
        sandboxSessionKey: params.runtimePolicySessionKey,
        allowGatewaySubagentBinding: true,
        messageChannel: params.followupRun.run.messageProvider,
        clientCaps: params.followupRun.run.clientCaps,
        conversationToolPolicy: params.followupRun.run.conversationToolPolicy,
        groupId: entry.groupId ?? params.followupRun.run.groupId,
        groupChannel: entry.groupChannel ?? params.followupRun.run.groupChannel,
        groupSpace: entry.space ?? params.followupRun.run.groupSpace,
        senderId: params.followupRun.run.senderId,
        senderName: params.followupRun.run.senderName,
        senderUsername: params.followupRun.run.senderUsername,
        senderE164: params.followupRun.run.senderE164,
        inputProvenance: params.followupRun.run.inputProvenance,
        sessionFile: compactionSessionKey,
        workspaceDir: params.followupRun.run.workspaceDir,
        cwd: params.followupRun.run.cwd,
        agentDir: params.followupRun.run.agentDir,
        config: params.cfg,
        // Group session keys do not encode account identity, so without this the
        // preflight path resolves the root history limit after prompt preparation
        // already used the account limit.
        agentAccountId: params.followupRun.run.agentAccountId,
        conversationRoutePeerId: params.followupRun.run.conversationRoutePeerId,
        chatType: params.followupRun.run.chatType,
        skillsSnapshot: entry.skillsSnapshot ?? params.followupRun.run.skillsSnapshot,
        provider: params.followupRun.run.provider,
        model: params.followupRun.run.model,
        authProfileId: params.followupRun.run.authProfileId,
        authProfileIdSource: params.followupRun.run.authProfileIdSource,
        sessionEntry: entry,
        agentHarnessId:
          params.agentHarnessId ??
          (entry.sessionId === params.followupRun.run.sessionId
            ? entry.modelSelectionLocked === true
              ? resolvePersistedSessionRuntimeId(entry)
              : runtimeId
            : undefined),
        modelSelectionLocked: entry.modelSelectionLocked === true,
        thinkLevel: params.followupRun.run.thinkLevel,
        bashElevated: params.followupRun.run.bashElevated,
        trigger: "budget",
        force: true,
        forcePreflight: true,
        preflightRequired: true,
        preflightCompactionTrigger: compactionTrigger,
        deferOwningContextEngineCompaction: false,
        contextTokenBudget: contextWindowTokens,
        currentTokenCount: tokenCountForCompaction ?? freshPersistedTokens,
        ownerNumbers: params.followupRun.run.ownerNumbers,
        abortSignal: params.abortSignal,
      },
      {
        assertActive,
        sourceAuthority: { assertActive, operatorAuthority },
        requestBudget: params.compactionRequestBudget,
        pendingUserEntryId: params.pendingUserEntryId,
        ...(compactionTrigger === "transcript_bytes" && isCodexRuntime
          ? {
              transcriptBytePreflightHarness: "codex" as const,
              ...(compactionTarget.storePath &&
              typeof activeTranscriptBytes === "number" &&
              typeof maxActiveTranscriptBytes === "number"
                ? {
                    withCompactionPersistenceAsync: async (prepared) => {
                      const committed = await persistCompactionBoundaryWithSessionEntryAsync(
                        {
                          ...compactionTarget,
                          expectedLifecycleRevision: expectedSession.lifecycleRevision,
                          expectedWriterRunId: expectedSession.activeWriterRunId,
                          sessionId: expectedSession.sessionId,
                        },
                        {
                          prepared,
                          transcriptByteCompactionLatch: {
                            activeBytes: activeTranscriptBytes,
                            sessionId: expectedSession.sessionId,
                            maxBytes: maxActiveTranscriptBytes,
                          },
                        },
                        assertActive,
                      );
                      hostAccountingCommitted = true;
                      return committed;
                    },
                  }
                : {}),
              onHostCompactionTranscriptSettled: async (commit) => {
                await recordCompactionAccounting(commit.entry, undefined, undefined, 0);
              },
            }
          : {}),
        // Record every host compaction while its session lane still excludes the next writer.
        onHostCompactionCommitted: async (commit) => {
          await recordCompactionAccounting(
            commit.entry,
            commit.tokensAfter,
            commit.compactionKind,
            hostAccountingCommitted ? 0 : 1,
          );
          hostAccountingCommitted = true;
        },
        onCommitted: (accepted) => {
          admissionTransition = accepted.admissionTransition;
          expectedSession = accepted.entry;
          entry = accepted.entry;
          compactionStore[compactionSessionKey] = accepted.entry;
          params.onCompactionCommitted?.(accepted);
        },
      },
    );

    if (!result?.ok || !result.compacted) {
      assertActive();
      const reason =
        (result?.ok ? normalizeOptionalString(result.reason) : result?.reason) ?? "not_compacted";
      if (!exceedsTranscriptByteThreshold && result && isBenignCompactionSkipResult(result)) {
        await notifyCompaction("skipped");
        logVerbose(`preflightCompaction skipped: sessionKey=${params.sessionKey} reason=${reason}`);
        return entry;
      }
      preflightCompactionLog.warn(`preflight compaction failed: ${reason}`);
      if (exceedsTranscriptByteThreshold) {
        await recordCompactionAccounting(expectedSession, undefined, undefined, 0);
        assertActive();
        await notifyCompaction("context_bounded");
        return compactionStore[compactionSessionKey] ?? entry;
      }
      await notifyCompaction("incomplete");
      throw new Error(`Preflight compaction required but failed: ${reason}`);
    }

    if (params.replyOperation && admissionTransition) {
      await acknowledgeReplySessionTransition(params.replyOperation, admissionTransition);
      assertActive();
    }
    if (!hostAccountingCommitted) {
      await recordCompactionAccounting(
        expectedSession,
        result.result?.tokensAfter,
        result.compactionKind,
      );
    }
    assertActive();
    entry = compactionStore[compactionSessionKey] ?? entry;
    const transcriptByteCompactionLatch = entry.transcriptByteCompactionLatch;
    if (transcriptByteCompactionLatch) {
      preflightCompactionLog.warn(
        "byte-triggered compaction left oversized history; continuing with bounded context",
        {
          sessionKey: compactionSessionKey,
          activeTranscriptBytes: transcriptByteCompactionLatch.activeBytes,
          maxActiveTranscriptBytes: transcriptByteCompactionLatch.maxBytes,
        },
      );
    }
    await appendPostCompactionRefreshPrompt({
      cfg: params.cfg,
      followupRun: params.followupRun,
    });
    assertActive();
    const notice = resolveCompactionCompletionNotice(
      result,
      Boolean(transcriptByteCompactionLatch),
    );
    await notifyCompaction(notice.phase, notice.text);
    assertActive();
    entry = compactionStore[compactionSessionKey] ?? entry;
    const previousSessionId = params.followupRun.run.sessionId;
    params.followupRun.run.sessionId = entry.sessionId;
    params.onSessionIdChanged?.(entry.sessionId);
    const queueKey = params.followupRun.run.sessionKey ?? params.sessionKey;
    if (queueKey) {
      params.followupRun.run.sessionFile = queueKey;
      refreshQueuedFollowupSession({
        key: queueKey,
        previousSessionId,
        nextSessionId: entry.sessionId,
        nextSessionFile: queueKey,
      });
    }
    return entry;
  } catch (err) {
    if (!terminalCompactionNoticeSent && !params.abortSignal?.aborted) {
      await notifyCompaction("incomplete");
    }
    throw err;
  } finally {
    stopHeartbeat?.();
  }
}

type MemoryFlushOutcome = "skipped" | "completed" | "failed" | "exhausted";

type MemoryFlushResult = {
  sessionEntry?: SessionEntry;
  outcome: MemoryFlushOutcome;
};

type MemoryFlushRunParams = Parameters<typeof runMemoryFlushIfNeeded>[0];

/** Runs pre-compaction memory flush when transcript state warrants it. */
export async function runMemoryFlushIfNeeded(params: {
  /** Supplied only by required preflight, while this admitted input is unprocessed. */
  preflightAdmission?: UserTurnTranscriptAdmissionReceipt;
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  promptForEstimate?: string;
  opts?: Pick<GetReplyOptions, "promptCacheKey" | "runId">;
  defaultModel: string;
  resolvedVerboseLevel: VerboseLevel;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  storePath?: string;
  replyOperation?: ReplyOperation;
  abortSignal?: AbortSignal;
}): Promise<MemoryFlushResult> {
  const abortSignal = resolveFollowupAbortSignal({
    abortSignal: params.replyOperation?.abortSignal ?? params.abortSignal,
    operatorAuthority: params.followupRun.operatorAuthority,
  });
  const assertMemoryFlushCurrent = () => {
    abortSignal?.throwIfAborted();
    params.followupRun.operatorAuthority?.assertCurrent();
  };
  const memoryFlushWritable =
    !params.sessionKey ||
    (await withSandboxRuntimeStatusInWorker(
      {
        cfg: params.cfg,
        agentId: params.followupRun.run.agentId,
        sessionKey: params.sessionKey,
        classificationSessionKey: params.runtimePolicySessionKey,
      },
      { env: process.env, cwd: process.cwd(), assertCurrent: assertMemoryFlushCurrent },
      async ({ sandboxed, workspaceAccess: access, classificationAgentId: agentId }) =>
        !sandboxed ||
        (access ?? resolveSandboxConfigForAgent(params.cfg, agentId).workspaceAccess) === "rw",
    ));

  let entry =
    params.sessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  if (entry?.incognito === true || isIncognitoSessionKey(params.sessionKey)) {
    return { sessionEntry: entry, outcome: "skipped" };
  }
  const runtimeParams = { ...params, sessionEntry: entry };
  const runtimeId = resolveFollowupAgentRuntimeId(runtimeParams);
  const isCli =
    followupUsesCliRuntime(runtimeParams, runtimeId) ||
    followupOwnsNativeCompaction(runtimeParams, runtimeId);
  // Only a native provider's flush can persist without a writable workspace, so other
  // resolvers are never called for a session whose workspace cannot be written.
  const canAttemptFlush = (memoryFlushWritable || isMemoryFlushPlanNativeProviderOwned()) && !isCli;
  if (!canAttemptFlush) {
    return { sessionEntry: entry, outcome: "skipped" };
  }

  const flushRunId = crypto.randomUUID();
  let flushRunRegistered = false;
  const recordFailure = (error: unknown) => recordMemoryFlushFailure(error, params, entry);
  const contextWindowTokens = resolveFollowupContextTokens(params, runtimeId);
  let memoryFlushResolution: MemoryFlushPlanForRunResolution | null;
  try {
    memoryFlushResolution = resolveMemoryFlushPlanForRun({ cfg: params.cfg, contextWindowTokens });
  } catch (error) {
    return await recordFailure(error);
  }
  if (!memoryFlushResolution) {
    return { sessionEntry: entry, outcome: "skipped" };
  }
  const memoryFlushPlan = memoryFlushResolution.plan;
  if (!isToolsMemoryFlushPlan(memoryFlushPlan) && !memoryFlushWritable) {
    return { sessionEntry: entry, outcome: "skipped" };
  }

  const promptTokenEstimate = estimatePromptTokensForMemoryFlush(
    params.promptForEstimate ?? params.followupRun.prompt,
  );
  const persistedPromptTokens = resolveFreshSessionTotalTokens(entry);
  const hasFreshPersistedPromptTokens = persistedPromptTokens !== undefined;

  // The soft margin belongs only to early flushing, leaving room before blocking compaction.
  const flushThreshold = Math.max(
    0,
    resolveCompactionThreshold({
      contextWindowTokens,
      reserveTokensFloor: memoryFlushPlan.reserveTokensFloor,
    }) - Math.max(0, Math.floor(memoryFlushPlan.softThresholdTokens)),
  );

  // When totals are stale/unknown, derive prompt + last output from transcript so memory
  // flush can still be evaluated against projected next-input size.
  //
  // When totals are fresh, only read the transcript when we're close enough to the
  // threshold that missing the last output tokens could flip the decision.
  const shouldReadTranscriptForOutput =
    entry &&
    hasFreshPersistedPromptTokens &&
    typeof promptTokenEstimate === "number" &&
    flushThreshold > 0 &&
    persistedPromptTokens + promptTokenEstimate >=
      flushThreshold - TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS;

  const shouldReadTranscript = Boolean(
    entry && (!hasFreshPersistedPromptTokens || shouldReadTranscriptForOutput),
  );

  const forceFlushTranscriptBytes = memoryFlushPlan.forceFlushTranscriptBytes;
  const shouldCheckTranscriptSizeForForcedFlush = Boolean(
    entry && Number.isFinite(forceFlushTranscriptBytes) && forceFlushTranscriptBytes > 0,
  );
  const sessionLogSnapshot = entry
    ? await readSessionLogSnapshot({
        agentId: params.followupRun.run.agentId,
        sessionId: params.followupRun.run.sessionId,
        sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
        storePath: params.storePath,
        includeByteSize: shouldCheckTranscriptSizeForForcedFlush,
        includeTurnTaint: true,
        includeUsage: shouldReadTranscript,
        abortSignal,
      })
    : undefined;
  assertMemoryFlushCurrent();
  const transcriptByteSize = sessionLogSnapshot?.byteSize;
  const shouldForceFlushByTranscriptSize =
    typeof transcriptByteSize === "number" && transcriptByteSize >= forceFlushTranscriptBytes;

  const transcriptUsageTokens =
    shouldReadTranscript && entry
      ? await estimatePromptTokensFromSessionTranscript(
          {
            agentId:
              params.followupRun.run.agentId ??
              resolveAgentIdFromSessionKey(params.sessionKey ?? params.followupRun.run.sessionKey),
            sessionId: entry.sessionId,
            sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
            storePath: params.storePath,
            contextWindowTokens,
            abortSignal,
          },
          sessionLogSnapshot,
        )
      : undefined;
  const transcriptPromptTokens = transcriptUsageTokens?.promptTokens;
  const transcriptOutputTokens = transcriptUsageTokens?.outputTokens;
  const shouldPersistTranscriptPromptTokens =
    transcriptPromptTokens !== undefined &&
    transcriptUsageTokens?.promptTokenSource !== "prompt_projection" &&
    (persistedPromptTokens === undefined || transcriptPromptTokens > persistedPromptTokens);

  assertMemoryFlushCurrent();
  if (entry && shouldPersistTranscriptPromptTokens) {
    const usageUpdate = {
      totalTokens: transcriptPromptTokens,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    };
    entry = { ...entry, ...usageUpdate };
    if (params.sessionKey && params.sessionStore) {
      params.sessionStore[params.sessionKey] = entry;
    }
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await updateSessionEntry(
          {
            storePath: params.storePath,
            sessionKey: params.sessionKey,
          },
          () => usageUpdate,
          {
            skipMaintenance: true,
            takeCacheOwnership: true,
          },
        );
        if (updatedEntry) {
          entry = updatedEntry;
          if (params.sessionStore) {
            params.sessionStore[params.sessionKey] = updatedEntry;
          }
        }
      } catch (err) {
        logVerbose(`failed to persist derived prompt totalTokens: ${String(err)}`);
      }
    }
  }

  const projectedTokenCount = projectPromptTokens(
    asPositiveFiniteNumber(persistedPromptTokens),
    promptTokenEstimate,
    transcriptPromptTokens === 0 ? undefined : transcriptUsageTokens,
  );
  const tokenCountForFlush = asPositiveFiniteNumber(projectedTokenCount);

  logVerbose(
    `memoryFlush check: sessionKey=${params.sessionKey} ` +
      `tokenCount=${tokenCountForFlush ?? "undefined"} ` +
      `contextWindow=${contextWindowTokens} threshold=${flushThreshold} ` +
      `isCli=${isCli} memoryFlushWritable=${memoryFlushWritable} ` +
      `compactionCount=${entry?.compactionCount ?? 0} memoryFlushCompactionCount=${entry?.memoryFlush?.compactionCount ?? "undefined"} ` +
      `persistedPromptTokens=${persistedPromptTokens ?? "undefined"} persistedFresh=${entry?.totalTokensFresh === true} ` +
      `promptTokensEst=${promptTokenEstimate ?? "undefined"} transcriptPromptTokens=${transcriptPromptTokens ?? "undefined"} transcriptOutputTokens=${transcriptOutputTokens ?? "undefined"} ` +
      `projectedTokenCount=${projectedTokenCount ?? "undefined"} transcriptBytes=${transcriptByteSize ?? "undefined"} ` +
      `forceFlushTranscriptBytes=${forceFlushTranscriptBytes} forceFlushByTranscriptSize=${shouldForceFlushByTranscriptSize}`,
  );

  const shouldFlushMemory =
    shouldRunMemoryFlush({
      entry,
      tokenCount: tokenCountForFlush,
      threshold: flushThreshold,
    }) ||
    (shouldForceFlushByTranscriptSize &&
      entry != null &&
      !hasAlreadyFlushedForCurrentCompaction(entry));

  if (!shouldFlushMemory) {
    return { sessionEntry: entry, outcome: "skipped" };
  }

  logVerbose(
    `memoryFlush triggered: sessionKey=${params.sessionKey} tokenCount=${tokenCountForFlush ?? "undefined"} threshold=${flushThreshold}`,
  );

  params.replyOperation?.setPhase("memory_flushing");
  let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    entry?.systemPromptReport ??
      (params.sessionKey
        ? params.sessionStore?.[params.sessionKey]?.systemPromptReport
        : undefined),
  );
  let persistenceToolCallSucceeded = false;
  let preparedAttempt: Awaited<
    ReturnType<typeof import("./memory-flush-prepare.js").prepareMemoryFlushAttempt>
  >;
  try {
    assertMemoryFlushCurrent();
    const runtime = await memoryFlushPreparationLoader.load();
    preparedAttempt = await runtime.prepareMemoryFlushAttempt({
      ...params,
      sessionEntry: entry,
      flushRunId,
      contextWindowTokens,
      memoryFlushWritable,
      abortSignal,
      assertCurrent: assertMemoryFlushCurrent,
      recordPersistenceToolSuccess: () => {
        persistenceToolCallSucceeded = true;
      },
    });
  } catch (error) {
    return await recordFailure(error);
  }
  if (!preparedAttempt) {
    return { sessionEntry: entry, outcome: "skipped" };
  }
  const {
    plan: activeMemoryFlushPlan,
    writePath: memoryFlushWritePath,
    systemPrompt: flushSystemPrompt,
    selection,
    preparedRunAdmission,
    memorySession,
    memoryAudience: flushMemoryAudience,
    memoryFlushTools,
    maintenanceRun,
    sourcePolicySessionKey,
  } = preparedAttempt;
  const deferredLifecycle = createDeferredEmbeddedRunLifecycleManager({
    runId: flushRunId,
    sessionId: memorySession.sessionId,
    sessionKey: memorySession.sessionKey,
    sessionFile: memorySession.sessionFile,
    abortSignal,
  });
  const flushedCompactionCount = entry?.compactionCount ?? 0;
  let visibleErrorPayloads: ReplyPayload[] = [];
  // Only the bounded phase belongs to the parent turn; maintenance content stays private.
  const parentRunId = params.opts?.runId;
  if (parentRunId) {
    emitAgentRunStatusEvent({
      runId: parentRunId,
      sessionKey: params.sessionKey,
      phase: "memory_flushing",
    });
  }
  const { turnAdoptionLifecycle } = params.followupRun;
  const stopHeartbeat = startFollowupRunPreAdoptionHeartbeat(turnAdoptionLifecycle, abortSignal);
  // Only runnable maintenance owns a run context. The matching finally is
  // the sole cleanup path so setup, execution, and persistence exits cannot orphan it.
  try {
    if (params.sessionKey) {
      registerAgentRunContext(flushRunId, {
        sessionKey: memorySession.sessionKey,
        sessionId: memorySession.sessionId,
        verboseLevel: params.resolvedVerboseLevel,
        isControlUiVisible: false,
        projectSessionActive: false,
        projectSessionLifecycle: false,
        projectSessionMessages: false,
      });
      flushRunRegistered = true;
    }
    memoryFlushLog.debug("memory flush dispatched", {
      event: "memory_flush_dispatched",
      runId: flushRunId,
      sessionKey: memorySession.sessionKey,
      sessionId: memorySession.sessionId,
      sourceSessionKey: params.sessionKey,
      sourceSessionId: entry?.sessionId,
    });
    const flushExecution = await runEmbeddedAgentEntry({
      preparedRunAdmission,
      modelResolve: {
        prompt: activeMemoryFlushPlan.prompt,
        cwd: maintenanceRun.cwd,
        modelSelectionLocked: maintenanceRun.modelSelectionLocked,
        context: buildModelResolveContext({
          run: maintenanceRun,
          sessionCtx: {},
          hasRepliedRef: undefined,
          trigger: "memory",
        }),
      },
      selection: buildRunEntrySelection(selection, params.followupRun.run),
      identity: {
        runId: flushRunId,
        agentId: params.followupRun.run.agentId,
        sessionId: memorySession.sessionId,
        sessionKey: memorySession.sessionKey,
        lane: CommandLane.Main,
      },
      harness: {
        workspaceDir: params.followupRun.run.workspaceDir,
        sessionKey: sourcePolicySessionKey,
        preparation: { kind: "direct" },
        resolveRuntimeOverride: (provider) =>
          resolveSessionRuntimeOverrideForProvider({
            provider,
            entry,
            cfg: params.cfg,
          }),
      },
      behavior: { kind: "maintenance" },
      sessionOverride: { kind: "preserve" },
      abortSignal: deferredLifecycle.signal,
      runCandidate: async (provider, model, runOptions) => {
        const sessionRuntimeOverride = runOptions.agentHarnessRuntimeOverride;
        const candidateThinkLevel = resolveRunThinkingLevelForFallbackCandidate({
          cfg: params.cfg,
          provider,
          modelId: model,
          run: params.followupRun.run,
          catalog: params.followupRun.run.thinkingCatalog,
          agentId: params.followupRun.run.agentId,
          sessionKey: sourcePolicySessionKey,
          sessionEntry: entry,
          agentRuntime: sessionRuntimeOverride,
        });
        const runBaseParams = await buildEmbeddedRunExecutionParams({
          run: {
            ...maintenanceRun,
            thinkLevel: candidateThinkLevel,
          },
          sessionCtx: {},
          hasRepliedRef: undefined,
          provider,
          model,
          runId: flushRunId,
          promptCacheKey: params.opts?.promptCacheKey,
          allowTransientCooldownProbe: runOptions.allowTransientCooldownProbe,
        });
        const runtime = await embeddedAgentRuntimeLoader.load();
        const result = await runtime.runEmbeddedAgent({
          preparedRunAdmission,
          ...runBaseParams,
          ...memorySession,
          agentHarnessId: resolveSessionPinnedHarnessId(entry),
          agentHarnessRuntimeOverride: sessionRuntimeOverride,
          sandboxSessionKey: sourcePolicySessionKey,
          memoryAudience: flushMemoryAudience,
          allowGatewaySubagentBinding: true,
          silentExpected: true,
          allowEmptyAssistantReplyAsSilent: true,
          terminalReplyExpectation: "optional",
          trigger: "memory",
          contextTokenBudget: contextWindowTokens,
          memoryFlushWritePath,
          memoryFlushTools,
          initialTurnTainted:
            !params.followupRun.run.senderIsOwner || sessionLogSnapshot?.turnTainted === true,
          prompt: activeMemoryFlushPlan.prompt,
          transcriptPrompt: "",
          extraSystemPrompt: flushSystemPrompt,
          isFinalFallbackAttempt: runOptions.isFinalFallbackAttempt,
          resolvedModelSelection: runOptions.resolvedModelSelection,
          modelFallbacksOverride: runOptions.modelFallbacksOverride,
          bootstrapPromptWarningSignaturesSeen,
          bootstrapPromptWarningSignature: bootstrapPromptWarningSignaturesSeen.at(-1),
          abortSignal: deferredLifecycle.signal,
          onDeferredLifecycleOwner: deferredLifecycle.adopt,
          onDeferredLifecycleAbort: deferredLifecycle.abort,
          onRetryWait: deferredLifecycle.beginRetryWait,
          assistantErrorTranscript: runOptions.assistantErrorTranscript,
          authProfileFailurePolicy: runOptions.authProfileFailurePolicy,
          contextEngineLogicalTurnLease: runOptions.contextEngineLogicalTurnLease,
          onContextEngineTurnCandidate: runOptions.onContextEngineTurnCandidate,
        });
        visibleErrorPayloads = resolveVisibleMemoryFlushErrorPayloads(result.payloads);
        bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
          result.meta?.systemPromptReport,
        );
        return result;
      },
    });
    deferredLifecycle.signal.throwIfAborted();
    if (visibleErrorPayloads.length > 0) {
      // Do not stamp memory-flush success for a resolved run that returned an error.
      throw buildVisibleMemoryFlushFailure(visibleErrorPayloads);
    }
    if (
      memoryFlushTools &&
      !persistenceToolCallSucceeded &&
      !memoryFlushResultIsSilent(flushExecution.result)
    ) {
      throw new Error("no persistence tool call succeeded");
    }
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await updateSessionEntry(
          { storePath: params.storePath, sessionKey: params.sessionKey },
          async () => ({
            memoryFlush: { kind: "succeeded", compactionCount: flushedCompactionCount },
          }),
          { skipMaintenance: true, takeCacheOwnership: true },
        );
        if (updatedEntry) {
          entry = updatedEntry;
        }
      } catch (err) {
        logVerbose(`failed to persist memory flush metadata: ${String(err)}`);
      }
    }
    return { sessionEntry: entry, outcome: "completed" };
  } catch (error) {
    if (error instanceof MemoryFlushToolsUnavailableError) {
      memoryFlushLog.warn(error.message);
      return { sessionEntry: entry, outcome: "skipped" };
    }
    return await recordFailure(error);
  } finally {
    stopHeartbeat?.();
    if (parentRunId && !abortSignal?.aborted) {
      emitAgentRunStatusEvent({
        runId: parentRunId,
        sessionKey: params.sessionKey,
        phase: "preparing_context",
      });
    }
    await deferredLifecycle.complete();
    if (flushRunRegistered) {
      clearAgentRunContext(flushRunId);
    }
    preparedRunAdmission.close();
    preparedAttempt.release();
  }
}

async function recordMemoryFlushFailure(
  error: unknown,
  run: MemoryFlushRunParams,
  initialSessionEntry?: SessionEntry,
): Promise<MemoryFlushResult> {
  let sessionEntry = initialSessionEntry;
  let outcome: MemoryFlushOutcome = "failed";
  // Caller cancellation may use any reason, not only an AbortError instance.
  if ((run.replyOperation?.abortSignal ?? run.abortSignal)?.aborted) {
    logVerbose("memory flush cancelled by its owner");
    return { sessionEntry, outcome };
  }
  const truncatedError = truncateMemoryFlushErrorMessage(error);
  const { sessionKey, storePath } = run;
  if (!isAbortError(error) && storePath && sessionKey) {
    try {
      const adoptEntry = (entry: SessionEntry | null) => {
        if (entry) {
          sessionEntry = entry;
          if (run.sessionStore) {
            run.sessionStore[sessionKey] = entry;
          }
        }
      };
      const updateEntry = (update: Parameters<typeof updateSessionEntry>[1]) =>
        updateSessionEntry({ storePath, sessionKey }, update, {
          skipMaintenance: true,
          takeCacheOwnership: true,
        });
      const failedEntry = await updateEntry(async (currentEntry) => ({
        memoryFlush: {
          kind: "failed",
          ...(currentEntry.memoryFlush?.compactionCount !== undefined
            ? { compactionCount: currentEntry.memoryFlush.compactionCount }
            : {}),
          failureCount:
            (currentEntry.memoryFlush?.kind === "failed"
              ? currentEntry.memoryFlush.failureCount
              : 0) + 1,
        },
      }));
      adoptEntry(failedEntry);
      const failureCount =
        failedEntry?.memoryFlush?.kind === "failed" ? failedEntry.memoryFlush.failureCount : 0;
      logVerbose(
        `memory flush failed (attempt ${failureCount}/${MAX_FLUSH_FAILURES}): ${truncatedError}`,
      );
      if (failedEntry && failureCount >= MAX_FLUSH_FAILURES) {
        outcome = "exhausted";
        logVerbose(
          `memory flush exhausted: skipping flush for this compaction cycle after ${failureCount} consecutive failures`,
        );
        const exhaustedEntry = await updateEntry(async (currentEntry) => ({
          memoryFlush: {
            kind: "succeeded",
            compactionCount: currentEntry.compactionCount ?? 0,
          },
        }));
        adoptEntry(exhaustedEntry);
      }
    } catch (persistError) {
      logVerbose(`failed to persist memory flush failure metadata: ${String(persistError)}`);
    }
  } else {
    logVerbose(`memory flush run failed: ${String(error)}`);
  }
  return { sessionEntry, outcome };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
