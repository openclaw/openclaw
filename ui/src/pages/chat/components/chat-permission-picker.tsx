import { For, createMemo } from "solid-js";
import type { SessionPermissionMode } from "../../../../../packages/gateway-protocol/src/index.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../../lib/external-link.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { restorePointerOpenedChatComposerTrigger } from "./chat-picker-overlay.ts";

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

function handlePermissionPickerKeydown(
  event: KeyboardEvent,
  onSelect: (mode: PermissionSelection) => void,
): void {
  const dropdown = event.currentTarget;
  if (
    !(dropdown instanceof HTMLElement) ||
    !dropdown.hasAttribute("open") ||
    !/^[1-5]$/u.test(event.key)
  ) {
    return;
  }
  const option = dropdown.querySelector<HTMLElement>(
    `[data-chat-permission-shortcut="${event.key}"]`,
  );
  if (!option || option.hasAttribute("disabled")) {
    return;
  }
  const mode = permissionSelection(option.dataset.chatPermissionOption);
  if (mode === undefined) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  onSelect(mode);
  dropdown.removeAttribute("open");
  dropdown.querySelector<HTMLButtonElement>("[slot=trigger]")?.focus();
}

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

function permissionSelection(value: string | undefined): PermissionSelection | undefined {
  if (value === DEFAULT_PERMISSION_VALUE) {
    return null;
  }
  return PERMISSION_MODES.find((mode) => mode === value);
}

function permissionIcon(mode: PermissionSelection | undefined) {
  return mode ? PERMISSION_ICONS[mode] : "shieldCheck";
}

export function ChatPermissionPicker(props: ChatPermissionPickerProps) {
  const disabled = createMemo(() => props.disabled || props.pending);
  const selectMode = (mode: PermissionSelection) => {
    if (disabled() || (mode === "full" && !props.canSelectFull)) {
      return;
    }
    if (mode !== (props.mode ?? null)) {
      void props.onSelect(mode);
    }
  };
  return (
    <wa-dropdown
      class="chat-controls__inline-select chat-controls__permission-picker"
      placement="top-start"
      onWa-after-show={restorePointerOpenedChatComposerTrigger}
      onKeyDown={(event: KeyboardEvent) => handlePermissionPickerKeydown(event, selectMode)}
      onWa-select={(event: CustomEvent<{ item: { value?: string } }>) => {
        const mode = permissionSelection(event.detail.item.value);
        if (mode !== undefined) {
          selectMode(mode);
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        class={[
          "chat-controls__inline-select-trigger chat-controls__permission-trigger",
          {
            "chat-controls__inline-select-trigger--disabled": props.disabled,
            "chat-controls__permission-trigger--default": !props.mode,
            "chat-controls__permission-trigger--full": (props.mode ?? props.defaultMode) === "full",
          },
        ]}
        data-chat-permission-select="true"
        data-chat-select-value={props.mode ?? ""}
        aria-label={`${t("chat.permissionControls.label")}: ${modeLabel(props.mode, props.defaultMode)}`}
        aria-disabled={disabled() ? "true" : "false"}
        title={props.disabledReason ?? t("chat.permissionControls.help")}
        disabled={disabled()}
      >
        <span class="chat-controls__permission-icon" aria-hidden="true">
          <Icon name={permissionIcon(props.mode)} />
        </span>
      </button>
      <div class="chat-controls__popover-title chat-controls__permission-heading">
        {t("chat.permissionControls.label")}
      </div>
      <wa-dropdown-item
        class="chat-controls__permission-learn-more learn-more-link"
        href={PERMISSION_MODES_DOCS_URL}
        target={EXTERNAL_LINK_TARGET}
        rel={buildExternalLinkRel()}
      >
        {t("common.learnMore")}
      </wa-dropdown-item>
      <For each={PERMISSION_OPTIONS} keyed={(mode) => mode ?? DEFAULT_PERMISSION_VALUE}>
        {(mode, index) => {
          const value = () => mode() ?? DEFAULT_PERMISSION_VALUE;
          const selected = () => (props.mode ?? null) === mode();
          const locked = () => mode() === "full" && !props.canSelectFull;
          const label = () => modeLabel(mode(), props.defaultMode);
          return (
            <wa-dropdown-item
              class={[
                "chat-controls__permission-option",
                { "chat-controls__permission-option--selected": selected() },
              ]}
              value={value()}
              data-chat-permission-option={value()}
              data-chat-permission-shortcut={String(index() + 1)}
              role="menuitemradio"
              aria-checked={selected() ? "true" : "false"}
              aria-label={
                locked() ? `${label()}. ${t("chat.permissionControls.fullRequiresAdmin")}` : label()
              }
              title={locked() ? t("chat.permissionControls.fullRequiresAdmin") : undefined}
              disabled={disabled() || locked()}
            >
              <span slot="icon" class="chat-controls__permission-option-icon" aria-hidden="true">
                <Icon name={permissionIcon(mode())} />
              </span>
              <span class="chat-controls__permission-option-copy">
                <span class="chat-controls__permission-option-title">
                  <span>{label()}</span>
                </span>
                <span class="chat-controls__permission-option-description">
                  {mode()
                    ? t(`chat.permissionControls.modes.${mode()}.description`)
                    : t("chat.permissionControls.defaultDescription")}
                </span>
              </span>
              <span
                slot="details"
                class="chat-controls__permission-option-state"
                aria-hidden="true"
              >
                {!selected() && !locked() && (
                  <span class="chat-controls__permission-shortcut">{index() + 1}</span>
                )}
                {locked() && (
                  <span class="chat-controls__permission-lock">
                    <Icon name="lock" />
                  </span>
                )}
                {selected() && !locked() && (
                  <span class="chat-controls__inline-select-check">
                    <Icon name="check" />
                  </span>
                )}
              </span>
            </wa-dropdown-item>
          );
        }}
      </For>
    </wa-dropdown>
  );
}
