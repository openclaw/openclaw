import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { ControlUiLinkPreview } from "../../../../../src/gateway/control-ui-contract.js";
import type { ApplicationContext } from "../../../app/context.ts";
import { resolveControlUiAuthToken } from "../../../app/control-ui-auth.ts";
import { postNativeExternalLink } from "../../../app/native-link-routing.ts";
import { isBrowserPanelAvailable } from "../../../app/panel-availability.ts";
import { browserTabKey, readBrowserTabTarget } from "../../../components/browser/browser-target.ts";
import { BROWSER_PANEL_TOGGLE_EVENT } from "../../../components/panel-toggle-contract.ts";
import "../../../components/web-awesome.ts";
import { BrandIcon, Icon } from "../../../components/solid/icon.tsx";
import { loadBrowserTabThumbnail } from "../../../lib/chat/browser-tab-preview.ts";
import type { ToolPreview } from "../../../lib/chat/tool-cards.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { canCallGatewayMethod } from "../../../lib/gateway-methods.ts";
import { loadLinkPreview } from "../../../lib/link-preview.ts";
import { openExternalUrlSafe, resolveSafeExternalUrl } from "../../../lib/open-external-url.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectSource } from "../../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import { browserTabTweet } from "./browser-tab-tweet.ts";
import "../../../styles/session-menu.css";
import "./browser-tab-card.css";

type BrowserTabCardProps = {
  context?: ApplicationContext;
  preview?: Extract<ToolPreview, { kind: "browser-tab" }>;
  revision?: string;
  latest: boolean;
};

function BrowserTabCard(props: BrowserTabCardProps, host: SolidBridgeElement<BrowserTabCardProps>) {
  const application = useOptionalApplication();
  const projection = projectSource<ApplicationContext | undefined, ApplicationContext | undefined>(
    untrack(() => props.context ?? application),
    {
      read: (context) => context,
      subscribe: (context, notify) => {
        const subscriptions = [
          context?.gateway.subscribe(notify),
          context?.config.subscribe(notify),
          context?.theme.subscribe(notify),
        ];
        return () => subscriptions.forEach((stop) => stop?.());
      },
      equality: "revision",
    },
  );
  createEffect(
    () => props.context ?? application,
    (context) => projection.replaceSource(context),
  );
  const context = () => projection.read();
  const [thumbnail, setThumbnail] = createSignal<string>();
  const [pagePreview, setPagePreview] = createSignal<ControlUiLinkPreview>();
  const [failedImages, setFailedImages] = createSignal<ReadonlySet<string>>(new Set<string>());
  let requestIdentity: { client: unknown; key: string } | undefined;
  let pageIdentity:
    | { client: unknown; url: string; generation: number; recoveryScope: string }
    | undefined;
  let active = true;
  const canLoadPagePreview = (current: ApplicationContext | undefined) => {
    return Boolean(
      current?.config.current.automaticallyFetchFavicons &&
      canCallGatewayMethod(current.gateway.snapshot, "controlUi.linkPreview", "operator.read", {
        requireAdvertisement: false,
      }),
    );
  };
  const pagePreviewCurrent = (current: ApplicationContext | undefined, url: string | undefined) => {
    const client = current?.gateway.snapshot.client;
    return Boolean(
      pageIdentity &&
      client &&
      canLoadPagePreview(current) &&
      pageIdentity.client === client &&
      pageIdentity.url === url &&
      pageIdentity.generation === client.connectionGeneration &&
      pageIdentity.recoveryScope === client.recoveryScope,
    );
  };
  createEffect(
    () => [context(), props.preview, props.revision, props.latest, projection.revision()] as const,
    ([current, preview, revision, latest]) => {
      const client = current?.gateway.snapshot.client;
      const url = preview?.url;
      if (!canLoadPagePreview(current) || !client || !url) {
        pageIdentity = undefined;
        setPagePreview(undefined);
      } else if (!pagePreviewCurrent(current, url)) {
        const identity = {
          client,
          url,
          generation: client.connectionGeneration,
          recoveryScope: client.recoveryScope,
        };
        pageIdentity = identity;
        setPagePreview(undefined);
        setFailedImages(new Set<string>());
        void loadLinkPreview(client, url).then((loadedPreview) => {
          if (
            active &&
            host.isConnected &&
            pageIdentity === identity &&
            pagePreviewCurrent(untrack(context), host.preview?.url) &&
            host.preview?.url === url
          ) {
            setPagePreview(loadedPreview);
          }
        });
      }
      const snapshot = current?.gateway.snapshot;
      if (
        !preview ||
        !current ||
        !snapshot ||
        !client ||
        !isBrowserPanelAvailable(snapshot) ||
        !latest ||
        !revision
      ) {
        if (!latest || !snapshot || !isBrowserPanelAvailable(snapshot)) {
          requestIdentity = undefined;
          setThumbnail(undefined);
        }
        return;
      }
      const key = JSON.stringify([browserTabKey(preview), revision]);
      if (requestIdentity?.key === key && requestIdentity.client === client) {
        return;
      }
      const identity = { client, key };
      requestIdentity = identity;
      setThumbnail(undefined);
      void loadBrowserTabThumbnail({
        client,
        tab: preview,
        revision,
        resourceBasePath: current.resourceBasePath,
        authToken: resolveControlUiAuthToken({
          hello: snapshot.hello,
          settings: { token: current.gateway.connection.token },
          password: current.gateway.connection.password,
        }),
      }).then((src) => {
        if (
          active &&
          host.isConnected &&
          requestIdentity === identity &&
          host.latest &&
          host.preview &&
          JSON.stringify([browserTabKey(host.preview), host.revision]) === key
        ) {
          setThumbnail(src);
        }
      });
    },
  );
  onCleanup(() => {
    active = false;
    requestIdentity = undefined;
    pageIdentity = undefined;
  });
  const opensExternally = () => context()?.theme.settings.openLinksExternally === true;
  const openExternal = () => {
    const url = resolveSafeExternalUrl(host.preview?.url ?? "", window.location.href);
    if (url && !postNativeExternalLink(url)) {
      openExternalUrlSafe(url);
    }
  };
  const openPanel = () => {
    const browserTab = readBrowserTabTarget(host.preview);
    if (browserTab) {
      host.dispatchEvent(
        new CustomEvent(BROWSER_PANEL_TOGGLE_EVENT, {
          detail: { open: true, browserTab },
          bubbles: true,
          composed: true,
        }),
      );
    }
  };
  const open = () => (untrack(opensExternally) ? openExternal() : openPanel());
  const onMenuSelect = (event: CustomEvent<{ item: { value?: string } }>) => {
    const url = host.preview?.url;
    if (!url) {
      return;
    }
    if (event.detail.item.value === "copy-url") {
      void copyToClipboard(url, () => active && host.preview?.url === url);
    } else if (event.detail.item.value === "open-new-tab") {
      openExternal();
    } else if (event.detail.item.value === "open-within-openclaw") {
      openPanel();
    }
  };
  const data = createMemo(() => {
    const loadedThumbnail = thumbnail();
    const loadedPage = pagePreview();
    const preview = props.preview;
    if (!preview) {
      return undefined;
    }
    const currentImage =
      requestIdentity?.client === context()?.gateway.snapshot.client &&
      requestIdentity?.key === JSON.stringify([browserTabKey(preview), props.revision])
        ? loadedThumbnail
        : undefined;
    const page = pagePreviewCurrent(context(), preview.url) ? loadedPage : undefined;
    const image =
      currentImage && !failedImages().has(currentImage) ? currentImage : page?.imageDataUrl;
    let pageHost = preview.url;
    try {
      pageHost = new URL(preview.url ?? "").host || preview.url;
    } catch {
      /* Internal URLs keep their supplied label. */
    }
    const title = preview.title?.trim() || page?.title || pageHost || t("browser.title");
    return {
      preview,
      currentImage,
      page,
      image,
      host: pageHost,
      title,
      label: preview.url ? `${title} — ${preview.url}` : title,
      tweet: browserTabTweet(preview.url, preview.title, page),
    };
  });
  const renderImage = (src: string) => (
    <img src={src} alt="" onError={() => setFailedImages((images) => new Set([...images, src]))} />
  );
  return (
    <>
      {data() && (
        <div class={data()!.tweet ? "card tweet" : "card"}>
          {data()!.tweet && (
            <>
              <header class="tweet-header">
                <span class="tweet-mark" aria-hidden="true">
                  <BrandIcon name="x" />
                </span>
                <span class="identity">
                  <span class="tweet-author" dir="auto">
                    {data()!.tweet!.author ?? t("browser.tweetPost")}
                  </span>
                  {data()!.tweet!.handle && (
                    <span class="tweet-handle" dir="ltr">
                      {data()!.tweet!.handle}
                    </span>
                  )}
                </span>
              </header>
              {data()!.tweet!.text && (
                <p class="tweet-text" dir="auto">
                  {data()!.tweet!.text}
                </p>
              )}
            </>
          )}
          {data()!.image && !failedImages().has(data()!.image!) && (
            <button
              type="button"
              class={data()!.image === data()!.currentImage ? "shot" : "shot social"}
              aria-label={data()!.label}
              title={opensExternally() ? t("browser.openExternal") : t("browser.openPanel")}
              data-new-tab-action={opensExternally() ? "" : undefined}
              onClick={open}
            >
              {renderImage(data()!.image!)}
            </button>
          )}
          <div class="bar">
            {data()!.tweet ? (
              <span class="tweet-source">{data()!.host}</span>
            ) : (
              <>
                <span class="icon" aria-hidden="true">
                  {data()!.page?.faviconDataUrl &&
                  !failedImages().has(data()!.page!.faviconDataUrl!) ? (
                    renderImage(data()!.page!.faviconDataUrl!)
                  ) : (
                    <Icon name="globe" />
                  )}
                </span>
                <span class="identity">
                  <span class="title">{data()!.title}</span>
                  {data()!.preview.url && <span class="url">{data()!.preview.url}</span>}
                </span>
              </>
            )}
            <span class="actions">
              <button
                type="button"
                title={opensExternally() ? t("browser.openExternal") : t("browser.openPanel")}
                data-new-tab-action={opensExternally() ? "" : undefined}
                onClick={open}
              >
                {t(data()!.tweet ? "browser.openPost" : "browser.open")}
              </button>
              <wa-dropdown class="session-menu" placement="bottom-end" onWa-select={onMenuSelect}>
                <button
                  slot="trigger"
                  type="button"
                  class="more"
                  aria-label={t("browser.moreActions")}
                  aria-haspopup="menu"
                  title={t("browser.moreActions")}
                >
                  <Icon name="moreHorizontal" />
                </button>
                <wa-dropdown-item class="session-menu__item" value="copy-url">
                  <span slot="icon" class="session-menu__icon" aria-hidden="true">
                    <Icon name="copy" />
                  </span>
                  {t("browser.copyUrl")}
                </wa-dropdown-item>
                <wa-dropdown-item
                  class="session-menu__item"
                  value={opensExternally() ? "open-within-openclaw" : "open-new-tab"}
                  data-new-tab-action={!opensExternally() ? "" : undefined}
                >
                  <span slot="icon" class="session-menu__icon" aria-hidden="true">
                    <Icon name={opensExternally() ? "globe" : "externalLink"} />
                  </span>
                  {opensExternally() ? t("browser.openWithinOpenClaw") : t("browser.openNewTab")}
                </wa-dropdown-item>
              </wa-dropdown>
            </span>
          </div>
        </div>
      )}
    </>
  );
}
export const OpenClawBrowserTabCard = defineSolidBridge<BrowserTabCardProps>(
  "openclaw-browser-tab-card",
  BrowserTabCard,
  {
    properties: {
      context: { default: undefined, attribute: false },
      preview: { default: undefined, attribute: false },
      revision: { default: undefined, attribute: false },
      latest: { default: false },
    },
  },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-browser-tab-card": SolidBridgeElement<BrowserTabCardProps>;
  }
}
