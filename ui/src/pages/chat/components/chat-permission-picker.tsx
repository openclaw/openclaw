import type { JSX } from "@solidjs/web";
import { createUniqueId, Errored, lazy, Loading, onSettled } from "solid-js";
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

export function permissionIcon(mode: PermissionSelection | undefined) {
  return mode ? PERMISSION_ICONS[mode] : "shieldCheck";
}

const Content = lazy(() => import("./chat-permission-picker-content.tsx"), {
  export: "ChatPermissionPickerContent",
});
export type ChatPermissionPickerContentProps = {
  picker: ChatPermissionPickerProps;
  renderItems: (items: () => readonly MenuEntry[]) => JSX.Element;
  readMenu: () => MenuHandle | undefined;
  onReady: (content: ChatPermissionPickerContent | undefined) => void;
};

type ChatPermissionPickerContent = {
  items: () => MenuItem[];
  select: (id: string) => void;
};

export function ChatPermissionPicker(props: ChatPermissionPickerProps) {
  const id = createUniqueId();
  let menu: MenuHandle | undefined;
  let stopTrigger: (() => void) | undefined;
  // Menu publishes its handle during settlement; release its listeners with this view.
  onSettled(() => () => {
    stopTrigger?.();
  });
  const controls = createMenuControls();
  let content: ChatPermissionPickerContent | undefined;
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
        return content?.items() ?? [];
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
              readMenu={() => menu}
              onReady={(next) => {
                content = next;
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
        if (handle.overlay.trigger) {
          stopTrigger = listen(
            handle.overlay.trigger,
            "keydown",
            (event) => {
              if (!handle.overlay.open) {
                keyboardOpen = ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key);
                focusLast = event.key === "ArrowUp";
              }
            },
            true,
          );
        }
      }}
      onSelect={(item) => content?.select(item.id)}
      trigger={
        <>
          <span class="chat-controls__permission-icon" aria-hidden="true">
            <Icon name={permissionIcon(props.mode ?? props.defaultMode)} />
          </span>
          {/* "Default (...)" belongs to the menu row; the trigger names the effective mode. */}
          <span class="chat-controls__inline-select-label chat-controls__permission-label">
            {modeLabel(props.mode ?? props.defaultMode)}
          </span>
        </>
      }
    >
      <MenuHeading label={t("chat.permissionControls.label")} />
    </Menu>
  );
}
