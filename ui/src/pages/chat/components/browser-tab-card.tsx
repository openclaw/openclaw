import { createMemo, createStore, createUniqueId, onSettled } from "solid-js";
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
import { projectApplicationConfig, projectGateway } from "../../../lib/reactive/application.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { sharedThemeProjection } from "../../../lib/reactive/shared-application-projections.ts";

/** Adapts existing anonymous page metadata; never fetches or embeds remote markup. */
function browserTabTweet(url: string, title?: string, page?: ControlUiLinkPreview) {
  const parsed = URL.parse(url);
  if (
    !parsed ||
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !/^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/u.test(parsed.hostname)
  ) {
    return undefined;
  }
  const status = /^\/([a-zA-Z0-9_]{1,15})\/status\/\d+(?:\/(?:photo|video)\/\d+)?\/?$/u.exec(
    parsed.pathname,
  );
  const anonymous = /^\/i\/(?:web\/)?status\/\d+\/?$/u.test(parsed.pathname);
  if (!status && !anonymous) {
    return undefined;
  }
  let handle = anonymous ? undefined : status?.[1];
  let author: string | undefined;
  let text: string | undefined;
  for (const candidate of [page?.title, title]) {
    const clean = candidate?.trim().replace(/\s+\/\s+(?:X|Twitter)$/u, "");
    if (!clean) {
      continue;
    }
    const named =
      /^(.*?)\s+\(@([a-zA-Z0-9_]{1,15})\)(?:\s+on (?:X|Twitter))?(?::\s*([\s\S]+))?$/u.exec(clean);
    if (named && (!handle || named[2]!.toLowerCase() === handle.toLowerCase())) {
      author ??= named[1]?.trim() || undefined;
      handle ??= named[2];
      text ??= named[3];
    }
    const quoted = /^(.*?)\s+on (?:X|Twitter):\s*([\s\S]+)$/u.exec(clean);
    if (quoted && !named) {
      author ??= quoted[1]?.trim() || undefined;
      text ??= quoted[2];
    }
  }
  text = text?.trim();
  if (
    text &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("“") && text.endsWith("”")))
  ) {
    text = text.slice(1, -1);
  }
  return {
    author,
    handle: handle ? "@" + handle : undefined,
    text: page?.description?.trim() || text,
  };
}

type BrowserTabCardProps = {
  context?: ApplicationContext;
  preview?: Extract<ToolPreview, { kind: "browser-tab" }>;
  revision?: string;
  latest?: boolean;
};

export function BrowserTabCardHost(props: BrowserTabCardProps) {
  let host!: HTMLElement;
  const application = useOptionalApplication();
  const menuId = createUniqueId();
  const sources = createMemo(() => {
    const context = props.context ?? application;
    return (
      context && [
        projectGateway(context.gateway),
        projectApplicationConfig(context.config),
        sharedThemeProjection(context.theme),
      ]
    );
  });
  const context = () => {
    sources()?.forEach((source) => source.read());
    return props.context ?? application;
  };
  let active = true;
  const pageTarget = createMemo(
    () => {
      const current = context();
      const snapshot = current?.gateway.snapshot;
      const url = props.preview?.url;
      return current?.config.current.automaticallyFetchFavicons &&
        snapshot?.client &&
        url &&
        canCallGatewayMethod(snapshot, "controlUi.linkPreview", "operator.read", {
          requireAdvertisement: false,
        })
        ? { client: snapshot.client, url }
        : undefined;
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
  // Screenshot refreshes and unavailable targets retain failures; a new target retries them.
  const [failedImages, setFailedImages] = createStore<Record<string, boolean>>((draft) => {
    if (pageTarget()) {
      for (const url of Object.keys(draft)) {
        delete draft[url];
      }
    }
  }, {});
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
    const url = resolveSafeExternalUrl(props.preview?.url ?? "", window.location.href);
    if (url && !postNativeExternalLink(url)) {
      openExternalUrlSafe(url);
    }
  };
  const openPanel = () => {
    const browserTab = readBrowserTabTarget(props.preview);
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
    const url = props.preview?.url;
    if (!url) {
      return;
    }
    if (value === "copy-url") {
      void copyToClipboard(url, () => active && props.preview?.url === url);
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
    const currentImage = thumbnail()?.();
    const page = pagePreview()?.();
    const image = currentImage && !failedImages[currentImage] ? currentImage : page?.imageDataUrl;
    const pageHost = URL.parse(preview.url)?.host || preview.url;
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
        setFailedImages((images) => {
          images[src] = true;
        })
      }
    />
  );
  return (
    <openclaw-browser-tab-card ref={(element) => (host = element)}>
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
          {data()!.image && !failedImages[data()!.image!] && (
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
                  {data()!.page?.faviconDataUrl && !failedImages[data()!.page!.faviconDataUrl!] ? (
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
    </openclaw-browser-tab-card>
  );
}
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-browser-tab-card": HTMLAttributes<HTMLElement>;
    }
  }
}
