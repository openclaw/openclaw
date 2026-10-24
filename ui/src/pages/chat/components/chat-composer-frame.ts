import {
  normalizeChatSendShortcut,
  patchSettings,
  type ChatFollowUpMode,
} from "../../../app/settings.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatGoalsEnglish } from "../../../i18n/locales/en-chat-goals.ts";
import "../../../components/tooltip.ts";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import {
  canSubmitBeforeChatHistory,
  isChatControlCommand,
  isModelIndependentChatCommand,
} from "../../../lib/chat/commands.ts";
import { updateHumanMentions } from "../../../lib/chat/human-mentions.ts";
import { clearCompositionEnd, recordCompositionEnd } from "../../../lib/ime.ts";
import { isSessionRunVisuallyActive } from "../../../lib/session-run-state.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { chatGoalCreationObjective } from "../chat-goals.ts";
import {
  hasTerminalRunStatus,
  isChatRunWorking,
  isCurrentSessionSubmittedProgress,
} from "../chat-run-working.ts";
import { insertComposerDictation, type ComposerDictationOwner } from "../composer-dictation.ts";
import { normalizeChatComposerDraft } from "../composer-draft.ts";
import type {
  ComposerMicrophoneOwner,
  MicrophonePickerProps,
} from "../composer-microphone-picker.ts";
import {
  adjustTextareaHeight,
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
  replaceComposerPopoverAnchor,
  scheduleTextareaHeightAdjustment,
} from "./chat-composer-dom.ts";
import type { GoalComposer } from "./chat-composer-goal-mode.tsx";
import { createComposerKeyDownHandler } from "./chat-composer-keydown.ts";
import type { HumanMentionMenuHost } from "./chat-composer-mention-menu-state.ts";
import { resolveChatSlashCommandArgOptions, resolveComposerMenus } from "./chat-composer-menus.ts";
import type { ComposerPrediction } from "./chat-composer-prediction.ts";
import { isSkillMenuVisible, type SkillMenuHost } from "./chat-composer-skill-menu-state.ts";
import type { SlashMenuHost } from "./chat-composer-slash-menu-state.ts";
import {
  clearPendingClearedSubmittedDraft,
  commitComposerDraft,
  composerDraftKey,
  consumeComposerInputIntent,
  getChatComposerState,
  markComposerInputIntent,
  suppressStaleSubmittedDraftReplay,
} from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";
import type { QuestionPanelProps } from "./chat-question-card.ts";

registerChatGoalsEnglish();

type ComposerInteraction = {
  composition: () => { key: string; value: string } | null;
  setComposition: (draft: { key: string; value: string } | null) => void;
  error: () => string | null;
  setError: (error: string | null) => void;
};

export function createChatComposerContext(
  props: ChatComposerProps,
  interaction: ComposerInteraction,
  goalComposer: GoalComposer,
  voice: { dictation: ComposerDictationOwner; picker: ComposerMicrophoneOwner },
  prediction: ComposerPrediction | undefined,
  questionPanelProps: QuestionPanelProps | null,
  streaming: boolean,
) {
  const state = getChatComposerState(props.paneId);
  state.slashCommandDispatchConnected = props.connected;
  const canCompose = props.canCompose ?? props.canSend;
  const isBusy = props.sending || streaming;
  const canAbort = Boolean(props.canAbort && props.onAbort);
  const showAbortableUi = canAbort && !hasTerminalRunStatus(props.runStatus);
  const submittedProgress = props.queue.find((item) =>
    isCurrentSessionSubmittedProgress(item, props.sessionKey, props.runStatus),
  );
  const hasSubmittedProgress = props.queue.some(
    (item) =>
      !item.pendingRunId &&
      (item.sendState === "submitting" ||
        item.sendState === "sending" ||
        item.sendState === "waiting-model"),
  );
  const sendingForCurrentSession =
    props.sending && (!hasSubmittedProgress || submittedProgress !== undefined);
  const runWorking = isChatRunWorking(props);
  const composerRunStatus = isSessionRunVisuallyActive(
    sendingForCurrentSession || runWorking,
    props.startupStatus?.phase,
  )
    ? { phase: "in-progress" as const }
    : props.runStatus;
  const draftKey = composerDraftKey(props);
  if (state.composerDraftScope !== null && state.composerDraftScope.key !== draftKey) {
    // A new draft owns a new input; late IME events from the retired node cannot commit into it.
    state.restoreComposerFocus ||= state.composerTextarea === document.activeElement;
    state.textareaRef?.();
    state.composerComposing = false;
    state.dictationSelection = null;
  }
  if (state.composerDraftScope?.key !== draftKey) {
    state.composerDraftScope = { key: draftKey };
  }
  const draftScope = state.composerDraftScope;
  const composition = interaction.composition();
  const visibleDraft =
    state.composerComposing && composition?.key === draftKey
      ? composition.value
      : (props.getDraft?.() ?? props.draft);
  state.composerInputRef ??= (element?: Element) => {
    state.composerInput = replaceComposerPopoverAnchor(state.composerInput, element);
  };
  state.textareaRef ??= (element?: Element) => {
    const nextTextarea = element instanceof HTMLTextAreaElement ? element : null;
    const prevTextarea = state.composerTextarea;
    if (prevTextarea && prevTextarea !== nextTextarea) {
      disconnectTextareaOverflowObserver(prevTextarea);
    }
    state.composerTextarea = nextTextarea;
    if (nextTextarea) {
      observeTextareaOverflow(nextTextarea, () => props.getTranscriptElement?.() ?? null);
      scheduleTextareaHeightAdjustment(nextTextarea);
      if (state.restoreComposerFocus) {
        state.restoreComposerFocus = false;
        queueMicrotask(() => state.composerTextarea?.focus({ preventScroll: true }));
      }
    }
  };
  // The stable ref only measures on attach, so programmatic draft swaps (send
  // clear, session switch, history restore) must re-measure explicitly.
  if (state.composerTextarea?.isConnected && state.composerTextarea.value !== visibleDraft) {
    scheduleTextareaHeightAdjustment(state.composerTextarea);
  }
  const assistantName = props.assistantName || "OpenClaw";
  const inProgressLabel = props.waitingApproval
    ? t("chat.waitingForApproval")
    : submittedProgress?.sendState === "waiting-model"
      ? t("chat.composer.preparingModel")
      : streaming
        ? t("chat.composer.responding", { name: assistantName })
        : sendingForCurrentSession || submittedProgress
          ? t("chat.composer.sendingMessage")
          : t("chat.composer.working", { name: assistantName });
  const cancellationCaveat =
    composerRunStatus?.phase === "interrupted" && composerRunStatus.localModelMayStillBeFinishing
      ? t("chat.composer.localCancellationCaveat")
      : null;
  // The visible caveat owns its announcement; keep other run phases accessible.
  const runStatusAnnouncement =
    composerRunStatus == null || cancellationCaveat
      ? ""
      : composerRunStatus.phase === "in-progress"
        ? inProgressLabel
        : composerRunStatus.phase === "done"
          ? t("chat.composer.runDone")
          : t("chat.composer.runInterrupted");
  const mentionsUnsupported = props.mentionsUnsupported || goalComposer.active;
  const mentionDirectory =
    props.connected && canCompose && !mentionsUnsupported ? props.mentionDirectory : undefined;
  const getMentions = () => props.getMentions?.() ?? props.mentions ?? [];
  const mentionError =
    getMentions().length > 0 && (mentionsUnsupported || visibleDraft.trimStart().startsWith("/"))
      ? t("chat.mentions.unsupported")
      : null;
  const shareTypingSelection = (target: HTMLTextAreaElement) => {
    props.onTypingChange?.(
      Boolean(target.value.trim()),
      target.value,
      target.selectionDirection === "backward" ? target.selectionStart : target.selectionEnd,
    );
  };
  const commitMenuDraft = (next: string, mentions?: readonly HumanMention[]) => {
    commitComposerDraft(props, next, mentions);
    props.onTypingChange?.(Boolean(next.trim()), next);
  };
  const skillMenuHost: SkillMenuHost = {
    paneId: props.paneId,
    getDraft: () => state.composerTextarea?.value ?? props.getDraft?.() ?? props.draft,
    commitDraft: commitMenuDraft,
    getTextarea: () => state.composerTextarea,
    refreshCommands: props.onSlashIntent,
  };
  const slashMenuHost: SlashMenuHost = {
    ...skillMenuHost,
    resolveArgOptions: (command) => resolveChatSlashCommandArgOptions(command, props),
    runCommand: () => submitDraft(props.getDraft?.() ?? props.draft),
    canRun: (inline, command, args = "") =>
      props.canSend &&
      state.slashCommandDispatchConnected &&
      !(inline && !props.onSlashCommand) &&
      (!props.modelRequiredReason ||
        isModelIndependentChatCommand(
          command ? `/${command.name} ${args}` : skillMenuHost.getDraft(),
        )) &&
      (!props.submitDisabledReason ||
        isChatControlCommand(command ? `/${command.name} ${args}` : skillMenuHost.getDraft())),
    runInlineCommand: props.connected ? props.onSlashCommand : undefined,
    activateComposerMode: goalComposer.activateCommand,
  };
  const mentionMenuHost: HumanMentionMenuHost = {
    paneId: props.paneId,
    getDraft: skillMenuHost.getDraft,
    getMentions,
    getTextarea: skillMenuHost.getTextarea,
    commitDraft: commitMenuDraft,
  };
  const sendShortcut = normalizeChatSendShortcut(props.sendShortcut);
  // Keyboard and tooltip share the opposite action, including inherited queue modes.
  const alternateFollowUpMode: ChatFollowUpMode | undefined =
    props.connected &&
    sendShortcut === "enter" &&
    showAbortableUi &&
    !props.suggestionComposer &&
    props.followUpMode !== undefined &&
    props.followUpMode !== "interrupt"
      ? props.followUpMode === "steer"
        ? "queue"
        : "steer"
      : undefined;
  const showComposer =
    !questionPanelProps ||
    questionPanelProps.model.nonBlocking === true ||
    questionPanelProps.model.collapsed;

  // Offline text and attachments may enter the persisted reconnect queue, but
  // slash commands are live controls and must not execute against stale state.
  const canSubmitDraft = (draft: string) =>
    props.canSend &&
    (!props.modelRequiredReason ||
      (!goalComposer.active &&
        (props.getAttachments?.() ?? props.attachments ?? []).length === 0 &&
        isModelIndependentChatCommand(draft))) &&
    (!props.submitDisabledReason || (!goalComposer.active && canSubmitBeforeChatHistory(draft))) &&
    !(getMentions().length > 0 && (mentionsUnsupported || draft.trimStart().startsWith("/"))) &&
    !goalComposer.pending &&
    state.dictation?.locksComposer !== true &&
    !(state.skillMenu.state.skillMenuOpen && state.skillMenu.state.skillCommandRefreshPending) &&
    (props.getPendingAttachmentReads?.() ?? props.pendingAttachmentReads ?? 0) === 0 &&
    (props.connected || !draft.trimStart().startsWith("/"));

  const syncComposerDraftAfterSend = (target: HTMLTextAreaElement | null) => {
    state.emojiMenu.close();
    state.mentionMenu.close();
    const submittedDraft = target?.value ?? props.getDraft?.() ?? props.draft;
    const hostDraft = props.getDraft?.() ?? props.draft;
    const clearedSubmittedDraft =
      hostDraft === "" && submittedDraft !== "" && target?.value === submittedDraft;
    if (clearedSubmittedDraft) {
      state.pendingClearedSubmittedDraft = {
        key: draftKey,
        value: submittedDraft,
      };
    } else {
      clearPendingClearedSubmittedDraft(state, draftKey);
    }
    if (target && target.value !== hostDraft) {
      target.value = hostDraft;
      adjustTextareaHeight(target);
    }
  };

  const submitDraft = (
    draft: string,
    submissionAction?: Event,
    followUpModeOverride?: ChatFollowUpMode,
  ) => {
    if (state.composerDraftScope !== draftScope || !canSubmitDraft(draft)) {
      return;
    }
    state.composerComposing = false;
    interaction.setComposition(null);
    commitComposerDraft(props, draft);
    props.onTypingChange?.(false);
    if (goalComposer.activateDraft(draft, true)) {
      return;
    }
    if (goalComposer.active) {
      void goalComposer.submit(submissionAction);
      return;
    }
    void props.onSend(followUpModeOverride, submissionAction);
    syncComposerDraftAfterSend(state.composerTextarea);
  };

  const acceptPrediction = () => {
    if (state.composerComposing || !canCompose) {
      return;
    }
    prediction?.acceptInto(state.composerTextarea);
  };
  const handleKeyDown = createComposerKeyDownHandler({
    prediction,
    acceptPrediction,
    state,
    props,
    skillMenuHost,
    slashMenuHost,
    mentionMenuHost,
    sendShortcut,
    canSubmitDraft,
    submitDraft,
    showAbortableUi,
    alternateFollowUpMode,
    goalComposer,
  });

  const updateEmojiMenu = (
    target: HTMLTextAreaElement,
    commandsOpen = state.skillMenu.state.skillMenuOpen || state.slashMenu.state.slashMenuOpen,
  ) =>
    state.emojiMenu.update(
      target,
      !state.composerComposing && !commandsOpen && !state.mentionMenu.open,
    );
  const syncComposerValue = (target: HTMLTextAreaElement, typedAtSign = false) => {
    prediction?.dismiss();
    adjustTextareaHeight(target, { nativeInput: true });
    target.dir = detectTextDirection(target.value);
    const mentions = getMentions();
    commitComposerDraft(
      props,
      target.value,
      mentions.length
        ? updateHumanMentions(
            props.getDraft?.() ?? props.draft,
            target.value,
            mentions,
            state.mentionInput,
          )
        : undefined,
    );
    state.mentionInput = undefined;
    const activatedGoal = goalComposer.activateDraft(target.value);
    if (!activatedGoal && !goalComposer.active) {
      const slashOpen = state.slashMenu.update(target.value, slashMenuHost);
      const skillOpen = state.skillMenu.update(target.value, target.selectionStart, skillMenuHost);
      const mentionIntent = typedAtSign ? "trigger" : "input";
      state.mentionMenu.update(target, mentionIntent);
      updateEmojiMenu(target, slashOpen || skillOpen);
    } else {
      updateEmojiMenu(target);
    }
    shareTypingSelection(target);
  };
  const handleBeforeInput = (event: InputEvent) => {
    prediction?.dismiss();
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement) || target !== state.composerTextarea) {
      return;
    }
    state.mentionInput = {
      value: target.value,
      start: target.selectionStart,
      end: target.selectionEnd,
      inputType: event.inputType,
    };
    if (!state.composerComposing && !event.isComposing) {
      markComposerInputIntent(state, composerDraftKey(props));
      state.emojiMenu.complete(event, canCompose);
    }
  };
  const handleInput = (event: InputEvent) => {
    // SAFETY: This handler is bound only to the native composer textarea.
    const target = event.target as HTMLTextAreaElement;
    if (target !== state.composerTextarea) {
      return;
    }
    const hasInputIntent = consumeComposerInputIntent(state, draftKey);
    if (state.composerComposing || event.isComposing) {
      interaction.setComposition({ key: draftKey, value: target.value });
      return;
    }
    interaction.setComposition(null);
    if (
      suppressStaleSubmittedDraftReplay(
        target,
        event,
        props.getDraft?.() ?? props.draft,
        hasInputIntent,
        state,
      )
    ) {
      return;
    }
    const typedAtSign = event.inputType === "insertText" && event.data?.includes("@") === true;
    if (event.inputType === "insertFromPaste" || event.inputType === "insertFromDrop") {
      state.mentionMenu.close();
    }
    syncComposerValue(target, typedAtSign);
  };
  const handleSelect = (event: Event) => {
    // SAFETY: Selection and keyup listeners are attached only to the composer textarea.
    const target = event.target as HTMLTextAreaElement;
    if (
      target === document.activeElement &&
      target.value.trim() &&
      !state.composerComposing &&
      !target.readOnly
    ) {
      shareTypingSelection(target);
    }
    if (goalComposer.active) {
      updateEmojiMenu(target);
      return;
    }
    state.mentionMenu.update(target);
    if (event.type === "keyup") {
      updateEmojiMenu(target);
      return;
    }
    const slashOpen = state.slashMenu.update(target.value, slashMenuHost);
    const skillOpen = state.skillMenu.update(target.value, target.selectionStart, skillMenuHost);
    updateEmojiMenu(target, slashOpen || skillOpen);
  };
  const handleCompositionEnd = (event: CompositionEvent) => {
    if (event.target !== state.composerTextarea) {
      return;
    }
    recordCompositionEnd(event);
    state.composerComposing = false;
    interaction.setComposition(null);
    // SAFETY: The identity check above requires the current composer textarea.
    syncComposerValue(event.target as HTMLTextAreaElement);
  };
  const handleBlur = (event: FocusEvent) => {
    if (event.target !== state.composerTextarea) {
      return;
    }
    clearCompositionEnd(event);
    state.emojiMenu.close();
    // SAFETY: The identity check above requires the current composer textarea.
    const target = event.target as HTMLTextAreaElement;
    // A dropped compositionend (detach/blur mid-IME) must not wedge the
    // composing flag: it persists across renders and kills Enter-send,
    // history keys, and command menus until the Send button resets it.
    state.composerComposing = false;
    interaction.setComposition(null);
    // Dictation owns the read-only preview; blur must not commit discarded speech.
    if (!state.dictation?.locksComposer) {
      const normalizedDraft = normalizeChatComposerDraft(target.value);
      if (target.value !== normalizedDraft) {
        target.value = normalizedDraft;
        adjustTextareaHeight(target);
      }
      commitComposerDraft(props, normalizedDraft);
    }
    props.onTypingChange?.(false);
  };
  const devicePicker = voice.picker;
  const startRealtimeTalk = () => {
    // Catalog help does not require history; only starting Talk does.
    if (devicePicker.realtimeStatus !== "ready") {
      devicePicker.handleOpen();
      return;
    }
    if (props.submitDisabledReason) {
      return;
    }
    props.onToggleRealtimeTalk?.();
  };
  const handleVoicePrimaryAction = () => {
    if (props.realtimeTalkActive) {
      props.onToggleRealtimeTalk?.();
      return;
    }
    const liveDraft = state.composerTextarea?.value ?? visibleDraft;
    if (liveDraft.trim() || props.attachments?.length) {
      submitDraft(liveDraft);
      return;
    }
    startRealtimeTalk();
  };
  const selectedMicrophoneId = props.realtimeTalkInputDeviceId?.trim() ?? "";
  const microphonePicker: MicrophonePickerProps | undefined = props.onToggleRealtimeTalk
    ? {
        devices: devicePicker.devices,
        loading: devicePicker.loading,
        open: devicePicker.open,
        selectedDeviceId: selectedMicrophoneId,
        voiceActive: Boolean(props.realtimeTalkActive),
        issue: devicePicker.issue,
        holdToDictate: props.composerHoldToRecord !== false,
        realtimeStatus: devicePicker.realtimeStatus,
        dictationStatus: devicePicker.dictationStatus,
        onOpen: devicePicker.handleOpen,
        onClose: devicePicker.handleClose,
        onSelect: (deviceId: string) => {
          patchSettings({ realtimeTalkInputDeviceId: deviceId.trim() || undefined });
          devicePicker.handleClose();
        },
        onHoldToDictateChange: (enabled: boolean) => {
          if (props.onComposerHoldToRecordChange) {
            props.onComposerHoldToRecordChange(enabled);
          } else {
            patchSettings({ composerHoldToRecord: enabled });
          }
        },
        onOpenTalkSettings: props.onOpenTalkSettings,
        onOpenDictationSettings: props.onOpenDictationSettings,
      }
    : undefined;
  const dictationOptions = createComposerDictationOptions(
    props,
    state,
    devicePicker,
    interaction.setError,
    visibleDraft.trim() || props.attachments?.length ? startRealtimeTalk : handleVoicePrimaryAction,
  );
  const dictation =
    props.onToggleRealtimeTalk && props.composerHoldToRecord !== false
      ? voice.dictation
      : undefined;
  const handleDictationStart = (event?: PointerEvent) => {
    interaction.setError(null);
    const target = state.composerTextarea;
    // Both hold and direct/mobile starts capture the draft before its preview
    // replaces the textarea value; otherwise committing appends the speech twice.
    const selection = {
      start: target?.selectionStart ?? visibleDraft.length,
      end: target?.selectionEnd ?? visibleDraft.length,
      value: target?.value ?? visibleDraft,
    };
    // Stop also emits pointerdown; only a new gesture owns a draft snapshot.
    if (!event || dictation?.handlePointerDown(event)) {
      state.dictationSelection = selection;
      if (event && target) {
        target.readOnly = true;
      }
    }
  };
  const replacingRunningGoal =
    isBusy &&
    props.selectedSession?.goal?.status === "active" &&
    (goalComposer.mode?.action === "start" ||
      chatGoalCreationObjective(visibleDraft) !== undefined);
  const runControlsProps = {
    canAbort: showAbortableUi,
    canSend: canSubmitDraft(visibleDraft),
    submitDisabledReason: props.submitDisabledReason,
    submitPending: props.submitPending,
    connected: props.connected,
    draft: visibleDraft,
    hasAttachments: !props.suggestionComposer && Boolean(props.attachments?.length),
    preparingAttachments:
      (props.getPendingAttachmentReads?.() ?? props.pendingAttachmentReads ?? 0) > 0,
    isBusy,
    followUpMode: props.followUpMode,
    alternateFollowUpMode,
    suggestionComposer: props.suggestionComposer,
    submissionLabel: replacingRunningGoal ? t("chat.goals.replace") : goalComposer.submissionLabel,
    sending: props.sending && !replacingRunningGoal,
    voiceActive: props.realtimeTalkActive,
    voiceStatus: props.realtimeTalkStatus,
    voiceDetail: props.realtimeTalkDetail,
    voiceInputLevel: props.realtimeTalkInputLevel,
    voiceVideoCapable: props.realtimeTalkVideoCapable,
    voiceVideoEnabled: Boolean(props.realtimeTalkVideoStream),
    voiceVideoPending: props.realtimeTalkVideoPending,
    onAbort: props.onAbort,
    onSend: (event?: Event) => submitDraft(state.composerTextarea?.value ?? props.draft, event),
    onToggleVoice: props.onToggleRealtimeTalk ? handleVoicePrimaryAction : undefined,
    onToggleCamera: props.onToggleRealtimeCamera,
    microphonePicker,
    readDictation: dictation ? () => dictation : undefined,
    onDictationPointerDown: handleDictationStart,
    onDirectDictationStart: handleDictationStart,
    onPrimaryActionPointerDown: (event: PointerEvent) => {
      if (state.composerTextarea?.matches(":focus")) {
        event.preventDefault();
      }
    },
  };
  const clearSlashMenu =
    props.modelSwitching && state.slashMenu.state.slashMenuCommand?.key === "think";
  const emojiEnabled =
    canCompose &&
    !state.composerComposing &&
    !state.dictation?.locksComposer &&
    !goalComposer.pending;
  const commandsVisible = props.connected && canCompose;
  const clearSkillMenu =
    !(commandsVisible && isSkillMenuVisible(state.skillMenu.state)) &&
    state.skillMenu.state.skillMenuOpen &&
    !state.skillMenu.state.skillCommandRefreshPending;
  const menus = resolveComposerMenus(
    props.paneId,
    commandsVisible,
    state.skillMenu.state,
    state.slashMenu.state,
    state.mentionMenu,
    state.emojiMenu,
  );

  return {
    interaction,
    clearSlashMenu,
    clearSkillMenu,
    props,
    state,
    attachmentReadRevision: props.attachmentReadRevision ?? props.attachmentReads?.revision,
    canCompose,
    showAbortableUi,
    visibleDraft,
    predictionText: prediction?.text ?? null,
    acceptPrediction,
    dismissPrediction: () => prediction?.dismiss(),
    runStatusAnnouncement,
    cancellationCaveat,
    sendShortcut,
    questionPanelProps,
    showComposer,
    handleKeyDown,
    handleBeforeInput,
    handleInput,
    handleSelect,
    draftKey,
    handleCompositionEnd,
    handleBlur,
    dictation,
    dictationOptions,
    runControlsProps,
    menus,
    mentionMenuHost,
    mentionDirectory,
    emojiEnabled,
    mentionError,
    skillMenuHost,
    slashMenuHost,
    goalComposer,
  };
}

export function createComposerDictationOptions(
  props: ChatComposerProps,
  state: ChatComposerState,
  devicePicker: ComposerMicrophoneOwner,
  setError: (error: string | null) => void,
  onTap?: () => void,
) {
  return {
    client: props.gatewayClient ?? null,
    sessionKey: props.sessionKey,
    draftKey: composerDraftKey(props),
    connected: props.connected,
    enabled: props.composerHoldToRecord !== false,
    dictationAvailable: devicePicker.dictationStatus === "ready",
    realtimeTalkActive: props.realtimeTalkActive === true,
    onCommit: (transcript: string, late?: true) => {
      const target = state.composerTextarea;
      const captured = state.dictationSelection;
      const liveValue = target?.value ?? props.getDraft?.() ?? props.draft;
      // Stop unlocks the draft. Preserve later edits by using the live caret only
      // when a delayed final finds that the captured draft has changed.
      const selection =
        captured && (!late || captured.value === liveValue)
          ? captured
          : {
              start: target?.selectionStart ?? liveValue.length,
              end: target?.selectionEnd ?? liveValue.length,
              value: liveValue,
            };
      const insertion = insertComposerDictation(
        selection.value,
        transcript,
        selection.start,
        selection.end,
      );
      if (target) {
        target.value = insertion.value;
        adjustTextareaHeight(target);
      }
      commitComposerDraft(props, insertion.value);
      state.dictationSelection = null;
      queueMicrotask(() => {
        const textarea = state.composerTextarea;
        if (!textarea) {
          return;
        }
        textarea.focus({ preventScroll: true });
        textarea.selectionStart = insertion.caret;
        textarea.selectionEnd = insertion.caret;
      });
    },
    onError: (
      message: string,
      failure: { kind: "interrupted" | "start"; preservesText: boolean },
    ) => {
      const recovery =
        failure.kind === "interrupted" && failure.preservesText
          ? t("chat.composer.dictationInterruptedRecovery")
          : t("chat.composer.dictationStartRecovery");
      setError(`${message} ${recovery}`);
    },
    onDictationUnavailable: devicePicker.handleOpen,
    onTap,
  };
}
