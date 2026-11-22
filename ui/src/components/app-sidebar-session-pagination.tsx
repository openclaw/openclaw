import { createMemo, createSignal } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { createIntersectionObserver } from "../lib/reactive/observers.ts";
import type {
  RenderableSessionSection,
  SidebarSessionListHost,
} from "./app-sidebar-session-render-types.ts";
import { SIDEBAR_SESSION_PAGE_SIZE } from "./app-sidebar-session-types.ts";

/** Whether a container holding the element has been scrolled. */
function scrolled(element: Element): boolean {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.scrollTop > 0) {
      return true;
    }
  }
  return false;
}

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
  const showMore = () =>
    host().setVisibleSessionLimit(section().id, section().visibleLimit + SIDEBAR_SESSION_PAGE_SIZE);
  const [end, setEnd] = createSignal<HTMLDivElement>();
  // One page per entry into view: the end has to leave and come back before the
  // next page, so rows that land off-screen never loop. Only a scrolled list
  // continues: an end that shows on mount or as the drawer opens keeps the first
  // page. Show more stays as the manual and keyboard path.
  createIntersectionObserver(
    () => {
      const target = end();
      return target && section().continuesOnScroll ? [target] : [];
    },
    (entries) => {
      if (
        section().continuesOnScroll &&
        entries.some((entry) => entry.isIntersecting && scrolled(entry.target)) &&
        canShowMore()
      ) {
        showMore();
      }
    },
  );
  return (
    <div ref={setEnd} class="sidebar-session-pagination">
      {canShowMore() ? (
        <button
          type="button"
          class="sidebar-session-pagination__button"
          aria-label={t("chat.selectors.loadMoreSessions")}
          onClick={showMore}
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
            host().resetVisibleSessionLimit(section().id);
          }}
        >
          {t("usage.details.collapse")}
        </button>
      ) : undefined}
    </div>
  );
}
