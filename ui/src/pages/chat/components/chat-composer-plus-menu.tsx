import { createEffect, createMemo, createSignal, createUniqueId, onSettled, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import {
  createMenuControls,
  Menu,
  type MenuEntry,
  type MenuHandle,
} from "../../../components/solid/menu.tsx";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { countSessionToolOverrides } from "../../../lib/sessions/tool-overrides.ts";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import type {
  ChatComposerPlusMenuContentProps,
  ChatComposerPlusMenuProps,
} from "./chat-composer-plus-menu.types.ts";

registerEnglishCatalog(registerChatComposerEnglish);

type MenuContent = typeof import("./chat-composer-plus-menu-content.tsx");
type ContentState =
  | { kind: "loading" }
  | { kind: "ready"; module: MenuContent }
  | { kind: "error"; error: unknown };

function PlusMenuSurface(props: { menu: ChatComposerPlusMenuContentProps }) {
  const controls = createMenuControls();
  let handle!: MenuHandle;
  let host!: HTMLDivElement;
  const id = createUniqueId();
  let releaseAnchor = () => {};
  let disposed = false;
  let loading: Promise<void> | undefined;
  let focusOnReady = false;
  let focusLastOnReady = false;
  let openingFocus: Element | null | undefined;
  const [content, setContent] = createSignal<ContentState>({ kind: "loading" });
  const runtime = createMemo(() => {
    const current = content();
    return current.kind === "ready" ? current.module : undefined;
  });
  const focusLoadedItems = () => {
    const { overlay } = handle;
    const active = host.ownerDocument.activeElement;
    if (
      !disposed &&
      focusOnReady &&
      overlay.open &&
      props.menu.open &&
      (active === openingFocus ||
        active === overlay.surface ||
        (active === host.ownerDocument.body && openingFocus && !openingFocus.isConnected))
    ) {
      const last = focusLastOnReady ? handle.itemElements().at(-1) : undefined;
      if (last) {
        last.focus({ preventScroll: true });
      } else {
        handle.focusFirst();
      }
    }
  };
  const loadContent = () => {
    if (runtime()) {
      return;
    }
    openingFocus = host.ownerDocument.activeElement;
    if (loading) {
      return;
    }
    setContent({ kind: "loading" });
    // Menu requires synchronous entries during native admission; its trigger and
    // loading row stay mounted while the cold entry builders arrive.
    loading = import("./chat-composer-plus-menu-content.tsx")
      .then(
        (module) => {
          if (!disposed) {
            setContent({ kind: "ready", module });
            onSettled(focusLoadedItems);
          }
        },
        (error: unknown) => {
          if (!disposed) {
            setContent({ kind: "error", error });
            onSettled(focusLoadedItems);
          }
        },
      )
      .finally(() => {
        loading = undefined;
      });
  };
  onSettled(() => {
    const stopKeyboard = listen(
      host,
      "keydown",
      (event) => {
        focusOnReady = true;
        focusLastOnReady = event.key === "ArrowUp";
      },
      true,
    );
    const stopClick = listen(
      host,
      "click",
      (event) => {
        focusOnReady = event.detail === 0;
        focusLastOnReady = false;
      },
      true,
    );
    return () => {
      disposed = true;
      stopKeyboard();
      stopClick();
      releaseAnchor();
    };
  });
  const view = createMemo(() => (props.menu.showCapabilities ? props.menu.view : "root"));
  const inputs = createMemo(
    () => {
      const current = view();
      const menu = props.menu;
      const module = runtime();
      return { module, view: current, menu, values: module?.menuRenderInputs(menu, current) ?? [] };
    },
    {
      lazy: true,
      equals: (previous, next) =>
        previous.module === next.module &&
        previous.view === next.view &&
        previous.values.length === next.values.length &&
        previous.values.every((value, index) => Object.is(value, next.values[index])),
    },
  );
  const items = createMemo(
    () => {
      const current = content();
      if (current.kind === "error") {
        return [
          {
            kind: "content",
            id: "plus-menu-error",
            content: (
              <LazyViewError
                error={current.error}
                onRetry={loadContent}
                retryRef={controls.ref()}
                inline
              />
            ),
          },
        ] satisfies MenuEntry[];
      }
      if (current.kind === "loading") {
        return [{ id: "plus-menu-loading", label: t("common.loading"), disabled: true }];
      }
      // Only a changed presentation snapshot recreates owned nodes; actions read live props.
      const { view: selected, menu } = inputs();
      return current.module.menuItems(menu, selected, () => inputs().menu);
    },
    { lazy: true },
  );
  return (
    <div
      ref={(element) => {
        host = element;
      }}
      class="agent-chat__attach-menu agent-chat__capability-menu"
      data-view={view()}
    >
      <Menu
        lazy
        id={`chat-composer-plus-${id}`}
        panelClass="agent-chat__capability-menu-panel"
        placement="top-start"
        pointerFocus="trigger"
        label={t("chat.composer.addAttachment")}
        open={props.menu.open}
        disabled={props.menu.disabled}
        triggerClass={[
          "agent-chat__input-btn agent-chat__input-btn--attach",
          {
            "agent-chat__input-btn--has-overrides":
              countSessionToolOverrides(props.menu.toolOverrides) > 0,
          },
        ]}
        triggerAttributes={{ title: t("chat.composer.addAttachment") }}
        trigger={<Icon name="plus" />}
        items={items()}
        controls={controls}
        ref={(next) => {
          handle = next;
          releaseAnchor();
          releaseAnchor = props.menu.inputHandle.bindAnchor(next.overlay.trigger);
        }}
        onSelect={(item, event) => runtime()?.handleMenuSelection(item, event, handle, props)}
        onNavigate={({ value }) =>
          props.menu.onNavigate(value === "manage-skills" ? "skills" : "plugins")
        }
        onOpenChange={(open) => {
          host.toggleAttribute("open", open);
          if (open) {
            loadContent();
            props.menu.onLoadSkills();
          } else {
            focusOnReady = false;
            openingFocus = undefined;
          }
          if (open !== props.menu.open) {
            props.menu.onOpenChange(open);
          }
        }}
      />
    </div>
  );
}

export function ChatComposerPlusMenu(props: { menu: ChatComposerPlusMenuProps }) {
  // Reconnects can replace the capability owner while this menu stays open.
  createEffect(
    () => ({
      open: props.menu.open,
      view: props.menu.view,
      load: props.menu.capabilityMenu?.onLoadView,
    }),
    ({ open, view, load }) => {
      if (open) {
        load?.(view);
      }
    },
  );
  const resolved = createMemo(() => {
    const current = props.menu;
    const capabilityMenu = current.capabilityMenu;
    if (
      !capabilityMenu &&
      !current.rootToggles?.length &&
      !uploadsEnabled(current.attachments.uploadConfig)
    ) {
      return null;
    }
    return {
      ...current,
      ...capabilityMenu,
      showCapabilities: capabilityMenu !== undefined,
      basePath: capabilityMenu?.basePath ?? "",
      skills: capabilityMenu?.skills ?? null,
      skillsRead: capabilityMenu?.skillsRead ?? null,
      mcpServers: capabilityMenu?.mcpServers ?? [],
      toolsEffectiveResult: capabilityMenu?.toolsEffectiveResult ?? null,
      toolsEffectiveLoading: capabilityMenu?.toolsEffectiveLoading ?? false,
      toolsEffectiveError: capabilityMenu?.toolsEffectiveError ?? false,
      toolAccessMutationBlockedReason: capabilityMenu?.toolAccessMutationBlockedReason ?? null,
      webSearchBaseEnabled: capabilityMenu?.webSearchBaseEnabled ?? true,
      mutationBlockedReason: capabilityMenu?.mutationBlockedReason ?? null,
      canAdmin: capabilityMenu?.canAdmin ?? false,
      adminBlockedReason: capabilityMenu?.adminBlockedReason ?? null,
      onLoadSkills: capabilityMenu?.onLoadSkills ?? (() => {}),
      onPatchToolOverrides: capabilityMenu?.onPatchToolOverrides ?? (() => {}),
      onNavigate: capabilityMenu?.onNavigate ?? (() => {}),
    };
  });
  return <Show when={resolved()}>{(menu) => <PlusMenuSurface menu={menu()} />}</Show>;
}
