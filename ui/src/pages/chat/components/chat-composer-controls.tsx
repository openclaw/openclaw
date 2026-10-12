import { For, createEffect, createMemo } from "solid-js";
import type { ChatFollowUpMode } from "../../../app/settings.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { syncDropdownItemRadio } from "../../../components/web-awesome.ts";
import { canSubmitBeforeChatHistory } from "../../../lib/chat/commands.ts";
import type { ControlUiFollowUpMode } from "../../../lib/chat/follow-up-mode.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ComposerDictationController } from "../composer-dictation.ts";
import type { ComposerTalkCapabilityStatus } from "../composer-microphone-picker.ts";
import {
  realtimeTalkDeviceIssueMessage,
  type RealtimeTalkDeviceIssue,
  type RealtimeTalkInputDevice,
} from "../talk/input.ts";
import type { RealtimeTalkLevelSignal } from "../talk/level.ts";
import type { RealtimeTalkStatus } from "../talk/session.ts";
import { solidTemplate, renderComposerSendTooltip } from "./chat-composer-controls.ts";
import { LitContent } from "./chat-composer-interop.tsx";
import {
  renderChatVoiceStatus,
  renderMicrophoneActivity,
  voiceStatusLabel,
} from "./chat-voice-activity.ts";

export type ChatRunControlsProps = Omit<ComposerVoiceButtonProps, "idleLabel"> & {
  canAbort: boolean;
  canSend: boolean;
  sending: boolean;
  isBusy: boolean;
  submitPending?: boolean;
  draft: string;
  hasAttachments?: boolean;
  preparingAttachments?: boolean;
  followUpMode?: ControlUiFollowUpMode;
  alternateFollowUpMode?: ChatFollowUpMode;
  suggestionComposer?: boolean;
  submissionLabel?: string;
  voiceActive?: boolean;
  voiceStatus?: RealtimeTalkStatus;
  voiceDetail?: string | null;
  voiceInputLevel?: RealtimeTalkLevelSignal;
  voiceVideoCapable?: boolean;
  voiceVideoEnabled?: boolean;
  voiceVideoPending?: boolean;
  onPrimaryActionPointerDown?: (event: PointerEvent) => void;
  onAbort?: () => void;
  onSend: (submissionAction?: Event) => void;
  onToggleCamera?: () => void;
};

type MicrophonePickerProps = {
  devices: RealtimeTalkInputDevice[];
  loading: boolean;
  open: boolean;
  selectedDeviceId: string;
  voiceActive: boolean;
  issue: RealtimeTalkDeviceIssue | null;
  holdToDictate?: boolean;
  showRealtimeCapability?: boolean;
  realtimeStatus: ComposerTalkCapabilityStatus;
  dictationStatus: ComposerTalkCapabilityStatus;
  onOpen: () => void;
  onClose: () => void;
  onSelect: (deviceId: string) => void;
  onHoldToDictateChange?: (enabled: boolean) => void;
  onOpenTalkSettings?: () => void;
  onOpenDictationSettings?: () => void;
};

// Pointer selection must blur after the dropdown restores focus, or this
// hover-revealed trigger keeps the microphone expanded. Preserve keyboard focus.
function releaseMicrophonePickerFocus(dropdown: EventTarget | null, item: HTMLElement): void {
  if (item.matches(":focus-visible")) {
    return;
  }
  if (!(dropdown instanceof HTMLElement)) {
    return;
  }
  queueMicrotask(() => {
    const trigger = dropdown.querySelector<HTMLElement>(".chat-talk-input-picker__trigger");
    if (trigger && document.activeElement === trigger) {
      trigger.blur();
    }
  });
}

function renderMicrophoneNotice(className: string, message: string, role?: "status" | "alert") {
  return (
    <wa-dropdown-item class="chat-talk-input-picker__notice" disabled>
      <div class={className} role={role}>
        {message}
      </div>
    </wa-dropdown-item>
  );
}

export function renderMicrophonePickerSolid(props: MicrophonePickerProps) {
  // Without an available capture route, a checked "System default" would claim
  // a selection that cannot exist. Show the discovery issue alone.
  const unavailable = createMemo(() =>
    !props.loading && props.devices.length === 0 ? props.issue : null,
  );
  // System default renders even while discovery runs: the dropdown's one-time
  // focus step needs at least one item or keyboard users never enter the menu.
  const options = createMemo(() =>
    unavailable()
      ? []
      : [
          { deviceId: "", label: t("chat.composer.systemDefaultMicrophone") },
          ...(props.loading ? [] : props.devices),
        ],
  );
  // A machine without a microphone and a browser that cannot enumerate are
  // facts, not faults; only the recoverable reasons earn the warn tone.
  const unavailableIsFault = createMemo(
    () =>
      unavailable() !== null &&
      unavailable() !== "none-found" &&
      unavailable() !== "list-unsupported",
  );
  const label = createMemo(() => t("chat.composer.microphoneInput"));
  const unavailableCapabilities = createMemo(() =>
    [
      {
        key: "realtime",
        label: t("chat.composer.realtimeTalkCapability"),
        status: props.realtimeStatus,
        unavailableReason: t("chat.composer.realtimeTalkProviderUnavailable"),
        onOpenSettings: props.onOpenTalkSettings,
      },
      {
        key: "dictation",
        label: t("chat.composer.dictationCapability"),
        status: props.dictationStatus,
        unavailableReason: t("chat.composer.dictationProviderUnavailableShort"),
        onOpenSettings: props.onOpenDictationSettings,
      },
    ].filter(
      (capability) =>
        capability.status !== "ready" &&
        (capability.key !== "realtime" || props.showRealtimeCapability !== false),
    ),
  );
  return (
    <wa-dropdown
      class="chat-talk-input-picker"
      placement="top-end"
      aria-label={label()}
      prop:open={props.open}
      onWa-show={() => props.onOpen()}
      onWa-hide={() => props.onClose()}
      onWa-select={(event: CustomEvent<{ item: HTMLElement & { value?: string } }>) => {
        const item = event.detail.item;
        if (item.hasAttribute("data-chat-talk-device")) {
          props.onSelect(item.value ?? "");
          releaseMicrophonePickerFocus(event.currentTarget, item);
          return;
        }
        event.preventDefault();
        if (item.dataset.chatTalkPreference === "hold-to-dictate") {
          props.onHoldToDictateChange?.(props.holdToDictate === false);
          return;
        }
        unavailableCapabilities()
          .find((capability) => capability.key === item.dataset.chatTalkCapability)
          ?.onOpenSettings?.();
      }}
    >
      <button
        slot="trigger"
        type="button"
        class="chat-talk-input-picker__trigger"
        aria-label={label()}
        aria-haspopup="menu"
        aria-expanded={props.open ? "true" : "false"}
      >
        <Icon name="chevronDown" />
      </button>
      <div class="chat-talk-input-picker__heading">{label()}</div>
      {unavailable() ? (
        renderMicrophoneNotice(
          `chat-talk-input-picker__empty${unavailableIsFault() ? " chat-talk-input-picker__empty--fault" : ""}`,
          realtimeTalkDeviceIssueMessage(unavailable()!, "audioinput"),
          "status",
        )
      ) : (
        <>
          <For each={options()} keyed={(option) => option.deviceId}>
            {(option) => {
              const selected = createMemo(() => option().deviceId === props.selectedDeviceId);
              let element: HTMLElement | undefined;
              createEffect(selected, (value) => syncDropdownItemRadio(element, value));
              // Checkbox items toggle their own check before the stored device
              // changes; these radio rows render only the committed selection.
              return (
                <wa-dropdown-item
                  class="chat-talk-input-picker__item"
                  data-chat-talk-device
                  value={option().deviceId}
                  role="menuitemradio"
                  aria-checked={selected() ? "true" : "false"}
                  ref={(node) => {
                    element = node;
                  }}
                >
                  <span slot="icon" class="chat-talk-input-picker__option-icon" aria-hidden="true">
                    <Icon name="mic" />
                  </span>
                  <span class="chat-talk-input-picker__label">{option().label}</span>
                  <span slot="details" class="chat-talk-input-picker__check" aria-hidden="true">
                    {selected() ? <Icon name="check" /> : null}
                  </span>
                </wa-dropdown-item>
              );
            }}
          </For>
          {props.loading
            ? renderMicrophoneNotice("chat-talk-input-picker__note", t("common.loading"), "status")
            : null}
          {props.issue
            ? renderMicrophoneNotice(
                "chat-talk-input-picker__warning",
                realtimeTalkDeviceIssueMessage(props.issue, "audioinput"),
                "alert",
              )
            : null}
          {props.voiceActive
            ? renderMicrophoneNotice(
                "chat-talk-input-picker__hint",
                t("chat.composer.microphoneAppliesNextSession"),
              )
            : null}
        </>
      )}
      <For each={unavailableCapabilities()} keyed={(capability) => capability.key}>
        {(capability) => (
          <wa-dropdown-item
            class="chat-talk-input-picker__capability"
            data-chat-talk-capability={capability().key}
            data-status={capability().status}
            disabled={!capability().onOpenSettings}
          >
            <span class="chat-talk-input-picker__capability-copy" role="status">
              <strong>
                {capability().status === "unavailable" ? (
                  <span class="chat-talk-input-picker__capability-alert" aria-hidden="true">
                    <Icon name="alertTriangle" />
                  </span>
                ) : null}
                <span>{capability().label}</span>
              </strong>
              <span>
                {capability().status === "checking"
                  ? t("chat.composer.talkCapabilityChecking")
                  : capability().status === "unknown"
                    ? t("chat.composer.talkCapabilityUnknown")
                    : capability().unavailableReason}
              </span>
            </span>
            {capability().onOpenSettings ? (
              <span slot="details" class="chat-talk-input-picker__settings">
                <span aria-hidden="true">
                  <Icon name="settings" />
                </span>
                <span>{t("chat.composer.configureCapability")}</span>
              </span>
            ) : null}
          </wa-dropdown-item>
        )}
      </For>
      {props.onHoldToDictateChange ? (
        <wa-dropdown-item
          class="chat-talk-input-picker__preference"
          data-chat-talk-preference="hold-to-dictate"
          type="checkbox"
          prop:checked={props.holdToDictate !== false}
        >
          <span>{t("chat.composer.holdToDictate")}</span>
          <span
            slot="details"
            class={`chat-controls__speed-toggle ${props.holdToDictate !== false ? "chat-controls__speed-toggle--active" : ""}`}
            aria-hidden="true"
          >
            <span class="chat-controls__speed-toggle-thumb" />
          </span>
        </wa-dropdown-item>
      ) : null}
    </wa-dropdown>
  );
}

// New Session shares the microphone without run controls or a Talk session.
type ComposerVoiceButtonProps = {
  connected: boolean;
  disabled?: boolean;
  submitDisabledReason?: string | null;
  readDictation?: () => ComposerDictationController;
  microphonePicker?: unknown;
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
  const startsDictationDirectly = createMemo(
    () => props.readDictation !== undefined && props.onToggleVoice === undefined,
  );
  const label = createMemo(() =>
    active()
      ? t("chat.composer.dictationStopAndKeep")
      : (props.idleLabel ?? t("chat.composer.startVoiceInput")),
  );
  const tooltip = createMemo(() =>
    props.readDictation && !startsDictationDirectly() && !(active() || finalizing())
      ? [props.submitDisabledReason, t("chat.composer.voiceGestureHint")]
          .filter(Boolean)
          .join(" · ")
      : active()
        ? label()
        : (props.submitDisabledReason ?? label()),
  );
  // This shape owns pointer capture. Keep it stable while dictation rerenders,
  // or replacing the button releases capture and cancels the active hold.
  return (
    <span class={`chat-talk-control${holding() ? " chat-talk-control--holding" : ""}`}>
      <openclaw-tooltip prop:content={tooltip()}>
        <button
          class={
            active()
              ? "chat-send-btn chat-send-btn--dictating"
              : `chat-send-btn chat-send-btn--voice${props.readDictation && !startsDictationDirectly() ? " chat-send-btn--hold-enabled" : ""}${arming() ? " chat-send-btn--dictation-arming" : ""}`
          }
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
      <LitContent value={props.microphonePicker} />
    </span>
  );
}

function primaryPointerDownRef(read: () => ((event: PointerEvent) => void) | undefined) {
  // Preserve input focus before native tooltip listeners run at the target.
  return (button: HTMLButtonElement) =>
    button.addEventListener("pointerdown", (event) => read()?.(event), true);
}

function ComposerDictationSendAction(props: {
  readDictation: () => ComposerDictationController;
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
    <>
      {props.readDictation().active ? (
        <>
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
        </>
      ) : null}
    </>
  );
}

export function renderComposerDictationStatusSolid(dictation?: ComposerDictationController) {
  if (!dictation?.active) {
    return null;
  }
  if (dictation.connecting) {
    return (
      <LitContent
        value={renderChatVoiceStatus({
          status: "connecting",
          detail: t("chat.composer.microphoneAccessPending"),
        })}
      />
    );
  }
  return (
    <div class="agent-chat__composer-status-stack">
      <div
        class={`agent-chat__dictation-status${dictation.finalizing ? " agent-chat__dictation-status--finalizing" : ""}`}
      >
        <span
          class={`agent-chat__dictation-phase${!dictation.finalizing ? " agent-chat__dictation-phase--listening" : ""}`}
        >
          {dictation.finalizing
            ? t("chat.composer.dictationFinalizing")
            : t("chat.composer.dictationListening")}
        </span>
      </div>
    </div>
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
  const hasComposedContent = createMemo(() => Boolean(props.draft.trim() || props.hasAttachments));
  const labels = createMemo(() =>
    props.suggestionComposer
      ? (["chat.sessionSuggestions.suggest", "chat.sessionSuggestions.suggestMessage"] as const)
      : !props.canAbort || props.followUpMode === undefined || props.followUpMode === "interrupt"
        ? (["chat.runControls.send", "chat.runControls.sendMessage"] as const)
        : props.followUpMode === "steer"
          ? (["chat.queue.steer", "chat.followUpModeSteer"] as const)
          : (["chat.runControls.queue", "chat.runControls.queueMessage"] as const),
  );
  const label = () => props.submissionLabel ?? t(labels()[0]);
  const description = () => props.submissionLabel ?? t(labels()[1]);
  const alternateLabel = () =>
    t(props.alternateFollowUpMode === "queue" ? "chat.runControls.queue" : "chat.queue.steer");
  const alternateAvailable = () =>
    props.alternateFollowUpMode && props.canSend && hasComposedContent();
  const tooltip = () =>
    alternateAvailable()
      ? `${label()} ⏎ · ${alternateLabel()} ${t("chat.sendShortcutModifierEnter")}`
      : label();
  const tooltipTemplate = () =>
    alternateAvailable()
      ? renderComposerSendTooltip(label(), alternateLabel(), t("chat.sendShortcutModifierEnter"))
      : undefined;
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
  const hasSendableContent = createMemo(
    () => hasComposedContent() && props.canSend && !props.sending && !sendDisabledReason(),
  );
  const SendAction = () => (
    <openclaw-tooltip
      prop:content={
        props.preparingAttachments
          ? t("chat.composer.preparingAttachments")
          : (sendStatus() ?? tooltip())
      }
      prop:contentTemplate={
        !props.preparingAttachments && sendStatus() == null ? tooltipTemplate() : undefined
      }
    >
      <button
        class={`chat-send-btn chat-send-btn--send${props.sending ? " chat-send-btn--sending" : ""}`}
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
      class={action.camera ? undefined : "chat-mobile-talk-action"}
      prop:content={
        action.camera
          ? cameraLabel()
          : (props.submitDisabledReason ?? t("chat.composer.realtimeTalkCapability"))
      }
    >
      <button
        class={`chat-send-btn chat-send-btn--${action.camera ? "voice" : "talk-mode"}`}
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
                class={`chat-send-btn chat-send-btn--voice-live${voiceErrored() ? " chat-send-btn--voice-error" : ""}`}
                onClick={() => props.onToggleVoice?.()}
                aria-label={t("chat.composer.stopVoiceInput")}
              >
                {voiceErrored() ? null : (
                  <LitContent
                    value={renderMicrophoneActivity({
                      status: props.voiceStatus,
                      inputLevel: props.voiceInputLevel,
                    })}
                  />
                )}
                <span class="chat-send-btn__voice-stop-glyph">
                  <Icon name="stop" />
                </span>
              </button>
            </openclaw-tooltip>
            <LitContent value={props.microphonePicker} />
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

export function renderMicrophonePicker(props: MicrophonePickerProps) {
  return solidTemplate(renderMicrophonePickerSolid, props);
}

export function renderComposerVoiceButton(props: ComposerVoiceButtonProps) {
  return solidTemplate(renderComposerVoiceButtonSolid, props);
}

export function renderComposerDictationSendAction(
  dictation: ComposerDictationController,
  onSend: (submissionAction?: Event) => void,
  onPointerDown?: (event: PointerEvent) => void,
) {
  return solidTemplate(ComposerDictationSendAction, {
    readDictation: () => dictation,
    onSend,
    onPointerDown,
  });
}

function RenderComposerDictationStatusAdapter(props: {
  readDictation?: () => ComposerDictationController;
}) {
  return <>{renderComposerDictationStatusSolid(props.readDictation?.())}</>;
}

export function renderComposerDictationStatus(dictation?: ComposerDictationController) {
  return solidTemplate(RenderComposerDictationStatusAdapter, {
    readDictation: dictation ? () => dictation : undefined,
  });
}
