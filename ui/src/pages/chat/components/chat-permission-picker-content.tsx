import { createMemo, onSettled } from "solid-js";
import type { SessionPermissionMode } from "../../../../../packages/gateway-protocol/src/index.js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuItem } from "../../../components/solid/menu.tsx";
import { registerPermissionPickerEnglish } from "../../../i18n/locales/en-permission-picker.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../../lib/external-link.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import {
  modeLabel,
  permissionIcon,
  type ChatPermissionPickerContentProps,
} from "./chat-permission-picker.tsx";

registerEnglishCatalog(registerPermissionPickerEnglish);

const PERMISSION_MODES_DOCS_URL = "https://docs.openclaw.ai/gateway/permission-modes";
const DEFAULT_PERMISSION_VALUE = "default";
const PERMISSION_OPTIONS = [null, "read-only", "guarded", "workspace", "full"] as const;

function agentDefaultLabel(defaultMode?: SessionPermissionMode): string {
  return defaultMode
    ? t("chat.permissionControls.agentDefaultWithMode", {
        mode: t(`chat.permissionControls.modes.${defaultMode}.label`),
      })
    : t("chat.permissionControls.agentDefault");
}

export function ChatPermissionPickerContent(props: ChatPermissionPickerContentProps) {
  const pending = createMemo(() => props.picker.pending);
  const disabled = createMemo(() => props.picker.disabled || pending());
  const selectedMode = createMemo(() => props.picker.mode ?? null);
  const defaultMode = createMemo(() => props.picker.defaultMode);
  const participant = createMemo(() => props.picker.participant);
  const canSelectFull = createMemo(() => props.picker.canSelectFull);
  const items = createMemo<MenuItem[]>(
    () => [
      {
        id: "learn-more",
        label: t("common.learnMore"),
        href: PERMISSION_MODES_DOCS_URL,
        attributes: { target: EXTERNAL_LINK_TARGET, rel: buildExternalLinkRel() },
        class: "oc-menu-heading__action chat-controls__permission-learn-more learn-more-link",
      },
      ...PERMISSION_OPTIONS.filter(
        (mode) =>
          !participant() ||
          mode === "read-only" ||
          (mode === "guarded" && selectedMode() !== "read-only"),
      ).map((mode, index): MenuItem => {
        const value = mode ?? DEFAULT_PERMISSION_VALUE;
        const selected = selectedMode() === mode;
        const locked = mode === "full" && !canSelectFull();
        const label = mode ? modeLabel(mode) : agentDefaultLabel(defaultMode());
        const fullAccess = mode === "full" || (mode === null && defaultMode() === "full");
        return {
          id: value,
          label: locked ? `${label}. ${t("chat.permissionControls.fullRequiresAdmin")}` : label,
          type: "radio",
          checked: selected,
          disabled: disabled() || locked,
          closeOnSelect: false,
          class: [
            "chat-controls__permission-option",
            {
              "chat-controls__permission-option--selected": selected,
              "chat-controls__permission-option--full": fullAccess,
              "chat-controls__permission-option--pending": selected && pending(),
            },
          ],
          attributes: {
            "data-chat-permission-option": value,
            "data-chat-permission-shortcut": String(index + 1),
            "data-shortcut": String(index + 1),
            title: locked ? t("chat.permissionControls.fullRequiresAdmin") : undefined,
          },
          icon: (
            <span class="chat-controls__permission-option-icon" aria-hidden="true">
              <Icon name={permissionIcon(mode)} />
            </span>
          ),
          content: (
            <span class="chat-controls__permission-option-copy">
              <span class="chat-controls__permission-option-title">
                <span>{mode ? modeLabel(mode) : t("chat.permissionControls.agentDefault")}</span>
                {mode && mode === defaultMode() && (
                  <span class="chat-controls__permission-default-badge">
                    {t("chat.permissionControls.default")}
                  </span>
                )}
              </span>
              <span class="chat-controls__permission-option-description">
                {locked
                  ? t("chat.permissionControls.requiresAdmin")
                  : mode
                    ? t(`chat.permissionControls.modes.${mode}.description`)
                    : t("chat.permissionControls.defaultDescription")}
              </span>
            </span>
          ),
          details: (
            <span class="chat-controls__permission-option-state" aria-hidden="true">
              {locked && (
                <span class="chat-controls__permission-lock">
                  <Icon name="lock" />
                </span>
              )}
              {selected && !locked && (
                <span class="chat-controls__inline-select-check">
                  {pending() ? <span class="btn__spinner" /> : <Icon name="check" />}
                </span>
              )}
            </span>
          ),
        };
      }),
    ],
    { lazy: true },
  );
  onSettled(() => {
    props.onReady(items);
    return () => props.onReady(undefined);
  });
  return <>{props.renderItems(items)}</>;
}
