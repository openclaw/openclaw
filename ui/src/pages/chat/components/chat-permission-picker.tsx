import { createMemo, createUniqueId, onCleanup } from "solid-js";
import type { SessionPermissionMode } from "../../../../../packages/gateway-protocol/src/index.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu, type MenuHandle, type MenuItem } from "../../../components/solid/menu.tsx";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../../lib/external-link.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerModelControlsEnglish);

const PERMISSION_MODES_DOCS_URL = "https://docs.openclaw.ai/gateway/permission-modes";
const PERMISSION_MODES = ["read-only", "guarded", "workspace", "full"] as const;
const DEFAULT_PERMISSION_VALUE = "default";
const PERMISSION_OPTIONS = [null, ...PERMISSION_MODES] as const;
const PERMISSION_ICONS = {
  "read-only": "shieldEllipsis",
  guarded: "shieldLock",
  workspace: "shieldCog",
  full: "shieldAlert",
} as const;

type PermissionSelection = SessionPermissionMode | null;

export type ChatPermissionPickerProps = {
  canSelectFull: boolean;
  disabled?: boolean;
  disabledReason?: string;
  mode?: SessionPermissionMode;
  defaultMode?: SessionPermissionMode;
  onSelect: (mode: PermissionSelection) => unknown;
  pending?: boolean;
};

function modeLabel(
  mode: SessionPermissionMode | null | undefined,
  defaultMode?: SessionPermissionMode,
): string {
  return mode
    ? t(`chat.permissionControls.modes.${mode}.label`)
    : defaultMode
      ? t("chat.permissionControls.defaultWithMode", {
          mode: t(`chat.permissionControls.modes.${defaultMode}.label`),
        })
      : t("chat.permissionControls.default");
}

function permissionSelection(value: string): PermissionSelection | undefined {
  return value === DEFAULT_PERMISSION_VALUE
    ? null
    : PERMISSION_MODES.find((mode) => mode === value);
}

function permissionIcon(mode: PermissionSelection | undefined) {
  return mode ? PERMISSION_ICONS[mode] : "shieldCheck";
}

export function ChatPermissionPicker(props: ChatPermissionPickerProps) {
  const id = createUniqueId();
  let menu: MenuHandle | undefined;
  const disabled = createMemo(() => props.disabled || props.pending);
  const selectedMode = createMemo(() => props.mode ?? null);
  const defaultMode = createMemo(() => props.defaultMode);
  const canSelectFull = createMemo(() => props.canSelectFull);
  const selectMode = (mode: PermissionSelection) => {
    if (!disabled() && (mode !== "full" || props.canSelectFull) && mode !== (props.mode ?? null)) {
      void props.onSelect(mode);
    }
  };
  const items = createMemo<MenuItem[]>(() => [
    {
      id: "learn-more",
      label: t("common.learnMore"),
      href: PERMISSION_MODES_DOCS_URL,
      attributes: { target: EXTERNAL_LINK_TARGET, rel: buildExternalLinkRel() },
      class: "chat-controls__permission-learn-more learn-more-link",
    },
    ...PERMISSION_OPTIONS.map((mode, index): MenuItem => {
      const value = mode ?? DEFAULT_PERMISSION_VALUE;
      const selected = selectedMode() === mode;
      const locked = mode === "full" && !canSelectFull();
      const label = modeLabel(mode, defaultMode());
      return {
        id: value,
        label: locked ? `${label}. ${t("chat.permissionControls.fullRequiresAdmin")}` : label,
        type: "radio",
        checked: selected,
        disabled: disabled() || locked,
        class: `chat-controls__permission-option${selected ? " chat-controls__permission-option--selected" : ""}`,
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
              <span>{label}</span>
            </span>
            <span class="chat-controls__permission-option-description">
              {mode
                ? t(`chat.permissionControls.modes.${mode}.description`)
                : t("chat.permissionControls.defaultDescription")}
            </span>
          </span>
        ),
        details: (
          <span class="chat-controls__permission-option-state" aria-hidden="true">
            {!selected && !locked && (
              <span class="chat-controls__permission-shortcut">{index + 1}</span>
            )}
            {locked && (
              <span class="chat-controls__permission-lock">
                <Icon name="lock" />
              </span>
            )}
            {selected && !locked && (
              <span class="chat-controls__inline-select-check">
                <Icon name="check" />
              </span>
            )}
          </span>
        ),
      };
    }),
  ]);
  const keydown = (event: KeyboardEvent) => {
    if (
      !menu?.overlay.open ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.defaultPrevented ||
      !/^[1-5]$/u.test(event.key)
    ) {
      return;
    }
    const item = items()[Number(event.key)];
    if (!item || item.disabled) {
      return;
    }
    const mode = permissionSelection(item.id);
    if (mode !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      selectMode(mode);
      menu.close();
    }
  };
  onCleanup(() => {
    menu?.overlay.surface.removeEventListener("keydown", keydown, true);
    menu?.overlay.trigger?.removeEventListener("keydown", keydown, true);
  });
  return (
    <Menu
      lazy
      id={`chat-permission-${id}`}
      label={`${t("chat.permissionControls.label")}: ${modeLabel(props.mode, props.defaultMode)}`}
      class="chat-controls__inline-select chat-controls__permission-picker"
      panelClass="chat-controls__permission-menu"
      triggerClass={`chat-controls__inline-select-trigger chat-controls__permission-trigger${props.disabled ? " chat-controls__inline-select-trigger--disabled" : ""}${!props.mode ? " chat-controls__permission-trigger--default" : ""}${(props.mode ?? props.defaultMode) === "full" ? " chat-controls__permission-trigger--full" : ""}`}
      triggerAttributes={{
        "data-chat-permission-select": "true",
        "data-chat-select-value": props.mode ?? "",
        title: props.disabledReason ?? t("chat.permissionControls.help"),
      }}
      disabled={Boolean(disabled())}
      placement="top-start"
      pointerFocus="trigger"
      items={items()}
      ref={(handle) => {
        menu = handle;
        handle.overlay.surface.addEventListener("keydown", keydown, true);
        handle.overlay.trigger?.addEventListener("keydown", keydown, true);
      }}
      onSelect={(item) => {
        const mode = permissionSelection(item.id);
        if (mode !== undefined) {
          selectMode(mode);
        }
      }}
      trigger={
        <span class="chat-controls__permission-icon" aria-hidden="true">
          <Icon name={permissionIcon(props.mode)} />
        </span>
      }
    >
      <div class="chat-controls__popover-title chat-controls__permission-heading">
        {t("chat.permissionControls.label")}
      </div>
    </Menu>
  );
}
