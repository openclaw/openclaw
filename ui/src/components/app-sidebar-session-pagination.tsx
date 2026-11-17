import { createMemo } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import type {
  RenderableSessionSection,
  SidebarSessionListHost,
} from "./app-sidebar-session-render-types.ts";
import {
  SIDEBAR_SESSION_PAGE_SIZE,
  sidebarSessionPagination,
} from "./app-sidebar-session-types.ts";

/** Section paging only reveals rows the roster already holds. Fetching the next
 *  roster page is a list-level action because it feeds every section at once --
 *  bolting it to one section left the others unable to recover missing rows. */
export default function SessionPagination(params: {
  host: SidebarSessionListHost;
  section: RenderableSessionSection;
}) {
  const host = createMemo(() => params.host),
    section = createMemo(() => params.section);
  const canShowMore = createMemo(() => section().visibleRowCount < section().totalRowCount);
  const canShowLess = createMemo(
    () => section().visibleRowCount > section().collapsedVisibleRowCount,
  );
  return (
    <div class="sidebar-session-pagination">
      {canShowMore() ? (
        <button
          type="button"
          class="sidebar-session-pagination__button"
          aria-label={t("chat.selectors.loadMoreSessions")}
          onClick={() => {
            host().setVisibleSessionLimit(
              section().id,
              section().visibleLimit + SIDEBAR_SESSION_PAGE_SIZE,
            );
          }}
        >
          {t("chat.selectors.loadMoreSessions")}
        </button>
      ) : undefined}
      {canShowLess() ? (
        <button
          type="button"
          class="sidebar-session-pagination__button"
          aria-label={t("usage.details.collapse")}
          onClick={() => {
            host().clearSessionSelection();
            // Also drops rows kept from when the section stood alone.
            host().sessionProjection.resetMembership(section().id);
            host().setVisibleSessionLimit(
              section().id,
              sidebarSessionPagination(host().effectiveSessionsGrouping(), section().id)
                .initialLimit,
            );
          }}
        >
          {t("usage.details.collapse")}
        </button>
      ) : undefined}
    </div>
  );
}
