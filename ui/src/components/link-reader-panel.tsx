import { createMemo, createUniqueId, For, Repeat, onSettled } from "solid-js";
import { copyToClipboard } from "../lib/clipboard.ts";
import { projectCallbackOwner } from "../lib/reactive/callback-owner.ts";
import { elementRef } from "../lib/reactive/element-ref.ts";
import { t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import { createScrollStateRef } from "../lib/reactive/scroll-state.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { nativeListener } from "../lib/solid-native-listener.ts";
import { createTabFocus } from "../lib/tabs.ts";
import { showToast } from "../lib/toast.ts";
import { DockResizer } from "./dock-layout-solid.tsx";
import { LinkReaderContent } from "./link-reader-content.tsx";
import type { LinkReaderPanelProps as LinkReaderOwnerProps } from "./link-reader-panel-lifecycle.ts";
import {
  LINK_READER_TAB_LIMIT,
  createLinkReaderPanel,
  type LinkReaderPanelOwner,
} from "./link-reader-panel-owner.ts";
import {
  linkReaderViewStyles,
  tabTarget,
  tabLabel,
  readerIcon,
  type ReaderTab,
  type ReaderSection,
} from "./link-reader-panel-view.ts";
import { LINK_READER_METADATA_REQUEST_EVENT } from "./link-reader-response.ts";
import { EMPTY_LINK_READERS } from "./link-reader-target.ts";
import type { PanelHostedTabsElement } from "./panel-hosted-tabs.ts";
import { PanelTabStrip } from "./panel-tab-strip-solid.tsx";
import { LINK_READER_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import { Icon } from "./solid/icon.tsx";
import { Menu } from "./solid/menu.tsx";
import { PanelEmptyState } from "./solid/panel-empty-state.tsx";
import { PanelIconButton } from "./solid/panel-icon-button.tsx";

const panelStyles = `@scope (openclaw-link-reader-panel) { ${linkReaderViewStyles.map((style) => style.replace(/:host\(([^)]+)\)/gu, ":scope$1").replaceAll(":host", ":scope")).join("\n")} }`;

function NewReaderTabAction(props: { view: () => LinkReaderPanelOwner; internal?: boolean }) {
  const label = () => t("linkReader.newTab");
  return (
    <button
      ref={nativeListener("click", () => props.view().createTab())}
      class={["rail-header__action bp-icon", { "session-panel-rail__button": props.internal }]}
      type="button"
      aria-label={label()}
      title={label()}
      disabled={
        props.view().state.tabs.length >= LINK_READER_TAB_LIMIT ||
        !props.view().props.available ||
        !props.view().props.readers.length
      }
    >
      <Icon name="plus" />
    </button>
  );
}

function ReaderLoading(props: { url: string }) {
  return (
    <div class="lr-loading" role="status">
      <div class="lr-eyebrow">{new URL(props.url).hostname + new URL(props.url).pathname}</div>
      <p class="lr-loading-label">{t("linkReader.loadingPreview")}</p>
      <div class="lr-skeleton" aria-hidden="true">
        <div class="lr-skeleton-title" />
        <div class="lr-skeleton-title lr-skeleton-short" />
        <div class="lr-skeleton-meta" />
        <div class="lr-skeleton-nav" />
        <Repeat count={2}>
          {() => (
            <div class="lr-skeleton-paragraph">
              <div />
              <div />
              <div class="lr-skeleton-short" />
            </div>
          )}
        </Repeat>
      </div>
    </div>
  );
}

function PanelContent(props: {
  tab: ReaderTab;
  available: boolean;
  refresh: () => void;
  loadSection: (section: ReaderSection) => void;
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
}) {
  const target = () => tabTarget(props.tab);
  return (
    <>
      {!target() ? (
        <p class="lr-status">{t("linkReader.urlPlaceholder")}</p>
      ) : props.tab.view.status !== "ready" &&
        (!props.available || props.tab.view.status === "error") ? (
        <div class="lr-status" role="alert">
          <h2>{t("linkReader.unavailableTitle")}</h2>
          <p>
            {!props.available
              ? t("linkReader.disconnected")
              : props.tab.view.status === "error"
                ? props.tab.view.message
                : t("linkReader.unavailable")}
          </p>
          <button
            class="lr-retry"
            type="button"
            disabled={!props.available}
            onClick={() => props.refresh()}
          >
            {t("linkReader.retry")}
          </button>
          <a
            href={target()!.href}
            target="_blank"
            rel="noopener noreferrer"
            data-link-reader-external
          >
            {t("linkReader.openExternal", { provider: target()!.reader.label })}
          </a>
        </div>
      ) : props.tab.view.status !== "ready" ? (
        <ReaderLoading url={target()!.href} />
      ) : (
        <>
          {(props.tab.view.refreshing || props.tab.view.message) && (
            <div class="lr-refresh-note" role="status">
              <span>
                {props.tab.view.refreshing
                  ? t("linkReader.refreshingSaved")
                  : props.tab.view.message}
                {!props.tab.view.refreshing && (
                  <button type="button" onClick={() => props.refresh()}>
                    {t("linkReader.refresh")}
                  </button>
                )}
              </span>
            </div>
          )}
          <LinkReaderContent
            detail={props.tab.view.detail}
            target={target()!}
            loadImage={props.tab.view.images?.load}
            sections={props.tab.view.sections}
            onLoadSection={(section) => props.loadSection(section)}
            onScrollPortRef={props.onScrollPortRef}
          />
        </>
      )}
    </>
  );
}

type Methods = {
  handleToggleRequest(event: Event): void;
  selectHostedTab(id: string): void;
  closeHostedTab(id: string): Promise<void>;
};
type PanelElement = SolidBridgeElement<LinkReaderPanelProps, Methods> & PanelHostedTabsElement;
const owners = new WeakMap<HTMLElement, LinkReaderPanelOwner>();

export type LinkReaderPanelProps = LinkReaderOwnerProps & {
  /** Native mobile shell presentation, independent of the panel's width. */
  mobile?: boolean;
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
};

function PanelView(
  props: LinkReaderPanelProps,
  host: SolidBridgeElement<LinkReaderPanelProps, Methods>,
) {
  const tabFocus = createTabFocus();
  let address: HTMLInputElement | undefined;
  const content = new Map<string, HTMLElement>();
  const { owner, view: projection } = projectCallbackOwner(
    (notify) =>
      createLinkReaderPanel(
        host,
        onSettled,
        (activeId) => ({
          address,
          content: content.get(activeId ?? ""),
        }),
        notify,
      ),
    (current) => current,
  );
  const view = projection.read;
  owners.set(host, owner);
  Object.defineProperties(host, {
    hostedTabs: { configurable: true, get: () => owner.hostedTabs() },
    activeHostedTabId: { configurable: true, get: () => owner.state.activeId },
  });
  const bridgePrototype = Object.getPrototypeOf(host);
  Object.defineProperty(host, "updateComplete", {
    configurable: true,
    get: () =>
      Promise.resolve(Reflect.get(bridgePrototype, "updateComplete", host)).then(() =>
        host.isConnected ? owner.updateComplete : false,
      ),
  });
  onSettled(() => {
    let disposed = false;
    const connect = () => {
      if (!disposed && host.isConnected) {
        owner.connect();
      }
    };
    // Direct Solid hosts settle before their parent inserts them.
    if (host.isConnected) {
      connect();
    } else {
      queueMicrotask(connect);
    }
    return () => {
      disposed = true;
      owner.dispose();
      if (owners.get(host) === owner) {
        owners.delete(host);
      }
    };
  });
  // One window listener follows this mounted owner; embedded panels never claim it.
  onSettled(() =>
    listen(window, LINK_READER_PANEL_TOGGLE_EVENT, (event) => {
      if (!host.embedded) {
        owner.handleToggleRequest(event);
      }
    }),
  );
  onSettled(() =>
    listen(window, LINK_READER_METADATA_REQUEST_EVENT, () => owner.publishMetadata()),
  );
  const tab = () => view().activeTab();
  const target = () => view().target();
  const railMenuId = createUniqueId();
  const editedUrl = () => !target() || view().state.urlDraft.trim() !== target()!.href;
  const loading = () => {
    const current = tab()?.view;
    return (
      current?.status === "loading" || (current?.status === "ready" && current.refreshing === true)
    );
  };
  const tabStripTabs = createMemo(() =>
    view()
      .hostedTabs()
      .map((item) => ({
        id: item.id,
        label: item.label,
        url: item.url,
        title: item.title,
        icon: item.icon,
        className: item.className,
        domId: item.id + "-label",
        closeLabel: t("linkReader.closeTab", { title: item.label }),
      })),
  );
  const initial = () => !target();
  const initialIcon = createMemo(() => {
    const icons = new Set(props.readers.map((reader) => reader.icon));
    return icons.size === 1 ? (props.readers[0]?.icon ?? "globe") : "globe";
  });
  function AddressInput() {
    const scrollState = createScrollStateRef(
      (element, state) => {
        element.dataset.overflow = String(state.scrollable);
      },
      {
        horizontal: true,
        content: () => [tab()?.id, view().state.urlDraft, props.mobile],
      },
    );
    return (
      <input
        ref={[
          (element) => {
            address = element;
          },
          scrollState,
        ]}
        class="lr-url"
        type="text"
        inputmode={props.mobile ? "url" : undefined}
        autocapitalize={props.mobile ? "off" : undefined}
        spellcheck="false"
        autocomplete="off"
        value={view().state.urlDraft}
        title={target()?.href}
        placeholder={t("linkReader.urlPlaceholder")}
        aria-label={t("linkReader.urlPlaceholder")}
        aria-invalid={view().state.invalidUrl ? "true" : "false"}
        onInput={(event) => {
          owner.editUrl(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            owner.editUrl(target()?.href ?? "");
          }
        }}
      />
    );
  }
  const action = (
    name: "chevronLeft" | "chevronRight" | "refresh" | "x",
    label: string,
    click: () => void,
    disabled = false,
  ) => (
    <PanelIconButton
      class={["rail-header__action bp-icon", { "session-panel-rail__button": !props.mobile }]}
      label={label}
      icon={<Icon name={name} />}
      onClick={click}
      disabled={disabled}
    />
  );
  return (
    <>
      <style>{panelStyles}</style>
      {tab() && !props.suppressed && (props.embedded || view().dockLayout.open) ? (
        <section
          class={["bp", props.embedded ? "bp--embedded" : "bp--right", "link-reader-panel"]}
          style={props.embedded ? undefined : { width: `${view().dockLayout.width}px` }}
          aria-label={t("linkReader.title")}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented) {
              event.preventDefault();
              event.stopPropagation();
              owner.closePanel();
            }
          }}
        >
          {!props.embedded && (
            <DockResizer
              controller={view().dockLayout}
              classPrefix="bp"
              label={t("linkReader.resize")}
            />
          )}
          {!(props.embedded && props.tabsInHeader) && (
            <header class="rail-header bp-header lr-tab-header">
              <openclaw-panel-tab-strip style={{ display: "contents" }}>
                <PanelTabStrip
                  focusOwner={tabFocus}
                  tabs={tabStripTabs()}
                  activeId={view().state.activeId}
                  ariaControls="link-reader-tab-panel"
                  onSelect={(id) => owner.selectHostedTab(id)}
                  onClose={(id) => owner.closeTab(id)}
                  onNew={() => owner.createTab()}
                  newLabel={t("linkReader.newTab")}
                  newDisabled={view().state.tabs.length >= 10}
                  newControl={null}
                />
              </openclaw-panel-tab-strip>
              {!props.embedded && action("x", t("linkReader.close"), () => owner.closePanel())}
            </header>
          )}
          {!initial() && (
            <form
              class={[
                "lr-toolbar",
                { "lr-toolbar--mobile": props.mobile, "session-panel-rail": !props.mobile },
              ]}
              data-presentation={props.mobile ? "mobile" : "desktop"}
              onSubmit={(event) => owner.commitUrl(event)}
            >
              <span class={["lr-history", { "session-panel-rail__group": !props.mobile }]}>
                {action(
                  "chevronLeft",
                  t("linkReader.back"),
                  () => owner.goHistory(-1),
                  tab()!.index <= 0,
                )}
                {action(
                  "chevronRight",
                  t("linkReader.forward"),
                  () => owner.goHistory(1),
                  tab()!.index >= tab()!.history.length - 1,
                )}
              </span>
              <span class="lr-address">
                <span class="lr-provider" aria-hidden="true">
                  {props.mobile ? (
                    readerIcon(target()?.reader.icon ?? props.readers[0]?.icon, host.ownerDocument)
                  ) : (
                    <Icon name="globe" />
                  )}
                </span>
                <AddressInput />
              </span>
              <span class={["lr-actions", { "session-panel-rail__group": !props.mobile }]}>
                {!props.mobile && <NewReaderTabAction view={view} internal />}
                {editedUrl() && (
                  <button
                    class={[
                      "rail-header__action bp-icon lr-go",
                      { "session-panel-rail__button": !props.mobile },
                    ]}
                    type="submit"
                    disabled={!props.available || !props.client}
                    title={t("linkReader.openUrl")}
                    aria-label={t("linkReader.openUrl")}
                  >
                    <Icon name="chevronRight" />
                  </button>
                )}
                {!editedUrl() &&
                  action(
                    "refresh",
                    t("linkReader.refresh"),
                    () => owner.refresh(),
                    !target() || !props.available || !props.client || loading(),
                  )}
                <Menu
                  id={railMenuId}
                  label={t("linkReader.moreActions")}
                  trigger={<Icon name="moreHorizontal" />}
                  triggerClass={
                    props.mobile
                      ? "rail-header__action bp-icon lr-menu"
                      : "rail-header__action bp-icon lr-menu session-panel-rail__button"
                  }
                  panelClass="lr-rail-menu"
                  placement="bottom-end"
                  disabled={!target()}
                  items={[
                    { id: "copy", label: t("linkReader.copyLink"), icon: <Icon name="copy" /> },
                    {
                      id: "external",
                      label: props.mobile
                        ? t("linkReader.openInBrowser")
                        : t("linkReader.openExternal", { provider: target()?.reader.label ?? "" }),
                      icon: <Icon name="externalLink" />,
                      href: target()?.href,
                      class: "lr-external",
                      attributes: {
                        target: "_blank",
                        rel: "noopener noreferrer",
                        "data-link-reader-external": "",
                      },
                    },
                  ]}
                  onSelect={(item) => {
                    const href = target()?.href;
                    if (item.id === "copy" && href) {
                      void copyToClipboard(href, () => host.isConnected).then((copied) => {
                        if (host.isConnected) {
                          showToast({
                            message: t(copied ? "common.copied" : "common.copyFailed"),
                            anchor: host,
                          });
                        }
                      });
                    }
                  }}
                />
              </span>
            </form>
          )}
          {!initial() && view().state.invalidUrl && (
            <p class="lr-note" role="alert">
              {t("linkReader.invalidUrl")}
            </p>
          )}
          {view().state.tabLimitUrl && (
            <p class="lr-note" role="alert">
              {t("linkReader.tabLimit")}
              <a
                href={view().state.tabLimitUrl!}
                target="_blank"
                rel="noopener noreferrer"
                data-link-reader-external
              >
                {t("linkReader.openOriginal")}
              </a>
            </p>
          )}
          <div
            id="link-reader-tab-panel"
            class="lr-panels"
            role="tabpanel"
            aria-labelledby={
              props.embedded && props.tabsInHeader ? undefined : tab()!.id + "-label"
            }
            aria-label={props.embedded && props.tabsInHeader ? tabLabel(tab()!) : undefined}
          >
            {initial() && (
              <div class={["lr-initial", { "lr-initial--mobile": props.mobile }]}>
                <PanelEmptyState
                  presentation={props.mobile ? "mobile" : "desktop"}
                  icon={<Icon name="link" />}
                  heading={t("linkReader.title")}
                  description={t("linkReader.invalidUrl")}
                  action={
                    <>
                      <form class="lr-initial-form" onSubmit={(event) => owner.commitUrl(event)}>
                        {!props.mobile && (
                          <span class="lr-provider" aria-hidden="true">
                            {readerIcon(initialIcon(), host.ownerDocument)}
                          </span>
                        )}
                        <AddressInput />
                        <button
                          type="submit"
                          disabled={!props.available || !props.client}
                          aria-label={t("linkReader.openUrl")}
                        >
                          {t("linkReader.openUrl")}
                        </button>
                      </form>
                      {view().state.invalidUrl && (
                        <p class="lr-note" role="alert">
                          {t("linkReader.invalidUrl")}
                        </p>
                      )}
                    </>
                  }
                />
              </div>
            )}
            <For each={[...view().state.tabs]} keyed={(item) => item.id}>
              {(item) => {
                const registerContent = elementRef<HTMLElement>((element) => {
                  const initialTabId = item().id;
                  content.set(initialTabId, element);
                  return () => content.delete(initialTabId);
                });
                return (
                  <div
                    ref={[registerContent, elementRef(props.onScrollPortRef)]}
                    class="lr-content"
                    tabindex={-1}
                    hidden={item().id !== view().state.activeId || initial()}
                    aria-busy={item().view.status === "loading" ? "true" : "false"}
                  >
                    <PanelContent
                      tab={(projection.revision(), item())}
                      available={props.available && Boolean(props.client)}
                      refresh={() => owner.refresh()}
                      loadSection={(section) => owner.requestSection(section)}
                      onScrollPortRef={props.onScrollPortRef}
                    />
                  </div>
                );
              }}
            </For>
          </div>
        </section>
      ) : undefined}
    </>
  );
}

export const LinkReaderPanel = defineSolidBridge<LinkReaderPanelProps, Methods>(
  "openclaw-link-reader-panel",
  PanelView,
  {
    propertyChanged: (host) => owners.get(host)?.inputsChanged(),
    properties: {
      client: { default: null, attribute: false },
      available: { default: false },
      agentId: { default: undefined },
      readers: { default: EMPTY_LINK_READERS, attribute: false },
      suppressed: { default: false },
      embedded: { default: false, reflect: true },
      presented: { default: false },
      tabsInHeader: { default: false },
      mobile: { default: false },
      sessionKey: { default: "", attribute: false },
      onClose: { default: undefined, attribute: false },
      onScrollPortRef: { default: undefined, attribute: false },
    },
    methods: {
      handleToggleRequest: (host, event) => owners.get(host)?.handleToggleRequest(event),
      selectHostedTab: (host, id) => owners.get(host)?.selectHostedTab(id),
      closeHostedTab: async (host, id) => {
        owners.get(host)?.closeTab(id);
        await host.updateComplete;
      },
    },
  },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-link-reader-panel": PanelElement;
  }
}
