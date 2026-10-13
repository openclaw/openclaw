import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { ref } from "lit/directives/ref.js";
import type { ChatFollowUpMode } from "../../../app/settings.ts";
import { icons } from "../../../components/icons.ts";
import { renderKbd } from "../../../components/kbd.ts";
import { syncDropdownItemRadio } from "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import { canSubmitBeforeChatHistory } from "../../../lib/chat/commands.ts";
import type { ControlUiFollowUpMode } from "../../../lib/chat/follow-up-mode.ts";
import type { ComposerDictationController } from "../composer-dictation.ts";
import type { ComposerTalkCapabilityStatus } from "../composer-microphone-picker.ts";
import {
  realtimeTalkDeviceIssueMessage,
  type RealtimeTalkDeviceIssue,
  type RealtimeTalkInputDevice,
} from "../talk/input.ts";
import type { RealtimeTalkLevelSignal } from "../talk/level.ts";
import type { RealtimeTalkStatus } from "../talk/session.ts";
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
  return html`<wa-dropdown-item class="chat-talk-input-picker__notice" disabled>
    <div class=${className} role=${role ?? nothing}>${message}</div>
  </wa-dropdown-item>`;
}

export function renderMicrophonePicker(props: MicrophonePickerProps) {
  // Without an available capture route, a checked "System default" would claim
  // a selection that cannot exist. Show the discovery issue alone.
  const unavailable = !props.loading && props.devices.length === 0 ? props.issue : null;
  // System default renders even while discovery runs: the dropdown's one-time
  // focus step needs at least one item or keyboard users never enter the menu.
  const options = unavailable
    ? []
    : [
        { deviceId: "", label: t("chat.composer.systemDefaultMicrophone") },
        ...(props.loading ? [] : props.devices),
      ];
  // A machine without a microphone and a browser that cannot enumerate are
  // facts, not faults; only the recoverable reasons earn the warn tone.
  const unavailableIsFault =
    unavailable !== null && unavailable !== "none-found" && unavailable !== "list-unsupported";
  const label = t("chat.composer.microphoneInput");
  const unavailableCapabilities = [
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
  );
  return html`
    <wa-dropdown
      class="chat-talk-input-picker"
      placement="top-end"
      aria-label=${label}
      .open=${props.open}
      @wa-show=${props.onOpen}
      @wa-hide=${props.onClose}
      @wa-select=${(event: CustomEvent<{ item: HTMLElement & { value?: string } }>) => {
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
        unavailableCapabilities
          .find((capability) => capability.key === item.dataset.chatTalkCapability)
          ?.onOpenSettings?.();
      }}
    >
      <button
        slot="trigger"
        type="button"
        class="chat-talk-input-picker__trigger"
        aria-label=${label}
        aria-haspopup="menu"
        aria-expanded=${String(props.open)}
      >
        ${icons.chevronDown}
      </button>
      <div class="chat-talk-input-picker__heading">${label}</div>
      ${
        unavailable
          ? renderMicrophoneNotice(
              `chat-talk-input-picker__empty${unavailableIsFault ? " chat-talk-input-picker__empty--fault" : ""}`,
              realtimeTalkDeviceIssueMessage(unavailable, "audioinput"),
              "status",
            )
          : html`
              ${options.map((option) => {
                const selected = option.deviceId === props.selectedDeviceId;
                // Checkbox items toggle their own check before the stored device
                // changes; these radio rows render only the committed selection.
                return html`
                  <wa-dropdown-item
                    class="chat-talk-input-picker__item"
                    data-chat-talk-device
                    value=${option.deviceId}
                    role="menuitemradio"
                    aria-checked=${String(selected)}
                    ${ref((element) => syncDropdownItemRadio(element, selected))}
                  >
                    <span slot="icon" class="chat-talk-input-picker__option-icon" aria-hidden="true"
                      >${icons.mic}</span
                    >
                    <span class="chat-talk-input-picker__label">${option.label}</span>
                    <span slot="details" class="chat-talk-input-picker__check" aria-hidden="true"
                      >${selected ? icons.check : nothing}</span
                    >
                  </wa-dropdown-item>
                `;
              })}
              ${
                props.loading
                  ? renderMicrophoneNotice(
                      "chat-talk-input-picker__note",
                      t("common.loading"),
                      "status",
                    )
                  : nothing
              }
              ${
                props.issue
                  ? renderMicrophoneNotice(
                      "chat-talk-input-picker__warning",
                      realtimeTalkDeviceIssueMessage(props.issue, "audioinput"),
                      "alert",
                    )
                  : nothing
              }
              ${
                props.voiceActive
                  ? renderMicrophoneNotice(
                      "chat-talk-input-picker__hint",
                      t("chat.composer.microphoneAppliesNextSession"),
                    )
                  : nothing
              }
            `
      }
      ${unavailableCapabilities.map(
        (capability) => html`
          <wa-dropdown-item
            class="chat-talk-input-picker__capability"
            data-chat-talk-capability=${capability.key}
            data-status=${capability.status}
            ?disabled=${!capability.onOpenSettings}
          >
            <span class="chat-talk-input-picker__capability-copy" role="status">
              <strong>
                ${
                  capability.status === "unavailable"
                    ? html`<span class="chat-talk-input-picker__capability-alert" aria-hidden="true"
                        >${icons.alertTriangle}</span
                      >`
                    : nothing
                }
                <span>${capability.label}</span>
              </strong>
              <span>
                ${
                  capability.status === "checking"
                    ? t("chat.composer.talkCapabilityChecking")
                    : capability.status === "unknown"
                      ? t("chat.composer.talkCapabilityUnknown")
                      : capability.unavailableReason
                }
              </span>
            </span>
            ${
              capability.onOpenSettings
                ? html`<span slot="details" class="chat-talk-input-picker__settings">
                    <span aria-hidden="true">${icons.settings}</span>
                    <span>${t("chat.composer.configureCapability")}</span>
                  </span>`
                : nothing
            }
          </wa-dropdown-item>
        `,
      )}
      ${
        props.onHoldToDictateChange
          ? html`
              <wa-dropdown-item
                class="chat-talk-input-picker__preference"
                data-chat-talk-preference="hold-to-dictate"
                type="checkbox"
                .checked=${live(props.holdToDictate !== false)}
              >
                <span>${t("chat.composer.holdToDictate")}</span>
                <span
                  slot="details"
                  class="chat-controls__speed-toggle ${
                    props.holdToDictate !== false ? "chat-controls__speed-toggle--active" : ""
                  }"
                  aria-hidden="true"
                >
                  <span class="chat-controls__speed-toggle-thumb"></span>
                </span>
              </wa-dropdown-item>
            `
          : nothing
      }
    </wa-dropdown>
  `;
}

// New Session shares the microphone without run controls or a Talk session.
type ComposerVoiceButtonProps = {
  connected: boolean;
  disabled?: boolean;
  submitDisabledReason?: string | null;
  dictation?: ComposerDictationController;
  microphonePicker?: TemplateResult | typeof nothing;
  /** Dictation-only surfaces must not promise Talk. */
  idleLabel?: string;
  onDictationPointerDown?: (event: PointerEvent) => void;
  onDirectDictationStart?: () => void;
  onToggleVoice?: () => void;
};

export function renderComposerVoiceButton(props: ComposerVoiceButtonProps) {
  const active = props.dictation?.active === true;
  const arming = props.dictation?.arming === true;
  const finalizing = props.dictation?.finalizing === true;
  const holding = props.dictation?.locksComposer === true;
  const startsDictationDirectly =
    props.dictation !== undefined && props.onToggleVoice === undefined;
  const label = active
    ? t("chat.composer.dictationStopAndKeep")
    : (props.idleLabel ?? t("chat.composer.startVoiceInput"));
  const tooltip =
    props.dictation && !startsDictationDirectly && !(active || finalizing)
      ? [props.submitDisabledReason, t("chat.composer.voiceGestureHint")]
          .filter(Boolean)
          .join(" · ")
      : active
        ? label
        : (props.submitDisabledReason ?? label);
  // This shape owns pointer capture. Keep it stable while dictation rerenders,
  // or replacing the button releases capture and cancels the active hold.
  return html`
    <span class="chat-talk-control${holding ? " chat-talk-control--holding" : ""}">
      <openclaw-tooltip .content=${tooltip}>
        <button
          class=${
            active
              ? "chat-send-btn chat-send-btn--dictating"
              : `chat-send-btn chat-send-btn--voice${props.dictation && !startsDictationDirectly ? " chat-send-btn--hold-enabled" : ""}${arming ? " chat-send-btn--dictation-arming" : ""}`
          }
          type="button"
          @pointerdown=${(event: PointerEvent) => props.onDictationPointerDown?.(event)}
          @click=${(event: MouseEvent) => {
            if (active) {
              event.preventDefault();
              // The controller owns hold suppression: releasing a latched hold
              // also clicks this button, and that click must not mean Stop.
              if (!finalizing) {
                props.dictation?.handleClick(event);
              }
              return;
            }
            if (startsDictationDirectly) {
              event.preventDefault();
              props.onDirectDictationStart?.();
              props.dictation?.startDirect();
              return;
            }
            if (props.dictation) {
              props.dictation.handleClick(event);
            } else {
              props.onToggleVoice?.();
            }
          }}
          @contextmenu=${(event: MouseEvent) => props.dictation?.handleContextMenu(event)}
          ?disabled=${
            !active &&
            (!props.connected ||
              props.disabled ||
              (!props.dictation && Boolean(props.submitDisabledReason)))
          }
          aria-disabled=${String(finalizing)}
          aria-label=${label}
        >
          ${
            active
              ? icons.stop
              : html`
                  ${icons.mic}
                  <span class="agent-chat__control-label">${label}</span>
                `
          }
        </button>
      </openclaw-tooltip>
      ${props.microphonePicker}
    </span>
  `;
}

export function renderComposerDictationSendAction(
  dictation: ComposerDictationController,
  onSend: (submissionAction?: Event) => void,
  onPointerDown?: (event: PointerEvent) => void,
) {
  if (!dictation.active) {
    return nothing;
  }
  return html`
    ${
      dictation.connecting
        ? nothing
        : html`<span class="sr-only" role="status" aria-live="polite" aria-atomic="true"
            >${
              dictation.finalizing
                ? t("chat.composer.dictationFinalizing")
                : t("chat.composer.dictationListening")
            }</span
          >`
    }
    <openclaw-tooltip .content=${t("chat.runControls.send")}>
      <button
        class="chat-send-btn chat-send-btn--send chat-send-btn--dictation-commit"
        type="button"
        @pointerdown=${onPointerDown}
        @click=${async (event: MouseEvent) => {
          if (dictation.finalizing) {
            return;
          }
          await dictation.finishActive();
          // Preserve the input action so submission publishes its pending state
          // before yielding to delivery, just like typed Send.
          onSend(event);
        }}
        aria-disabled=${String(dictation.finalizing)}
        aria-label=${t("chat.runControls.send")}
      >
        ${icons.arrowUp}
      </button>
    </openclaw-tooltip>
  `;
}

export function renderComposerDictationStatus(dictation?: ComposerDictationController) {
  if (!dictation?.active) {
    return nothing;
  }
  if (dictation.connecting) {
    return renderChatVoiceStatus({
      status: "connecting",
      detail: t("chat.composer.microphoneAccessPending"),
    });
  }
  const listening = !dictation.finalizing;
  return html`
    <div class="agent-chat__composer-status-stack">
      <div
        class=${`agent-chat__dictation-status${dictation.finalizing ? " agent-chat__dictation-status--finalizing" : ""}`}
      >
        <span
          class="agent-chat__dictation-phase${
            listening ? " agent-chat__dictation-phase--listening" : ""
          }"
        >
          ${
            dictation.finalizing
              ? t("chat.composer.dictationFinalizing")
              : t("chat.composer.dictationListening")
          }
        </span>
      </div>
    </div>
  `;
}

export function renderChatAbortAction(
  props: Pick<ChatRunControlsProps, "canAbort" | "onAbort" | "onPrimaryActionPointerDown">,
) {
  return props.canAbort
    ? html`
        <openclaw-tooltip .content=${t("chat.runControls.stop")}>
          <button
            class="chat-send-btn chat-send-btn--stop"
            @pointerdown=${props.onPrimaryActionPointerDown}
            @click=${props.onAbort}
            aria-label=${t("chat.runControls.stopGenerating")}
          >
            ${icons.stop}
            <span class="agent-chat__control-label">${t("chat.runControls.stop")}</span>
          </button>
        </openclaw-tooltip>
      `
    : nothing;
}

export function renderChatPrimaryActions(props: ChatRunControlsProps) {
  const hasComposedContent = Boolean(props.draft.trim() || props.hasAttachments);
  const [actionLabel, actionDescription] = props.suggestionComposer
    ? (["chat.sessionSuggestions.suggest", "chat.sessionSuggestions.suggestMessage"] as const)
    : !props.canAbort || props.followUpMode === undefined || props.followUpMode === "interrupt"
      ? (["chat.runControls.send", "chat.runControls.sendMessage"] as const)
      : props.followUpMode === "steer"
        ? (["chat.queue.steer", "chat.followUpModeSteer"] as const)
        : (["chat.runControls.queue", "chat.runControls.queueMessage"] as const);
  const activeRunActionLabel = props.submissionLabel ?? t(actionLabel);
  const activeRunActionDescription = props.submissionLabel ?? t(actionDescription);
  const alternateActionLabel = t(
    props.alternateFollowUpMode === "queue" ? "chat.runControls.queue" : "chat.queue.steer",
  );
  const alternateShortcutAvailable =
    props.alternateFollowUpMode && props.canSend && hasComposedContent;
  const activeRunActionTooltip = alternateShortcutAvailable
    ? `${activeRunActionLabel} ⏎ · ${alternateActionLabel} ${t("chat.sendShortcutModifierEnter")}`
    : activeRunActionLabel;
  const activeRunActionTooltipTemplate = alternateShortcutAvailable
    ? html`${activeRunActionLabel}${" "}${renderKbd("⏎", { inline: true })}${" · "}${alternateActionLabel}${" "}${renderKbd(
        t("chat.sendShortcutModifierEnter").split(/(⌘)/u).filter(Boolean),
        { inline: true },
      )}`
    : undefined;
  const abortAction = renderChatAbortAction(props);

  // An errored transport remains active. Keep Stop; the alert row owns its error.
  const voiceErrored = props.voiceStatus === "error";
  const cameraLabel = t(
    props.voiceVideoEnabled ? "chat.composer.turnCameraOff" : "chat.composer.turnCameraOn",
  );
  const renderTalkAction = (action: "start" | "camera") => {
    const camera = action === "camera";
    const label = camera ? cameraLabel : t("chat.composer.realtimeTalkCapability");
    return html`
      <openclaw-tooltip
        class=${camera ? nothing : "chat-mobile-talk-action"}
        .content=${camera ? label : (props.submitDisabledReason ?? label)}
      >
        <button
          class=${`chat-send-btn chat-send-btn--${camera ? "voice" : "talk-mode"}`}
          type=${camera ? nothing : "button"}
          @pointerdown=${camera ? undefined : props.onPrimaryActionPointerDown}
          @click=${camera ? props.onToggleCamera : props.onToggleVoice}
          ?disabled=${
            camera
              ? props.voiceVideoPending ||
                props.voiceStatus === "connecting" ||
                props.voiceStatus === "error"
              : !props.connected ||
                props.sending ||
                props.isBusy ||
                Boolean(props.submitDisabledReason)
          }
          aria-label=${label}
          aria-pressed=${camera ? String(Boolean(props.voiceVideoEnabled)) : nothing}
        >
          ${camera ? (props.voiceVideoEnabled ? icons.cameraOff : icons.camera) : icons.audioLines}
          <span class="agent-chat__control-label">${label}</span>
        </button>
      </openclaw-tooltip>
    `;
  };
  // Dictation edits the draft; only Talk-only controls depend on turn activity.
  const voiceButton = renderComposerVoiceButton({
    ...props,
    disabled: !props.dictation && (props.sending || props.isBusy),
  });
  // Either voice route keeps the microphone ahead of the primary action.
  const voiceControl = props.dictation || props.onToggleVoice ? voiceButton : nothing;
  const mobileDictationControl = props.dictation
    ? html`
        <span class="chat-mobile-dictation-action">
          ${renderComposerVoiceButton({
            connected: props.connected,
            dictation: props.dictation,
            idleLabel: t("chat.composer.dictationCapability"),
            onDirectDictationStart: props.onDirectDictationStart,
          })}
        </span>
      `
    : nothing;
  const mobileTalkAction =
    !hasComposedContent && !props.dictation?.active && props.onToggleVoice
      ? renderTalkAction("start")
      : nothing;
  const sendDisabledReason =
    props.canSend && canSubmitBeforeChatHistory(props.draft) ? null : props.submitDisabledReason;
  const sendBusy = props.sending || Boolean(sendDisabledReason && props.submitPending);
  const sendStatus =
    sendDisabledReason ??
    (props.sending
      ? t("chat.composer.sendingMessage")
      : hasComposedContent
        ? null
        : t("chat.composer.emptyHint"));
  const hasSendableContent =
    hasComposedContent && props.canSend && !props.sending && !sendDisabledReason;
  // A held draft must not replace Stop with a disabled Send. Only an available
  // follow-up action takes that slot during an abortable run.
  const sendAction = html`
    <openclaw-tooltip
      .content=${props.preparingAttachments ? t("chat.composer.preparingAttachments") : (sendStatus ?? activeRunActionTooltip)}
      .contentTemplate=${!props.preparingAttachments && sendStatus == null ? activeRunActionTooltipTemplate : undefined}
    >
      <button
        class="chat-send-btn chat-send-btn--send${props.sending ? " chat-send-btn--sending" : ""}"
        @pointerdown=${props.onPrimaryActionPointerDown}
        @click=${props.onSend}
        ?disabled=${!hasSendableContent}
        aria-label=${sendStatus ?? activeRunActionDescription}
        aria-busy=${sendBusy || props.preparingAttachments ? "true" : "false"}
      >
        ${sendBusy ? html`<span class="btn__spinner" aria-hidden="true"></span>` : icons.arrowUp}
        <span class="agent-chat__control-label">${activeRunActionLabel}</span>
      </button>
    </openclaw-tooltip>
  `;
  const dictationSendAction =
    props.dictation && (!props.submitDisabledReason || canSubmitBeforeChatHistory(props.draft))
      ? renderComposerDictationSendAction(
          props.dictation,
          props.onSend,
          props.onPrimaryActionPointerDown,
        )
      : sendAction;
  const activePrimaryAction = props.dictation?.active
    ? dictationSendAction
    : props.canAbort && !hasSendableContent
      ? abortAction
      : null;
  const desktopPrimaryAction = activePrimaryAction ?? sendAction;
  const mobilePrimaryAction =
    activePrimaryAction ??
    (hasComposedContent || !props.onToggleVoice ? sendAction : mobileTalkAction);
  const primaryActions =
    mobilePrimaryAction === desktopPrimaryAction
      ? html`<span class="chat-mobile-primary-action chat-desktop-primary-action"
          >${desktopPrimaryAction}</span
        >`
      : html`
          <span class="chat-mobile-primary-action">${mobilePrimaryAction}</span>
          <span class="chat-desktop-primary-action">${desktopPrimaryAction}</span>
        `;
  return html`
    ${
      props.voiceActive && props.onToggleVoice
        ? html`
            <span class="chat-talk-control chat-talk-control--active">
              <openclaw-tooltip .content=${t("chat.composer.stopVoiceInput")}>
                <button
                  class="chat-send-btn chat-send-btn--voice-live${
                    voiceErrored ? " chat-send-btn--voice-error" : ""
                  }"
                  @click=${props.onToggleVoice}
                  aria-label=${t("chat.composer.stopVoiceInput")}
                >
                  ${
                    voiceErrored
                      ? nothing
                      : renderMicrophoneActivity({
                          status: props.voiceStatus,
                          inputLevel: props.voiceInputLevel,
                        })
                  }
                  <span class="chat-send-btn__voice-stop-glyph">${icons.stop}</span>
                </button>
              </openclaw-tooltip>
              ${props.microphonePicker}
            </span>
            ${
              voiceErrored || props.voiceStatus === "connecting"
                ? nothing
                : html`
                    <span
                      class="sr-only agent-chat__voice-status"
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                      >${voiceStatusLabel(props.voiceStatus, props.voiceDetail)}</span
                    >
                  `
            }
            ${
              props.voiceVideoCapable && props.onToggleCamera ? renderTalkAction("camera") : nothing
            }
            <span class="chat-mobile-primary-action chat-desktop-primary-action"
              >${abortAction}</span
            >
          `
        : html` ${voiceControl} ${mobileDictationControl} ${primaryActions} `
    }
  `;
}
