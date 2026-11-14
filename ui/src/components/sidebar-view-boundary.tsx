import { Errored, Loading, onSettled, Repeat, type ParentProps } from "solid-js";
import { finishBootFrame } from "../app/boot-composer.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../app/stale-chunk-reload.ts";
import { t } from "../lib/reactive/i18n.ts";
import { InlineAlert } from "./solid/inline-alert.tsx";

function SidebarViewError(props: { error: unknown; reset: () => void }) {
  onSettled(() => finishBootFrame());
  let active = true;
  onSettled(() => () => {
    active = false;
  });
  return (
    <InlineAlert tone="danger" class="sidebar-view-loading sidebar-session-error" role="alert">
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
    </InlineAlert>
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
