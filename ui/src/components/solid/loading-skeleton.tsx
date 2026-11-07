import type { JSX as SolidJSX } from "@solidjs/web";
import { onSettled } from "solid-js";
import {
  bootComposerElement,
  settleBootComposer,
  snapshotBootComposerScroll,
} from "../../app/boot-composer.ts";
import { beginNativeWindowDrag } from "../../app/native-window-drag.ts";
import { t } from "../../lib/reactive/i18n.ts";

// Every chat loading frame shows the document's one boot composer in its
// composer slot, so typing continues across frames until the chat pane adopts it.
function BootComposer() {
  const textarea = bootComposerElement();
  // JSX moves the existing node before the old frame's cleanup can capture it.
  snapshotBootComposerScroll();
  onSettled(() => {
    settleBootComposer();
    return snapshotBootComposerScroll;
  });
  return (
    <div
      class={["loading-skeleton__composer", { skeleton: !textarea }]}
      aria-hidden={textarea ? undefined : "true"}
    >
      {textarea}
    </div>
  );
}

export function LoadingSkeleton(
  props: {
    messagesOnly?: boolean;
    composer?: boolean;
    header?: boolean;
    renderContent?: () => SolidJSX.Element;
  } = {},
) {
  let skeleton: HTMLDivElement;
  onSettled(() => () => {
    // Retire CSS-owned effects before detachment. Script cancel() leaves their
    // native records retained in WebKit; keep the boot composer's geometry intact.
    skeleton.style.setProperty("--skeleton-animation", "none");
    skeleton.getAnimations({ subtree: true });
  });
  return (
    <div ref={(element) => (skeleton = element)} class="loading-skeleton">
      {!props.messagesOnly && props.header !== false ? (
        <div class="loading-skeleton__header" aria-hidden="true">
          <div class="skeleton loading-skeleton__avatar" />
          <div class="skeleton skeleton-line loading-skeleton__title" />
        </div>
      ) : null}
      <div
        class={[
          "loading-skeleton__messages",
          { "loading-skeleton__content": Boolean(props.renderContent) },
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
              <div class="skeleton skeleton-line skeleton-line--long" />
              <div class="skeleton skeleton-line skeleton-line--medium" />
            </div>
          </>
        )}
      </div>
      {!props.messagesOnly ? (
        props.composer ? (
          <BootComposer />
        ) : (
          <div class="skeleton loading-skeleton__composer" aria-hidden="true" />
        )
      ) : null}
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
          <div class="skeleton skeleton-line" />
          <div class="skeleton skeleton-line" />
          <div class="skeleton skeleton-line" />
          <div class="skeleton skeleton-line" />
          <div class="skeleton skeleton-line" />
          <div class="skeleton skeleton-line" />
        </aside>
        <div class="connect-splash__main">
          <LoadingSkeleton composer={route === "chat"} renderContent={props.renderContent} />
          {!props.renderContent ? (
            <span
              class="connect-splash__status"
              aria-hidden="true"
              onMouseDown={(event) => event.stopPropagation()}
            >
              {props.status ?? t("common.loading")}
            </span>
          ) : null}
        </div>
      </div>
    </main>
  );
}
