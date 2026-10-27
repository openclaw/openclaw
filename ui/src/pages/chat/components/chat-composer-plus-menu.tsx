import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  Errored,
  lazy,
  Loading,
  onSettled,
  Show,
} from "solid-js";
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
  ChatComposerPlusMenuHandlers,
  ChatComposerPlusMenuProps,
} from "./chat-composer-plus-menu.types.ts";

registerEnglishCatalog(registerChatComposerEnglish);

function PlusMenuSurface(props: { menu: ChatComposerPlusMenuContentProps }) {
  const Content = lazy(() => import("./chat-composer-plus-menu-content.tsx"), {
    export: "ChatComposerPlusMenuContent",
  });
  const controls = createMenuControls();
  let handle!: MenuHandle;
  let host!: HTMLDivElement;
  const id = createUniqueId();
  let releaseAnchor = () => {};
  let disposed = false;
  const [handlers, setHandlers] = createSignal<ChatComposerPlusMenuHandlers>();
  let focusOnReady = false;
  let focusLastOnReady = false;
  let openingFocus: Element | null | undefined;
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
  const items: MenuEntry[] = [
    {
      kind: "group",
      id: "plus-menu-content",
      get items() {
        return handlers()?.items() ?? [];
      },
      render: (renderItems) => (
        <Errored
          fallback={(error, reset) => {
            onSettled(focusLoadedItems);
            return (
              <LazyViewError
                error={error()}
                onRetry={() => {
                  openingFocus = host.ownerDocument.activeElement;
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
              { id: "plus-menu-loading", label: t("common.loading"), disabled: true },
            ])}
          >
            <Content
              menu={props.menu}
              controls={controls}
              view={view()}
              readMenu={() => handle}
              onReady={(next) => {
                setHandlers(next);
                if (next) {
                  onSettled(focusLoadedItems);
                }
              }}
              renderItems={renderItems}
            />
          </Loading>
        </Errored>
      ),
    },
  ];
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
        class="agent-chat__attach-control"
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
        items={items}
        controls={controls}
        ref={(next) => {
          handle = next;
          releaseAnchor();
          releaseAnchor = props.menu.inputHandle.bindAnchor(next.overlay.trigger);
        }}
        onSelect={(item, event) => handlers()?.select(item, event)}
        onNavigate={({ value }) =>
          props.menu.onNavigate(value === "manage-skills" ? "skills" : "plugins")
        }
        onBeforeShow={() => {
          openingFocus = host.ownerDocument.activeElement;
        }}
        onOpenChange={(open) => {
          host.toggleAttribute("open", open);
          if (open) {
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
