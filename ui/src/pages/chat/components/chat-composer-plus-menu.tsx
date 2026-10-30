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
import { warmWhenIdle } from "../../../lib/idle-warmup.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { countSessionToolOverrides } from "../../../lib/sessions/tool-overrides.ts";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import type {
  ChatComposerPlusMenuHandlers,
  ChatComposerPlusMenuProps,
} from "./chat-composer-plus-menu.types.ts";

registerEnglishCatalog(registerChatComposerEnglish);

function PlusMenuSurface(props: { menu: ChatComposerPlusMenuProps }) {
  const Content = lazy(() => import("./chat-composer-plus-menu-content.tsx"), {
    export: "ChatComposerPlusMenuContent",
  });
  // Each surface owns its lazy component; warming only the module still commits
  // one loading row on that surface's first open.
  warmWhenIdle(Content.preload);
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
  const view = createMemo(() => (props.menu.capabilityMenu ? props.menu.view : "root"));
  // Native opening validates a row before the controlled open prop settles.
  const loadingItems = (): MenuEntry[] => [
    { id: "plus-menu-loading", label: t("common.loading"), disabled: true },
  ];
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
          <Loading fallback={renderItems(loadingItems)}>
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
        onNavigate={({ value }) => handlers()?.navigate(value)}
        onBeforeShow={() => {
          openingFocus = host.ownerDocument.activeElement;
        }}
        onOpenChange={(open) => {
          host.toggleAttribute("open", open);
          if (open && handlers()) {
            props.menu.capabilityMenu?.read()?.onLoadSkills();
          } else if (!open) {
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
  createEffect(
    () => ({
      open: props.menu.open,
      view: props.menu.view,
      source: props.menu.capabilityMenu,
    }),
    ({ open, view, source }) => {
      if (open) {
        source?.read()?.onLoadView?.(view);
      }
    },
  );
  const available = createMemo(() =>
    Boolean(
      props.menu.capabilityMenu ||
      props.menu.rootToggles?.length ||
      uploadsEnabled(props.menu.attachments.uploadConfig),
    ),
  );
  return (
    <Show when={available()}>
      <PlusMenuSurface menu={props.menu} />
    </Show>
  );
}
