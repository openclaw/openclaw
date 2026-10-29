import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { renderAgentHarnessPreflightUserMessage } from "../../agents/embedded-agent-helpers/user-facing-text.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { selectLiveRuntimeConfig } from "../../config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../../config/runtime-source-projection.js";
import type { SessionEntry } from "../../config/sessions.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { TypingMode } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import { logVerbose } from "../../globals.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import type { ReplyOperation, ReplyTurnKind } from "../../sessions/session-controller.js";
import {
  attachSessionControllerInputOperation,
  bindSessionControllerInputOperation,
  claimSessionControllerInput,
  releaseSessionControllerClaim,
  type SessionControllerMailboxClaim,
} from "../../sessions/session-controller.mailbox.js";
import { readPendingUserTurnTranscriptAdmission } from "../../sessions/user-turn-transcript-admission.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel-constants.js";
import { prepareCommandOwnerAuthority } from "../command-auth.js";
import {
  bindCommandOwnerAuthority,
  captureCommandOwnerAssertion,
} from "../command-owner-authority.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import { normalizeVerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { resolveRunAfterAutoFallbackPrimaryProbeRecheck } from "./agent-runner-auto-fallback.js";
import { buildPreflightCompactionFailureText } from "./agent-runner-failure-reply.js";
import { runMemoryFlushIfNeeded, runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import { resolveQueuedReplyExecutionConfig } from "./agent-runner-utils.js";
import {
  shouldNotifyUserAboutCompaction,
  type CompactionNoticePhase,
} from "./compaction-notice.js";
import { settleQueuedFollowupPresentation } from "./followup-presentation.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import {
  isGoalContinuationCurrent,
  isGoalContinuationPlacementCurrent,
} from "./goal-continuation.js";
import { refreshActiveGoalContext } from "./inbound-meta.js";
import { getFollowupQueueDepth } from "./queue/enqueue.js";
import {
  isFollowupRunAborted,
  resolveFollowupAbortSignal,
  type FollowupRun,
} from "./queue/types.js";
import { prepareReplySourceAdmission } from "./reply-source-admission.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import type { createReplyTurnRotationEvidence } from "./reply-turn-rotation.js";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";
import type { TypingController } from "./typing.js";

export type FollowupRunnerParams = {
  resolveGatewayContext?: GatewayContextResolver;
  opts?: InternalGetReplyOptions;
  typing: TypingController;
  typingMode: TypingMode;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  toolProgressDetail?: "explain" | "raw";
};

type FollowupSessionOwner = {
  current: () => SessionEntry | undefined;
  publish(entry: SessionEntry | undefined): void;
} & ({ kind: "detached" } | { kind: "session"; key: string; storePath?: string });

export type AdmittedFollowupTurn = {
  readonly runId: string;
  queued: FollowupRun;
  operation: ReplyOperation;
  config: OpenClawConfig;
  session: FollowupSessionOwner;
  sessionStore?: Record<string, SessionEntry>;
  sendPolicy: "allow" | "deny";
  preflightCompactionApplied: boolean;
  memoryFlushAttempted?: boolean;
  preflightFailurePayload?: ReplyPayload;
  preflightError?: Error;
  releaseSourceAdmission?: () => Promise<void>;
};

function isSameSessionGeneration(
  left: SessionEntry | undefined,
  right: SessionEntry | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.sessionId === right.sessionId &&
    left.lifecycleRevision === right.lifecycleRevision,
  );
}

type PrepareReplyAgentTurnParams<TConfigured> = {
  queued: FollowupRun;
  defaults: FollowupRunnerParams;
  kind?: ReplyTurnKind;
  resetTriggered?: boolean;
  routeThreadId?: string | number;
  providedReplyOperation?: ReplyOperation;
  rotationEvidence?: ReturnType<typeof createReplyTurnRotationEvidence>;
  claimSource?: () => Promise<SessionControllerMailboxClaim | undefined>;
  onOperationOwned?: (operation: ReplyOperation) => boolean | void;
  configure?: (config: OpenClawConfig) => Promise<TConfigured> | TConfigured;
  signalRunStart?: () => Promise<void>;
  trace?: <T>(phase: string, run: () => Promise<T>) => Promise<T>;
  onCompactionNotice?: (
    phase: CompactionNoticePhase,
    text: string | undefined,
    turn: AdmittedFollowupTurn,
  ) => Promise<void>;
};

type PreparedReplyAgentTurn<TConfigured> =
  | { kind: "admitted"; configured: TConfigured; turn: AdmittedFollowupTurn }
  | {
      kind: "skipped";
      reason: "active-run" | "aborted" | "lifecycle-invalidated" | "goal-inactive";
      operation?: ReplyOperation;
    };

/** Claims and prepares immediate and queued turns through one admission and preflight owner. */
export function prepareReplyAgentTurn<TConfigured>(
  params: PrepareReplyAgentTurnParams<TConfigured> & {
    configure: (config: OpenClawConfig) => Promise<TConfigured> | TConfigured;
  },
): Promise<PreparedReplyAgentTurn<TConfigured>>;
export function prepareReplyAgentTurn(
  params: PrepareReplyAgentTurnParams<undefined>,
): Promise<PreparedReplyAgentTurn<undefined>>;
export async function prepareReplyAgentTurn<TConfigured>(
  params: PrepareReplyAgentTurnParams<TConfigured>,
): Promise<PreparedReplyAgentTurn<TConfigured | undefined>> {
  const assertOperatorCurrent = () => params.queued.operatorAuthority?.assertCurrent();
  assertOperatorCurrent();
  const readAdmissionConfig = () =>
    params.queued.readAdmissionConfig?.() ?? selectLiveRuntimeConfig(params.queued.run.config);
  let config = captureRuntimeConfig(params.queued.run.config);
  const existingClaim = params.queued.controllerInput?.claim;
  const claimQueuedFirst = !params.providedReplyOperation && !params.claimSource;
  let mailboxClaim: SessionControllerMailboxClaim | undefined;
  try {
    // Queued sources become selectable by Stop before asynchronous preparation.
    if (claimQueuedFirst) {
      mailboxClaim = await claimSessionControllerInput(params.queued);
    }
    if (!claimQueuedFirst && !params.providedReplyOperation) {
      mailboxClaim = await params.claimSource?.();
    }
    if (!mailboxClaim && !params.providedReplyOperation) {
      return {
        kind: "skipped",
        reason: resolveFollowupAbortSignal(params.queued)?.aborted ? "aborted" : "active-run",
      } as const;
    }
    const replySessionKey = params.queued.run.sessionKey ?? params.defaults.sessionKey;
    const initialStoredEntry = replySessionKey
      ? params.defaults.sessionStore?.[replySessionKey]
      : undefined;
    const initialEntry =
      initialStoredEntry ??
      (replySessionKey === params.defaults.sessionKey ? params.defaults.sessionEntry : undefined);
    let run = { ...params.queued.run, config };
    const resolveRunSessionFile = (source: FollowupRun["run"]) =>
      normalizeOptionalString(replySessionKey) ?? source.sessionFile;
    const kind = params.kind ?? "queued_followup";
    const sourceSignal = resolveFollowupAbortSignal(params.queued);
    const admission = params.providedReplyOperation
      ? {
          status: "owned" as const,
          operation: params.providedReplyOperation,
          sessionEntry: initialEntry,
        }
      : await admitReplyTurn({
          mailboxClaim,
          rotationEvidence: params.rotationEvidence,
          runId: params.queued.controllerInput?.protocolRunId,
          onDatabaseRegistration: params.defaults.opts?.onDatabaseRegistration,
          providerReviewAcknowledgment: params.defaults.opts?.providerReviewAcknowledgment,
          agentId: run.agentId,
          resolveGatewayContext: params.defaults.resolveGatewayContext,
          sessionId: params.queued.admissionSessionId ?? run.sessionId,
          sessionKey: replySessionKey ?? "",
          expectedSessionId: initialEntry?.sessionId,
          storePath: params.defaults.storePath,
          kind,
          // Settings writers can refresh this queued source while admission waits.
          // Capture configuration and selection at the admission owner’s writer fence, before any
          // source-adoption await. Session identity and authority keep their original
          // bindings; later preference edits cannot alter this detached turn selection.
          captureRunSelection: () => {
            const selected = params.queued.run;
            config = captureRuntimeConfig(readAdmissionConfig());
            run = {
              ...run,
              config,
              provider: selected.provider,
              model: selected.model,
              requestedRouteResolution: selected.requestedRouteResolution,
              hasAutoFallbackProvenance: selected.hasAutoFallbackProvenance,
              autoFallbackPrimaryProbe: selected.autoFallbackPrimaryProbe
                ? { ...selected.autoFallbackPrimaryProbe }
                : undefined,
              hasSessionModelOverride: selected.hasSessionModelOverride,
              modelOverrideSource: selected.modelOverrideSource,
              // Scheduled fallback policy is derived from the selection; its authority stays bound.
              ...(run.scheduledAutomation
                ? {
                    scheduledAutomation: {
                      ...run.scheduledAutomation,
                      modelFallbackPolicy: selected.scheduledAutomation?.modelFallbackPolicy,
                    },
                  }
                : {}),
              authProfileId: selected.authProfileId,
              authProfileIdSource: selected.authProfileIdSource,
              thinkLevel: selected.thinkLevel,
              thinkingCatalog: selected.thinkingCatalog,
              cyberAccessProgram: selected.cyberAccessProgram,
            };
          },
          resetTriggered: params.resetTriggered === true,
          routeThreadId: params.routeThreadId ?? params.queued.originatingThreadId,
          originatingLeafEntryId: params.queued.turnAdoptionLifecycle?.originatingLeafEntryId,
          upstreamAbortSignal:
            sourceSignal && mailboxClaim
              ? AbortSignal.any([sourceSignal, mailboxClaim.abortController.signal])
              : (sourceSignal ?? mailboxClaim?.abortController.signal),
        });
    if (admission.status === "skipped") {
      if (admission.error) {
        params.queued.run.internalEventExecution?.onFailed?.(admission.error);
      }
      if (!existingClaim && mailboxClaim) {
        releaseSessionControllerClaim(mailboxClaim);
      }
      return {
        kind: "skipped",
        reason:
          kind === "queued_followup" && admission.reason === "active-run"
            ? "lifecycle-invalidated"
            : admission.reason,
      } as const;
    }
    const operation = admission.operation;
    const assertAdmissionCurrent = () => {
      assertOperatorCurrent();
      operation.abortSignal.throwIfAborted();
      if (operation.result) {
        throw new Error("Reply execution is no longer current");
      }
    };
    if (params.providedReplyOperation) {
      attachSessionControllerInputOperation(params.queued, operation);
    } else {
      bindSessionControllerInputOperation(params.queued, operation);
    }
    const selectionEntry = admission.sessionEntry ?? initialEntry;
    const admittedSelectionEntry = selectionEntry ? { ...selectionEntry } : undefined;
    // An edit before enqueue can miss the queue refresh; admission owns the saved preference.
    if (kind === "queued_followup" && admission.sessionEntry) {
      run.cyberAccessProgram = admittedSelectionEntry?.cyberAccessProgram;
    }
    let queuedFollowupAdmitted = false;
    let admissionFailed = false;
    let callerOwnsOperation = false;
    let releaseSourceAdmission: (() => Promise<void>) | undefined;
    try {
      callerOwnsOperation = params.onOperationOwned?.(operation) === true;
      params.queued.run.onOperationAdmitted?.(operation);
      if (isFollowupRunAborted(params.queued)) {
        return { kind: "skipped", reason: "aborted", operation } as const;
      }

      // The queued source retains its runner, including its own dispatcher callbacks.
      if (kind === "queued_followup") {
        queuedFollowupAdmitted = true;
        await params.defaults.opts?.onQueuedFollowupAdmitted?.();
      }
      config = await resolveQueuedReplyExecutionConfig(config, {
        originatingChannel: params.queued.originatingChannel,
        messageProvider: run.messageProvider,
        originatingAccountId: params.queued.originatingAccountId,
        agentAccountId: run.agentAccountId,
      });
      assertAdmissionCurrent();
      run = { ...run, config };
      const origin = run.requesterOrigin;
      if (
        !params.providedReplyOperation &&
        origin?.messageProvider &&
        !origin.operatorProfileId &&
        origin.messageProvider !== INTERNAL_MESSAGE_CHANNEL &&
        !run.internalEventExecution &&
        !run.sessionEventOrigin
      ) {
        const owner = await prepareCommandOwnerAuthority(config, {
          channel: origin.messageProvider,
          accountId: origin.accountId ?? undefined,
          senderId: origin.senderId ?? undefined,
          senderE164: origin.senderE164 ?? undefined,
        });
        assertAdmissionCurrent();
        run.senderIsOwner = owner.isCurrent(config);
        run.traceAuthorized = run.senderIsOwner;
        // Refresh configured policy only on the newly admitted execution's projection.
        bindCommandOwnerAuthority(run, {
          recoveryReference: owner.recoveryReference,
          isCurrent: () => owner.isCurrent(readAdmissionConfig()),
        });
        if (run.senderIsOwner) {
          captureCommandOwnerAssertion(run)?.();
        }
      }
      const configured = await params.configure?.(config);
      assertAdmissionCurrent();
      const sessionRotated = operation.sessionId !== run.sessionId;
      const admissionEntry =
        admission.sessionEntry?.sessionId === operation.sessionId
          ? admission.sessionEntry
          : undefined;
      let activeEntry =
        admissionEntry ??
        (initialEntry?.sessionId === operation.sessionId ? initialEntry : undefined);
      const goalContinuation = params.queued.goalContinuation;
      if (goalContinuation) {
        const goalEntry =
          replySessionKey && params.defaults.storePath
            ? await readSessionEntryInWorker({
                storePath: params.defaults.storePath,
                sessionKey: replySessionKey,
              })
            : activeEntry;
        assertOperatorCurrent();
        if (
          !isGoalContinuationCurrent(goalContinuation, goalEntry) ||
          getFollowupQueueDepth(replySessionKey ?? "") > 0
        ) {
          return { kind: "skipped", reason: "goal-inactive", operation } as const;
        }
      }
      const lifecycleRevisionChanged =
        operation.sessionId === params.queued.run.sessionId &&
        activeEntry?.sessionId === operation.sessionId &&
        activeEntry.lifecycleRevision !==
          (initialEntry?.sessionId === operation.sessionId
            ? initialEntry.lifecycleRevision
            : undefined);
      if (sessionRotated || activeEntry?.sessionId === operation.sessionId) {
        run = {
          ...run,
          ...(sessionRotated ? { sessionId: operation.sessionId } : {}),
          sessionFile: resolveRunSessionFile(run),
          modelSelectionLocked: activeEntry?.modelSelectionLocked === true,
          ...(sessionRotated || lifecycleRevisionChanged
            ? {
                cliSessionBindingFacts: undefined,
                autoFallbackPrimaryProbe: undefined,
              }
            : {}),
        };
      }
      run = resolveRunAfterAutoFallbackPrimaryProbeRecheck({
        run,
        // Preferences stay fixed at admission; lifecycle checks and compaction
        // independently consume current session state.
        entry: admittedSelectionEntry,
        sessionKey: replySessionKey,
      });
      const queued: FollowupRun = { ...params.queued, run };
      const sessionEntryHandle = createReplySessionEntryHandle({
        sessionEntry: activeEntry,
        sessionKey: replySessionKey,
        sessionStore: params.defaults.sessionStore,
      });
      const session: FollowupSessionOwner = {
        ...(replySessionKey
          ? { kind: "session" as const, key: replySessionKey, storePath: params.defaults.storePath }
          : { kind: "detached" as const }),
        current: () => sessionEntryHandle.getCurrent(),
        publish: (entry) => entry && sessionEntryHandle.replaceCurrent(entry),
      };
      const sessionStore = replySessionKey
        ? sessionEntryHandle.toCompatSessionStore()
        : params.defaults.sessionStore;
      const resolveTurnSendPolicy = (
        entry: SessionEntry | undefined,
        source: FollowupRun = queued,
      ) =>
        resolveSendPolicy({
          cfg: config,
          entry,
          sessionKey: source.run.runtimePolicySessionKey ?? replySessionKey,
          channel:
            source.originatingChannel ??
            source.run.messageProvider ??
            sessionDeliveryChannel(entry),
          chatType: normalizeChatType(
            source.originatingChatType ?? source.run.chatType ?? entry?.chatType,
          ),
        });
      const currentInboundContext = refreshActiveGoalContext(
        queued.currentInboundContext,
        activeEntry,
      );
      // Preallocate the one lifecycle identity passed as opts.runId; canonical
      // execution owns registration and cleanup under this same id.
      const turn: AdmittedFollowupTurn = {
        runId:
          params.queued.controllerInput?.protocolRunId ??
          (kind !== "queued_followup" ? params.defaults.opts?.runId : undefined) ??
          crypto.randomUUID(),
        queued: { ...queued, currentInboundContext },
        operation,
        config,
        session,
        sessionStore,
        sendPolicy: resolveTurnSendPolicy(activeEntry),
        preflightCompactionApplied: false,
      };
      const readNoticeSessionEntry = async () =>
        replySessionKey && params.defaults.storePath
          ? await readSessionEntryInWorker({
              storePath: params.defaults.storePath,
              sessionKey: replySessionKey,
            })
          : replySessionKey && params.defaults.sessionStore
            ? params.defaults.sessionStore[replySessionKey]
            : session.current();
      const refreshTurnSessionState = (
        entry: SessionEntry | undefined,
        previousEntry: SessionEntry | undefined,
      ) => {
        const generationRotated = Boolean(entry && !isSameSessionGeneration(entry, previousEntry));
        if (entry && generationRotated) {
          operation.updateSessionId(entry.sessionId);
          turn.queued = {
            ...turn.queued,
            run: {
              ...turn.queued.run,
              sessionId: entry.sessionId,
              sessionFile: resolveRunSessionFile(turn.queued.run),
              cliSessionBindingFacts: undefined,
              autoFallbackPrimaryProbe: undefined,
              modelSelectionLocked: entry.modelSelectionLocked === true,
            },
          };
        }
        const refreshedInboundContext = refreshActiveGoalContext(
          params.queued.currentInboundContext,
          entry,
        );
        turn.sendPolicy = resolveTurnSendPolicy(entry, turn.queued);
        turn.queued = { ...turn.queued, currentInboundContext: refreshedInboundContext };
        return generationRotated;
      };
      const previousCompactionCount = activeEntry?.compactionCount ?? 0;
      let pendingTerminalCompactionNotice:
        | { phase: Exclude<CompactionNoticePhase, "start">; text?: string }
        | undefined;
      const notifyPreflightCompaction =
        turn.sendPolicy === "allow" && queued.currentInboundEventKind !== "room_event"
          ? async (phase: CompactionNoticePhase, text?: string) => {
              if (
                phase !== "context_bounded" &&
                phase !== "degraded" &&
                !shouldNotifyUserAboutCompaction(config)
              ) {
                return;
              }
              if (
                kind === "queued_followup" &&
                phase !== "start" &&
                phase !== "memory_flush_degraded"
              ) {
                pendingTerminalCompactionNotice = { phase, text };
                return;
              }
              const noticeEntry = await readNoticeSessionEntry();
              if (resolveTurnSendPolicy(noticeEntry, turn.queued) === "deny") {
                return;
              }
              await params.onCompactionNotice?.(phase, text, turn);
            }
          : undefined;
      releaseSourceAdmission = await prepareReplySourceAdmission({
        operation,
        followupRun: turn.queued,
        recorder: turn.queued.userTurnTranscriptRecorder,
        runId: turn.runId,
      });
      turn.releaseSourceAdmission = releaseSourceAdmission;
      const preflightEntry = session.current();
      try {
        await params.signalRunStart?.();
        const resolvedVerboseLevel =
          normalizeVerboseLevel(
            turn.queued.run.verboseLevelOverride ??
              activeEntry?.verboseLevel ??
              turn.queued.run.verboseLevel,
          ) ?? "off";
        const preparation = {
          cfg: config,
          followupRun: turn.queued,
          promptForEstimate: turn.queued.prompt,
          defaultModel: params.defaults.defaultModel,
          sessionEntry: activeEntry,
          sessionStore,
          sessionKey: replySessionKey,
          storePath: params.defaults.storePath,
          opts: { ...params.defaults.opts, runId: turn.runId },
          resolvedVerboseLevel,
          runtimePolicySessionKey: turn.queued.run.runtimePolicySessionKey,
          onCompactionNotice: notifyPreflightCompaction,
        };
        const preflightAdmission = readPendingUserTurnTranscriptAdmission(
          preparation.followupRun.userTurnTranscriptRecorder,
        );
        const trace = params.trace;
        const tracePhase = <T>(phase: string, runPhase: () => Promise<T>) =>
          trace ? trace(phase, runPhase) : runPhase();
        try {
          activeEntry = await tracePhase("reply.preflight_compaction", () =>
            runSessionCompactionIfNeeded({
              ...preparation,
              replyOperation: operation,
              pendingUserEntryId: preflightAdmission?.entryId,
              abortSignal: operation.abortSignal,
              // Compaction decides whether work is needed, then replans from the
              // checkpoint result. A queued source must not bypass this memory write.
              beforeCompaction: async (entry) => {
                const flushed = await tracePhase("reply.memory_flush", () =>
                  runMemoryFlushIfNeeded({
                    ...preparation,
                    preflightAdmission,
                    replyOperation: operation,
                    abortSignal: operation.abortSignal,
                    sessionEntry: entry,
                  }),
                );
                turn.memoryFlushAttempted ||= flushed.outcome !== "skipped";
                session.publish(flushed.sessionEntry);
                operation.abortSignal.throwIfAborted();
                if (flushed.outcome === "exhausted") {
                  await preparation.onCompactionNotice?.("memory_flush_degraded");
                }
                return flushed.sessionEntry;
              },
              onCompactionStart: () => operation.setPhase("preflight_compacting"),
              onSessionIdChanged: (sessionId) => operation.updateSessionId(sessionId),
            }),
          );
        } catch (error) {
          const recorder = preparation.followupRun.userTurnTranscriptRecorder;
          if (recorder && buildPreflightCompactionFailureText(formatErrorMessage(error)) !== null) {
            try {
              // Keep approved input after failed maintenance without claiming a recovery turn.
              await recorder.persistApproved({
                expectedSessionId: operation.sessionId,
                beforeFreshMessageCommit: () => {
                  operation.abortSignal.throwIfAborted();
                  preparation.followupRun.operatorAuthority?.assertCurrent();
                  if (operation.lifecycleGeneration) {
                    assertAgentRunLifecycleGenerationCurrent(operation.lifecycleGeneration);
                  }
                },
              });
            } catch (persistError) {
              logVerbose(
                `user turn not kept after failed preflight: ${formatErrorMessage(persistError)}`,
              );
            }
          }
          throw error;
        }
        if (activeEntry) {
          session.publish(activeEntry);
          activeEntry = session.current() ?? activeEntry;
        }
        const generationRotated = refreshTurnSessionState(activeEntry, preflightEntry);
        turn.preflightCompactionApplied =
          generationRotated || (activeEntry?.compactionCount ?? 0) > previousCompactionCount;
      } catch (error) {
        const failureEntry = session.current();
        if (failureEntry) {
          session.publish(failureEntry);
          activeEntry = session.current() ?? failureEntry;
        }
        refreshTurnSessionState(activeEntry, preflightEntry);
        turn.preflightError = toErrorObject(error, "Reply preparation failed");
        const admittedVerboseLevel =
          turn.queued.run.verboseLevelOverride ??
          session.current()?.verboseLevel ??
          turn.queued.run.verboseLevel;
        const text =
          renderAgentHarnessPreflightUserMessage(error) ??
          buildPreflightCompactionFailureText(formatErrorMessage(error), {
            includeDetails: admittedVerboseLevel === "on" || admittedVerboseLevel === "full",
          });
        if (text) {
          turn.preflightFailurePayload = markReplyPayloadForSourceSuppressionDelivery({ text });
        }
      }
      if (
        pendingTerminalCompactionNotice &&
        turn.sendPolicy === "allow" &&
        turn.queued.currentInboundEventKind !== "room_event"
      ) {
        const noticeEntry = await readNoticeSessionEntry();
        if (resolveTurnSendPolicy(noticeEntry, turn.queued) === "allow") {
          await params.onCompactionNotice?.(
            pendingTerminalCompactionNotice.phase,
            pendingTerminalCompactionNotice.text,
            turn,
          );
        }
      }
      if (goalContinuation) {
        const currentEntry =
          replySessionKey && params.defaults.storePath
            ? await readSessionEntryInWorker({
                storePath: params.defaults.storePath,
                sessionKey: replySessionKey,
              })
            : session.current();
        const placementCurrent = await isGoalContinuationPlacementCurrent({
          continuation: goalContinuation,
          agentId: run.agentId,
          sessionKey: replySessionKey ?? "",
          hasOperatorAuthority: Boolean(params.queued.operatorAuthority),
          requiresWorker: Boolean(run.config?.cloudWorkers?.requiredProfile),
        });
        assertOperatorCurrent();
        if (
          !placementCurrent ||
          operation.abortSignal.aborted ||
          !isGoalContinuationCurrent(goalContinuation, currentEntry) ||
          getFollowupQueueDepth(replySessionKey ?? "") > 0
        ) {
          return { kind: "skipped", reason: "goal-inactive", operation } as const;
        }
      }
      // Only a returned turn transfers presentation cleanup to the runner.
      queuedFollowupAdmitted = false;
      releaseSourceAdmission = undefined;
      return { kind: "admitted", configured, turn } as const;
    } catch (error) {
      admissionFailed = true;
      const failure = error instanceof Error ? error : new Error(formatErrorMessage(error));
      if (!operation.result) {
        operation.fail("run_failed", failure);
      }
      throw failure;
    } finally {
      try {
        if (queuedFollowupAdmitted) {
          await settleQueuedFollowupPresentation(params.defaults.opts?.onQueuedFollowupSettled);
        }
      } finally {
        try {
          await releaseSourceAdmission?.();
        } finally {
          if (admissionFailed && !callerOwnsOperation) {
            operation.complete();
          }
        }
      }
    }
  } catch (error) {
    if (!existingClaim && mailboxClaim) {
      releaseSessionControllerClaim(mailboxClaim);
    }
    throw error;
  }
}
