import type { JSX } from "@solidjs/web";
import { createMemo, onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuEntry } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { MicrophonePickerProps } from "../composer-microphone-picker.ts";
import { realtimeTalkDeviceIssueMessage } from "../talk/input.ts";

export function MicrophoneMenu(props: {
  picker: MicrophonePickerProps;
  renderItems: (items: () => readonly MenuEntry[]) => JSX.Element;
  onReady: (items: (() => MenuEntry[]) | undefined) => void;
  onDevicePointer: (pointer: boolean) => void;
}) {
  const items = createMemo(
    () => {
      const capabilities = [
        {
          key: "realtime",
          label: t("chat.composer.realtimeTalkCapability"),
          status: props.picker.realtimeStatus,
          unavailableReason: t("chat.composer.realtimeTalkProviderUnavailable"),
          onOpenSettings: props.picker.onOpenTalkSettings,
        },
        {
          key: "dictation",
          label: t("chat.composer.dictationCapability"),
          status: props.picker.dictationStatus,
          unavailableReason: t("chat.composer.dictationProviderUnavailableShort"),
          onOpenSettings: props.picker.onOpenDictationSettings,
        },
      ].filter(
        (capability) =>
          capability.status !== "ready" &&
          (capability.key !== "realtime" || props.picker.showRealtimeCapability !== false),
      );
      const entries: MenuEntry[] = [
        {
          kind: "content",
          id: "heading",
          content: (
            <div class="chat-talk-input-picker__heading">{t("chat.composer.microphoneInput")}</div>
          ),
        },
      ];
      const notice = (id: string, className: string, message: string, role?: "status" | "alert") =>
        entries.push({
          id,
          label: message,
          disabled: true,
          class: "chat-talk-input-picker__notice",
          content: (
            <div class={className} role={role}>
              {message}
            </div>
          ),
        });
      const issue =
        !props.picker.loading && props.picker.devices.length === 0 ? props.picker.issue : null;
      if (issue) {
        const fault = issue !== "none-found" && issue !== "list-unsupported";
        notice(
          "unavailable",
          `chat-talk-input-picker__empty${fault ? " chat-talk-input-picker__empty--fault" : ""}`,
          realtimeTalkDeviceIssueMessage(issue, "audioinput"),
          "status",
        );
      } else {
        for (const option of [
          { deviceId: "", label: t("chat.composer.systemDefaultMicrophone") },
          ...(props.picker.loading ? [] : props.picker.devices),
        ]) {
          entries.push({
            id: `device:${option.deviceId}`,
            label: option.label,
            type: "radio",
            checked: option.deviceId === props.picker.selectedDeviceId,
            class: "chat-talk-input-picker__item",
            attributes: {
              "data-chat-talk-device": "",
              value: option.deviceId,
              onClick: (event) => {
                props.onDevicePointer(event.detail > 0);
              },
            },
            icon: (
              <span class="chat-talk-input-picker__option-icon" aria-hidden="true">
                <Icon name="mic" />
              </span>
            ),
            content: <span class="chat-talk-input-picker__label">{option.label}</span>,
            details: (
              <span class="chat-talk-input-picker__check" aria-hidden="true">
                {option.deviceId === props.picker.selectedDeviceId ? <Icon name="check" /> : null}
              </span>
            ),
          });
        }
        if (props.picker.loading) {
          notice("loading", "chat-talk-input-picker__note", t("common.loading"), "status");
        }
        if (props.picker.issue) {
          notice(
            "issue",
            "chat-talk-input-picker__warning",
            realtimeTalkDeviceIssueMessage(props.picker.issue, "audioinput"),
            "alert",
          );
        }
        if (props.picker.voiceActive) {
          notice(
            "active-hint",
            "chat-talk-input-picker__hint",
            t("chat.composer.microphoneAppliesNextSession"),
          );
        }
      }
      for (const capability of capabilities) {
        const detail =
          capability.status === "checking"
            ? t("chat.composer.talkCapabilityChecking")
            : capability.status === "unknown"
              ? t("chat.composer.talkCapabilityUnknown")
              : capability.unavailableReason;
        entries.push({
          id: `capability:${capability.key}`,
          label: [
            capability.label,
            detail,
            capability.onOpenSettings ? t("chat.composer.configureCapability") : null,
          ]
            .filter(Boolean)
            .join(" "),
          disabled: !capability.onOpenSettings,
          class: "chat-talk-input-picker__capability",
          attributes: {
            "data-chat-talk-capability": capability.key,
            "data-status": capability.status,
          },
          closeOnSelect: false,
          content: (
            <span class="chat-talk-input-picker__capability-copy" role="status">
              <strong>
                {capability.status === "unavailable" ? (
                  <span class="chat-talk-input-picker__capability-alert" aria-hidden="true">
                    <Icon name="alertTriangle" />
                  </span>
                ) : null}
                <span>{capability.label}</span>
              </strong>
              <span>{detail}</span>
            </span>
          ),
          details: capability.onOpenSettings ? (
            <span class="chat-talk-input-picker__settings">
              <span aria-hidden="true">
                <Icon name="settings" />
              </span>
              <span>{t("chat.composer.configureCapability")}</span>
            </span>
          ) : undefined,
        });
      }
      if (props.picker.onHoldToDictateChange) {
        entries.push({
          id: "hold-to-dictate",
          label: t("chat.composer.holdToDictate"),
          type: "checkbox",
          checked: props.picker.holdToDictate !== false,
          class: "oc-menu-item--switch chat-talk-input-picker__preference",
          attributes: { "data-chat-talk-preference": "hold-to-dictate" },
          closeOnSelect: false,
          details: (
            <span
              class={[
                "chat-controls__speed-toggle",
                { "chat-controls__speed-toggle--active": props.picker.holdToDictate !== false },
              ]}
              aria-hidden="true"
            >
              <span class="chat-controls__speed-toggle-thumb" />
            </span>
          ),
        });
      }
      return entries;
    },
    { lazy: true },
  );
  onSettled(() => {
    props.onReady(items);
    return () => props.onReady(undefined);
  });
  return <>{props.renderItems(items)}</>;
}
