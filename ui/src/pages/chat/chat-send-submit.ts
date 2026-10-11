import { shouldForwardModelCommandToServer } from "../../../../src/auto-reply/commands-registry.shared.js";
import { isAbortTrigger } from "../../../../src/auto-reply/reply/abort-trigger-text.js";
import {
  captureChatWorkContext,
  formatChatWorkContext,
} from "../../../../src/chat/work-context.js";
import { normalizeChatFollowUpModeOverride } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { registerChatGoalsEnglish } from "../../i18n/locales/en-chat-goals.ts";
import { registerMcpEnglish } from "../../i18n/locales/en-mcp.ts";
import { canSubmitBeforeChatHistory, parseSlashCommand } from "../../lib/chat/commands.ts";
import { extractCompanionCommandQuestion } from "../../lib/chat/companion-question.ts";
import { resolveCurrentUserIdentity } from "../../lib/chat/current-user-identity.ts";
import { trimHumanMentions } from "../../lib/chat/human-mentions.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { scopedAgentIdForSession, visibleSessionMatches } from "../../lib/sessions/index.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { uploadsEnabled, uploadsDisabledMessage } from "../../lib/uploads.ts";
import { composeBrowserAnnotationContext } from "./browser-annotation-context.ts";
import {
  dispatchChatSlashCommand,
  requireChatSessionAction,
  shouldQueueLocalSlashCommand,
} from "./chat-commands.ts";
import { isInitialChatHistoryUnavailable, setChatError } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { chatProviderReviewRow } from "./chat-provider-review.ts";
import { enqueueChatMessage, readQueuedMessageById } from "./chat-queue.ts";
import {
  captureChatCommandComposerRecovery,
  cancelChatDelivery,
  chatSubmitKey,
  clearSubmittedComposerState,
  settleChatCommandComposer,
  snapshotChatAttachments,
  submittedCommandScopeIsVisible,
  type PendingComposerSnapshot,
} from "./chat-send-composer.ts";
import type { ChatHost, ChatSendSubmitOptions } from "./chat-send-contract.ts";
import { deliverChatQueueItem } from "./chat-send-delivery.ts";
import { sendDetachedCommandMessage } from "./chat-send-detached-command.ts";
import {
  canSendVolatileQueueItem,
  captureChatConnectionOwner,
  createPendingSendMessage,
  publishPendingSendMessage,
  reconnectSafeQueuedSendState,
  waitForPendingChatSettings,
} from "./chat-send-queue-state.ts";
import { resolveDisplayedLeafEntryId } from "./chat-send-request.ts";
import {
  chatSendAdmissionHoldReason,
  chatSendHoldReason,
  formatChatQueueAdmissionError,
  isChatResetCommand,
  OFFLINE_QUEUE_STORAGE_ERROR,
  prependReplyQuote,
} from "./chat-send-support.ts";
import { recordChatSendTiming } from "./chat-send-timing.ts";
import { getPendingChatPickerPatch } from "./chat-settings-patches.ts";
import {
  withChatSubmitGuard,
  withChatSubmitHandoff,
  type ChatSubmitGuard,
} from "./chat-submit-guard.ts";
import { attachmentBatchRejection } from "./components/chat-attachment-admission.ts";
import { recordNonTranscriptInputHistory } from "./input-history.ts";
import {
  captureOutboxPayloadOwner,
  outboxPayloadError,
  prepareOutboxPayload,
  retireOutboxPayload,
} from "./outbox-payloads.ts";
import { controlUiNowMs } from "./performance.ts";
import { activeQueuedMessageEdit, retireEditedQueuedMessageSource } from "./queued-message-edit.ts";
import {
  handleAbortChat,
  hasAbortableSessionRun,
  hasDirectSessionRun,
  isChatBusy,
  isChatStopCommand,
} from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";

registerChatGoalsEnglish();
registerMcpEnglish();

async function waitForSubmittedRoute(host: ChatHost, sessionKey: string): Promise<boolean> {
  const pending = getPendingChatPickerPatch(host, sessionKey);
  if (pending && !(await waitForPendingChatSettings(host, sessionKey, pending))) {
    return false;
  }
  return host.sessionKey === sessionKey;
}

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: ChatSendSubmitOptions,
  submissionAction?: Event,
) {
  if (
    chatProviderReviewRow(host)?.providerReview &&
    !isChatStopCommand(messageOverride ?? host.chatMessage)
  ) {
    setChatError(host, t("chat.providerReview.pausedBody"));
    return undefined;
  }
  if (
    isInitialChatHistoryUnavailable(host) &&
    (opts?.intent ||
      opts?.resumeQueuedMessageEditId ||
      !canSubmitBeforeChatHistory(messageOverride ?? host.chatMessage))
  ) {
    return undefined;
  }
  if (opts?.intent && chatProviderReviewRow(host)?.sendDisabledReason) {
    host.requestUpdate?.();
    return undefined;
  }
  const previousDraft = host.chatMessage;
  const previousMentions = host.chatMentions?.map((mention) => ({ ...mention }));
  const previousReplyTarget = host.chatReplyTarget ? { ...host.chatReplyTarget } : null;
  const previousGoalDraftMode = host.chatGoalDraftMode;
  const intent = opts?.intent;
  const rawMessage = messageOverride ?? host.chatMessage;
  const draftMentions = messageOverride == null ? previousMentions : opts?.mentionsOverride;
  const submitted = trimHumanMentions(rawMessage, draftMentions);
  const userMessage = intent ? rawMessage : submitted.text;
  const submittedAtMs = controlUiNowMs();
  const submittedSessionKey = host.sessionKey;
  const submittedConnectionIsCurrent = captureChatConnectionOwner(host, false);
  const submittedOwnerIsCurrent = captureOutboxPayloadOwner(host);
  let expectedLeafEntryId = resolveDisplayedLeafEntryId(host);
  const attachmentsToSend = snapshotChatAttachments(
    messageOverride == null ? host.chatAttachments : (opts?.attachmentsOverride ?? []),
  );
  const submitGuardOptions = {
    attachments: messageOverride == null ? attachmentsToSend : [],
    scope: resolveUiConversationIdentity(host, submittedSessionKey),
    isCurrent: () =>
      submittedOwnerIsCurrent() &&
      submittedConnectionIsCurrent() &&
      host.sessionKey === submittedSessionKey,
  };
  const clearComposer = (retainAttachments: "none" | "annotations" | "all" = "none") =>
    messageOverride == null
      ? clearSubmittedComposerState(
          host,
          previousDraft,
          attachmentsToSend,
          previousMentions,
          previousReplyTarget,
          retainAttachments,
        )
      : {};
  const hasAttachments = attachmentsToSend.length > 0;
  if (hasAttachments && !uploadsEnabled(host.uploadConfig)) {
    setChatError(host, uploadsDisabledMessage());
    return undefined;
  }
  if (intent) {
    if (draftMentions?.length) {
      setChatError(host, t("chat.mentions.unsupported"));
      return undefined;
    }
    if (!host.connected || !host.client) {
      setChatError(host, t("chat.goals.offline"));
      return undefined;
    }
    if (isChatBusy(host) || hasDirectSessionRun(host)) {
      setChatError(host, t("chat.goals.busy"));
      return undefined;
    }
    if (attachmentsToSend.some((attachment) => attachment.browserAnnotation)) {
      setChatError(host, t("chat.goals.annotationUnsupported"));
      return undefined;
    }
    if (!userMessage.trim()) {
      return undefined;
    }
  }
  const requestedEditId = opts?.resumeQueuedMessageEditId;
  const inlineEdit = requestedEditId ? activeQueuedMessageEdit(host) : null;
  if (requestedEditId != null && inlineEdit?.id !== requestedEditId) {
    return undefined;
  }
  const isInlineEditSubmission = requestedEditId != null && inlineEdit?.id === requestedEditId;
  const submittedInlineEditRevision = isInlineEditSubmission ? inlineEdit.revision : null;
  // Classify the operator's raw row draft before browser annotation context is
  // prepended. Otherwise annotation text can hide /stop, /compact, or a stop
  // alias from the inline-edit command fence.
  const rawParsedCommand = intent ? null : parseSlashCommand(userMessage);
  if (
    submitted.mentions?.length &&
    (rawParsedCommand || /^\/(?:btw|side)(?::|\s|$)/i.test(userMessage))
  ) {
    setChatError(host, t("chat.mentions.unsupported"));
    return undefined;
  }
  if (isInlineEditSubmission && (rawParsedCommand || isChatStopCommand(userMessage))) {
    setChatError(
      host,
      "Queued-row edits cannot run commands or stop aliases. Cancel this edit and send the command from the composer.",
    );
    return undefined;
  }

  // Commands own the raw composer text. Annotation context is model input and must not
  // turn a recognized command into an ordinary message.
  const message =
    rawParsedCommand || intent
      ? userMessage
      : composeBrowserAnnotationContext(userMessage, attachmentsToSend);
  // Slash commands may use ordinary files, but annotations belong to the next model prompt.
  const deliveredAttachments = rawParsedCommand
    ? attachmentsToSend.filter(
        (attachment) => !attachment.browserAnnotation && !attachment.selectionAnnotation,
      )
    : attachmentsToSend;
  const rejectOversizedAttachments = () => {
    const error = attachmentBatchRejection(deliveredAttachments, host.hello?.policy);
    if (error === undefined) {
      return false;
    }
    showToast({ message: error });
    return true;
  };

  if (!message && !hasAttachments) {
    return undefined;
  }

  if (!intent) {
    // Natural stop aliases require a run; explicit /stop is always available.
    if (
      isChatStopCommand(userMessage) &&
      (userMessage.startsWith("/") || hasAbortableSessionRun(host))
    ) {
      if (host.connected && !requireChatSessionAction(host, "abort")) {
        return undefined;
      }
      host.chatRunError = null;
      if (messageOverride == null) {
        recordNonTranscriptInputHistory(host, userMessage);
      }
      await handleAbortChat(host, { scope: "session" });
      return undefined;
    }

    const parsed = rawParsedCommand;
    if (/^\/(?:btw|side)(?::|\s|$)/i.test(userMessage)) {
      host.chatRunError = null;
      const question = extractCompanionCommandQuestion(userMessage);
      const submitKey = chatSubmitKey(host, "local", message, []);
      await withChatSubmitGuard(host, submitKey, submitGuardOptions, async () => {
        if (messageOverride == null) {
          recordNonTranscriptInputHistory(host, userMessage);
          clearComposer("all");
        }
        await host.openSessionCompanion?.(question);
      });
      return undefined;
    }
    const clientPresentation = parsed?.command.clientPresentation;
    const dispatchClientPresentation = host.dispatchClientPresentation;
    if (
      host.connected &&
      parsed?.args === "" &&
      clientPresentation?.when === "no-arguments" &&
      !hasAttachments &&
      host.chatReplyTarget == null &&
      dispatchClientPresentation
    ) {
      const submitKey = chatSubmitKey(host, "local", message, []);
      const presentationResult = await withChatSubmitGuard(
        host,
        submitKey,
        submitGuardOptions,
        async () => {
          if (host.sessionKey !== submittedSessionKey) {
            return "not-handled" as const;
          }
          let handled = false;
          try {
            handled = await dispatchClientPresentation(clientPresentation.action);
          } catch {
            // Presentation failures retain the established remote command path.
          }
          if (!handled) {
            return "not-handled" as const;
          }
          // The awaited action may outlive its submitted session; never mutate a newly selected one.
          if (host.sessionKey !== submittedSessionKey) {
            return "handled" as const;
          }
          host.chatRunError = null;
          if (messageOverride == null) {
            clearComposer();
            recordNonTranscriptInputHistory(host, message);
          }
          return "handled" as const;
        },
      );
      // An in-flight identical submit is already deciding whether to handle or fall through.
      if (presentationResult !== "not-handled") {
        return undefined;
      }
    }
    const forwardModel =
      parsed?.command.key === "model" && shouldForwardModelCommandToServer(parsed.args);
    if (
      (!parsed?.command.executeLocal || forwardModel) &&
      chatProviderReviewRow(host)?.sendDisabledReason
    ) {
      host.requestUpdate?.();
      return undefined;
    }
    host.chatRunError = null;
    // Approval controls also precede the first snapshot that hydrates the local run.
    if (
      parsed?.command.key === "approve" &&
      (isChatBusy(host) || isInitialChatHistoryUnavailable(host))
    ) {
      const submitKey = chatSubmitKey(host, "detached", message, attachmentsToSend);
      await withChatSubmitGuard(host, submitKey, submitGuardOptions, async () => {
        if (!(await waitForSubmittedRoute(host, submittedSessionKey))) {
          return;
        }
        if (rejectOversizedAttachments()) {
          return;
        }
        const cleared = clearComposer("annotations");
        if (messageOverride == null) {
          recordNonTranscriptInputHistory(host, userMessage);
        }
        const recoveryScope = resolveUiConversationIdentity(host, submittedSessionKey);
        scheduleChatScroll(host, true, false, { source: "manual" });
        await sendDetachedCommandMessage(host, message, {
          attachments: deliveredAttachments.length ? deliveredAttachments : undefined,
          recovery: captureChatCommandComposerRecovery(host, recoveryScope, cleared),
        });
      });
      return undefined;
    }

    if (parsed?.command.executeLocal && !forwardModel) {
      if (shouldQueueLocalSlashCommand(parsed.command.key)) {
        if (chatSendHoldReason(host, submittedSessionKey)) {
          host.requestUpdate?.();
          return undefined;
        }
        const submitKey = chatSubmitKey(host, "local", message, attachmentsToSend);
        await withChatSubmitGuard(host, submitKey, submitGuardOptions, async () => {
          const admission = captureChatOutboxAdmission(host, host.sessionKey);
          if (messageOverride == null) {
            recordNonTranscriptInputHistory(host, userMessage);
            clearComposer("all");
          }
          const queued = enqueueChatMessage(
            host,
            message,
            isChatResetCommand(message),
            {
              args: parsed.args,
              name: parsed.command.key,
            },
            resolveCurrentUserIdentity(host.hello, host.client?.instanceId, host.selfUser) ??
              undefined,
          );
          if (!queued) {
            return;
          }
          queued.sendState = reconnectSafeQueuedSendState(host);
          if (chatOutboxOwner(host).admit(host, admission, queued) !== "admitted") {
            chatOutboxOwner(host).remove(host, queued.id);
            if (messageOverride == null) {
              host.chatMessage = previousDraft;
              host.chatMentions = previousMentions ?? [];
              host.chatReplyTarget = previousReplyTarget;
              host.chatAttachments = attachmentsToSend;
            }
            setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
            return;
          }
          // Submission resumes follow; delayed command results respect later reader input.
          scheduleChatScroll(host, true, false, { source: "manual" });
          await deliverChatQueueItem(host, queued, { routingSessionKey: host.sessionKey });
        });
        return undefined;
      }
      const waitsForPicker = parsed.command.key === "redirect";
      const dispatchLocalCommand = async () => {
        if (waitsForPicker && !(await waitForSubmittedRoute(host, submittedSessionKey))) {
          return;
        }
        let recoveryComposer: PendingComposerSnapshot | undefined;
        const recoveryScope = resolveUiConversationIdentity(host, submittedSessionKey);
        if (messageOverride == null) {
          recordNonTranscriptInputHistory(host, userMessage);
          if (parsed.command.key !== "export-session") {
            recoveryComposer = clearComposer();
          }
        }
        const recovery = captureChatCommandComposerRecovery(host, recoveryScope, recoveryComposer);
        if (parsed.command.key === "steer" || parsed.command.key === "redirect") {
          scheduleChatScroll(host, true, false, { source: "manual" });
        }
        const dispatchResult = await dispatchChatSlashCommand(
          host,
          parsed.command.key,
          parsed.args,
        );
        if (
          parsed.command.key === "export-session" &&
          dispatchResult === "completed" &&
          messageOverride == null &&
          submittedCommandScopeIsVisible(host, recovery)
        ) {
          clearComposer("all");
        }
        if (dispatchResult === "failed" || dispatchResult === "cancelled") {
          settleChatCommandComposer(host, recovery, false, recovery.composer?.previousAttachments);
        } else if (dispatchResult === "completed") {
          settleChatCommandComposer(host, recovery, true, recovery.composer?.previousAttachments);
        }
      };
      if (waitsForPicker) {
        const submitKey = chatSubmitKey(host, "local", message, attachmentsToSend);
        await withChatSubmitGuard(host, submitKey, submitGuardOptions, dispatchLocalCommand);
      } else {
        await dispatchLocalCommand();
      }
      return undefined;
    }
  }

  if (rejectOversizedAttachments()) {
    return undefined;
  }

  const { replyTargetOverride = previousReplyTarget } = opts ?? {};
  const replyTarget = isInlineEditSubmission ? null : replyTargetOverride;
  // Persisted ids use replyToId; synthetic replies fall back to a quote.
  const replyToId = isInlineEditSubmission
    ? inlineEdit.replyToId
    : replyTarget?.sourceMessageId?.trim() || undefined;
  const quotedMessage =
    replyTarget && !replyToId && !intent ? prependReplyQuote(message, replyTarget) : message;
  // Edits retain the original snapshot only while the edited text remains
  // ordinary model input; commands and Goals never acquire ambient context.
  const acceptsWorkContext =
    !intent &&
    !userMessage.startsWith("/") &&
    !userMessage.startsWith("!") &&
    !isAbortTrigger(quotedMessage);
  const context = acceptsWorkContext
    ? isInlineEditSubmission
      ? inlineEdit.source.workContext
      : host.getWorkContext?.()
    : undefined;
  const workContext = context ? captureChatWorkContext(context) : undefined;
  // Annotation and fallback-reply prefixes shift mentions; structured work context never does.
  const mentionOffset = quotedMessage.length - userMessage.length;
  const effectiveMentions = submitted.mentions?.map((mention) => ({
    profileId: mention.profileId,
    start: mention.start + mentionOffset,
    end: mention.end + mentionOffset,
  }));

  // A row edit and a composer send may intentionally carry the same payload.
  // Keep their guards independent so submitting one cannot suppress the other.
  const submitKey = chatSubmitKey(
    host,
    requestedEditId ? "queued-edit" : intent ? "goal" : "message",
    workContext ? `${quotedMessage}\n\n${formatChatWorkContext(workContext)}` : quotedMessage,
    attachmentsToSend,
    effectiveMentions,
  );
  let accepted = false;
  const submitMessage = async (guard: ChatSubmitGuard) => {
    if (host.chatLoading && (intent || rawParsedCommand || isInlineEditSubmission)) {
      // Commands and row edits retain their draft until history resolves.
      if (!(await loadChatHistory(host))) {
        return;
      }
      expectedLeafEntryId = resolveDisplayedLeafEntryId(host);
    }
    if (host.sessionKey !== submittedSessionKey) {
      return;
    }
    const submittedAgentId = scopedAgentIdForSession(host, submittedSessionKey);
    const submissionOwnerIsCurrent = () =>
      submitGuardOptions.isCurrent() &&
      visibleSessionMatches(host, submittedSessionKey, submittedAgentId);
    if (!visibleSessionMatches(host, submittedSessionKey, submittedAgentId)) {
      setChatError(host, t("mcpServers.sessionUnavailable"));
      return;
    }
    if (intent && (isChatBusy(host) || hasDirectSessionRun(host))) {
      setChatError(host, t("chat.goals.busy"));
      return;
    }
    // History may settle after the operator cancels or changes the row edit.
    const resumedEditCandidate = activeQueuedMessageEdit(host);
    if (
      isInlineEditSubmission &&
      (resumedEditCandidate !== inlineEdit ||
        resumedEditCandidate.revision !== submittedInlineEditRevision)
    ) {
      return;
    }
    const admissionHoldReason = () =>
      intent || rawParsedCommand || isInlineEditSubmission
        ? chatSendHoldReason(host, submittedSessionKey, false, submittedAgentId)
        : chatSendAdmissionHoldReason(host, submittedSessionKey, submittedAgentId);
    if (admissionHoldReason()) {
      // The composer owns transient recovery notices, including their removal.
      host.requestUpdate?.();
      return;
    }
    let pendingSettings = getPendingChatPickerPatch(host, submittedSessionKey);
    const initialTurnPending = host.hasPendingInitialTurn?.(submittedSessionKey) === true;
    const applyRunPolicy = hasDirectSessionRun(host) || isInitialChatHistoryUnavailable(host);
    // The edited row hands its place to the replacement and is retired by the same
    // store write, so a rejected write leaves the original queued and editable.
    const resumedEdit =
      requestedEditId && resumedEditCandidate?.id === requestedEditId ? resumedEditCandidate : null;
    // Editing preserves the row's delivery choice; current composer defaults must
    // not turn an explicitly queued message into a steer or interrupt.
    const followUpMode = initialTurnPending
      ? "queue"
      : resumedEdit
        ? (resumedEdit.source.queueMode ?? "queue")
        : (opts?.followUpMode ??
          host.chatFollowUpMode ??
          normalizeChatFollowUpModeOverride(host.settings?.chatFollowUpMode));
    const activeRunQueueMode =
      !intent && applyRunPolicy && followUpMode !== "queue" ? followUpMode : undefined;
    const allowActiveRunSend = Boolean(intent || (applyRunPolicy && followUpMode !== "queue"));
    const submission = createPendingSendMessage(
      host,
      quotedMessage,
      deliveredAttachments.length ? deliveredAttachments : undefined,
      Boolean(intent) || isChatResetCommand(message),
      submittedAtMs,
      pendingSettings ? "waiting-model" : reconnectSafeQueuedSendState(host),
      replyToId,
      resumedEdit?.orderKey,
      activeRunQueueMode,
      intent,
      expectedLeafEntryId,
      effectiveMentions,
      workContext,
    );
    if (!submission) {
      return;
    }
    let queued = submission.item;
    queued.asyncQuestionItemId =
      resumedEdit?.source.asyncQuestionItemId ?? opts?.asyncQuestionItemId;
    if (queued.attachments?.length) {
      const payload = await prepareOutboxPayload(host, queued);
      const currentEdit = activeQueuedMessageEdit(host);
      const stillOwnsSubmission =
        submissionOwnerIsCurrent() &&
        (!isInlineEditSubmission ||
          (currentEdit === inlineEdit && currentEdit.revision === submittedInlineEditRevision));
      if (!stillOwnsSubmission) {
        if (payload.status === "ready") {
          retireOutboxPayload(payload.update);
        }
        return;
      }
      if (payload.status === "failed") {
        setChatError(host, outboxPayloadError(payload.reason));
        return;
      }
      queued = { ...queued, ...payload.update };
      const hold = admissionHoldReason();
      if (hold || (intent && (isChatBusy(host) || hasDirectSessionRun(host)))) {
        retireOutboxPayload(queued);
        if (hold) {
          host.requestUpdate?.();
        } else {
          setChatError(host, t("chat.goals.busy"));
        }
        return;
      }
      // Retain a picker captured before storage, including its rejected result;
      // delivery follows the latest picker tail before issuing the request.
      pendingSettings ??= getPendingChatPickerPatch(host, submittedSessionKey);
      queued.sendState = pendingSettings ? "waiting-model" : reconnectSafeQueuedSendState(host);
    }
    const cleared = clearComposer(rawParsedCommand ? "annotations" : "none");
    if (messageOverride == null) {
      recordNonTranscriptInputHistory(host, userMessage);
    }

    queued = publishPendingSendMessage(host, queued);
    const admissionResult = chatOutboxOwner(host).admit(
      host,
      submission.admission,
      queued,
      resumedEdit
        ? {
            id: resumedEdit.id,
            expected: resumedEdit.source,
          }
        : undefined,
    );
    const admittedDurably = admissionResult === "admitted";
    if (admittedDurably) {
      guard.releaseAttachments();
      if (messageOverride == null && !rawParsedCommand && !intent && submissionOwnerIsCurrent()) {
        // Pending admissions retain their files until their own composer snapshot can settle.
        host.chatAttachments = host.chatAttachments.filter(
          (attachment) => !guard.canRetireAttachment(attachment),
        );
      }
    }
    if (resumedEdit) {
      retireEditedQueuedMessageSource(host, admittedDurably, queued.attachments, resumedEdit);
    }
    const canSendFromMemory =
      !admittedDurably &&
      !queued.attachments?.length &&
      (!resumedEdit || !resumedEdit.sourceWasDurable) &&
      // A still-open edit means its stored source outlived the rejected write;
      // sending the replacement from memory would strand the original as a duplicate.
      !activeQueuedMessageEdit(host) &&
      !pendingSettings &&
      canSendVolatileQueueItem(host, queued, submittedSessionKey);
    if (!admittedDurably && !canSendFromMemory) {
      retireOutboxPayload(queued);
      cancelChatDelivery(host, queued, {
        ...cleared,
        previousGoalDraftMode,
      });
      setChatError(host, formatChatQueueAdmissionError(admissionResult, Boolean(resumedEdit)));
      return;
    }
    setChatError(host, null);
    opts?.onOutboxAdmitted?.();
    const sendResult = await withChatSubmitHandoff(
      host,
      queued,
      {
        yieldToInput: admittedDurably && Boolean(submissionAction),
        isCurrent: submissionOwnerIsCurrent,
        allowActiveRunSend,
        pendingSettings,
      },
      (deliveryItem) =>
        deliverChatQueueItem(host, deliveryItem, {
          ...cleared,
          previousGoalDraftMode,
          ...(allowActiveRunSend ? { allowActiveRunSend: true } : {}),
          ...(expectedLeafEntryId !== undefined ? { expectedLeafEntryId } : {}),
          ...(pendingSettings ? { pendingSettings } : {}),
          restoreOnTerminalFailure: Boolean(rawParsedCommand || intent),
          routingSessionKey: submittedSessionKey,
          storageMode: canSendFromMemory ? "memory" : "durable",
        }),
    );
    const pending = readQueuedMessageById(host, queued.id);
    accepted = sendResult !== "failed";
    const pendingBusySend =
      sendResult === "pending" &&
      pending?.sendState === "waiting-idle" &&
      host.sessionKey === submittedSessionKey &&
      visibleSessionMatches(host, submittedSessionKey, pending.agentId) &&
      (isChatBusy(host) || hasDirectSessionRun(host));
    if (pendingBusySend) {
      recordChatSendTiming(host, pending, "queued-busy", submittedAtMs);
    }
  };
  await withChatSubmitGuard(
    host,
    submitKey,
    {
      ...submitGuardOptions,
      action: submissionAction,
    },
    submitMessage,
  );
  return accepted;
}
