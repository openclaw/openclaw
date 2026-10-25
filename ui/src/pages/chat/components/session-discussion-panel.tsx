import {
  Errored,
  Loading,
  Show,
  action,
  affects,
  createMemo,
  createOptimistic,
  onSettled,
  refresh,
} from "solid-js";
import type {
  SessionDiscussionInfo,
  SessionDiscussionState,
} from "../../../../../packages/gateway-protocol/src/index.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelEmptyState } from "../../../components/solid/panel-empty-state.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import {
  buildWidgetThemeMessage,
  postWidgetTheme,
  registerWidgetThemeFrame,
} from "../../../lib/widget-theme.ts";

registerEnglishCatalog(registerChatSessionEnglish);

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
  /** Native shell presentation, independent of the panel's width. */
  presentation?: "desktop" | "mobile";
};
const retireDiscussion = new WeakMap<HTMLElement, () => void>();

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
  const receipt = createMemo(() => ({
    target: request(),
    result: Promise.withResolvers<SessionDiscussionInfo | null>(),
    retired: Promise.withResolvers<void>(),
  }));
  // The read outlives each request, so a held result cannot park scope replacement.
  const info = createMemo(() => receipt().result.promise);
  const [opening, setOpening] = createOptimistic(false);
  let releaseTheme: (() => void) | undefined;
  const presentOpening = action(function* (
    current: ReturnType<typeof receipt>,
    pending: Promise<SessionDiscussionInfo>,
    isCurrent: () => boolean,
  ) {
    if (isCurrent()) {
      setOpening(true);
      affects(info);
    }
    // The admitted chain below publishes failures through the read boundary.
    yield Promise.race([pending.catch(() => undefined), current.retired.promise]);
    if (isCurrent()) {
      void refresh(info);
    }
  });
  function RequestLifetime(input: { receipt: ReturnType<typeof receipt> }) {
    onSettled(() => {
      const current = input.receipt;
      const [sessionKey, loader, opener, generation, canOpen] = current.target;
      let active = true;
      const isCurrent = () =>
        active &&
        host.isConnected &&
        sessionKey === host.sessionKey.trim() &&
        loader === host.loadInfo &&
        opener === host.openDiscussion &&
        generation === host.sourceGeneration &&
        canOpen === host.canOpen;
      const retire = () => {
        active = false;
        current.retired.resolve();
        current.result.resolve(null);
        if (retireDiscussion.get(host) === retireIfStale) {
          releaseTheme?.();
          releaseTheme = undefined;
        }
      };
      const retireIfStale = () => {
        if (!isCurrent()) {
          retire();
        }
      };
      retireDiscussion.set(host, retireIfStale);
      void (async () => {
        try {
          if (!loader || !sessionKey) {
            current.result.resolve(null);
            return;
          }
          let loadedInfo = await loader(sessionKey);
          if (!isCurrent()) {
            return;
          }
          if (loadedInfo.state === "available" && canOpen && opener) {
            host.onStateChange?.(
              sessionKey,
              loadedInfo.state,
              resolveDiscussionUrl(loadedInfo.openUrl),
            );
            if (!isCurrent()) {
              return;
            }
            const pending = opener(sessionKey);
            void presentOpening(current, pending, isCurrent).catch(current.result.reject);
            loadedInfo = (await pending) ?? loadedInfo;
          }
          if (!isCurrent()) {
            return;
          }
          host.onStateChange?.(
            sessionKey,
            loadedInfo.state,
            resolveDiscussionUrl(loadedInfo.openUrl),
          );
          if (isCurrent()) {
            current.result.resolve(loadedInfo);
          }
        } catch (error) {
          if (isCurrent()) {
            current.result.reject(error);
          }
        }
      })();
      return () => {
        retire();
        if (retireDiscussion.get(host) === retireIfStale) {
          retireDiscussion.delete(host);
        }
      };
    });
    return null;
  }
  const empty = (description: string, openUrl?: string | null) => (
    <PanelEmptyState
      presentation={props.presentation}
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
  const renderInfo = (current: SessionDiscussionInfo) => {
    if (current.state === "none") {
      return null;
    }
    if (current.state === "available") {
      return empty(
        t(
          props.canOpen
            ? "chat.sessionDiscussion.unavailable"
            : "chat.sessionDiscussion.requiresWriteAccess",
        ),
      );
    }
    const embedUrl = resolveDiscussionEmbedUrl(current.embedUrl);
    return (
      <div class="session-discussion__open">
        {embedUrl ? (
          <iframe
            class="session-discussion__frame"
            ref={(frame) => {
              releaseTheme?.();
              releaseTheme = registerWidgetThemeFrame(frame, new URL(embedUrl).origin);
            }}
            src={embedUrl}
            title={t("chat.sessionDiscussion.frameTitle")}
            sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
            onLoad={(event) =>
              postWidgetTheme(event.currentTarget, new URL(event.currentTarget.src).origin)
            }
          />
        ) : (
          empty(t("chat.sessionDiscussion.unavailable"), resolveDiscussionUrl(current.openUrl))
        )}
      </div>
    );
  };
  return (
    <>
      <Show when={receipt()} keyed>
        {(current) => <RequestLifetime receipt={current} />}
      </Show>
      <Errored
        fallback={(error) => (
          <div class="session-discussion__empty">
            <div class="callout danger">{formatUiError(error())}</div>
          </div>
        )}
      >
        <Loading
          on={request()}
          fallback={
            <Show when={request()[0] && request()[1]}>
              <PanelLoadingSkeleton
                variant="discussion"
                label={t(
                  opening() ? "chat.sessionDiscussion.opening" : "chat.sessionDiscussion.loading",
                )}
              />
            </Show>
          }
        >
          <Show when={info()} keyed>
            {(current) => <>{renderInfo(current)}</>}
          </Show>
        </Loading>
      </Errored>
    </>
  );
}

export const SessionDiscussionPanel = defineSolidBridge<DiscussionProps>(
  "openclaw-session-discussion",
  DiscussionPanel,
  {
    propertyChanged: (host, key) => {
      if (key !== "presentation" && key !== "onStateChange") {
        retireDiscussion.get(host)?.();
      }
    },
    disconnected: (host) => {
      // Match the bridge's retained root when the host moves within one turn.
      queueMicrotask(() => {
        if (!host.isConnected) {
          retireDiscussion.get(host)?.();
        }
      });
    },
    properties: {
      sessionKey: { default: "" },
      loadInfo: { default: null, attribute: false },
      openDiscussion: { default: null, attribute: false },
      onStateChange: { default: null, attribute: false },
      canOpen: { default: true },
      sourceGeneration: { default: 0 },
      presentation: { default: undefined },
    },
  },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-session-discussion": SolidBridgeElement<DiscussionProps>;
  }
}
