import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { dynamic } from "@solidjs/web";
import { createMemo, createSignal, lazy, Show } from "solid-js";
import { createFooterControlRef } from "../../../app/shell-layout-traits-solid.tsx";
import { McpAppCatalog } from "../../../components/mcp-app-catalog.tsx";
import { McpAppResources } from "../../../components/mcp-app-resources.tsx";
import { createBackgroundLayoutRef } from "../../../components/session-background-layout-context.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../styles/chat/composer-surface.css";
import "../../../styles/chat/composer-mobile.css";
import { McpAppContextStrip } from "../../../components/solid/mcp-app-context-strip.tsx";
import { shouldHandleNavigationClick } from "../../../lib/navigation-click.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { PaneSubagentStop } from "../chat-pane-header-view.tsx";
import { hasVisibleChatActivityPills } from "./chat-activity-pills-visibility.ts";
import "../../../styles/chat/composer-context-strip.css";
import { createChatAttachmentInputHandle } from "./chat-attachment-inputs.ts";
import { ChatAttachmentInputs } from "./chat-attachment-inputs.tsx";
import { AttachmentPreview, AttachmentReadStatus } from "./chat-attachments.tsx";
import { ComposerContent } from "./chat-composer-content.tsx";
import { ContextNotice } from "./chat-composer-context.tsx";
import {
  renderChatAbortActionSolid,
  renderChatPrimaryActionsSolid as ChatPrimaryActions,
} from "./chat-composer-controls.tsx";
import { focusComposerFromChrome, paneDomId } from "./chat-composer-dom.ts";
import "../../../styles/chat/emoji-menu.css";
import "../../../styles/chat/mention-menu.css";
import type { createChatComposerContext } from "./chat-composer-frame.ts";
import { createComposerMobileInteraction } from "./chat-composer-mobile-interaction.tsx";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";
import type { ChatComposerPlusMenuView } from "./chat-composer-plus-menu.types.ts";
import { ComposerQuestionDock } from "./chat-composer-question.tsx";
import { ComposerQueue, ComposerInputScope, ComposerProgress } from "./chat-composer-regions.tsx";
import { SelectedHumanMentions } from "./chat-composer-selected-mentions.tsx";
import { commitComposerDraft } from "./chat-composer-state.ts";
import { renderFallbackIndicatorSolid } from "./chat-composer-status.tsx";
import { renderComposerTextarea, type ComposerTextareaProps } from "./chat-composer-textarea.tsx";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { ChatPermissionPicker } from "./chat-permission-picker.tsx";
import { ChatVoiceStatus, ComposerDictationStatus } from "./chat-voice-activity.tsx";

type ChatComposerViewContext = ReturnType<typeof createChatComposerContext>;

const SlashMenu = lazy(() => import("./chat-composer-slash-menu.tsx"), { export: "SlashMenu" });
const SkillMenu = lazy(() => import("./chat-composer-skill-menu.tsx"), { export: "SkillMenu" });
const HumanMentionMenuView = lazy(() => import("./chat-composer-mention-menu.tsx"), {
  export: "HumanMentionMenuView",
});
const EmojiMenu = lazy(() => import("./chat-composer-emoji.tsx"), { export: "EmojiMenu" });
const ChatGoal = lazy(() => import("./chat-composer-goal.tsx"), { export: "ChatGoal" });
const ChatGoalRecoveryNotice = lazy(() => import("./chat-composer-goal.tsx"), {
  export: "ChatGoalRecoveryNotice",
});
const GoalComposerMode = lazy(() => import("./chat-composer-goal-mode-view.tsx"), {
  export: "GoalComposerMode",
});

const ChatActivityPills = lazy(() => import("./chat-activity-pills.tsx"), {
  export: "ChatActivityPills",
});

export function renderChatComposerView(
  context: () => ChatComposerViewContext,
  props: ChatComposerProps,
  state: ChatComposerState,
) {
  const footerControl = createFooterControlRef();
  const ComposerTextarea = (view: ComposerTextareaProps) =>
    renderComposerTextarea(context, props, state, view);
  const inputHandle = createChatAttachmentInputHandle();
  let shell: HTMLDivElement | undefined;
  let placeholderElement: HTMLSpanElement | undefined;
  const { mobileEditing, keyboardNavigation, lifecycle } = createComposerMobileInteraction(
    context,
    props,
    state,
    () => shell,
    () => placeholderElement,
  );
  const [capabilityOpen, setCapabilityOpen] = createSignal(false);
  const capabilityAvailable = createMemo(() => Boolean(props.capabilityMenu));
  const [capabilityView, setCapabilityView] = createSignal<ChatComposerPlusMenuView>(
    (): ChatComposerPlusMenuView => {
      capabilityAvailable();
      return "root";
    },
  );

  const resumeRecovery = createMemo(() => {
    const recovery = props.goalRecovery;
    return recovery?.action === "resume" &&
      !recovery.retired &&
      recovery.goalId === props.selectedSession?.goal?.id
      ? recovery
      : undefined;
  });
  const composerLeadControl = (
    <Show when={props.permissionPicker}>{(picker) => <ChatPermissionPicker {...picker()} />}</Show>
  );
  const placeholder = createMemo(() =>
    context().goalComposer.active
      ? t("chat.goals.objectivePlaceholder")
      : t("chat.composer.placeholder", { name: props.assistantName || "agent" }),
  );
  const mirrorCameraPreview = createMemo(
    () =>
      props.realtimeTalkVideoStream?.getVideoTracks?.()[0]?.getSettings?.().facingMode !==
      "environment",
  );
  const canSwitchCamera = createMemo(
    () =>
      (props.realtimeTalkCameraDevices?.length ?? 0) >= 2 && Boolean(props.onSwitchRealtimeCamera),
  );
  const slashMenuAnnouncementId = () => paneDomId(props.paneId, "slash-active-announcement");
  // Owner refreshes replace the banner and callback values, not the focused action's DOM.
  const disabledBanner = (
    <Show when={props.disabledBanner?.presentation !== "hidden" ? props.disabledBanner : undefined}>
      {(banner) => (
        <div
          class={[
            "agent-chat__disabled-banner",
            {
              "agent-chat__disabled-banner--replacement": banner().kind === "composer-replacement",
              "agent-chat__disabled-banner--compact": banner().presentation === "compact",
            },
            "callout",
            banner().tone === "neutral" ? "agent-chat__disabled-banner--neutral" : "info",
            "callout--action",
          ]}
          role="status"
        >
          {banner().icon ? (
            <span
              class={[
                "agent-chat__disabled-banner-icon",
                `agent-chat__disabled-banner-icon--${banner().icon}`,
              ]}
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
                class={["btn btn--sm", banner().actionStyle]}
                disabled={Boolean(banner().disabledReason) || banner().busy}
                aria-busy={banner().busy ? "true" : "false"}
                title={banner().disabledReason ?? undefined}
                onClick={() => onAction()()}
              >
                {banner().busy ? (
                  <>
                    <span class="btn__spinner" aria-hidden="true" />
                    {banner().busyLabel ?? banner().actionLabel}
                  </>
                ) : (
                  banner().actionLabel
                )}
              </button>
            )}
          </Show>
          <Show when={banner().stop}>
            {(stop) => <PaneSubagentStop onAbort={stop().onAbort} notice />}
          </Show>
          {banner().kind === "composer-replacement" &&
          banner().presentation !== "compact" &&
          context().showAbortableUi
            ? renderChatAbortActionSolid(context().runControlsProps)
            : undefined}
        </div>
      )}
    </Show>
  );
  const showComposerInput = createMemo(
    () => context().showComposer && props.disabledBanner?.kind !== "composer-replacement",
  );
  const disabledReasonId = () => paneDomId(props.paneId, "disabled-reason");
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
  const composerError = () => context().mentionError || context().interaction.error();
  const predictionAnnouncement = () => {
    const text = context().predictionText;
    return text ? t("chat.composer.predictionAvailable", { text }) : "";
  };
  const primaryComposerStatus = createMemo(() =>
    props.disabledReason
      ? {
          text: props.disabledReason,
          tone: props.disabledReasonTone ?? ("danger" as const),
          icon: props.disabledReasonBusy ? (
            <span class="btn__spinner" aria-hidden="true" />
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
          <Show when={props.disabledReason ? props.disabledReasonAction : undefined}>
            {(action) => (
              <a
                class="btn btn--sm"
                href={action().href}
                onClick={(event: MouseEvent) => {
                  if (shouldHandleNavigationClick(event)) {
                    event.preventDefault();
                    action().onNavigate();
                  }
                }}
              >
                {action().label}
              </a>
            )}
          </Show>
        </div>
      </div>
    ) : undefined;
  });
  const fallbackStatus = createMemo(() => renderFallbackIndicatorSolid(props.fallbackStatus));
  return (
    <div
      class="agent-chat__composer-shell"
      ref={[
        footerControl,
        (element) => {
          shell = element;
        },
        elementRef(props.onComposerShellRef),
      ]}
      data-mobile-composer={props.mobileComposer ? "true" : undefined}
      data-composer-editing={mobileEditing() ? "true" : "false"}
      data-composer-keyboard={props.mobileKeyboardVisible ? "true" : undefined}
      data-composer-keyboard-navigation={keyboardNavigation() ? "true" : undefined}
    >
      {lifecycle}
      <div class="agent-chat__composer-float" ref={[elementRef(props.onComposerFloatRef)]}>
        <div class="chat-footer__context">
          {props.footerContent}
          <div class="agent-chat__composer-notices">
            {props.notices} {composerStatus()} {composerAlerts()} {fallbackStatus()}
            <Show when={context().cancellationCaveat}>
              {(caveat) => (
                <div
                  class="agent-chat__cancellation-notice compaction-indicator"
                  role="status"
                  aria-live="polite"
                >
                  {caveat()}
                </div>
              )}
            </Show>
          </div>
          <ComposerQuestionDock panel={context().questionPanelProps} />
          {props.disabledBanner?.kind === "above-composer" ? disabledBanner : undefined}
          <ComposerProgress composer={props} shown={context().showComposer} />{" "}
          <Show when={!props.mobileComposer}>
            <ComposerQueue composer={props} showAbortableUi={context().showAbortableUi} />
          </Show>
          <Show when={!resumeRecovery() && props.goalRecovery}>
            {(recovery) => (
              <ChatLazyBoundary>
                <ChatGoalRecoveryNotice recovery={recovery()} connected={props.connected} />
              </ChatLazyBoundary>
            )}
          </Show>
          <Show when={!props.mobileActivityPills?.goal && props.selectedSession?.goal} keyed>
            {(goal) => (
              <div class="agent-chat__goal-float">
                <ChatLazyBoundary>
                  <ChatGoal
                    goal={goal}
                    resumeRecovery={resumeRecovery()}
                    connected={props.connected}
                    expanded={context().state.presentation.goalExpandedId === goal.id}
                    canAct={
                      props.connected &&
                      props.canSend &&
                      !props.submitDisabledReason &&
                      Boolean(props.currentSessionId) &&
                      !props.goalRecovery
                    }
                    onGoalAction={props.onGoalAction}
                    onGoalEdit={
                      props.onGoalSubmit
                        ? (selected) => context().goalComposer.begin(selected)
                        : undefined
                    }
                    onExpandedChange={(expanded) => {
                      context().state.updatePresentation((draft) => {
                        draft.goalExpandedId = expanded ? goal.id : null;
                      });
                    }}
                  />
                </ChatLazyBoundary>
              </div>
            )}
          </Show>
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
        <Show
          when={
            props.mobileComposer &&
            props.mobileActivityPills &&
            hasVisibleChatActivityPills(props.mobileActivityPills)
              ? props.mobileActivityPills
              : undefined
          }
        >
          {(activities) => (
            <ChatLazyBoundary>
              <ChatActivityPills {...activities()} onLayout={props.onActivityPillsLayout} />
            </ChatLazyBoundary>
          )}
        </Show>
        {props.mobileApprovalContent}
      </div>
      <Show when={props.mobileComposer}>
        <ComposerQueue composer={props} showAbortableUi={context().showAbortableUi} />
      </Show>
      {showComposerInput() ? (
        <ComposerInputScope>
          <div
            class={[
              "agent-chat__input agent-chat__input--chat agent-chat__input--mobile-toolbar",
              {
                "agent-chat__input--offline": props.offline,
                "agent-chat__input--dictating": context().dictation?.active,
                "agent-chat__input--disabled": !context().canCompose,
              },
            ]}
            aria-busy={props.disabledReasonBusy ? "true" : "false"}
            data-composer-layout={
              props.mobileComposer && !mobileEditing() ? "single-line" : undefined
            }
            data-incognito={props.selectedSession?.incognito ? "true" : undefined}
            onOpenclaw-composer-dismiss-invocations={() => {
              context().state.slashMenu.reset();
              context().state.skillMenu.reset();
              context().state.mentionMenu.close();
              context().state.emojiMenu.dismiss(context().state.composerTextarea);
            }}
            onClick={(event: MouseEvent) =>
              focusComposerFromChrome(event, context().canCompose, state.composerTextarea)
            }
            onPointerDown={(event: PointerEvent) =>
              focusComposerFromChrome(event, context().canCompose, state.composerTextarea)
            }
            onMouseDown={(event: MouseEvent) =>
              focusComposerFromChrome(event, context().canCompose, state.composerTextarea)
            }
            ref={[
              elementRef<HTMLDivElement>((element) => {
                state.composerInputRef?.(element);
                return () => {
                  if (state.composerInput === element) {
                    state.composerInputRef?.();
                  }
                };
              }),
              createBackgroundLayoutRef("composer"),
            ]}
          >
            {context().menus.slashMenuVisible ? (
              <ChatLazyBoundary onClose={() => state.slashMenu.reset()}>
                <SlashMenu
                  menu={context().state.slashMenu}
                  host={context().slashMenuHost}
                  draft={context().visibleDraft}
                />
              </ChatLazyBoundary>
            ) : undefined}
            {context().menus.skillMenuVisible ? (
              <ChatLazyBoundary onClose={() => state.skillMenu.reset()}>
                <SkillMenu menu={context().state.skillMenu} host={context().skillMenuHost} />
              </ChatLazyBoundary>
            ) : undefined}
            <Show when={state.emojiMenu.open}>
              <ChatLazyBoundary onClose={() => state.emojiMenu.close()}>
                <EmojiMenu args={[state.emojiMenu, props.paneId, state.composerTextarea]} />
              </ChatLazyBoundary>
            </Show>
            {context().menus.mentionMenuVisible ? (
              <ChatLazyBoundary onClose={() => state.mentionMenu.close()}>
                <HumanMentionMenuView
                  args={[context().state.mentionMenu, context().mentionMenuHost]}
                />
              </ChatLazyBoundary>
            ) : undefined}
            <div class="agent-chat__composer-lede">
              {props.sessionAdmitted === false ? undefined : (
                <>
                  <McpAppCatalog
                    surface="thread"
                    sessionKey={props.sessionKey}
                    agentId={props.currentAgentId}
                  />
                  <McpAppResources sessionKey={props.sessionKey} agentId={props.currentAgentId} />
                </>
              )}
              <Show when={context().goalComposer.active}>
                <ChatLazyBoundary>
                  <GoalComposerMode composer={context().goalComposer} />
                </ChatLazyBoundary>
              </Show>
              <SelectedHumanMentions
                text={context().visibleDraft}
                mentions={props.mentions}
                onRemove={() => {
                  commitComposerDraft(props, props.getDraft?.() ?? props.draft, []);
                }}
                avatarUrls={context().state.mentionMenu.selectedAvatarUrls}
              />
              {props.replyTarget ? (
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
              ) : undefined}
              {props.sessionAdmitted === false ? undefined : (
                <McpAppContextStrip sessionKey={props.sessionKey} agentId={props.currentAgentId} />
              )}
              <AttachmentPreview {...props} readRevision={context().attachmentReadRevision} />
              <AttachmentReadStatus
                pendingReads={
                  props.getPendingAttachmentReads?.() ?? props.pendingAttachmentReads ?? 0
                }
              />
              <ComposerDictationStatus readDictation={() => context().dictation} />
              <ChatAttachmentInputs
                {...props}
                inputHandle={inputHandle}
                disabled={!context().canCompose}
                cameraActive={context().showComposer && props.cameraActive !== false}
              />
              {props.realtimeTalkVideoStream ? (
                <div class="agent-chat__video-preview">
                  <video
                    class={{ "agent-chat__video-preview-mirrored": mirrorCameraPreview() }}
                    autoplay
                    muted
                    ref={(video) => {
                      video.muted = true;
                    }}
                    playsinline
                    aria-label={t("chat.composer.cameraPreview")}
                    prop:srcObject={props.realtimeTalkVideoStream}
                  />
                  {canSwitchCamera() ? (
                    <openclaw-tooltip
                      class="agent-chat__video-preview-switch-tooltip"
                      prop:content={t("chat.composer.switchCamera")}
                    >
                      <button
                        type="button"
                        class="agent-chat__video-preview-switch"
                        aria-label={t("chat.composer.switchCamera")}
                        disabled={props.realtimeTalkVideoPending}
                        onClick={() => props.onSwitchRealtimeCamera?.()}
                      >
                        {<Icon name="switchCamera" />}
                      </button>
                    </openclaw-tooltip>
                  ) : undefined}
                </div>
              ) : undefined}
            </div>

            <div class="agent-chat__composer-input-row">
              <div
                class="agent-chat__composer-combobox"
                data-prediction={context().predictionText ? "true" : undefined}
              >
                <Show when={context().draftKey} keyed>
                  {(scopeKey) => (
                    <ComposerTextarea
                      scopeKey={scopeKey}
                      announcementId={slashMenuAnnouncementId()}
                      disabledReasonId={disabledReasonId()}
                      placeholder={placeholder()}
                    />
                  )}
                </Show>
                <span
                  class="agent-chat__composer-placeholder"
                  aria-hidden="true"
                  ref={[
                    elementRef<HTMLSpanElement>((element) => {
                      placeholderElement = element;
                      return () => {
                        if (placeholderElement === element) {
                          placeholderElement = undefined;
                        }
                      };
                    }),
                  ]}
                >
                  {context().dictation?.active || context().predictionText ? "" : placeholder()}
                </span>
                <Show when={context().predictionText}>
                  <span class="agent-chat__composer-prediction" aria-hidden="true">
                    {context().predictionText}
                  </span>
                  <div class="agent-chat__composer-prediction-actions">
                    <button
                      type="button"
                      aria-label={t("chat.composer.usePrediction")}
                      aria-keyshortcuts="Tab"
                      onClick={() => context().acceptPrediction()}
                    >
                      <kbd>{t("chat.composer.predictionShortcut")}</kbd>{" "}
                      {t("chat.composer.usePrediction")}
                    </button>
                    <button
                      type="button"
                      onClick={() => context().dismissPrediction()}
                      aria-label={t("chat.composer.dismissPrediction")}
                    >
                      {t("chat.composer.dismissPrediction")}
                    </button>
                  </div>
                </Show>
                <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
                  {predictionAnnouncement()}
                </span>
                <span
                  id={slashMenuAnnouncementId()}
                  class="sr-only"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {context().menus.activeMenuOptionLabel}
                </span>
                <span
                  class="agent-chat__run-status-announcement sr-only"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {context().runStatusAnnouncement}
                </span>
              </div>
            </div>

            <div class="agent-chat__composer-footer">
              <div class="agent-chat__composer-lead agent-chat__composer-meta">
                <ChatComposerPlusMenu
                  menu={{
                    attachments: props,
                    inputHandle,
                    capabilityMenu: props.capabilityMenu,
                    disabled: !context().canCompose || props.suggestionComposer === true,
                    open: capabilityOpen(),
                    view: capabilityView(),
                    toolOverrides: props.toolOverrides,
                    onOpenChange: (open) => {
                      setCapabilityOpen(open);
                      if (!open) {
                        setCapabilityView("root");
                      }
                    },
                    onViewChange: setCapabilityView,
                  }}
                />
                {composerLeadControl}
              </div>
              <div class="agent-chat__composer-trail">
                <div class="agent-chat__composer-meta agent-chat__composer-context">
                  <ContextNotice
                    session={props.selectedSession}
                    messages={props.messages}
                    providerUsage={props.providerUsage}
                    gateway={props.contextGateway}
                    agentId={props.currentAgentId}
                    onOpenContext={props.onOpenContext}
                  />
                </div>
                <Show when={props.composerControls}>
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
                  <ChatPrimaryActions {...context().runControlsProps} />
                </div>
              </div>
            </div>
          </div>
        </ComposerInputScope>
      ) : props.disabledBanner?.kind === "composer-replacement" ? (
        disabledBanner
      ) : undefined}
    </div>
  );
}
