import { Errored, Loading, onSettled, Repeat, type ParentProps } from "solid-js";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../app/stale-chunk-reload.ts";
import { t } from "../lib/reactive/i18n.ts";

function SidebarViewError(props: { error: unknown; reset: () => void }) {
  let active = true;
  onSettled(() => () => {
    active = false;
  });
  return (
    <div class="sidebar-view-loading sidebar-session-error callout danger" role="alert">
      <span>{t("lazyView.errorTitle")}</span>
      <button
        class="btn btn--sm"
        type="button"
        onClick={() =>
          isStaleChunkImportError(props.error)
            ? void retryStaleChunkReloadWhenReachable({ canReload: () => active })
            : props.reset()
        }
      >
        {t(isStaleChunkImportError(props.error) ? "common.reload" : "common.retry")}
      </button>
    </div>
  );
}

/** The fixed sidebar shell stays mounted while an optional view loads. */
export function SidebarViewBoundary(
  props: ParentProps<{ fallback?: import("@solidjs/web").JSX.Element }>,
) {
  return (
    <Errored fallback={(error, reset) => <SidebarViewError error={error()} reset={reset} />}>
      <Loading
        fallback={
          props.fallback ?? (
            <div
              class="sidebar-view-loading sidebar-recent-sessions__list"
              role="status"
              aria-label={t("common.loading")}
              aria-busy="true"
            >
              <Repeat count={4}>
                {() => (
                  <span
                    class="sidebar-session-tree__loading skeleton skeleton-line"
                    aria-hidden="true"
                  />
                )}
              </Repeat>
            </div>
          )
        }
      >
        {props.children}
      </Loading>
    </Errored>
  );
}
