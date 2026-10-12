import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type {
  SessionDiscussionInfo,
  SessionDiscussionState,
} from "../../../../../packages/gateway-protocol/src/index.js";
import { renderPanelLoadingSkeleton } from "../../../components/panel-loading-skeleton.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelEmptyState } from "../../../components/solid/panel-empty-state.tsx";
import { formatUiError } from "../../../lib/format-error.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { buildWidgetThemeMessage, postWidgetTheme } from "../../../lib/widget-theme.ts";
import {
  defineSolidBridge,
  LitContent,
  type SolidBridgeElement,
} from "../../../lit/solid-bridge.ts";

type SessionDiscussionInfoLoader = (sessionKey: string) => Promise<SessionDiscussionInfo>;
type SessionDiscussionStateListener = (
  sessionKey: string,
  discussionState: SessionDiscussionState,
  openUrl: string | null,
) => void;
export type SessionDiscussionPanelConfig = {
  sessionKey: string;
  canOpen: boolean;
  openUrl: string | null;
  loadInfo: SessionDiscussionInfoLoader;
  openDiscussion: SessionDiscussionInfoLoader;
  onStateChange: SessionDiscussionStateListener;
};
type DiscussionProps = {
  sessionKey: string;
  loadInfo: SessionDiscussionInfoLoader | null;
  openDiscussion: SessionDiscussionInfoLoader | null;
  onStateChange: SessionDiscussionStateListener | null;
  canOpen: boolean;
  sourceGeneration: number;
};
type DiscussionState =
  | { status: "empty" | "loading" | "opening" }
  | { status: "complete"; info: SessionDiscussionInfo }
  | { status: "error"; error: unknown };

function resolveDiscussionUrl(value: string | undefined): string | null {
  const url = value ? URL.parse(value) : null;
  return url && (url.protocol === "https:" || url.protocol === "http:") ? url.href : null;
}

// The frame runs with allow-scripts + allow-same-origin (cookies must flow for
// the discussion app's session). A same-origin src would therefore inherit THIS
// app's origin and could reach the parent DOM and gateway credentials — reject
// it; cross-origin same-site hosts (the supported topology) pass.
function resolveDiscussionEmbedUrl(value: string | undefined): string | null {
  const resolved = resolveDiscussionUrl(value);
  if (!resolved) {
    return null;
  }
  const url = new URL(resolved);
  if (url.origin === window.location.origin) {
    return null;
  }
  if (
    url.searchParams.get("openclawHostTheme") !== "1" ||
    !/^\/embed\/(?:channel|thread)\/[^/]+\/[^/]+\/?$/u.test(url.pathname)
  ) {
    // Provider-issued and signed discussion URLs are opaque. Only ClickClack's
    // documented embed routes support the first-paint theme query contract.
    return url.href;
  }
  // The initial URL protects the first paint; hostOrigin binds subsequent
  // full-palette messages to this exact Control UI parent.
  url.searchParams.set(
    "theme",
    document.documentElement.dataset.themeMode === "light" ? "light" : "dark",
  );
  url.searchParams.set("hostOrigin", window.location.origin);
  const themeTokens = buildWidgetThemeMessage().tokens;
  if (Object.keys(themeTokens).length > 0) {
    url.searchParams.set("themeTokens", JSON.stringify(themeTokens));
  }
  return url.href;
}

function DiscussionPanel(props: DiscussionProps, host: SolidBridgeElement<DiscussionProps>) {
  const [state, setState] = createSignal<DiscussionState>({ status: "empty" });
  const request = createMemo(
    () =>
      [
        props.sessionKey.trim(),
        props.loadInfo,
        props.openDiscussion,
        props.sourceGeneration,
        props.canOpen,
      ] as const,
    { equals: (before, after) => before.every((value, index) => value === after[index]) },
  );
  createEffect(request, ([sessionKey, loader, opener, generation, canOpen]) => {
    let active = true;
    const isCurrent = () =>
      active &&
      host.isConnected &&
      sessionKey === host.sessionKey.trim() &&
      loader === host.loadInfo &&
      opener === host.openDiscussion &&
      generation === host.sourceGeneration &&
      canOpen === host.canOpen;
    if (!loader || !sessionKey) {
      setState({ status: "empty" });
      return undefined;
    }
    setState({ status: "loading" });
    void (async () => {
      try {
        let info = await loader(sessionKey);
        if (!isCurrent()) {
          return;
        }
        if (info.state === "available" && canOpen && opener) {
          setState({ status: "opening" });
          host.onStateChange?.(sessionKey, info.state, resolveDiscussionUrl(info.openUrl));
          if (!isCurrent()) {
            return;
          }
          info = (await opener(sessionKey)) ?? info;
        }
        if (!isCurrent()) {
          return;
        }
        setState({ status: "complete", info });
        host.onStateChange?.(sessionKey, info.state, resolveDiscussionUrl(info.openUrl));
      } catch (error) {
        if (isCurrent()) {
          setState({ status: "error", error });
        }
      }
    })();
    return () => {
      active = false;
    };
  });
  const postTheme = (
    frame = host.querySelector<HTMLIFrameElement>(".session-discussion__frame"),
  ) => {
    if (frame?.isConnected) {
      postWidgetTheme(frame, new URL(frame.src).origin);
    }
  };
  const observer = new MutationObserver(() => postTheme());
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-theme-mode", "style"],
  });
  onCleanup(() => observer.disconnect());
  const empty = (description: string, openUrl?: string | null) => (
    <PanelEmptyState
      icon={<Icon name="messageSquare" />}
      heading={t("chat.sidePanel.discussion")}
      description={description}
      action={
        openUrl ? (
          <a class="session-link" href={openUrl} target="_blank" rel="noopener">
            {t("chat.sessionDiscussion.openExternal")}
          </a>
        ) : undefined
      }
    />
  );
  const renderState = () => {
    const current = state();
    if (current.status === "loading" || current.status === "opening") {
      return (
        <LitContent
          render={() =>
            renderPanelLoadingSkeleton(
              "discussion",
              t(
                state().status === "opening"
                  ? "chat.sessionDiscussion.opening"
                  : "chat.sessionDiscussion.loading",
              ),
            )
          }
        />
      );
    }
    if (current.status === "error") {
      return (
        <div class="session-discussion__empty">
          <div class="callout danger">{formatUiError(current.error)}</div>
        </div>
      );
    }
    if (current.status !== "complete" || current.info.state === "none") {
      return null;
    }
    if (current.info.state === "available") {
      return empty(
        t(
          props.canOpen
            ? "chat.sessionDiscussion.unavailable"
            : "chat.sessionDiscussion.requiresWriteAccess",
        ),
      );
    }
    const embedUrl = resolveDiscussionEmbedUrl(current.info.embedUrl);
    return (
      <div class="session-discussion__open">
        {embedUrl ? (
          <iframe
            class="session-discussion__frame"
            src={embedUrl}
            title={t("chat.sessionDiscussion.frameTitle")}
            sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
            onLoad={(event) => postTheme(event.currentTarget)}
          />
        ) : (
          empty(t("chat.sessionDiscussion.unavailable"), resolveDiscussionUrl(current.info.openUrl))
        )}
      </div>
    );
  };
  return <>{renderState()}</>;
}

export const SessionDiscussionPanel = defineSolidBridge<DiscussionProps>(
  "openclaw-session-discussion",
  DiscussionPanel,
  {
    properties: {
      sessionKey: { default: "" },
      loadInfo: { default: null, attribute: false },
      openDiscussion: { default: null, attribute: false },
      onStateChange: { default: null, attribute: false },
      canOpen: { default: true },
      sourceGeneration: { default: 0 },
    },
  },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-session-discussion": SolidBridgeElement<DiscussionProps>;
  }
}
