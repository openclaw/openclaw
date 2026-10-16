import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { dynamic } from "@solidjs/web";
import { createMemo, createRenderEffect, onCleanup, Show, untrack } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../styles/chat/composer-surface.css";
import "../../../components/mcp-app-catalog.tsx";
import "../../../components/solid/mcp-app-context-strip.tsx";
import "../../../components/mcp-app-resources.tsx";
import { clearCompositionEnd } from "../../../lib/ime.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { insertComposerDictation } from "../composer-dictation.ts";
import "../../../styles/chat/composer-context-strip.css";
import { ChatAttachmentInputs } from "./chat-attachment-inputs.tsx";
import { handleChatAttachmentPaste } from "./chat-attachments.ts";
import { AttachmentPreview, AttachmentReadStatus } from "./chat-attachments.tsx";
import { ComposerContent } from "./chat-composer-content.tsx";
import { ContextNotice } from "./chat-composer-context.tsx";
import {
  renderChatAbortActionSolid,
  renderChatPrimaryActionsSolid as ChatPrimaryActions,
  renderComposerDictationStatusSolid,
} from "./chat-composer-controls.tsx";
import { focusComposerFromChrome, paneDomId } from "./chat-composer-dom.ts";
import { EmojiMenu } from "./chat-composer-emoji.tsx";
import type { createChatComposerContext } from "./chat-composer-frame.ts";
import { GoalComposerMode } from "./chat-composer-goal-mode.tsx";
import { HumanMentionMenuView } from "./chat-composer-mention-menu.tsx";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";
import { ComposerQuestionDock } from "./chat-composer-question.tsx";
import {
  ComposerQueue,
  ComposerInputScope,
  ComposerProgress,
  ComposerGoal,
} from "./chat-composer-regions.tsx";
import { SelectedHumanMentions } from "./chat-composer-selected-mentions.tsx";
import { resetSkillMenuState, SkillMenu } from "./chat-composer-skill-menu.tsx";
import { SlashMenu, resetSlashMenuState } from "./chat-composer-slash-menu.tsx";
import { commitComposerDraft } from "./chat-composer-state.ts";
import { renderFallbackIndicatorSolid } from "./chat-composer-status.tsx";
import { isPastedTextAttachment } from "./chat-pasted-text.ts";
import { ChatPermissionPicker } from "./chat-permission-picker.tsx";
import { ChatVoiceStatus } from "./chat-voice-activity.tsx";

type ChatComposerViewContext = ReturnType<typeof createChatComposerContext>;

export function renderChatComposerView(context: ChatComposerViewContext) {
  const props = untrack(() => context.props);

  const activeSession = createMemo(() => props.selectedSession);
  const composerControls = createMemo(() => props.composerControls ?? undefined);
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
  // Owner refreshes replace the banner and callback values, not the focused action's DOM.
  const disabledBanner = (
    <Show when={props.disabledBanner?.presentation !== "hidden" ? props.disabledBanner : undefined}>
      {(banner) => (
        <>
          <div
            class={`agent-chat__disabled-banner ${
              banner().kind === "composer-replacement"
                ? "agent-chat__disabled-banner--replacement"
                : ""
            } ${banner().presentation === "compact" ? "agent-chat__disabled-banner--compact" : ""} callout ${
              banner().tone === "neutral" ? "agent-chat__disabled-banner--neutral" : "info"
            } callout--action`}
            role="status"
          >
            {banner().icon ? (
              <span
                class={`agent-chat__disabled-banner-icon agent-chat__disabled-banner-icon--${banner().icon}`}
                aria-hidden="true"
              >
                <Icon
                  name={
                    ({ archive: "archive", eye: "eye", warning: "alertTriangle" } as const)[
                      banner().icon!
                    ]
                  }
                />
              </span>
            ) : undefined}
            <div class="callout__content">
              {banner().title ? (
                <div class="agent-chat__disabled-banner-title">{banner().title}</div>
              ) : undefined}
              <div class="agent-chat__disabled-banner-detail">{banner().text}</div>
            </div>
            <Show when={banner().onAction}>
              {(onAction) => (
                <button
                  type="button"
                  class={`btn btn--sm ${banner().actionStyle ?? ""}`}
                  disabled={Boolean(banner().disabledReason) || banner().busy}
                  aria-busy={banner().busy ? "true" : "false"}
                  title={banner().disabledReason ?? undefined}
                  onClick={() => onAction()()}
                >
                  {banner().busy ? (
                    <>
                      <span class="btn__spinner" aria-hidden="true"></span>
                      {banner().busyLabel ?? banner().actionLabel}
                    </>
                  ) : (
                    banner().actionLabel
                  )}
                </button>
              )}
            </Show>
            {banner().kind === "composer-replacement" &&
            banner().presentation !== "compact" &&
            context.showAbortableUi
              ? renderChatAbortActionSolid(context.runControlsProps)
              : undefined}
          </div>
        </>
      )}
    </Show>
  );
  const showComposerInput = createMemo(
    () => context.showComposer && props.disabledBanner?.kind !== "composer-replacement",
  );
  const disabledReasonId = createMemo(() => paneDomId(props.paneId, "disabled-reason"));
  const composerAlerts = createMemo(() =>
    showComposerInput() ? (
      <>
        <ChatVoiceStatus
          status={props.realtimeTalkCameraError ? "error" : props.realtimeTalkStatus}
          detail={props.realtimeTalkDetail}
          onUseSystemDefaultMicrophone={props.onUseSystemDefaultMicrophone}
          onDismissError={
            props.realtimeTalkCameraError ? undefined : props.onDismissRealtimeTalkError
          }
        />
        {props.realtimeTalkInputNotice ? (
          <ChatVoiceStatus
            status="error"
            detail={props.realtimeTalkInputNotice}
            onDismissError={props.onDismissRealtimeTalkInputNotice}
          />
        ) : undefined}
      </>
    ) : undefined,
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
          {props.footerContent}
          <div class="agent-chat__composer-notices">
            {props.notices} {composerStatus()} {composerAlerts()} {fallbackStatus()}
          </div>
          <ComposerQuestionDock panel={context.questionPanelProps} />
          {props.disabledBanner?.kind === "above-composer" ? disabledBanner : undefined}
          <ComposerProgress composer={props} shown={context.showComposer} />{" "}
          <ComposerQueue composer={props} showAbortableUi={context.showAbortableUi} />
          <ComposerGoal
            composer={props}
            state={context.state}
            controller={context.goalComposer}
            requestUpdate={context.requestUpdate}
          />
          <Show when={props.composerRecovery}>
            {(recovery) => {
              const Recovery = dynamic(() => recovery().component);
              return (
                <ComposerContent>
                  <Recovery {...recovery()} />
                </ComposerContent>
              );
            }}
          </Show>
        </div>
        {showComposerInput() ? (
          <ComposerInputScope state={context.state}>
            <div
              class={`agent-chat__input agent-chat__input--chat agent-chat__input--mobile-toolbar ${props.offline ? "agent-chat__input--offline" : ""}${context.dictation?.active ? " agent-chat__input--dictating" : ""}${!context.canCompose ? " agent-chat__input--disabled" : ""}`}
              aria-busy={props.disabledReasonBusy ? "true" : "false"}
              onOpenclaw-composer-dismiss-invocations={() => {
                resetSlashMenuState(context.state);
                resetSkillMenuState(context.state);
                context.state.mentionMenu.close();
                context.state.emojiMenu.dismiss(context.state.composerTextarea);
                context.requestUpdate();
              }}
              onClick={(event: MouseEvent) => focusComposerFromChrome(event, context.canCompose)}
              onPointerDown={(event: PointerEvent) =>
                focusComposerFromChrome(event, context.canCompose)
              }
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
                <AttachmentPreview {...props} readRevision={context.attachmentReadRevision} />
                <AttachmentReadStatus
                  pendingReads={
                    props.getPendingAttachmentReads?.() ?? props.pendingAttachmentReads ?? 0
                  }
                />
                {renderComposerDictationStatusSolid(context.dictation)}
                <ChatAttachmentInputs
                  {...props}
                  disabled={!context.canCompose}
                  cameraActive={context.showComposer && props.cameraActive !== false}
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
                <div
                  class="agent-chat__composer-combobox"
                  data-prediction={context.predictionText ? "true" : undefined}
                >
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
                    {context.dictation?.active || context.predictionText ? "" : placeholder()}
                  </span>
                  <Show when={context.predictionText}>
                    <span class="agent-chat__composer-prediction" aria-hidden="true">
                      {context.predictionText}
                    </span>
                    <div class="agent-chat__composer-prediction-actions">
                      <button
                        type="button"
                        aria-label={t("chat.composer.usePrediction")}
                        aria-keyshortcuts="Tab"
                        onClick={() => context.acceptPrediction()}
                      >
                        <kbd>{t("chat.composer.predictionShortcut")}</kbd>{" "}
                        {t("chat.composer.usePrediction")}
                      </button>
                      <button
                        type="button"
                        onClick={() => context.dismissPrediction()}
                        aria-label={t("chat.composer.dismissPrediction")}
                      >
                        {t("chat.composer.dismissPrediction")}
                      </button>
                    </div>
                  </Show>
                  <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
                    {context.predictionText
                      ? t("chat.composer.predictionAvailable", {
                          text: context.predictionText,
                        })
                      : ""}
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
                  <Show when={composerControls()}>
                    {(controls) => {
                      const Controls = dynamic(() => controls().component);
                      return (
                        <>
                          {" "}
                          <div class="agent-chat__composer-controls">
                            <ComposerContent>
                              <Controls model={controls().model} />
                            </ComposerContent>
                          </div>{" "}
                        </>
                      );
                    }}
                  </Show>
                  <div class="agent-chat__composer-actions">
                    <ChatPrimaryActions {...context.runControlsProps} />
                  </div>
                </div>
              </div>
            </div>
          </ComposerInputScope>
        ) : props.disabledBanner?.kind === "composer-replacement" ? (
          disabledBanner
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
        context.dismissPrediction();
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
