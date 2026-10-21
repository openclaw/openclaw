import { For } from "solid-js";
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
      role="status"
      aria-live="polite"
      aria-label={props.status ?? t("common.loading")}
    >
      <div class="connect-splash__layout" aria-hidden="true" onMouseDown={beginNativeWindowDrag}>
        <aside class="connect-splash__sidebar">
          <div class="skeleton loading-skeleton__avatar" />
          <div class="skeleton connect-splash__new-session" />
          <For each={[85, 65, 75, 55, 80, 60]}>
            {(width) => <div class="skeleton skeleton-line" style={{ width: `${width}%` }} />}
          </For>
        </aside>
        <LoadingSkeleton />
      </div>
      {props.status ? <span class="connect-splash__status">{props.status}</span> : undefined}
    </main>
  );
}
