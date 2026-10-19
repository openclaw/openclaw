import { children, onSettled, Show, type Element } from "solid-js";
import { NAV_DRAWER_TOGGLE_REGISTRATION } from "../../../app/navigation-surface.ts";
import { createRouteElementRef } from "../../../app/route-element-ref.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { SessionTitlePlaceholder } from "../../../components/solid/session-title-placeholder.tsx";
import "../../../components/tooltip.ts";
import type { GatewayStatus } from "../../../lib/gateway-status.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  ChatSessionPublicIndicator,
  type ChatSessionSharingProps,
} from "./chat-session-sharing.solid.tsx";
import "./chat-pane-mobile-header.css";

type ChatPaneMobileHeaderNotice =
  | { kind: "gateway"; status: GatewayStatus; onRetry?: () => void }
  | {
      kind: "device-offline";
      deviceName: string;
      onOpenMachine: (source: HTMLElement) => void;
    };

export type ChatPaneMobileHeaderProps = {
  active?: boolean;
  onHeaderRef?: (element: HTMLElement) => void | (() => void);
  title: string;
  titlePending?: boolean;
  /** Mobile ProjectCrumb: menu, full accessible name and overflow fade. */
  project?: Element;
  publicAccess?: Pick<ChatSessionSharingProps, "state">;
  incognito?: boolean;
  navDrawerOpen: boolean;
  onToggleNavigation: (source: HTMLElement) => void;
  onOpenDetails: (source: HTMLElement) => void;
  onOpenPanels: (source: HTMLElement) => void;
  panelsOpen: boolean;
  /** Supplied navigation glyphs, rendered at 20px. */
  navigationIcon: Element;
  panelsIcon: Element;
  /** The People control owns its trigger, presence facts and expanded action. */
  people?: Element;
  /** Native menu trigger; the owner omits it while disconnected/reconnecting. */
  actions?: Element;
  /** Supply only for an available session Dashboard; opens/reuses its destination. */
  onOpenDashboard?: (source: HTMLElement) => void;
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
  const project = children(() => props.project);
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
      <Show when={props.active !== false ? props.onHeaderRef : undefined} keyed>
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
          {props.navigationIcon}
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
        <Show
          when={project()}
          fallback={
            <Show when={props.publicAccess}>
              {(access) => <ChatSessionPublicIndicator {...access()} mobile />}
            </Show>
          }
        >
          <div class="mobile-header__project">{project()}</div>
        </Show>
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
          <Show when={project() ? props.publicAccess : undefined}>
            {(access) => <ChatSessionPublicIndicator {...access()} mobile />}
          </Show>
        </div>
      </div>
      <Show when={props.people}>
        {(people) => <div class="mobile-header__people">{people()}</div>}
      </Show>
      <div class="mobile-header__capsule">
        <Show when={props.onOpenDashboard}>
          <button
            type="button"
            class="mobile-header__control mobile-header__dashboard"
            aria-label={t("pluginUi.dashboardTitle")}
            onClick={(event) => props.onOpenDashboard?.(event.currentTarget)}
          >
            <Icon name="layoutDashboard" />
          </button>
        </Show>
        <button
          type="button"
          class="mobile-header__control"
          aria-label={t("chat.sessionHeader.panels")}
          aria-expanded={props.panelsOpen ? "true" : "false"}
          onClick={(event) => props.onOpenPanels(event.currentTarget)}
        >
          <span class="mobile-header__glyph" aria-hidden="true">
            {props.panelsIcon}
          </span>
        </button>
        <Show when={props.actions}>
          {(actions) => <div class="mobile-header__actions">{actions()}</div>}
        </Show>
      </div>
      <Show when={props.notice}>{(notice) => <MobileHeaderNotice notice={notice()} />}</Show>
    </div>
  );
}
