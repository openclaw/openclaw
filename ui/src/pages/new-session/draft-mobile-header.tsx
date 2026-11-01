import { Show } from "solid-js";
import { COMMAND_PALETTE_OPEN_EVENT } from "../../components/command-palette-contract.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { ContextNewSessionAction } from "../../components/solid/new-session-link.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { ChatPaneMobileHeader } from "../chat/components/chat-pane-mobile-header.tsx";
import type { NewSessionPageOwner, NewSessionPageProps } from "./new-session-page-owner.ts";

/** Chat's phone header; a draft keeps the top bar's actions where the session's will be. */
export function DraftMobileHeader(props: {
  page: () => NewSessionPageOwner;
  shell: NewSessionPageProps;
}) {
  const notice = () => {
    const status = props.shell.gatewayStatus;
    return status?.kind && status.kind !== "connected"
      ? { kind: "gateway" as const, status: status.kind, onRetry: status.onRetry }
      : undefined;
  };
  return (
    <ChatPaneMobileHeader
      active
      title={t("newSession.title")}
      titlePending={false}
      incognito={props.page().submission.visibility === "incognito"}
      navDrawerOpen={props.shell.navDrawerOpen}
      panelsOpen={false}
      compactActions
      notice={notice()}
      draftControls={
        <>
          <Show when={props.page().context}>
            {(context) => (
              <ContextNewSessionAction
                context={context()}
                class="mobile-header__control"
                agentId={props.page().place.agentId || undefined}
                icon="sessionNew"
                showTooltip={false}
              />
            )}
          </Show>
          <button
            type="button"
            class="mobile-header__control mobile-header__search"
            aria-label={t("chat.openCommandPalette")}
            onClick={() => window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT))}
          >
            <Icon name="search" />
          </button>
        </>
      }
    />
  );
}
