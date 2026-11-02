import { Show } from "solid-js";
import type { SessionCatalogSession } from "../../../packages/gateway-protocol/src/index.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { SessionCatalogGroupsParams } from "./app-sidebar-session-render-types.ts";

export const CATALOG_SESSION_GROUP_LIMIT = 5;

export function CatalogPagination(props: {
  host: Pick<SessionCatalogGroupsParams["host"], "sessionData" | "setVisibleSessionLimit">;
  sessions: readonly SessionCatalogSession[];
  sectionId: string;
}) {
  const expanded = () =>
    (props.host.sessionData.visibleSessionLimits.get(props.sectionId) ??
      CATALOG_SESSION_GROUP_LIMIT) > CATALOG_SESSION_GROUP_LIMIT;
  const label = () => (expanded() ? t("chat.messages.showLess") : t("chat.messages.showMore"));
  return (
    <Show when={props.sessions.length > CATALOG_SESSION_GROUP_LIMIT}>
      <div class="sidebar-session-pagination sidebar-session-pagination--catalog">
        <button
          type="button"
          class="sidebar-session-pagination__button"
          aria-label={label()}
          onClick={() =>
            props.host.setVisibleSessionLimit(
              props.sectionId,
              expanded() ? CATALOG_SESSION_GROUP_LIMIT : props.sessions.length,
            )
          }
        >
          {label()}
        </button>
      </div>
    </Show>
  );
}
