import type { JSX } from "@solidjs/web";
import { createMemo, createUniqueId, Errored, lazy, Loading, onSettled } from "solid-js";
import type { SessionPermissionMode } from "../../../../../packages/gateway-protocol/src/index.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import { MenuHeading } from "../../../components/solid/menu-heading.tsx";
import {
  createMenuControls,
  Menu,
  type MenuEntry,
  type MenuHandle,
  type MenuItem,
} from "../../../components/solid/menu.tsx";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";

registerEnglishCatalog(registerModelControlsEnglish);

const PERMISSION_MODES = ["read-only", "guarded", "workspace", "full"] as const;
const DEFAULT_PERMISSION_VALUE = "default";
const PERMISSION_ICONS = {
  "read-only": "shieldEllipsis",
  guarded: "shieldLock",
  workspace: "shieldCog",
  full: "shieldAlert",
} as const;

type PermissionSelection = SessionPermissionMode | null;

export type ChatPermissionPickerProps = {
  canSelectFull: boolean;
  participant?: boolean;
  setBy?: string;
  disabled?: boolean;
  disabledReason?: string;
  mode?: SessionPermissionMode;
  defaultMode?: SessionPermissionMode;
  onSelect: (mode: PermissionSelection) => unknown;
  pending?: boolean;
};

export function modeLabel(
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

export function permissionIcon(mode: PermissionSelection | undefined) {
  return mode ? PERMISSION_ICONS[mode] : "shieldCheck";
}

const Content = lazy(() => import("./chat-permission-picker-content.tsx"), {
  export: "ChatPermissionPickerContent",
});
export type ChatPermissionPickerContentProps = {
  picker: ChatPermissionPickerProps;
  renderItems: (items: () => readonly MenuEntry[]) => JSX.Element;
  onReady: (items: (() => MenuItem[]) | undefined) => void;
};

export function ChatPermissionPicker(props: ChatPermissionPickerProps) {
  const id = createUniqueId();
  let menu: MenuHandle | undefined;
  let stopSurface: (() => void) | undefined;
  let stopTrigger: (() => void) | undefined;
  // Menu publishes its handle during settlement; release its listeners with this view.
  onSettled(() => () => {
    stopSurface?.();
    stopTrigger?.();
  });
  // Equal owner refreshes must not recreate the open menu's option content.
  const pending = createMemo(() => props.pending);
  const disabled = createMemo(() => props.disabled || pending());
  const selectMode = (mode: PermissionSelection) => {
    if (
      props.participant &&
      (mode === null ||
        mode === "workspace" ||
        mode === "full" ||
        (props.mode === "read-only" && mode !== "read-only"))
    ) {
      return;
    }
    if (!disabled() && (mode !== "full" || props.canSelectFull) && mode !== (props.mode ?? null)) {
      // The owner reports failures; keep its pending choice visible until settlement.
      const result = props.onSelect(mode);
      if (result instanceof Promise) {
        void result.then(
          () => menu?.close(),
          () => menu?.close(),
        );
      } else {
        menu?.close();
      }
    } else if (!disabled()) {
      menu?.close();
    }
  };
  const controls = createMenuControls();
  let readItems: (() => MenuItem[]) | undefined;
  let keyboardOpen = false;
  let focusLast = false;
  let openingFocus: Element | null | undefined;
  const focusReady = () => {
    if (!keyboardOpen || !menu?.overlay.open) {
      return;
    }
    const active = menu.overlay.surface.ownerDocument.activeElement;
    if (
      active !== openingFocus &&
      active !== menu.overlay.surface &&
      !(
        active === menu.overlay.surface.ownerDocument.body &&
        openingFocus &&
        !openingFocus.isConnected
      )
    ) {
      return;
    }
    const last = focusLast ? menu.itemElements().at(-1) : undefined;
    if (last) {
      last.focus({ preventScroll: true });
    } else {
      menu.focusFirst();
    }
  };
  const entries: MenuEntry[] = [
    {
      kind: "group",
      id: "permission-options",
      get items() {
        return readItems?.() ?? [];
      },
      render: (renderItems) => (
        <Errored
          fallback={(error, reset) => {
            onSettled(focusReady);
            return (
              <LazyViewError
                error={error()}
                onRetry={() => {
                  openingFocus = menu?.overlay.surface.ownerDocument.activeElement;
                  keyboardOpen = true;
                  focusLast = false;
                  reset();
                }}
                retryRef={controls.ref()}
                inline
              />
            );
          }}
        >
          <Loading
            fallback={renderItems(() => [
              { id: "permission-loading", label: t("common.loading"), disabled: true },
            ])}
          >
            <Content
              picker={props}
              renderItems={renderItems}
              onReady={(next) => {
                readItems = next;
                if (next) {
                  focusReady();
                }
              }}
            />
          </Loading>
        </Errored>
      ),
    },
  ];
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
    const item = readItems?.()[Number(event.key)];
    if (!item || item.disabled) {
      return;
    }
    const mode = permissionSelection(item.id);
    if (mode !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      selectMode(mode);
    }
  };
  return (
    <Menu
      lazy
      controls={controls}
      id={`chat-permission-${id}`}
      label={`${t("chat.permissionControls.label")}: ${modeLabel(props.mode, props.defaultMode)}`}
      class="chat-controls__inline-select chat-controls__permission-picker"
      panelClass="chat-controls__permission-menu"
      triggerClass={[
        "chat-controls__inline-select-trigger chat-controls__permission-trigger",
        {
          "chat-controls__permission-trigger--default": !props.mode,
          "chat-controls__permission-trigger--full": (props.mode ?? props.defaultMode) === "full",
        },
      ]}
      triggerAttributes={{
        "data-chat-permission-select": "true",
        "data-chat-select-value": props.mode ?? "",
        title: props.disabledReason ?? t("chat.permissionControls.help"),
        "aria-description": props.disabledReason,
        "aria-busy": props.pending ? "true" : undefined,
      }}
      disabled={Boolean(props.disabled)}
      placement="top-start"
      pointerFocus="trigger"
      items={entries}
      onBeforeShow={() => {
        openingFocus = menu?.overlay.surface.ownerDocument.activeElement;
      }}
      onOpenChange={(open) => {
        if (!open) {
          keyboardOpen = false;
          openingFocus = undefined;
        }
      }}
      ref={(handle) => {
        menu = handle;
        stopSurface = listen(handle.overlay.surface, "keydown", keydown, true);
        if (handle.overlay.trigger) {
          stopTrigger = listen(
            handle.overlay.trigger,
            "keydown",
            (event) => {
              if (!handle.overlay.open) {
                keyboardOpen = ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key);
                focusLast = event.key === "ArrowUp";
              }
              keydown(event);
            },
            true,
          );
        }
      }}
      onSelect={(item) => {
        const mode = permissionSelection(item.id);
        if (mode !== undefined) {
          selectMode(mode);
        }
      }}
      trigger={
        <>
          <span class="chat-controls__permission-icon" aria-hidden="true">
            <Icon name={permissionIcon(props.mode ?? props.defaultMode)} />
          </span>
          {/* "Default (...)" belongs to the menu row; the trigger names the effective mode. */}
          <span class="chat-controls__inline-select-label chat-controls__permission-label">
            {props.participant
              ? t("chat.permissionControls.setByCreator", {
                  mode: modeLabel(props.mode ?? "guarded"),
                  name: props.setBy ?? t("chat.permissionControls.creator"),
                })
              : modeLabel(props.mode ?? props.defaultMode)}
          </span>
        </>
      }
    >
      <MenuHeading label={t("chat.permissionControls.label")} />
    </Menu>
  );
}
