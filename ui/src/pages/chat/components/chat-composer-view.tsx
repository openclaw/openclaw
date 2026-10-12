import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createMemo, createRenderEffect, onCleanup, Show, untrack } from "solid-js";
import "../../../styles/chat/composer-surface.css";
import "../../../components/mcp-app-catalog.tsx";
import "../../../components/solid/mcp-app-context-strip.tsx";
import "../../../components/mcp-app-resources.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { clearCompositionEnd } from "../../../lib/ime.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import type { ComposerDictationController } from "../composer-dictation.ts";
import { insertComposerDictation } from "../composer-dictation.ts";
import "../../../styles/chat/composer-context-strip.css";
import { renderChatAttachmentInputs } from "./chat-attachment-inputs.ts";
import {
  handleChatAttachmentPaste,
  renderAttachmentPreview,
  renderAttachmentReadStatus,
} from "./chat-attachments.ts";
import { ContextNotice } from "./chat-composer-context.tsx";
import { hasComposerContent } from "./chat-composer-controls.ts";
import type { ChatRunControlsProps } from "./chat-composer-controls.tsx";
import {
  renderChatAbortActionSolid,
  renderChatPrimaryActionsSolid as ChatPrimaryActions,
  renderComposerDictationStatusSolid,
} from "./chat-composer-controls.tsx";
import { focusComposerFromChrome, paneDomId } from "./chat-composer-dom.ts";
import { EmojiMenu } from "./chat-composer-emoji.tsx";
import { GoalComposerMode, type GoalComposerController } from "./chat-composer-goal-mode.tsx";
import { renderChatGoalRecoverySolid } from "./chat-composer-goal.tsx";
import { LitContent } from "./chat-composer-interop.tsx";
import { HumanMentionMenuView, type HumanMentionMenuHost } from "./chat-composer-mention-menu.tsx";
import type { resolveComposerMenus } from "./chat-composer-menus.ts";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";
import { ComposerQuestionDock } from "./chat-composer-question.tsx";
import { renderChatQueue } from "./chat-composer-queue.tsx";
import {
  ComposerQueue,
  ComposerInputScope,
  ComposerProgress,
  ComposerGoal,
} from "./chat-composer-regions.tsx";
import { SelectedHumanMentions } from "./chat-composer-selected-mentions.tsx";
import { resetSkillMenuState, SkillMenu, type SkillMenuHost } from "./chat-composer-skill-menu.tsx";
import { SlashMenu, resetSlashMenuState, type SlashMenuHost } from "./chat-composer-slash-menu.tsx";
import { commitComposerDraft } from "./chat-composer-state.ts";
import { renderFallbackIndicatorSolid } from "./chat-composer-status.tsx";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";
import { isPastedTextAttachment } from "./chat-pasted-text.ts";
import { ChatPermissionPicker } from "./chat-permission-picker.ts";
import {
  handleChatComposerDropdownShow,
  markPointerOpenedChatComposerDropdown,
  restorePointerOpenedChatComposerTrigger,
} from "./chat-picker-overlay.ts";
import type { createGatewayQuestionPanelProps } from "./chat-question-card.ts";
import { renderChatVoiceStatus } from "./chat-voice-activity.ts";

type ChatComposerViewContext = {
  props: ChatComposerProps;
  state: ChatComposerState;
  attachmentReadRevision: number | undefined;
  canCompose: boolean;
  showAbortableUi: boolean;
  visibleDraft: string;
  runStatusAnnouncement: string;
  requestUpdate: () => void;
  sendShortcut: "enter" | "modifier-enter";
  questionPanelProps: ReturnType<typeof createGatewayQuestionPanelProps> | null;
  showComposer: boolean;
  handleKeyDown: (event: KeyboardEvent) => void;
  handleBeforeInput: (event: InputEvent) => void;
  handleInput: (event: InputEvent) => void;
  handleSelect: (event: Event) => void;
  draftKey: string;
  handleCompositionEnd: (event: CompositionEvent) => void;
  handleBlur: (event: FocusEvent) => void;
  dictation: ComposerDictationController | undefined;
  runControlsProps: ChatRunControlsProps;
  menus: ReturnType<typeof resolveComposerMenus>;
  mentionMenuHost: HumanMentionMenuHost;
  mentionError: string | null;
  skillMenuHost: SkillMenuHost;
  slashMenuHost: SlashMenuHost;
  goalComposer: GoalComposerController;
};

export function renderChatComposerQueue(props: ChatComposerProps, showAbortableUi: boolean) {
  const canAct = props.connected && props.canSend && !props.submitDisabledReason;
  return renderChatQueue({
    queue: props.queue,
    displayQueue: props.displayQueue,
    offline: props.offline,
    canAbort: showAbortableUi,
    canRemoveServerQueued: canAct,
    onQueueRetry: canAct ? props.onQueueRetry : undefined,
    onQueueSteer: canAct ? props.onQueueSteer : undefined,
    // Reordering is local bookkeeping, so it stays available while offline —
    // exactly when a queue is long enough to need it.
    onQueueMove: props.onQueueMove,
    queuedEdit: props.queuedEdit,
    onQueueRemove: props.onQueueRemove,
  });
}

export function renderChatComposerView(context: ChatComposerViewContext) {
  const props = untrack(() => context.props);

  const activeSession = createMemo(() => props.selectedSession);
  const composerControls = createMemo(() => props.composerControls ?? undefined);
  const attachmentPreview = createMemo(() => {
    // Read entries mutate without replacing the lifecycle or attachment array.
    void context.attachmentReadRevision;
    return renderAttachmentPreview(props);
  });
  const composerLeadControl = (
    <Show when={props.permissionPicker}>{(picker) => <ChatPermissionPicker {...picker()} />}</Show>
  );
  const placeholder = createMemo(() =>
    context.goalComposer.active
      ? t("chat.goals.objectivePlaceholder")
      : (props.attachments ?? []).some((attachment) => !isPastedTextAttachment(attachment))
        ? t("chat.composer.placeholderWithAttachments")
        : t("chat.composer.placeholder", { name: props.assistantName || "agent" }),
  );
  const mirrorCameraPreview = createMemo(
    () =>
      props.realtimeTalkVideoStream?.getVideoTracks?.()[0]?.getSettings?.().facingMode !==
      "environment",
  );
  const slashMenuAnnouncementId = createMemo(() =>
    paneDomId(props.paneId, "slash-active-announcement"),
  );
  const disabledBanner = createMemo(() =>
    props.disabledBanner && props.disabledBanner.presentation !== "hidden" ? (
      <>
        <div
          class={`agent-chat__disabled-banner ${
            props.disabledBanner.kind === "composer-replacement"
              ? "agent-chat__disabled-banner--replacement"
              : ""
          } ${props.disabledBanner.presentation === "compact" ? "agent-chat__disabled-banner--compact" : ""} callout ${
            props.disabledBanner.tone === "neutral"
              ? "agent-chat__disabled-banner--neutral"
              : "info"
          } callout--action`}
          role="status"
        >
          {props.disabledBanner.icon ? (
            <>
              <span
                class={`agent-chat__disabled-banner-icon agent-chat__disabled-banner-icon--${props.disabledBanner.icon}`}
                aria-hidden="true"
              >
                {props.disabledBanner.icon === "archive" ? (
                  <Icon name="archive" />
                ) : props.disabledBanner.icon === "eye" ? (
                  <Icon name="eye" />
                ) : (
                  <Icon name="alertTriangle" />
                )}
              </span>
            </>
          ) : undefined}
          <div class="callout__content">
            {props.disabledBanner.title ? (
              <>
                <div class="agent-chat__disabled-banner-title">{props.disabledBanner.title}</div>
              </>
            ) : undefined}
            <div class="agent-chat__disabled-banner-detail">{props.disabledBanner.text}</div>
          </div>
          {props.disabledBanner.onAction ? (
            <>
              <button
                type="button"
                class={`btn btn--sm ${props.disabledBanner.actionStyle ?? ""}`}
                disabled={Boolean(props.disabledBanner.disabledReason) || props.disabledBanner.busy}
                aria-busy={props.disabledBanner.busy ? "true" : "false"}
                title={props.disabledBanner.disabledReason ?? undefined}
                onClick={props.disabledBanner.onAction}
              >
                {props.disabledBanner.busy ? (
                  <>
                    <span class="btn__spinner" aria-hidden="true"></span>
                    {props.disabledBanner.busyLabel ?? props.disabledBanner.actionLabel}
                  </>
                ) : (
                  props.disabledBanner.actionLabel
                )}
              </button>
            </>
          ) : undefined}
          {props.disabledBanner.kind === "composer-replacement" &&
          props.disabledBanner.presentation !== "compact" &&
          context.showAbortableUi
            ? renderChatAbortActionSolid(context.runControlsProps)
            : undefined}
        </div>
      </>
    ) : undefined,
  );
  const showComposerInput = createMemo(
    () => context.showComposer && props.disabledBanner?.kind !== "composer-replacement",
  );
  const disabledReasonId = createMemo(() => paneDomId(props.paneId, "disabled-reason"));
  const composerAlerts = createMemo(() =>
    showComposerInput() ? (
      <>
        <LitContent
          value={renderChatVoiceStatus({
            status: props.realtimeTalkCameraError ? "error" : props.realtimeTalkStatus,
            detail: props.realtimeTalkDetail,
            onUseSystemDefaultMicrophone: props.onUseSystemDefaultMicrophone,
            onDismissError: props.realtimeTalkCameraError
              ? undefined
              : props.onDismissRealtimeTalkError,
          })}
        />
        {props.realtimeTalkInputNotice ? (
          <LitContent
            value={renderChatVoiceStatus({
              status: "error",
              detail: props.realtimeTalkInputNotice,
              onDismissError: props.onDismissRealtimeTalkInputNotice,
            })}
          />
        ) : undefined}
      </>
    ) : undefined,
  );
  const offlineText = createMemo(() =>
    props.offline && props.queuedOutboxCount
      ? t("chat.composer.offlineQueuedHint", { count: String(props.queuedOutboxCount) })
      : null,
  );
  const composerError = createMemo(() => context.mentionError || context.state.dictationError);
  const primaryComposerStatus = createMemo(() =>
    props.disabledReason
      ? {
          text: props.disabledReason,
          tone: props.disabledReasonTone ?? ("danger" as const),
          icon: props.disabledReasonBusy ? (
            <>
              <span class="btn__spinner" aria-hidden="true"></span>
            </>
          ) : (props.disabledReasonTone ?? "danger") === "danger" ? (
            <Icon name="alertTriangle" />
          ) : (
            <Icon name="shieldQuestion" />
          ),
        }
      : composerError()
        ? { text: composerError(), tone: "danger" as const, icon: <Icon name="alertTriangle" /> }
        : offlineText()
          ? { text: offlineText(), tone: "info" as const, icon: <Icon name="inbox" /> }
          : null,
  );
  const composerStatus = createMemo(() => {
    if (!showComposerInput()) {
      return undefined;
    }
    const status = primaryComposerStatus();
    return status ? (
      <>
        <div class="agent-chat__composer-status" data-tone={status.tone}>
          <div
            id={props.disabledReason ? disabledReasonId() : undefined}
            class="agent-chat__composer-status-band"
            role={status.tone === "danger" ? "alert" : "status"}
            aria-live="polite"
            aria-busy={props.disabledReasonBusy ? "true" : "false"}
          >
            <span class="agent-chat__composer-status-icon" aria-hidden="true">
              {status.icon}
            </span>
            <span class="agent-chat__composer-status-text">{status.text}</span>
          </div>
        </div>
      </>
    ) : undefined;
  });
  const fallbackStatus = createMemo(() => renderFallbackIndicatorSolid(props.fallbackStatus));
  return (
    <>
      <div class="agent-chat__composer-shell">
        <div class="chat-footer__context">
          <LitContent value={props.footerContent ?? undefined} />
          <div class="agent-chat__composer-notices">
            <LitContent value={props.notices ?? undefined} /> {composerStatus()} {composerAlerts()}{" "}
            {fallbackStatus()}
          </div>
          <ComposerQuestionDock panel={context.questionPanelProps} />
          {props.disabledBanner?.kind === "above-composer" ? disabledBanner() : undefined}
          <ComposerProgress composer={props} shown={context.showComposer} />{" "}
          <ComposerQueue composer={props} showAbortableUi={context.showAbortableUi} />
          {renderChatGoalRecoverySolid(props.goalRecovery, props.connected)}{" "}
          <ComposerGoal
            composer={props}
            state={context.state}
            controller={context.goalComposer}
            requestUpdate={context.requestUpdate}
          />
          <LitContent value={props.composerRecovery ?? undefined} />
        </div>
        {showComposerInput() ? (
          <ComposerInputScope state={context.state}>
            <div
              class={`agent-chat__input agent-chat__input--chat agent-chat__input--mobile-toolbar ${props.offline ? "agent-chat__input--offline" : ""}${context.dictation?.active ? " agent-chat__input--dictating" : ""}${!context.canCompose ? " agent-chat__input--disabled" : ""}`}
              aria-busy={props.disabledReasonBusy ? "true" : "false"}
              onWa-show={handleChatComposerDropdownShow}
              onWa-after-show={restorePointerOpenedChatComposerTrigger}
              onOpenclaw-composer-dismiss-invocations={() => {
                resetSlashMenuState(context.state);
                resetSkillMenuState(context.state);
                context.state.mentionMenu.close();
                context.state.emojiMenu.dismiss(context.state.composerTextarea);
                context.requestUpdate();
              }}
              onClick={(event: MouseEvent) => focusComposerFromChrome(event, context.canCompose)}
              onPointerDown={(event: PointerEvent) => {
                markPointerOpenedChatComposerDropdown(event);
                focusComposerFromChrome(event, context.canCompose);
              }}
              ref={context.state.composerInputRef ?? undefined}
            >
              {context.menus.slashMenuVisible ? (
                <SlashMenu
                  args={[
                    context.state,
                    context.slashMenuHost,
                    context.visibleDraft,
                    context.requestUpdate,
                  ]}
                />
              ) : undefined}
              {context.menus.skillMenuVisible ? (
                <SkillMenu args={[context.state, context.skillMenuHost, context.requestUpdate]} />
              ) : undefined}
              <EmojiMenu
                args={[
                  context.state.emojiMenu,
                  props.paneId,
                  context.state.composerTextarea,
                  context.requestUpdate,
                ]}
              />
              {context.menus.mentionMenuVisible ? (
                <HumanMentionMenuView
                  args={[context.state.mentionMenu, context.mentionMenuHost, context.requestUpdate]}
                />
              ) : undefined}
              <div class="agent-chat__composer-lede">
                {props.sessionAdmitted === false ? undefined : (
                  <>
                    <openclaw-mcp-app-catalog
                      surface="thread"
                      prop:sessionKey={props.sessionKey}
                      prop:agentId={props.currentAgentId}
                    ></openclaw-mcp-app-catalog>
                    <openclaw-mcp-app-resources
                      prop:sessionKey={props.sessionKey}
                      prop:agentId={props.currentAgentId}
                    ></openclaw-mcp-app-resources>
                  </>
                )}
                <GoalComposerMode controller={context.goalComposer} />
                <SelectedHumanMentions
                  text={context.visibleDraft}
                  mentions={props.mentions}
                  onRemove={() => {
                    commitComposerDraft(props, props.getDraft?.() ?? props.draft, []);
                    context.requestUpdate();
                  }}
                  avatarUrls={context.state.mentionMenu.selectedAvatarUrls}
                />
                {props.replyTarget ? (
                  <>
                    <div class="chat-reply-preview composer-context-strip">
                      <span class="chat-reply-preview__label composer-context-strip__label">
                        <span class="chat-reply-preview__icon composer-context-strip__icon">
                          {<Icon name="messageSquare" />}
                        </span>
                        <span class="composer-context-strip__label-text">
                          {t("chat.messages.replyingTo", {
                            name: props.replyTarget.senderLabel ?? t("chat.messages.message"),
                          })}
                        </span>
                      </span>
                      <span class="chat-reply-preview__text composer-context-strip__text">
                        {truncateUtf16Safe(props.replyTarget.text, 120)}
                        {props.replyTarget.text.length > 120 ? "..." : ""}
                      </span>
                      <button
                        type="button"
                        class="chat-reply-preview__dismiss composer-context-strip__dismiss"
                        onClick={() => props.onClearReply?.()}
                        aria-label={t("chat.composer.cancelReply")}
                        title={t("chat.composer.cancelReply")}
                      >
                        {<Icon name="x" />}
                      </button>
                    </div>
                  </>
                ) : undefined}
                {props.sessionAdmitted === false ? undefined : (
                  <>
                    <openclaw-mcp-app-context-strip
                      prop:sessionKey={props.sessionKey}
                      prop:agentId={props.currentAgentId}
                    ></openclaw-mcp-app-context-strip>
                  </>
                )}
                <LitContent value={attachmentPreview()} />
                <LitContent
                  value={renderAttachmentReadStatus(
                    props.getPendingAttachmentReads?.() ?? props.pendingAttachmentReads ?? 0,
                  )}
                />
                {renderComposerDictationStatusSolid(context.dictation)}
                <LitContent
                  value={renderChatAttachmentInputs({
                    ...props,
                    disabled: !context.canCompose,
                    cameraActive: context.showComposer && props.cameraActive !== false,
                  })}
                />
                {props.realtimeTalkVideoStream ? (
                  <>
                    <div class="agent-chat__video-preview">
                      <video
                        class={
                          mirrorCameraPreview() ? "agent-chat__video-preview-mirrored" : undefined
                        }
                        autoplay
                        muted
                        ref={(video) => {
                          video.muted = true;
                        }}
                        playsinline
                        aria-label={t("chat.composer.cameraPreview")}
                        prop:srcObject={props.realtimeTalkVideoStream}
                      ></video>
                      {props.realtimeTalkCameraDevices &&
                      props.realtimeTalkCameraDevices.length >= 2 &&
                      props.onSwitchRealtimeCamera ? (
                        <>
                          <openclaw-tooltip
                            class="agent-chat__video-preview-switch-tooltip"
                            prop:content={t("chat.composer.switchCamera")}
                          >
                            <button
                              type="button"
                              class="agent-chat__video-preview-switch"
                              aria-label={t("chat.composer.switchCamera")}
                              disabled={props.realtimeTalkVideoPending}
                              onClick={props.onSwitchRealtimeCamera}
                            >
                              {<Icon name="switchCamera" />}
                            </button>
                          </openclaw-tooltip>
                        </>
                      ) : undefined}
                    </div>
                  </>
                ) : undefined}
              </div>

              <div class="agent-chat__composer-input-row">
                <div class="agent-chat__composer-combobox">
                  <Show when={context.draftKey} keyed>
                    {(scopeKey) => (
                      <ComposerTextarea
                        context={context}
                        scopeKey={scopeKey}
                        announcementId={slashMenuAnnouncementId()}
                        disabledReasonId={disabledReasonId()}
                        placeholder={placeholder()}
                      />
                    )}
                  </Show>
                  <span class="agent-chat__composer-placeholder" aria-hidden="true">
                    {context.dictation?.active ? "" : placeholder()}
                  </span>
                  <span
                    id={slashMenuAnnouncementId()}
                    class="sr-only"
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                  >
                    {context.menus.activeMenuOptionLabel}
                  </span>
                  <span
                    class="agent-chat__run-status-announcement sr-only"
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                  >
                    {context.runStatusAnnouncement}
                  </span>
                </div>
              </div>

              <div class="agent-chat__composer-footer">
                <div class="agent-chat__composer-lead agent-chat__composer-meta">
                  <ChatComposerPlusMenu
                    menu={{
                      attachments: props,
                      capabilityMenu: props.capabilityMenu,
                      disabled: !context.canCompose || props.suggestionComposer === true,
                      open: context.state.capabilityMenuOpen,
                      view: context.state.capabilityMenuView,
                      toolOverrides: props.toolOverrides,
                      onOpenChange: (open) => {
                        context.state.capabilityMenuOpen = open;
                        if (!open) {
                          context.state.capabilityMenuView = "root";
                        }
                        context.requestUpdate();
                      },
                      onViewChange: (view) => {
                        context.state.capabilityMenuView = view;
                        context.requestUpdate();
                      },
                    }}
                  />
                  {composerLeadControl}
                </div>
                <div class="agent-chat__composer-trail">
                  <div class="agent-chat__composer-meta agent-chat__composer-context">
                    <ContextNotice
                      session={activeSession()}
                      messages={props.messages}
                      providerUsage={props.providerUsage}
                    />
                  </div>
                  {hasComposerContent(composerControls()) ? (
                    <>
                      {" "}
                      <div class="agent-chat__composer-controls">
                        <LitContent value={composerControls()} />
                      </div>{" "}
                    </>
                  ) : undefined}
                  <div class="agent-chat__composer-actions">
                    <ChatPrimaryActions {...context.runControlsProps} />
                  </div>
                </div>
              </div>
            </div>
          </ComposerInputScope>
        ) : props.disabledBanner?.kind === "composer-replacement" ? (
          disabledBanner()
        ) : undefined}
      </div>
    </>
  );
}

function ComposerTextarea(view: {
  context: ChatComposerViewContext;
  scopeKey: string;
  announcementId: string;
  disabledReasonId: string;
  placeholder: string;
}) {
  const context = untrack(() => view.context);
  const composer = untrack(() => context.props);
  const ownerState = untrack(() => context.state);
  let element: HTMLTextAreaElement | undefined;
  const value = createMemo(() => {
    const state = context.state;
    const draft =
      state.composingDraft?.key === view.scopeKey
        ? state.composingDraft.value
        : (composer.getDraft?.() ?? composer.draft);
    const dictation = context.dictation;
    return dictation?.active
      ? insertComposerDictation(
          state.dictationSelection?.value ?? draft,
          dictation.transcript,
          state.dictationSelection?.start ?? draft.length,
          state.dictationSelection?.end ?? draft.length,
        ).value
      : draft;
  });
  createRenderEffect(value, (next) => {
    // Native edits own their value and undo history until the draft scope changes.
    if (element && !ownerState.composerComposing && element.value !== next) {
      element.value = next;
    }
  });
  onCleanup(() => {
    if (ownerState.composerTextarea === element) {
      ownerState.textareaRef?.();
    }
  });
  return (
    <textarea
      ref={(node) => {
        element = node;
        ownerState.textareaRef?.(node);
        const next = untrack(value);
        if (node.value !== next) {
          node.value = next;
        }
      }}

      dir={detectTextDirection(value())}
      disabled={!context.canCompose}
      readonly={context.dictation?.locksComposer === true || context.goalComposer.pending}
      aria-autocomplete="list"
      aria-controls={context.menus.menuVisible ? context.menus.menuListboxId : undefined}
      aria-haspopup={context.menus.menuVisible ? "listbox" : undefined}
      aria-activedescendant={context.menus.activeMenuOptionId ?? undefined}
      aria-describedby={`${view.announcementId}${
        composer.disabledReason ? ` ${view.disabledReasonId}` : ""
      }`}
      aria-keyshortcuts={context.sendShortcut === "enter" ? "Enter" : "Control+Enter Meta+Enter"}
      onKeyDown={(event) => context.handleKeyDown(event)}
      onBeforeInput={(event) => context.handleBeforeInput(event)}
      onInput={(event) => context.handleInput(event)}
      onSelect={(event) => context.handleSelect(event)}
      onFocus={(event) => context.handleSelect(event)}
      onPointerUp={(event) => context.handleSelect(event)}
      onKeyUp={(event: KeyboardEvent) => {
        clearCompositionEnd(event);
        context.state.emojiMenu.handleKeyup(event);
        if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
          context.handleSelect(event);
        }
      }}
      onCompositionStart={(event: CompositionEvent) => {
        if (event.target !== context.state.composerTextarea || context.draftKey !== view.scopeKey) {
          return;
        }
        const emojiWasOpen = context.state.emojiMenu.open;
        context.state.mentionMenu.close();
        context.state.emojiMenu.close();
        context.state.editRevision += 1;
        context.state.composerComposing = true;
        context.state.composingDraft = {
          key: context.draftKey,
          // SAFETY: The identity check above requires this scope's composer textarea.
          value: (event.target as HTMLTextAreaElement).value,
        };
        if (emojiWasOpen) {
          context.requestUpdate();
        }
      }}
      onCompositionEnd={(event) => context.handleCompositionEnd(event)}
      onBlur={(event) => context.handleBlur(event)}
      onPaste={(event: ClipboardEvent) => {
        if (context.canCompose && !composer.suggestionComposer) {
          handleChatAttachmentPaste(event, composer);
        }
      }}
      aria-label={t("chat.composer.composerInput")}
      placeholder={context.dictation?.active ? "" : view.placeholder}
      rows="1"
    ></textarea>
  );
}
