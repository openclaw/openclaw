import type { JSX } from "@solidjs/web";
import { createUniqueId, Errored, lazy, Loading, onSettled, Show } from "solid-js";
import { PersonAvatarLink } from "../../../components/person-activity-link-solid.tsx";
import { personActivityLink } from "../../../components/person-activity-link.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import {
  createMenuControls,
  Menu,
  type MenuControls,
  type MenuEntry,
  type MenuHandle,
} from "../../../components/solid/menu.tsx";
import { SessionOwnerChip } from "../../../components/solid/session-owner-chip.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import type { ChatHeaderSharingSnapshot } from "../chat-header-viewers-snapshot.ts";
import {
  type ChatSessionSharingProps,
  VISIBILITY_LABEL_KEYS,
  canManageChatSessionSharing,
  ChatSessionSharingModeIcon,
} from "./chat-session-sharing-shared.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

function SharingTrigger(props: {
  visibility: Exclude<ChatHeaderSharingSnapshot, "public">;
  published: boolean;
}) {
  return (
    <>
      <span class="chat-pane__sharing-trigger-state">
        <Show
          when={props.published}
          fallback={<ChatSessionSharingModeIcon visibility={props.visibility} external />}
        >
          <Icon name="globe" />
        </Show>
        <Show when={props.published || props.visibility !== "shared"}>
          <span>
            {t(
              props.published
                ? "chat.sessionSharing.publicIndicator"
                : VISIBILITY_LABEL_KEYS[props.visibility],
            )}
          </span>
        </Show>
      </span>
      <Icon name="chevronDown" class="chat-pane__sharing-chevron" />
    </>
  );
}

export function ChatSessionSharingPlaceholder(props: { display: ChatHeaderSharingSnapshot }) {
  return (
    <div class="chat-pane__sharing-menu chat-pane__sharing-menu--desktop" aria-hidden="true" inert>
      <span class="btn chat-pane__sharing-trigger">
        <SharingTrigger
          visibility={props.display === "public" ? "shared" : props.display}
          published={props.display === "public"}
        />
      </span>
    </div>
  );
}

const Content = lazy(() => import("./chat-session-sharing-content.tsx"), {
  export: "ChatSessionSharingContent",
});
type SharingHandlers = {
  items(): readonly MenuEntry[];
  select(value: string): Promise<void>;
  onOpenChange(open: boolean): void;
  onEscape(): boolean;
};
export type ChatSessionSharingContentProps = {
  sharing: ChatSessionSharingProps;
  controls: MenuControls;
  readMenu: () => MenuHandle | undefined;
  onReady: (handlers: SharingHandlers | undefined) => void;
  renderItems: (items: () => readonly MenuEntry[]) => JSX.Element;
};

export function ChatSessionSharing(props: ChatSessionSharingProps) {
  const id = createUniqueId();
  const controls = createMenuControls();
  let sharing: SharingHandlers | undefined;
  let menu: MenuHandle | undefined;
  let openingFocus: Element | null | undefined;
  let focusLast = false;
  let stopKeyboard: (() => void) | undefined;
  const focusReady = () => {
    if (!menu?.overlay.open) {
      return;
    }
    const active = menu.overlay.surface.ownerDocument.activeElement;
    if (
      active === openingFocus ||
      active === menu.overlay.surface ||
      (active === menu.overlay.surface.ownerDocument.body &&
        openingFocus &&
        !openingFocus.isConnected)
    ) {
      const last = focusLast ? menu.itemElements().at(-1) : undefined;
      if (last) {
        last.focus({ preventScroll: true });
      } else {
        menu.focusFirst();
      }
    }
  };
  onSettled(() => () => stopKeyboard?.());
  const items: MenuEntry[] = [
    {
      kind: "group",
      id: "sharing-content",
      get items() {
        return sharing?.items() ?? [];
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
              { id: "sharing-loading", label: t("common.loading"), disabled: true },
            ])}
          >
            <Content
              sharing={props}
              controls={controls}
              readMenu={() => menu}
              onReady={(next) => {
                sharing = next;
                if (next && menu?.overlay.open) {
                  focusReady();
                }
              }}
              renderItems={renderItems}
            />
          </Loading>
        </Errored>
      ),
    },
  ];
  const visibility = () => props.session?.visibility ?? "shared";
  const owner = () => props.state?.result?.owner ?? props.session?.owner?.actor;
  const canManage = () => props.session && canManageChatSessionSharing(props.session);
  const published = () =>
    props.state?.result ? Boolean(props.state.result.publicShare) : props.cachedPublished === true;
  return (
    <Show when={props.session}>
      <Show
        when={canManage()}
        fallback={
          <Show when={visibility() === "draft"}>
            <Show when={props.showOwner && owner()}>
              {(person) => (
                <PersonAvatarLink
                  standalone
                  link={personActivityLink(
                    person().identity?.type === "profile" ? person().identity?.id : undefined,
                    props.personActivity,
                    person().label,
                  )}
                >
                  <SessionOwnerChip
                    owner={person()}
                    size="header"
                    attribution="owned"
                    viewingNow={props.ownerViewing}
                  />
                </PersonAvatarLink>
              )}
            </Show>
            <span class="chat-pane__draft-indicator" title={t("chat.sessionSharing.draft")}>
              <ChatSessionSharingModeIcon visibility="draft" />
            </span>
          </Show>
        }
      >
        <Menu
          controls={controls}
          lazy
          id={id}
          ref={(handle) => {
            menu = handle;
            stopKeyboard?.();
            if (handle.overlay.trigger) {
              stopKeyboard = listen(
                handle.overlay.trigger,
                "keydown",
                (event) => {
                  if (!handle.overlay.open) {
                    focusLast = event.key === "ArrowUp";
                  }
                },
                true,
              );
            }
          }}
          class="chat-pane__sharing-menu chat-pane__sharing-menu--desktop"
          panelClass="session-menu chat-pane__sharing-panel"
          label={t("chat.sessionSharing.menu")}
          placement="bottom-end"
          disabled={Boolean(props.openDisabledReason)}
          triggerClass="btn chat-pane__sharing-trigger"
          triggerAttributes={{
            "data-public": published() ? "true" : "false",
            title:
              props.openDisabledReason ??
              (published()
                ? t("chat.sessionSharing.worldReadable")
                : t("chat.sessionSharing.current", {
                    visibility: t(VISIBILITY_LABEL_KEYS[visibility()]),
                  })),
          }}
          trigger={<SharingTrigger visibility={visibility()} published={published()} />}
          items={items}
          onBeforeShow={() => {
            openingFocus = menu?.overlay.surface.ownerDocument.activeElement;
            if (!props.openDisabledReason) {
              props.onOpen();
            }
          }}
          onSelect={(item) => void sharing?.select(item.id)}
          onOpenChange={(open) => {
            sharing?.onOpenChange(open);
            if (!open) {
              openingFocus = undefined;
              focusLast = false;
            }
          }}
          onEscape={() => sharing?.onEscape() ?? false}
        />
      </Show>
    </Show>
  );
}
