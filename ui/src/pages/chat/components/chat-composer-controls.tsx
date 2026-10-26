import type { JSX } from "@solidjs/web";
import { Show, createSignal, createUniqueId, lazy, onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Kbd } from "../../../components/solid/kbd.tsx";
import { Menu, type MenuEntry, type MenuHandle } from "../../../components/solid/menu.tsx";
import { registerSessionNavigationEnglish } from "../../../i18n/locales/en-session-navigation.ts";
import { isMobileBrowserPlatform } from "../../../lib/browser-platform.ts";
import { canSubmitBeforeChatHistory } from "../../../lib/chat/commands.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { nativeListener } from "../../../lib/solid-native-listener.ts";
import type { ComposerDictationOwner } from "../composer-dictation.ts";
import type { MicrophonePickerProps } from "../composer-microphone-picker.ts";
import { ComposerContent } from "./chat-composer-content.tsx";
import type { createChatComposerContext } from "./chat-composer-frame.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { MicrophoneActivity, voiceStatusLabel } from "./chat-voice-activity.tsx";

registerEnglishCatalog(registerSessionNavigationEnglish);

const MicrophoneMenu = lazy(() => import("./chat-composer-microphone-menu.tsx"), {
  export: "MicrophoneMenu",
});

type ChatRunControlsProps = ReturnType<typeof createChatComposerContext>["runControlsProps"];

export function renderMicrophonePickerSolid(props: MicrophonePickerProps) {
  const menuId = createUniqueId();
  let handle: MenuHandle | undefined;
  let host!: HTMLDivElement;
  let pointerDeviceSelection = false;
  const label = () => t("chat.composer.microphoneInput");
  const [readItems, setReadItems] = createSignal<() => MenuEntry[]>();
  let focusOnReady = false;
  let focusLastOnReady = false;
  const items: MenuEntry[] = [
    {
      kind: "group",
      id: "microphone-menu-content",
      get items() {
        return readItems()?.() ?? [];
      },
      render: (renderItems) => (
        <ChatLazyBoundary
          fallback={renderItems(() => [
            { id: "microphone-menu-loading", label: t("common.loading"), disabled: true },
          ])}
        >
          <MicrophoneMenu
            picker={props}
            renderItems={renderItems}
            onDevicePointer={(pointer) => {
              pointerDeviceSelection = pointer;
            }}
            onReady={(next) => {
              setReadItems(() => next);
              if (next && focusOnReady) {
                onSettled(() => {
                  const active = host.ownerDocument.activeElement;
                  if (
                    handle?.overlay.open &&
                    (active === handle.overlay.surface || host.contains(active))
                  ) {
                    if (focusLastOnReady) {
                      handle.itemElements().at(-1)?.focus({ preventScroll: true });
                    } else {
                      handle.focusFirst();
                    }
                  }
                });
              }
            }}
          />
        </ChatLazyBoundary>
      ),
    },
  ];
  return (
    <div
      ref={(element) => {
        host = element;
      }}
      class="chat-talk-input-picker"
      onKeyDown={(event) => {
        focusOnReady = true;
        focusLastOnReady = event.key === "ArrowUp";
      }}
      onClick={(event) => {
        focusOnReady = event.detail === 0;
        focusLastOnReady = false;
      }}
    >
      <Menu
        id={`chat-microphone-${menuId}`}
        lazy
        panelClass="chat-talk-input-picker__menu"
        placement="top-end"
        pointerFocus="trigger"
        label={label()}
        open={props.open}
        triggerClass="chat-talk-input-picker__trigger"
        trigger={<Icon name="chevronDown" />}
        items={items}
        ref={(next) => {
          handle = next;
        }}
        onOpenChange={(open) => {
          host.toggleAttribute("open", open);
          if (open) {
            props.onOpen();
          } else {
            props.onClose();
          }
        }}
        onSelect={(item) => {
          if (item.id.startsWith("device:")) {
            const pointer = pointerDeviceSelection;
            pointerDeviceSelection = false;
            props.onSelect(item.id.slice("device:".length));
            // Pointer selection should not leave the hover-revealed microphone expanded.
            if (pointer) {
              queueMicrotask(() => handle?.overlay.trigger?.blur());
            }
          } else if (item.id === "hold-to-dictate") {
            props.onHoldToDictateChange?.(props.holdToDictate === false);
          } else if (item.id === "capability:realtime") {
            props.onOpenTalkSettings?.();
          } else if (item.id === "capability:dictation") {
            props.onOpenDictationSettings?.();
          }
        }}
      />
    </div>
  );
}

// New Session shares the microphone without run controls or a Talk session.
type ComposerVoiceButtonProps = {
  connected: boolean;
  disabled?: boolean;
  submitDisabledReason?: string | null;
  readDictation?: () => ComposerDictationOwner;
  microphonePicker?: JSX.Element;
  /** Dictation-only surfaces must not promise Talk. */
  idleLabel?: string;
  onDictationPointerDown?: (event: PointerEvent) => void;
  onDirectDictationStart?: () => void;
  onToggleVoice?: () => void;
};

export function renderComposerVoiceButtonSolid(props: ComposerVoiceButtonProps) {
  const active = () => props.readDictation?.()?.active === true;
  const arming = () => props.readDictation?.()?.arming === true;
  const finalizing = () => props.readDictation?.()?.finalizing === true;
  const holding = () => props.readDictation?.()?.locksComposer === true;
  const startsDictationDirectly = () =>
    props.readDictation !== undefined && props.onToggleVoice === undefined;
  const label = () =>
    active()
      ? t("chat.composer.dictationStopAndKeep")
      : (props.idleLabel ?? t("chat.composer.startVoiceInput"));
  const tooltip = () =>
    props.readDictation && !startsDictationDirectly() && !(active() || finalizing())
      ? [props.submitDisabledReason, t("chat.composer.voiceGestureHint")]
          .filter(Boolean)
          .join(" · ")
      : active()
        ? label()
        : (props.submitDisabledReason ?? label());
  // This shape owns pointer capture. Keep it stable while dictation rerenders,
  // or replacing the button releases capture and cancels the active hold.
  return (
    <span class={["chat-talk-control", { "chat-talk-control--holding": holding() }]}>
      <openclaw-tooltip prop:content={tooltip()}>
        <button
          class={[
            "chat-send-btn",
            active()
              ? "chat-send-btn--dictating"
              : [
                  "chat-send-btn--voice",
                  {
                    "chat-send-btn--hold-enabled":
                      props.readDictation && !startsDictationDirectly(),
                    "chat-send-btn--dictation-arming": arming(),
                  },
                ],
          ]}
          type="button"
          onPointerDown={(event: PointerEvent) => props.onDictationPointerDown?.(event)}
          onClick={(event: MouseEvent) => {
            if (active()) {
              event.preventDefault();
              // The controller owns hold suppression: releasing a latched hold
              // also clicks this button, and that click must not mean Stop.
              if (!finalizing()) {
                props.readDictation?.()?.handleClick(event);
              }
              return;
            }
            if (startsDictationDirectly()) {
              event.preventDefault();
              props.onDirectDictationStart?.();
              props.readDictation?.()?.startDirect();
              return;
            }
            if (props.readDictation) {
              props.readDictation().handleClick(event);
            } else {
              props.onToggleVoice?.();
            }
          }}
          onContextMenu={(event: MouseEvent) => props.readDictation?.()?.handleContextMenu(event)}
          disabled={
            !active() &&
            (!props.connected ||
              props.disabled ||
              (!props.readDictation && Boolean(props.submitDisabledReason)))
          }
          aria-disabled={finalizing() ? "true" : "false"}
          aria-label={label()}
        >
          {active() ? (
            <Icon name="stop" />
          ) : (
            <>
              <Icon name="mic" />
              <span class="agent-chat__control-label">{label()}</span>
            </>
          )}
        </button>
      </openclaw-tooltip>
      <ComposerContent>{props.microphonePicker}</ComposerContent>
    </span>
  );
}

function primaryPointerDownRef(read: () => ((event: PointerEvent) => void) | undefined) {
  // Preserve input focus before native tooltip listeners run at the target.
  return nativeListener("pointerdown", (event) => read()?.(event), true);
}

export function ComposerDictationSendAction(props: {
  readDictation: () => ComposerDictationOwner;
  onSend: (submissionAction?: Event) => void;
  onPointerDown?: (event: PointerEvent) => void;
}) {
  const finishAndSend = async (event: MouseEvent) => {
    const dictation = props.readDictation();
    const send = props.onSend;
    if (dictation.finalizing) {
      return;
    }
    await dictation.finishActive();
    // Keep the initiating input action when asynchronous dictation finishes.
    send(event);
  };
  return (
    <Show when={props.readDictation().active}>
      {props.readDictation().connecting ? null : (
        <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {props.readDictation().finalizing
            ? t("chat.composer.dictationFinalizing")
            : t("chat.composer.dictationListening")}
        </span>
      )}
      <openclaw-tooltip prop:content={t("chat.runControls.send")}>
        <button
          class="chat-send-btn chat-send-btn--send chat-send-btn--dictation-commit"
          type="button"
          ref={primaryPointerDownRef(() => props.onPointerDown)}
          onClick={(event: MouseEvent) => void finishAndSend(event)}
          aria-disabled={props.readDictation().finalizing ? "true" : "false"}
          aria-label={t("chat.runControls.send")}
        >
          <Icon name="arrowUp" />
        </button>
      </openclaw-tooltip>
    </Show>
  );
}

export function renderChatAbortActionSolid(
  props: Pick<ChatRunControlsProps, "canAbort" | "onAbort" | "onPrimaryActionPointerDown">,
) {
  return (
    <>
      {props.canAbort ? (
        <openclaw-tooltip prop:content={t("chat.runControls.stop")}>
          <button
            class="chat-send-btn chat-send-btn--stop"
            ref={primaryPointerDownRef(() => props.onPrimaryActionPointerDown)}
            onClick={() => props.onAbort?.()}
            aria-label={t("chat.runControls.stopGenerating")}
          >
            <Icon name="stop" />
            <span class="agent-chat__control-label">{t("chat.runControls.stop")}</span>
          </button>
        </openclaw-tooltip>
      ) : null}
    </>
  );
}

export function renderChatPrimaryActionsSolid(props: ChatRunControlsProps) {
  const MicrophonePicker = renderMicrophonePickerSolid;
  const microphonePicker = (
    <Show when={props.microphonePicker}>{(picker) => <MicrophonePicker {...picker()} />}</Show>
  );
  const hasComposedContent = () => Boolean(props.draft.trim() || props.hasAttachments);
  const labels = () =>
    props.suggestionComposer
      ? (["chat.sessionSuggestions.suggest", "chat.sessionSuggestions.suggestMessage"] as const)
      : !props.canAbort || props.followUpMode === undefined || props.followUpMode === "interrupt"
        ? (["chat.runControls.send", "chat.runControls.sendMessage"] as const)
        : props.followUpMode === "steer"
          ? (["chat.queue.steer", "chat.followUpModeSteer"] as const)
          : (["chat.runControls.queue", "chat.runControls.queueMessage"] as const);
  const label = () => props.submissionLabel ?? t(labels()[0]);
  const description = () => props.submissionLabel ?? t(labels()[1]);
  const alternateLabel = () =>
    t(props.alternateFollowUpMode === "queue" ? "chat.runControls.queue" : "chat.queue.steer");
  const alternateAvailable = () =>
    props.alternateFollowUpMode && props.canSend && hasComposedContent();
  const voiceErrored = () => props.voiceStatus === "error";
  const cameraLabel = () =>
    t(props.voiceVideoEnabled ? "chat.composer.turnCameraOff" : "chat.composer.turnCameraOn");
  const sendDisabledReason = () =>
    props.canSend && canSubmitBeforeChatHistory(props.draft) ? null : props.submitDisabledReason;
  const sendBusy = () => props.sending || Boolean(sendDisabledReason() && props.submitPending);
  const sendStatus = () =>
    sendDisabledReason() ??
    (props.sending
      ? t("chat.composer.sendingMessage")
      : hasComposedContent()
        ? null
        : t("chat.composer.emptyHint"));
  const hasSendableContent = () =>
    hasComposedContent() && props.canSend && !props.sending && !sendDisabledReason();
  const showShortcutTooltip = () =>
    !isMobileBrowserPlatform() &&
    !props.preparingAttachments &&
    sendStatus() == null &&
    alternateAvailable();
  const SendAction = () => (
    <openclaw-tooltip
      prop:content={
        props.preparingAttachments
          ? t("chat.composer.preparingAttachments")
          : showShortcutTooltip()
            ? ""
            : (sendStatus() ?? label())
      }
    >
      <Show when={showShortcutTooltip()}>
        <span slot="content">
          {label()} <Kbd keys="⏎" inline />
          {" · "}
          {alternateLabel()} <Kbd keys={t("chat.sendShortcutModifierEnter")} inline />
        </span>
      </Show>
      <button
        class={["chat-send-btn chat-send-btn--send", { "chat-send-btn--sending": props.sending }]}
        ref={primaryPointerDownRef(() => props.onPrimaryActionPointerDown)}
        onClick={(event) => props.onSend(event)}
        disabled={!hasSendableContent()}
        aria-label={sendStatus() ?? description()}
        aria-busy={sendBusy() || props.preparingAttachments ? "true" : "false"}
      >
        {sendBusy() ? <span class="btn__spinner" aria-hidden="true" /> : <Icon name="arrowUp" />}
        <span class="agent-chat__control-label">{label()}</span>
      </button>
    </openclaw-tooltip>
  );
  const TalkAction = (action: { camera?: boolean }) => (
    <openclaw-tooltip
      class={{ "chat-mobile-talk-action": !action.camera }}
      prop:content={
        action.camera
          ? cameraLabel()
          : (props.submitDisabledReason ?? t("chat.composer.realtimeTalkCapability"))
      }
    >
      <button
        class={[
          "chat-send-btn",
          action.camera ? "chat-send-btn--voice" : "chat-send-btn--talk-mode",
        ]}
        type={action.camera ? undefined : "button"}
        ref={primaryPointerDownRef(() =>
          action.camera ? undefined : props.onPrimaryActionPointerDown,
        )}
        onClick={() => {
          if (action.camera) {
            props.onToggleCamera?.();
          } else {
            props.onToggleVoice?.();
          }
        }}
        disabled={
          action.camera
            ? props.voiceVideoPending ||
              props.voiceStatus === "connecting" ||
              props.voiceStatus === "error"
            : !props.connected ||
              props.sending ||
              props.isBusy ||
              Boolean(props.submitDisabledReason)
        }
        aria-label={action.camera ? cameraLabel() : t("chat.composer.realtimeTalkCapability")}
        aria-pressed={action.camera ? (props.voiceVideoEnabled ? "true" : "false") : undefined}
      >
        <Icon
          name={action.camera ? (props.voiceVideoEnabled ? "cameraOff" : "camera") : "audioLines"}
        />
        <span class="agent-chat__control-label">
          {action.camera ? cameraLabel() : t("chat.composer.realtimeTalkCapability")}
        </span>
      </button>
    </openclaw-tooltip>
  );
  const AbortAction = renderChatAbortActionSolid;
  const VoiceButton = renderComposerVoiceButtonSolid;
  const PrimaryAction = (placement: { mobile?: boolean }) => (
    <>
      {props.readDictation?.()?.active ? (
        !props.submitDisabledReason || canSubmitBeforeChatHistory(props.draft) ? (
          <ComposerDictationSendAction
            readDictation={props.readDictation}
            onSend={props.onSend}
            onPointerDown={(event) => props.onPrimaryActionPointerDown?.(event)}
          />
        ) : (
          <SendAction />
        )
      ) : props.canAbort && !hasSendableContent() ? (
        <AbortAction {...props} />
      ) : placement.mobile && !hasComposedContent() && props.onToggleVoice ? (
        <TalkAction />
      ) : (
        <SendAction />
      )}
    </>
  );
  return (
    <>
      {props.voiceActive && props.onToggleVoice ? (
        <>
          <span class="chat-talk-control chat-talk-control--active">
            <openclaw-tooltip prop:content={t("chat.composer.stopVoiceInput")}>
              <button
                class={[
                  "chat-send-btn chat-send-btn--voice-live",
                  { "chat-send-btn--voice-error": voiceErrored() },
                ]}
                onClick={() => props.onToggleVoice?.()}
                aria-label={t("chat.composer.stopVoiceInput")}
              >
                {voiceErrored() ? null : (
                  <MicrophoneActivity
                    status={props.voiceStatus}
                    inputLevel={props.voiceInputLevel}
                  />
                )}
                <span class="chat-send-btn__voice-stop-glyph">
                  <Icon name="stop" />
                </span>
              </button>
            </openclaw-tooltip>
            <ComposerContent>{microphonePicker}</ComposerContent>
          </span>
          {voiceErrored() || props.voiceStatus === "connecting" ? null : (
            <span
              class="sr-only agent-chat__voice-status"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {voiceStatusLabel(props.voiceStatus, props.voiceDetail)}
            </span>
          )}
          {props.voiceVideoCapable && props.onToggleCamera ? <TalkAction camera /> : null}
          <span class="chat-mobile-primary-action chat-desktop-primary-action">
            <AbortAction {...props} />
          </span>
        </>
      ) : (
        <>
          {props.readDictation || props.onToggleVoice ? (
            <VoiceButton
              {...props}
              microphonePicker={microphonePicker}
              disabled={!props.readDictation && (props.sending || props.isBusy)}
            />
          ) : null}
          {props.readDictation ? (
            <span class="chat-mobile-dictation-action">
              <VoiceButton
                connected={props.connected}
                readDictation={props.readDictation}
                idleLabel={t("chat.composer.dictationCapability")}
                onDirectDictationStart={props.onDirectDictationStart}
              />
            </span>
          ) : null}
          {!props.readDictation?.()?.active &&
          !(props.canAbort && !hasSendableContent()) &&
          !hasComposedContent() &&
          props.onToggleVoice ? (
            <>
              <span class="chat-mobile-primary-action">
                <PrimaryAction mobile />
              </span>
              <span class="chat-desktop-primary-action">
                <PrimaryAction />
              </span>
            </>
          ) : (
            <span class="chat-mobile-primary-action chat-desktop-primary-action">
              <PrimaryAction />
            </span>
          )}
        </>
      )}
    </>
  );
}
