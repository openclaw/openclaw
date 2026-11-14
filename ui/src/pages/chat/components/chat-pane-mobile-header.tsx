import { children, onSettled, Show, type Element } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import {
  MobileHeaderNotice,
  type MobileHeaderNoticeContent,
} from "../../../components/solid/mobile-header-notice.tsx";
import { MobileNavToggle } from "../../../components/solid/mobile-nav-toggle.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { SessionTitlePlaceholder } from "../../../components/solid/session-title-placeholder.tsx";
import "../../../components/tooltip.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import "./chat-pane-mobile-header.css";
import {
  ChatSessionPublicIndicator,
  type ChatSessionSharingProps,
} from "./chat-session-sharing-shared.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

export function ChatPaneMobileHeader(props: {
  active: boolean;
  onHeaderRef?: (element: HTMLElement) => void | (() => void);
  title: string;
  titlePending: boolean;
  /** Mobile ProjectCrumb: menu, full accessible name and overflow fade. */
  project?: Element;
  publicAccess?: Pick<ChatSessionSharingProps, "state">;
  incognito: boolean;
  navDrawerOpen: boolean;
  /** Omitted until the Gateway admits the session; its controls render disabled. */
  onOpenDetails?: (source: HTMLElement) => void;
  onOpenPanels?: (source: HTMLElement) => void;
  panelsOpen: boolean;
  compactActions?: boolean;
  /** The People control owns its trigger, presence facts and expanded action. */
  people?: Element;
  /** Native menu trigger; the owner omits it while disconnected/reconnecting. */
  actions?: Element;
  /** A draft has no session controls; its own take their place in the capsule. */
  draftControls?: Element;
  /** Supply only for an available session Dashboard; opens/reuses its destination. */
  onOpenDashboard?: (source: HTMLElement) => void;
  /** One owner-selected notice: Gateway status takes priority over device offline. */
  notice?: MobileHeaderNoticeContent;
}) {
  let header!: HTMLDivElement;
  const project = children(() => props.project);
  const people = children(() => props.people);
  const titleOverflow = useScrollState(true, false);
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
      <MobileNavToggle class="mobile-header__navigation" open={props.navDrawerOpen} />
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
      <div
        class={["mobile-header__identity", { "mobile-header__identity--title-only": !project() }]}
      >
        <div class="mobile-header__title-row">
          <button
            type="button"
            class="mobile-header__title"
            aria-label={`${props.title} — ${t("chat.details")}`}
            disabled={!props.onOpenDetails}
            onClick={(event) => props.onOpenDetails?.(event.currentTarget)}
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
        <Show when={project()}>
          <div class="mobile-header__project">{project()}</div>
        </Show>
      </div>
      <Show when={people()}>
        <div class="mobile-header__people">{people()}</div>
      </Show>
      <div class="mobile-header__capsule">
        <Show when={props.draftControls}>{(controls) => controls()}</Show>
        <Show when={props.onOpenDashboard}>
          <button
            type="button"
            class="mobile-header__control mobile-header__dashboard"
            hidden={props.compactActions}
            style={{ display: props.compactActions ? "none" : undefined }}
            aria-label={t("pluginUi.dashboardTitle")}
            onClick={(event) => props.onOpenDashboard?.(event.currentTarget)}
          >
            <Icon name="layoutDashboard" />
          </button>
        </Show>
        <button
          type="button"
          class="mobile-header__control"
          hidden={props.compactActions}
          style={{ display: props.compactActions ? "none" : undefined }}
          aria-label={t("chat.sessionHeader.panels")}
          aria-expanded={props.panelsOpen ? "true" : "false"}
          disabled={!props.onOpenPanels}
          onClick={(event) => props.onOpenPanels?.(event.currentTarget)}
        >
          <span class="mobile-header__glyph" aria-hidden="true">
            <Icon name="sessionPanels" />
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
