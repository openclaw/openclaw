import type { JSX as SolidJSX } from "@solidjs/web";
import { onSettled, Repeat, Show } from "solid-js";
import { bootComposerElement, settleBootComposer } from "../../app/boot-composer.ts";
import { beginNativeWindowDrag } from "../../app/native-window-drag.ts";
import { t } from "../../lib/reactive/i18n.ts";

// Every chat loading frame shows the document's one boot composer in its
// composer slot, so typing continues across frames until the chat pane adopts it.
function BootComposer() {
  const textarea = bootComposerElement();
  onSettled(settleBootComposer);
  return (
    <div class="skeleton loading-skeleton__composer" aria-hidden={textarea ? undefined : "true"}>
      {textarea}
    </div>
  );
}

export function LoadingSkeleton(
  props: {
    messagesOnly?: boolean;
    composer?: boolean;
    renderContent?: () => SolidJSX.Element;
  } = {},
) {
  return (
    <div class="loading-skeleton">
      <Show when={!props.messagesOnly}>
        <div class="loading-skeleton__header" aria-hidden="true">
          <div class="skeleton loading-skeleton__avatar" />
          <div class="skeleton skeleton-line loading-skeleton__title" />
        </div>
      </Show>
      <div
        class={[
          "loading-skeleton__messages",
          { "loading-skeleton__messages--interactive": Boolean(props.renderContent) },
        ]}
        aria-hidden={props.renderContent ? undefined : "true"}
        onMouseDown={(event) => {
          if (props.renderContent) {
            event.stopPropagation();
          }
        }}
      >
        {props.renderContent ? (
          props.renderContent()
        ) : (
          <>
            <div class="loading-skeleton__message loading-skeleton__message--user">
              <div class="skeleton skeleton-line" />
              <div class="skeleton skeleton-line skeleton-line--medium" />
            </div>
            <div class="loading-skeleton__message">
              <div class="skeleton loading-skeleton__avatar" />
              <div class="skeleton skeleton-line" />
              <div class="skeleton skeleton-line--long" />
              <div class="skeleton skeleton-line--medium" />
            </div>
          </>
        )}
      </div>
      <Show when={!props.messagesOnly}>
        <Show
          when={props.composer}
          fallback={<div class="skeleton loading-skeleton__composer" aria-hidden="true" />}
        >
          <BootComposer />
        </Show>
      </Show>
    </div>
  );
}

export function ConnectingSplash(props: {
  status?: string;
  renderContent?: () => SolidJSX.Element;
}) {
  const basePath = document.documentElement.dataset.openclawControlUiBasePath ?? "";
  const pathname = location.pathname.slice(basePath.length) || "/";
  // The document's inline boot frame uses this same data-free route selection.
  const route = /^\/new\/?$/.test(pathname)
    ? "new"
    : /^\/(?:settings\/)?sessions\/?$/.test(pathname)
      ? "sessions"
      : /^\/(?:automations|cron)\/?$/.test(pathname)
        ? "cron"
        : /^\/settings(?:\/|$)/.test(pathname)
          ? "settings"
          : /^\/chat(?:\/|$)/.test(pathname) && !new URLSearchParams(location.search).has("catalog")
            ? "chat"
            : "other";
  return (
    <main
      class="connect-splash connect-splash--skeleton"
      data-route={route}
      data-chat={route === "chat" ? "" : undefined}
      role="status"
      aria-live="polite"
      aria-label={props.status ?? t("common.loading")}
    >
      <div class="connect-splash__layout" onMouseDown={beginNativeWindowDrag}>
        <aside class="connect-splash__sidebar" aria-hidden="true">
          <div class="skeleton loading-skeleton__avatar" />
          <div class="skeleton connect-splash__new-session" />
          <Repeat count={6}>{() => <div class="skeleton skeleton-line" />}</Repeat>
        </aside>
        <div class="connect-splash__main">
          <LoadingSkeleton composer={route === "chat"} renderContent={props.renderContent} />
          <Show when={!props.renderContent}>
            <span
              class="connect-splash__status"
              aria-hidden="true"
              onMouseDown={(event) => event.stopPropagation()}
            >
              {props.status ?? t("common.loading")}
            </span>
          </Show>
        </div>
      </div>
    </main>
  );
}
