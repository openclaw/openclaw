import { createMemo } from "@solidjs/signals";
import { createSignal, onSettled, Show } from "solid-js";
import { registerBrowserEnglish } from "../../i18n/locales/en-browser.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../../lib/reactive/layout-measurement.ts";
import { showToast } from "../../lib/toast.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { readLinkFavicon, type LinkFaviconFetcher } from "../../pages/chat/link-favicon-cache.ts";
import { Icon } from "../solid/icon.tsx";
import { Menu, type MenuItem } from "../solid/menu.tsx";
import { PanelIconButton } from "../solid/panel-icon-button.tsx";
import { StrokeIcon } from "../solid/stroke-icon.tsx";
import type { BrowserPanel } from "./browser-panel-owner.ts";

registerEnglishCatalog(registerBrowserEnglish);

export function BrowserToolbar(
  props: { controller: BrowserPanel } & {
    embedded: boolean;
    mobilePresentation?: boolean;
    fetchFavicon?: LinkFaviconFetcher;
  },
) {
  const menuId = `browser-actions-${generateUUID()}`;
  const [editing, setEditing] = createSignal(false);
  const [favicon, setFavicon] = createSignal<string | undefined>(undefined);
  let addressText!: HTMLSpanElement;
  onSettled(() => {
    const controller = props.controller;
    return () => {
      controller.addressInput = undefined;
      controller.urlDraftEditing = false;
    };
  });
  const nativeTab = createMemo(() => props.controller.native.activeTab);
  const hasView = createMemo(() => Boolean(nativeTab() || props.controller.view));
  const activeUrl = createMemo(
    () =>
      nativeTab()?.url || props.controller.view?.metrics?.url || props.controller.view?.url || "",
  );
  const addressEdited = createMemo(
    () =>
      Boolean(props.controller.urlDraft.trim()) &&
      (props.controller.pendingNewTab || props.controller.urlDraft !== activeUrl()),
  );
  const suppliedFavicon = createMemo(
    () =>
      nativeTab()?.favicon ||
      props.controller.tabs.find((tab) => tab.id === props.controller.activeTargetId)?.favicon,
  );
  const faviconSource = createMemo(() => ({
    url: activeUrl(),
    supplied: suppliedFavicon(),
    fetcher: props.fetchFavicon,
  }));
  function FaviconLifetime(faviconProps: { source: ReturnType<typeof faviconSource> }) {
    onSettled(() => {
      const { url, supplied, fetcher } = faviconProps.source;
      setFavicon(supplied);
      if (supplied || !fetcher || !url) {
        return undefined;
      }
      let hostname: string;
      try {
        hostname = new URL(url).hostname;
      } catch {
        return undefined;
      }
      if (!hostname) {
        return undefined;
      }
      let disposed = false;
      const refresh = () => {
        if (!disposed) {
          setFavicon(readLinkFavicon(hostname, fetcher, refresh) || undefined);
        }
      };
      refresh();
      return () => {
        disposed = true;
      };
    });
    return null;
  }
  const measureAddress = createLayoutMeasurement(
    () => props.controller.urlDraft,
    () => {
      const overflow = addressText.scrollWidth > addressText.clientWidth + 1;
      return () => {
        addressText.dataset.overflow = String(overflow);
      };
    },
    { targets: () => [addressText] },
  );
  onSettled(() => {
    // Fonts can settle without changing the address viewport's dimensions.
    let disposed = false;
    void document.fonts.ready.then(() => {
      if (!disposed) {
        measureAddress();
      }
    });
    return () => {
      disposed = true;
    };
  });
  const menuItems = createMemo((): MenuItem[] => [
    ...(!props.controller.host.fixedTab
      ? [
          {
            id: "new",
            label: t("browser.newBrowserTab"),
            icon: <Icon name="plus" />,
          },
        ]
      : []),
    { id: "copy", label: t("browser.copyUrl"), icon: <Icon name="copy" />, disabled: !activeUrl() },
    {
      id: "open",
      label: t("browser.openExternal"),
      icon: <Icon name="externalLink" />,
      disabled: !hasView(),
    },
    ...(!props.controller.host.dashboardTarget?.sessionScoped
      ? [
          {
            id: "download",
            label: t(
              props.controller.download.pending ? "browser.downloading" : "browser.downloadFile",
            ),
            icon: <Icon name={props.controller.download.pending ? "loader" : "download"} />,
            disabled: !props.controller.download.available,
            attributes: { "aria-busy": props.controller.download.pending ? "true" : "false" },
          } satisfies MenuItem,
        ]
      : []),
    {
      id: "annotate",
      label: t("browser.annotate"),
      icon: <Icon name="penLine" />,
      disabled: !hasView(),
      class: props.controller.mode === "annotate" ? "bp-toolbar-active" : undefined,
    },
    {
      id: "inspect",
      label: t("browser.inspect"),
      icon: (
        <StrokeIcon aria-hidden="true">
          <path d="m4 4 7.07 17 2.51-7.39L21 11.07z" />
        </StrokeIcon>
      ),
      disabled: !hasView() || (!nativeTab() && props.controller.evaluateUnavailable),
      attributes: {
        title: t(
          !nativeTab() && props.controller.evaluateUnavailable
            ? "browser.inspectUnavailable"
            : "browser.inspect",
        ),
      },
      class: props.controller.mode === "inspect" ? "bp-toolbar-active" : undefined,
    },
  ]);
  const selectAction = (item: MenuItem) => {
    props.controller.urlDraftEditing = false;
    switch (item.id) {
      case "new":
        props.controller.beginNewTab();
        break;
      case "open":
        props.controller.openExternal();
        break;
      case "download":
        void props.controller.download.save();
        break;
      case "annotate":
        props.controller.setMode("annotate");
        break;
      case "inspect":
        props.controller.setMode("inspect");
        break;
      case "copy":
        void copyToClipboard(activeUrl(), () => props.controller.host.isConnected).then(
          (copied) => {
            showToast({ message: t(copied ? "common.copied" : "common.copyFailed") });
          },
        );
        break;
    }
  };
  return (
    <div
      class={["bp-toolbar", { "session-panel-rail": !props.mobilePresentation }]}
      data-mobile={props.mobilePresentation ? "true" : "false"}
      data-presentation={props.mobilePresentation ? undefined : "desktop"}
      onFocusOut={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          props.controller.urlDraftEditing = false;
        }
      }}
    >
      {!nativeTab() &&
      !props.controller.host.fixedTab &&
      !props.controller.host.dashboardTarget?.sessionScoped &&
      props.controller.operations.route ? (
        <span
          class="bp-profile"
          title={t("browser.profile", { profile: props.controller.operations.route!.profile })}
        >
          {props.controller.operations.route!.profile}
        </span>
      ) : null}
      <div
        class={["bp-toolbar-group", { "session-panel-rail__group": !props.mobilePresentation }]}
        role="group"
        aria-label={t("browser.navigation")}
        onFocusIn={() => {
          props.controller.urlDraftEditing = false;
        }}
      >
        <PanelIconButton
          class={["bp-icon", { "session-panel-rail__button": !props.mobilePresentation }]}
          label={t("browser.back")}
          icon={<Icon name="chevronLeft" />}
          disabled={
            nativeTab()
              ? !nativeTab()!.canGoBack
              : !hasView() || props.controller.evaluateUnavailable
          }
          onClick={() => {
            props.controller.urlDraftEditing = false;
            props.controller.goHistory(-1);
          }}
        />
        <PanelIconButton
          class={["bp-icon", { "session-panel-rail__button": !props.mobilePresentation }]}
          label={t("browser.forward")}
          icon={<Icon name="chevronRight" />}
          disabled={
            nativeTab()
              ? !nativeTab()!.canGoForward
              : !hasView() || props.controller.evaluateUnavailable
          }
          onClick={() => {
            props.controller.urlDraftEditing = false;
            props.controller.goHistory(1);
          }}
        />
      </div>
      <div class="bp-toolbar-location" data-editing={editing() ? "true" : "false"}>
        <span class="bp-toolbar-favicon" aria-hidden="true">
          <Show when={faviconSource()} keyed>
            {(source) => <FaviconLifetime source={source} />}
          </Show>
          {!props.mobilePresentation && favicon() ? (
            <img src={favicon()} alt="" onError={() => setFavicon(undefined)} />
          ) : (
            <Icon name="globe" />
          )}
        </span>
        <div class="bp-toolbar-address">
          <span
            class="bp-toolbar-address-text"
            ref={(element) => {
              addressText = element;
            }}
            aria-hidden="true"
          >
            {props.controller.urlDraft || t("browser.urlPlaceholder")}
          </span>
          <input
            class="bp-url"
            ref={(element) => (props.controller.addressInput = element)}
            type="text"
            spellcheck="false"
            autocomplete="off"
            aria-label={t("browser.address")}
            title={props.controller.urlDraft}
            disabled={Boolean(props.controller.host.fixedTab && !props.controller.activeTargetId)}
            placeholder={t("browser.urlPlaceholder")}
            value={props.controller.urlDraft}
            onFocus={(event) => {
              setEditing(true);
              props.controller.urlDraftEditing = true;
              event.currentTarget.select();
            }}
            onBlur={() => {
              setEditing(false);
            }}
            onInput={(event) => props.controller.setState("urlDraft", event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                props.controller.commitUrlDraft();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                props.controller.resetUrlDraftFromView();
                event.currentTarget.blur();
              }
            }}
          />
        </div>
      </div>
      <div
        class={["bp-toolbar-group", { "session-panel-rail__group": !props.mobilePresentation }]}
        role="group"
        aria-label={t("browser.actions")}
      >
        <PanelIconButton
          class={["bp-icon", { "session-panel-rail__button": !props.mobilePresentation }]}
          label={t(
            addressEdited()
              ? "browser.go"
              : nativeTab()?.loading
                ? "browser.stop"
                : "browser.reload",
          )}
          icon={
            <Icon name={addressEdited() ? "arrowRight" : nativeTab()?.loading ? "x" : "refresh"} />
          }
          busy={!addressEdited() && !nativeTab() && props.controller.loading}
          disabled={!addressEdited() && !props.controller.activeTargetId}
          onClick={() => {
            props.controller.urlDraftEditing = false;
            if (addressEdited()) {
              props.controller.commitUrlDraft();
            } else {
              props.controller.reloadPage();
            }
          }}
        />
        <Menu
          id={menuId}
          class="bp-toolbar-menu-anchor"
          label={t("browser.actions")}
          lazy
          trigger={<Icon name="moreHorizontal" />}
          triggerClass={props.mobilePresentation ? "bp-icon" : "bp-icon session-panel-rail__button"}
          panelClass="bp-toolbar-menu"
          placement="bottom-end"
          items={menuItems()}
          onSelect={selectAction}
        />
      </div>
    </div>
  );
}
