import { insert } from "@solidjs/web";
import { createMemo, For, Repeat, onCleanup, onSettled } from "solid-js";
import { projectCallbackOwner } from "../lib/reactive/callback-owner.ts";
import { t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { nativeListener } from "../lib/solid-native-listener.ts";
import { createTabFocus } from "../lib/tabs.ts";
import { DockResizer } from "./dock-layout-solid.tsx";
import { LinkReaderContent } from "./link-reader-content.tsx";
import type { LinkReaderPanelProps } from "./link-reader-panel-lifecycle.ts";
import {
  LINK_READER_TAB_LIMIT,
  createLinkReaderPanel,
  type LinkReaderPanelOwner,
} from "./link-reader-panel-owner.ts";
import {
  linkReaderViewStyles,
  tabTarget,
  tabLabel,
  type ReaderTab,
  type ReaderSection,
} from "./link-reader-panel-view.ts";
import { EMPTY_LINK_READERS } from "./link-reader-target.ts";
import type { PanelHostedTabsElement } from "./panel-hosted-tabs.ts";
import { PanelTabStrip } from "./panel-tab-strip-solid.tsx";
import { LINK_READER_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import { Icon } from "./solid/icon.tsx";
import { PanelIconButton } from "./solid/panel-icon-button.tsx";

const panelStyles = `@scope (openclaw-link-reader-panel) { ${linkReaderViewStyles.map((style) => style.replace(/:host\(([^)]+)\)/gu, ":scope$1").replaceAll(":host", ":scope")).join("\n")} }`;

function HostedAction(props: { view: () => LinkReaderPanelOwner }) {
  const label = () => t("linkReader.newTab");
  return (
    <button
      ref={nativeListener("click", () => props.view().createTab())}
      class="rail-header__action bp-icon"
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
  // The panel owns this action while the sidebar hosts its DOM.
  const hostedActions = document.createElement("span");
  hostedActions.style.display = "contents";
  insert(hostedActions, <HostedAction view={view} />);
  Object.defineProperties(host, {
    hostedTabs: { configurable: true, get: () => owner.hostedTabs() },
    activeHostedTabId: { configurable: true, get: () => owner.state.activeId },
    hostedActions: {
      configurable: true,
      get: () => hostedActions,
    },
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
  onCleanup(() => {
    hostedActions.remove();
    if (owners.get(host) === owner) {
      owners.delete(host);
    }
  });
  const tab = () => view().activeTab();
  const target = () => view().target();
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
  const action = (
    name: "chevronLeft" | "chevronRight" | "refresh" | "x",
    label: string,
    click: () => void,
    disabled = false,
  ) => (
    <PanelIconButton
      class="rail-header__action bp-icon"
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
                />
              </openclaw-panel-tab-strip>
              {!props.embedded && action("x", t("linkReader.close"), () => owner.closePanel())}
            </header>
          )}
          <form class="lr-toolbar" onSubmit={(event) => owner.commitUrl(event)}>
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
            {action(
              "refresh",
              t("linkReader.refresh"),
              () => owner.refresh(),
              !target() || !props.available || !props.client || loading(),
            )}
            <input
              ref={(element) => {
                address = element;
              }}
              class="lr-url"
              type="text"
              spellcheck="false"
              autocomplete="off"
              value={view().state.urlDraft}
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
            <button
              class="rail-header__action bp-icon lr-go"
              type="submit"
              disabled={!props.available || !props.client}
              title={t("linkReader.openUrl")}
              aria-label={t("linkReader.openUrl")}
            >
              <Icon name="chevronRight" />
            </button>
            {target() && (
              <a
                class="lr-external"
                href={target()!.href}
                target="_blank"
                rel="noopener noreferrer"
                data-link-reader-external
              >
                <Icon name="externalLink" />
                <span>{t("linkReader.openExternal", { provider: target()!.reader.label })}</span>
              </a>
            )}
          </form>
          {view().state.invalidUrl && (
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
            <For each={[...view().state.tabs]} keyed={(item) => item.id}>
              {(item) => {
                let id = "";
                onCleanup(() => content.delete(id));
                return (
                  <div
                    ref={(element) => {
                      id = item().id;
                      content.set(id, element);
                    }}
                    class="lr-content"
                    tabindex={-1}
                    hidden={item().id !== view().state.activeId}
                    aria-busy={item().view.status === "loading" ? "true" : "false"}
                  >
                    <PanelContent
                      tab={(projection.revision(), item())}
                      available={props.available && Boolean(props.client)}
                      refresh={() => owner.refresh()}
                      loadSection={(section) => owner.requestSection(section)}
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
      sessionKey: { default: "", attribute: false },
      onClose: { default: undefined, attribute: false },
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
