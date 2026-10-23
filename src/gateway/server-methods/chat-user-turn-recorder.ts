import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import {
  createOperatorInputRecoverySource,
  createRestartRecoveryOperatorSource,
} from "../../agents/operator-run-recovery-source.js";
import { captureRequesterOrigin } from "../../agents/requester-origin.js";
import { createRestartRecoveryRequesterSource } from "../../agents/requester-run-recovery-source.js";
import type { InternalGetReplyOptions } from "../../auto-reply/reply/get-reply.types.js";
import { normalizeMessageClientSources } from "../../chat/message-client-source.js";
import { bindUserTurnInputActor } from "../../config/sessions/session-input-actor.js";
import {
  composeSessionSourceAssertion,
  prepareSessionSourceAuthority,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { isProgressCardRefreshInputProvenance } from "../../sessions/input-provenance.js";
import { getRpcSourceIdentity } from "../../sessions/session-controller.rpc-sources.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
  type UserTurnInput,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import type { UserTurnOriginalInputCommit } from "../../sessions/user-turn-transcript.types.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isBrowserOperatorUiClient,
} from "../../utils/message-channel.js";
import { readChatInputRecoveryAdmission } from "../chat-input-recovery-source.js";
import type { MentionInbox } from "../mention-inbox.types.js";
import { hasGatewayAdminScope } from "../operator-scopes.js";
import { captureWorkerTurnInputSource } from "../worker-environments/worker-turn-transcript-target.js";
import { formatForLog } from "../ws-log.js";
import { buildRestartSafeChatTranscriptState } from "./chat-restart-recovery.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import {
  resolveChatSendReplyContext,
  type ChatSendReplyContextFields,
} from "./chat-send-reply-context.js";
import { createChatInputRecovery, type NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { createChatSendGoalCommitGuard } from "./chat-send-work-admission.js";
import { gatewayClientSenderFields } from "./gateway-client-identity.js";
import type { GatewayClient } from "./shared-types.js";

export type GatewayChatUserTurnPersist = (options?: {
  contextFreeCommand?: true;
}) => ReturnType<UserTurnTranscriptRecorder["persistFallback"]>;

type GatewayChatUserTurnController = {
  baseInput: UserTurnInput;
  persist: GatewayChatUserTurnPersist;
  persistBestEffort: GatewayChatUserTurnPersist;
  recorder: UserTurnTranscriptRecorder;
  replyContextFieldsPromise?: Promise<ChatSendReplyContextFields>;
  getSessionInitializationOptions: () => Pick<
    InternalGetReplyOptions,
    | "requestedSessionId"
    | "resumeRequestedSession"
    | "expectedExistingSessionId"
    | "pinExpectedExistingSession"
    | "newlyCreatedSessionId"
    | "recordedSessionActivity"
  >;
  setInputPromise: (input: Promise<UserTurnInput>) => void;
};

export function createGatewayChatUserTurnController(params: {
  admission: AdmittedChatSend;
  isDirectExternalUser?: boolean;
  client: GatewayClient | null;
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  transcript?: Pick<UserTurnInput, "display" | "excludeFromContext">;
  startedAt: number;
  warn: (message: string) => void;
  mentionInbox?: MentionInbox;
  goalCommitGuard?: ReturnType<typeof createChatSendGoalCommitGuard>;
  assertOriginalInputCommit?: SessionSourceAssertion;
  onMessagePersisted?: () => void;
}): GatewayChatUserTurnController {
  const { admission, request, session } = params;
  const progressRefresh = isProgressCardRefreshInputProvenance(request.systemInputProvenance);
  const sender =
    request.goalOperation?.action === "resume"
      ? undefined
      : gatewayClientSenderFields(params.client).sender;
  const senderProfileId = params.client?.authenticatedUserProfile?.profileId;
  const toolCaller = params.client?.internal?.agentToolCaller;
  const requesterOrigin = captureRequesterOrigin({
    requesterOrigin: toolCaller?.requesterOrigin,
    sessionKey: session.sessionKey,
    operatorProfileId: toolCaller ? undefined : admission.operatorAuthority?.profileId,
    messageProvider: INTERNAL_MESSAGE_CHANNEL,
    agentAccountId: admission.originatingRoute.accountId,
    chatType: "direct",
    messageThreadId: admission.originatingRoute.messageThreadId,
    senderId: toolCaller ? undefined : sender?.id,
    senderName: toolCaller ? undefined : sender?.name,
  });
  const mentionInbox = params.mentionInbox;
  const sourceId = buildRunUserTurnIdempotencyKey(session.clientRunId);
  const recoveredInput = readChatInputRecoveryAdmission(session.clientRunId);
  const selectedMentions =
    recoveredInput?.target.message["__openclaw"]?.humanMentions ?? request.mentions;
  const recoveryEntry = admission.admittedSessionEntry ?? admission.initialSessionEntry;
  const recovery =
    recoveredInput || admission.restartSafeAdmission || !recoveryEntry
      ? undefined
      : createChatInputRecovery({
          request,
          source: createOperatorInputRecoverySource({
            authority: admission.operatorAuthority,
            entry: recoveryEntry,
            agentId: session.agentId,
            sessionKey: session.sessionKey,
            sourceRunId: session.clientRunId,
          }),
        });
  const sourceClients =
    !params.client?.internal?.syntheticClient &&
    (!request.systemInputProvenance || request.systemInputProvenance.kind === "external_user")
      ? normalizeMessageClientSources([request.clientInfo])
      : [];
  const baseInput: UserTurnInput = {
    ...params.transcript,
    ...(request.goalOperation?.action === "resume" || request.restartResume
      ? { display: false }
      : {}),
    text: request.rawMessage,
    requesterOrigin,
    ...(request.workContext ? { workContext: request.workContext } : {}),
    ...(request.mentions ? { mentions: request.mentions } : {}),
    timestamp: session.now,
    idempotencyKey: sourceId,
    ...(request.p.replyToId ? { replyToId: request.p.replyToId } : {}),
    ...(sender ? { sender } : {}),
    ...(sourceClients.length ? { transport: { clients: sourceClients } } : {}),
    ...(hasGatewayAdminScope(params.client) ? { senderIsOwner: true } : {}),
    ...(request.systemInputProvenance
      ? { provenance: request.systemInputProvenance }
      : admission.restartSafeAdmission && params.isDirectExternalUser
        ? { provenance: { kind: "external_user" } as const }
        : {}),
  };
  const replyContextFieldsPromise = request.p.replyToId
    ? resolveChatSendReplyContext({
        replyToId: request.p.replyToId,
        cfg: session.cfg,
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        sessionEntry: session.entry,
        storePath: session.storePath,
        userSenderLabel: request.clientInfo?.displayName,
        warn: params.warn,
      })
    : undefined;
  let inputPromise = replyContextFieldsPromise
    ? replyContextFieldsPromise.then((fields): UserTurnInput => ({
        ...baseInput,
        ...(fields.ReplyToBody
          ? {
              replyToPreview: {
                text: fields.ReplyToBody,
                ...(fields.ReplyToSender ? { senderLabel: fields.ReplyToSender } : {}),
              },
            }
          : {}),
      }))
    : Promise.resolve(baseInput);
  let contextFreeCommand = false;
  let mentionCommit: Promise<void> | undefined;
  const onPersistenceError = (error: unknown) =>
    params.warn(`gateway user transcript persistence failed: ${formatForLog(error)}`);
  const captureWorkerGoalSource = () =>
    captureWorkerTurnInputSource({
      agentId: session.agentId,
      sessionId: getRpcSourceIdentity(admission.sourceRef).sessionId,
      sessionKey: session.sessionKey,
    });
  const prepareWorkerGoalSource = async () =>
    prepareSessionSourceAuthority(captureWorkerGoalSource());
  const workerGoalSource: SessionSourceAssertion | undefined = admission.workerGoalAdmission
    ? Object.assign(() => captureWorkerGoalSource()(), {
        prepareSessionSource: prepareWorkerGoalSource,
        prepareSessionSourceScope: prepareWorkerGoalSource,
      })
    : undefined;
  const recorder: UserTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
    onMessagePersisted: params.onMessagePersisted,
    ...(recoveredInput ? { message: recoveredInput.target.message } : {}),
    // Attribution and submitted bytes survive reconnect; generated state does not.
    pendingInputRequestFingerprint:
      recoveredInput?.requestFingerprint ??
      request.goalOperation?.requestFingerprint ??
      (sender?.id
        ? sha256Hex(
            stableStringify([
              {
                ...request.p,
                sessionId: getRpcSourceIdentity(admission.sourceRef).sessionId,
                expectedLeafEntryId: undefined,
              },
              sender.identity ?? sender.id,
              hasGatewayAdminScope(params.client),
            ]),
          )
        : undefined),
    ...(request.goalOperation
      ? {
          sessionTurnMutation: {
            kind: "goal",
            operation: request.goalOperation,
            runId: session.clientRunId,
            ...params.goalCommitGuard,
            assertCurrent: admission.workerGoalAdmission
              ? composeSessionSourceAssertion([
                  params.goalCommitGuard?.assertCurrent,
                  workerGoalSource,
                ])
              : params.goalCommitGuard?.assertCurrent,
          },
        }
      : {}),
    input: baseInput,
    resolveInput: () => inputPromise,
    target: () => {
      // Retain only the current binding; transcript writers recheck it at commit.
      const target = session.sessionTarget;
      const sessionId = getRpcSourceIdentity(admission.sourceRef).sessionId;
      return {
        sessionId,
        expectedSessionId: sessionId,
        initialSessionEntry: admission.initialSessionEntry,
        sessionKey: target.storeKey,
        sessionEntry: undefined,
        storePath: target.storePath,
        agentId: session.agentId,
        config: session.cfg,
      };
    },
    ...(admission.restartSafeAdmission
      ? buildRestartSafeChatTranscriptState({
          admission: admission.restartSafeAdmission,
          clientRunId: session.clientRunId,
          startedAt: params.startedAt,
          ...(!progressRefresh ? { lastInteractionAt: params.startedAt } : {}),
          sourceIngress: isBrowserOperatorUiClient(request.clientInfo) ? "control-ui" : "internal",
          requesterSource: admission.restartSafeAdmission.retryExpectedState
            ? undefined
            : createRestartRecoveryRequesterSource({
                requesterOrigin,
                entry: admission.admittedSessionEntry ?? admission.initialSessionEntry!,
                agentId: session.agentId,
                sessionKey: session.sessionKey,
                sourceRunId: session.clientRunId,
              }),
          operatorSource: admission.restartSafeAdmission.retryExpectedState
            ? undefined
            : createRestartRecoveryOperatorSource({
                authority: admission.operatorAuthority,
                entry: admission.admittedSessionEntry ?? admission.initialSessionEntry!,
                agentId: session.agentId,
                sessionKey: session.sessionKey,
                sourceRunId: session.clientRunId,
                // Goal Resume is an authenticated operator action even though its
                // hidden transcript input is marked as an internal system message.
                inputProvenance:
                  request.goalOperation?.action === "resume"
                    ? undefined
                    : request.systemInputProvenance,
              }),
        })
      : {}),
    errorContext: "gateway chat user turn transcript",
    assertOriginalInputCommit: composeSessionSourceAssertion([
      params.assertOriginalInputCommit,
      admission.operatorAuthority?.assertCurrent,
    ]),
    beforeMessageWrite: (event) => {
      if (recoveredInput) {
        return event.message;
      }
      const originalInput = event.message.idempotencyKey === sourceId;
      const next = runAgentHarnessBeforeMessageWriteHook(event);
      if (originalInput && next?.role === "user") {
        const metadata = { ...asOptionalRecord(Reflect.get(next, "__openclaw")) };
        delete metadata.chatRequestIdentity;
        return {
          ...next,
          ...(contextFreeCommand ? { excludeFromContext: true } : {}),
          __openclaw: {
            ...metadata,
            ...(recovery ? { chatInputRecovery: recovery } : {}),
            ...(request.requestIdentity ? { chatRequestIdentity: request.requestIdentity } : {}),
            ...(contextFreeCommand ? { contextFreeCommand: true } : {}),
          },
        };
      }
      return next;
    },
    onPersistenceError,
    ...(selectedMentions && senderProfileId && mentionInbox
      ? {
          onOriginalInputCommitted: ({ message, anchor }: UserTurnOriginalInputCommit) => {
            const stored = message["__openclaw"]?.humanMentions;
            const text =
              extractTextFromChatContent(message.content, {
                joinWith: "\n",
                normalizeText: (value) => value,
              }) ?? "";
            const retained = recoveredInput
              ? selectedMentions
              : selectedMentions.filter(
                  (mention) =>
                    Array.isArray(stored) &&
                    stored.some((value) => {
                      const span = asOptionalRecord(value);
                      return (
                        span?.profileId === mention.profileId &&
                        span.start === mention.start &&
                        span.end === mention.end &&
                        text.slice(mention.start, mention.end) ===
                          request.rawMessage.slice(mention.start, mention.end)
                      );
                    }),
                );
            if (!retained.length) {
              params.warn(
                "Human mentions skipped because the committed text no longer contains the selected tokens.",
              );
              return;
            }
            mentionCommit = mentionInbox.recordCommittedInputAsync({
              sourceId,
              committedSource: {
                generation: anchor.generation,
                sequence: anchor.rawSeq,
                timestamp: message.timestamp,
              },
              agentId: anchor.agentId,
              sessionKey: session.sessionKey,
              sessionId: anchor.sessionId,
              messageId: anchor.entryId,
              senderProfileId,
              recipientProfileIds: retained.map((mention) => mention.profileId),
              excerpt: text,
            });
            void mentionCommit.catch(onPersistenceError);
          },
        }
      : {}),
  });
  bindUserTurnInputActor(recorder, { phase: "acceptInput", acquire: admission.acquireInputActor });
  const persist: GatewayChatUserTurnController["persist"] = async (options) => {
    if (options?.contextFreeCommand === true && !recorder.hasPersisted()) {
      contextFreeCommand = true;
    }
    // A setup/error fallback must not activate a Goal before placement admission.
    // The selected native harness promotes staged input through persistApproved.
    if (admission.workerGoalAdmission && !recorder.hasPersisted()) {
      return undefined;
    }
    const persisted = await measureDiagnosticsTimelineSpan(
      "gateway.chat_send.persist_user_transcript",
      () => recorder.persistFallback(),
      {
        phase: "agent-turn",
        config: session.cfg,
        attributes: admission.chatSendTraceAttributes,
      },
    );
    await mentionCommit;
    return persisted;
  };
  return {
    baseInput,
    persist,
    persistBestEffort: async (options) => {
      return await persist(options).catch(() => undefined);
    },
    recorder,
    replyContextFieldsPromise,
    getSessionInitializationOptions: () => ({
      requestedSessionId: session.requestedSessionId,
      resumeRequestedSession: request.reconnectResumeRequested || Boolean(request.restartResume),
      ...(request.restartResume ? { pinExpectedExistingSession: true } : {}),
      ...(admission.restartSafeAdmission || admission.workerGoalAdmission
        ? {
            expectedExistingSessionId: admission.admittedSessionId,
            pinExpectedExistingSession: true,
            newlyCreatedSessionId: admission.initialSessionEntry?.sessionId,
            ...(recorder.hasPersisted() && !progressRefresh
              ? {
                  recordedSessionActivity: {
                    sessionId: admission.admittedSessionId,
                    sessionKey: session.sessionKey,
                    at: params.startedAt,
                  },
                }
              : {}),
          }
        : session.entry?.sessionId
          ? { expectedExistingSessionId: session.entry.sessionId }
          : {}),
    }),
    setInputPromise: (input) => {
      const previousInputPromise = inputPromise;
      inputPromise = Promise.all([previousInputPromise, input]).then(([previous, next]) => ({
        ...previous,
        ...next,
        requesterOrigin: previous.requesterOrigin,
      }));
    },
  };
}
