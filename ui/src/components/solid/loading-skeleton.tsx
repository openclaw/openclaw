import { Repeat } from "solid-js";
import { beginNativeWindowDrag } from "../../app/native-window-drag.ts";
import { t } from "../../lib/reactive/i18n.ts";

export function LoadingSkeleton() {
  return (
    <div class="loading-skeleton" aria-hidden="true">
      <div class="loading-skeleton__header">
        <div class="skeleton loading-skeleton__avatar" />
        <div class="skeleton skeleton-line loading-skeleton__title" />
      </div>
      <div class="loading-skeleton__messages">
        <div class="loading-skeleton__message loading-skeleton__message--user">
          <div class="skeleton skeleton-line" />
          <div class="skeleton skeleton-line skeleton-line--medium" />
        </div>
        <div class="loading-skeleton__message">
          <div class="skeleton loading-skeleton__avatar" />
          <div class="skeleton skeleton-line" />
          <div class="skeleton skeleton-line skeleton-line--long" />
          <div class="skeleton skeleton-line skeleton-line--medium" />
        </div>
      </div>
      <div class="skeleton loading-skeleton__composer" />
    </div>
  );
}

export function ConnectingSplash(props: { status?: string }) {
  return (
    <main
      class="connect-splash connect-splash--skeleton"
      data-chat={
        /\/chat(?:\/|$)/.test(location.pathname) &&
        !new URLSearchParams(location.search).has("catalog")
          ? ""
          : undefined
      }
      role="status"
      aria-live="polite"
      aria-label={props.status ?? t("common.loading")}
    >
      <div class="connect-splash__layout" aria-hidden="true" onMouseDown={beginNativeWindowDrag}>
        <aside class="connect-splash__sidebar">
          <div class="skeleton loading-skeleton__avatar" />
          <div class="skeleton connect-splash__new-session" />
          <Repeat count={6}>{() => <div class="skeleton skeleton-line" />}</Repeat>
        </aside>
        <div class="connect-splash__main">
          <LoadingSkeleton />
          <span class="connect-splash__status" onMouseDown={(event) => event.stopPropagation()}>
            {props.status ?? t("common.loading")}
          </span>
        </div>
      </div>
    </main>
  );
}
