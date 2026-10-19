import { createMemo, createSignal, createUniqueId, onSettled } from "solid-js";
import type { ControlUiLinkPreview } from "../../../../../src/gateway/control-ui-contract.js";
import type { ApplicationContext } from "../../../app/context.ts";
import { resolveControlUiAuthToken } from "../../../app/control-ui-auth.ts";
import { postNativeExternalLink } from "../../../app/native-link-routing.ts";
import { isBrowserPanelAvailable } from "../../../app/panel-availability.ts";
import { browserTabKey, readBrowserTabTarget } from "../../../components/browser/browser-target.ts";
import { BROWSER_PANEL_TOGGLE_EVENT } from "../../../components/panel-toggle-contract.ts";
import { BrandIcon, Icon } from "../../../components/solid/icon.tsx";
import { Menu, type MenuItem } from "../../../components/solid/menu.tsx";
import { loadBrowserTabThumbnail } from "../../../lib/chat/browser-tab-preview.ts";
import type { ToolPreview } from "../../../lib/chat/tool-cards.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { canCallGatewayMethod } from "../../../lib/gateway-methods.ts";
import { loadLinkPreview } from "../../../lib/link-preview.ts";
import { openExternalUrlSafe, resolveSafeExternalUrl } from "../../../lib/open-external-url.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
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
  const menuId = createUniqueId();
  const sources = createMemo(() => {
    const context = props.context ?? application;
    return (
      context && [
        projectOwner(context.gateway, (owner) => owner),
        projectOwner(context.config, (owner) => owner),
        projectOwner(context.theme, (owner) => owner),
      ]
    );
  });
  const context = () => {
    sources()?.forEach((source) => source.read());
    return props.context ?? application;
  };
  let active = true;
  const canLoadPagePreview = (current: ApplicationContext | undefined) => {
    return Boolean(
      current?.config.current.automaticallyFetchFavicons &&
      canCallGatewayMethod(current.gateway.snapshot, "controlUi.linkPreview", "operator.read", {
        requireAdvertisement: false,
      }),
    );
  };
  const pageTarget = createMemo(
    () => {
      const current = context();
      const client = current?.gateway.snapshot.client;
      const url = props.preview?.url;
      return canLoadPagePreview(current) && client && url ? { client, url } : undefined;
    },
    {
      equals: (before, after) => before?.client === after?.client && before?.url === after?.url,
    },
  );
  const pagePreview = createMemo(() => {
    const target = pageTarget();
    // Each identity starts empty; loading never suspends the card's controls.
    return (
      target &&
      createMemo<ControlUiLinkPreview | undefined>(
        () => loadLinkPreview(target.client, target.url),
        { loadingValue: undefined },
      )
    );
  });
  // Screenshot refreshes keep image failures latched; a new page target may retry them.
  const [failedImages, setFailedImages] = createSignal<{
    target: ReturnType<typeof pageTarget>;
    urls: ReadonlySet<string>;
  }>((previous) => {
    const target = pageTarget();
    return target && target !== previous?.target
      ? { target, urls: new Set<string>() }
      : (previous ?? { target, urls: new Set<string>() });
  });
  const thumbnailTarget = createMemo(
    () => {
      const current = context();
      const preview = props.preview;
      const revision = props.revision;
      const snapshot = current?.gateway.snapshot;
      const client = snapshot?.client;
      if (
        !preview ||
        !current ||
        !snapshot ||
        !client ||
        !isBrowserPanelAvailable(snapshot) ||
        !props.latest ||
        !revision
      ) {
        return undefined;
      }
      return {
        client,
        key: JSON.stringify([browserTabKey(preview), revision]),
        tab: preview,
        revision,
        context: current,
      };
    },
    { equals: (before, after) => before?.client === after?.client && before?.key === after?.key },
  );
  const thumbnail = createMemo(() => {
    const target = thumbnailTarget();
    return (
      target &&
      createMemo<string | undefined>(
        () =>
          loadBrowserTabThumbnail({
            client: target.client,
            tab: target.tab,
            revision: target.revision,
            resourceBasePath: target.context.resourceBasePath,
            authToken: resolveControlUiAuthToken({
              hello: target.context.gateway.snapshot.hello,
              settings: { token: target.context.gateway.connection.token },
              password: target.context.gateway.connection.password,
            }),
          }),
        { loadingValue: undefined },
      )
    );
  });
  onSettled(() => () => {
    active = false;
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
  const open = () => (opensExternally() ? openExternal() : openPanel());
  const onMenuSelect = (value: string) => {
    const url = host.preview?.url;
    if (!url) {
      return;
    }
    if (value === "copy-url") {
      void copyToClipboard(url, () => active && host.preview?.url === url);
    } else if (value === "open-new-tab") {
      openExternal();
    } else if (value === "open-within-openclaw") {
      openPanel();
    }
  };
  const menuItems = createMemo<MenuItem[]>(() => [
    {
      id: "copy-url",
      label: t("browser.copyUrl"),
      class: "session-menu__item",
      icon: (
        <span class="session-menu__icon" aria-hidden="true">
          <Icon name="copy" />
        </span>
      ),
    },
    {
      id: opensExternally() ? "open-within-openclaw" : "open-new-tab",
      label: opensExternally() ? t("browser.openWithinOpenClaw") : t("browser.openNewTab"),
      class: "session-menu__item",
      attributes: {
        "data-new-tab-action": !opensExternally() ? "" : undefined,
      },
      icon: (
        <span class="session-menu__icon" aria-hidden="true">
          <Icon name={opensExternally() ? "globe" : "externalLink"} />
        </span>
      ),
    },
  ]);
  const data = createMemo(() => {
    const preview = props.preview;
    if (!preview) {
      return undefined;
    }
    const current = context();
    const snapshot = current?.gateway.snapshot;
    const target = thumbnailTarget();
    const currentImage =
      props.latest &&
      snapshot &&
      isBrowserPanelAvailable(snapshot) &&
      target?.client === snapshot.client &&
      target?.key === JSON.stringify([browserTabKey(preview), props.revision])
        ? thumbnail()?.()
        : undefined;
    const pageRequest = pageTarget();
    const page =
      canLoadPagePreview(current) &&
      pageRequest?.client === snapshot?.client &&
      pageRequest?.url === preview.url
        ? pagePreview()?.()
        : undefined;
    const image =
      currentImage && !failedImages().urls.has(currentImage) ? currentImage : page?.imageDataUrl;
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
    <img
      src={src}
      alt=""
      onError={() =>
        setFailedImages((images) => ({
          ...images,
          urls: new Set([...images.urls, src]),
        }))
      }
    />
  );
  return (
    <>
      {data() && (
        <div class={["card", { tweet: Boolean(data()!.tweet) }]}>
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
          {data()!.image && !failedImages().urls.has(data()!.image!) && (
            <button
              type="button"
              class={["shot", { social: data()!.image !== data()!.currentImage }]}
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
                  !failedImages().urls.has(data()!.page!.faviconDataUrl!) ? (
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
              <Menu
                id={`browser-tab-card-${menuId}`}
                class="session-menu"
                placement="bottom-end"
                triggerClass="more"
                triggerAttributes={{ title: t("browser.moreActions") }}
                label={t("browser.moreActions")}
                trigger={<Icon name="moreHorizontal" />}
                items={menuItems()}
                onSelect={(item) => onMenuSelect(item.id)}
              />
            </span>
          </div>
        </div>
      )}
    </>
  );
}
export const BrowserTabCardHost = defineSolidBridge<BrowserTabCardProps>(
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
