import { onSettled, Show, type Element } from "solid-js";
import { NAV_DRAWER_TOGGLE_REGISTRATION } from "../../../app/navigation-surface.ts";
import { createRouteElementRef } from "../../../app/route-element-ref.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { SessionTitlePlaceholder } from "../../../components/solid/session-title-placeholder.tsx";
import "../../../components/tooltip.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import type { GatewayStatus } from "../../../lib/gateway-status.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import "./chat-pane-mobile-header.css";
import {
  ChatSessionPublicIndicator,
  type ChatSessionSharingProps,
} from "./chat-session-sharing-shared.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

type ChatPaneMobileHeaderNotice =
  | { kind: "gateway"; status: GatewayStatus; onRetry?: () => void }
  | {
      kind: "device-offline";
      deviceName: string;
      onOpenMachine: (source: HTMLElement) => void;
    };

export type ChatPaneMobileHeaderProps = {
  active: boolean;
  onHeaderRef?: (element: HTMLElement) => void | (() => void);
  title: string;
  titlePending: boolean;
  publicAccess?: Pick<ChatSessionSharingProps, "state">;
  incognito: boolean;
  navDrawerOpen: boolean;
  onToggleNavigation: (source: HTMLElement) => void;
  onOpenDetails: (source: HTMLElement) => void;
  /** Native menu trigger; local navigation remains available while disconnected. */
  actions?: Element;
  /** One owner-selected notice: Gateway status takes priority over device offline. */
  notice?: ChatPaneMobileHeaderNotice;
};

function MobileHeaderNotice(props: { notice: ChatPaneMobileHeaderNotice }) {
  return (
    <div
      class="mobile-header__notices"
      role={props.notice.kind === "device-offline" ? "status" : undefined}
      aria-live={props.notice.kind === "device-offline" ? "polite" : undefined}
    >
      <Show when={props.notice.kind === "device-offline" ? props.notice : undefined}>
        {(notice) => (
          <button
            type="button"
            class="mobile-header__notice mobile-header__machine"
            onClick={(event) => notice().onOpenMachine(event.currentTarget)}
          >
            <Icon name="monitor" />
            <span class="mobile-header__device-name">{notice().deviceName}</span>
            <span>{t("common.offline")}</span>
            <Icon name="chevronRight" />
          </button>
        )}
      </Show>
      <Show when={props.notice.kind === "gateway" ? props.notice : undefined}>
        {(notice) => (
          <span class="mobile-header__notice">
            <Show when={notice().status !== "offline" && notice().status !== "reload-required"}>
              <Icon
                name={
                  notice().status === "suspended" || notice().status === "suspending"
                    ? "pause"
                    : "loader"
                }
                class={
                  notice().status === "suspended" || notice().status === "suspending"
                    ? undefined
                    : "mobile-header__spinner"
                }
              />
            </Show>
            <span>{t(`connection.${notice().status}`)}</span>
            <Show when={notice().status === "offline" && notice().onRetry}>
              <span class="mobile-header__notice-divider" aria-hidden="true" />
              <button
                type="button"
                class="mobile-header__retry"
                aria-label={t("connection.retryNow")}
                onClick={() => notice().onRetry?.()}
              >
                {t("common.retry")}
              </button>
            </Show>
          </span>
        )}
      </Show>
    </div>
  );
}

export function ChatPaneMobileHeader(props: ChatPaneMobileHeaderProps) {
  let header!: HTMLDivElement;
  const drawerRef = createRouteElementRef(NAV_DRAWER_TOGGLE_REGISTRATION);
  const titleOverflow = useScrollState(true, false);
  const drawerLabel = () => (props.navDrawerOpen ? t("nav.collapse") : t("nav.expand"));
  return (
    <div
      ref={(element) => (header = element)}
      class={["agent-chat__header--mobile", { "mobile-header--incognito": props.incognito }]}
      role="group"
      aria-label={props.title}
      tabindex={-1}
    >
      {/* Header registration follows the active layout without remounting its DOM. */}
      <Show when={props.active ? props.onHeaderRef : undefined} keyed>
        {(register) => {
          onSettled(() => register(header));
          return undefined;
        }}
      </Show>
      <button
        ref={drawerRef}
        type="button"
        class="mobile-header__control mobile-header__navigation"
        aria-label={drawerLabel()}
        aria-expanded={props.navDrawerOpen ? "true" : "false"}
        onClick={(event) => props.onToggleNavigation(event.currentTarget)}
      >
        <span class="mobile-header__glyph" aria-hidden="true">
          <Icon name="sessionMenu" />
        </span>
      </button>
      <Show when={props.incognito}>
        <openclaw-tooltip
          prop:content={t("sessionsView.incognitoDescription")}
          placement="bottom"
          prop:openOnClick={true}
        >
          <button
            type="button"
            class="mobile-header__control mobile-header__incognito"
            aria-label={t("sessionsView.incognitoLabel")}
          >
            <Icon name="incognito" />
          </button>
        </openclaw-tooltip>
      </Show>
      <div class="mobile-header__identity">
        <div class="mobile-header__title-row">
          <button
            type="button"
            class="mobile-header__title"
            aria-label={`${props.title} — ${t("chat.details")}`}
            onClick={(event) => props.onOpenDetails(event.currentTarget)}
          >
            <span class="mobile-header__title-text" ref={titleOverflow}>
              <Show when={!props.titlePending} fallback={<SessionTitlePlaceholder />}>
                {props.title}
              </Show>
            </span>
          </button>
          <Show when={props.publicAccess}>
            {(access) => <ChatSessionPublicIndicator {...access()} mobile />}
          </Show>
        </div>
      </div>
      <Show when={props.actions}>
        {(actions) => <div class="mobile-header__actions">{actions()}</div>}
      </Show>
      <Show when={props.notice}>{(notice) => <MobileHeaderNotice notice={notice()} />}</Show>
    </div>
  );
}
