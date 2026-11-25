import { Show } from "solid-js";
import { COMMAND_PALETTE_OPEN_EVENT } from "../../components/command-palette-contract.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { ChatPaneMobileHeader } from "../chat/components/chat-pane-mobile-header.tsx";
import * as catalog from "./catalog-target.ts";
import {
  NewSessionVisibilityToggles,
  type NewSessionVisibilityControl,
} from "./incognito-control-view.tsx";
import type { NewSessionPageOwner, NewSessionPageProps } from "./new-session-page-owner.ts";

/** Chat's phone header. Draft, incognito and search hold the session controls' place. */
export function DraftMobileHeader(props: {
  page: () => NewSessionPageOwner;
  shell: NewSessionPageProps;
  submission: NewSessionVisibilityControl;
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
      incognito={false}
      navDrawerOpen={props.shell.navDrawerOpen}
      panelsOpen={false}
      compactActions
      notice={notice()}
      draftControls={
        <>
          <Show when={!catalog.isTarget(props.page().data)}>
            <NewSessionVisibilityToggles
              inHeader
              submission={props.submission}
              draftAvailable={props
                .page()
                .submission.capabilities.canStartAsDraft(props.page().context)}
            />
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
