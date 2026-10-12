import {
  createEffect,
  createRenderEffect,
  createSignal,
  For,
  onCleanup,
  onSettled,
} from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, LitContent, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { LinkReaderContent } from "./link-reader-content.tsx";
import { LinkReaderPanelOwner, type LinkReaderPanelProps } from "./link-reader-panel-owner.ts";
import {
  linkReaderViewStyles,
  tabTarget,
  tabLabel,
  type ReaderTab,
} from "./link-reader-panel-view.ts";
import { EMPTY_LINK_READERS } from "./link-reader-target.ts";
import type { PanelHostedTabsElement } from "./panel-hosted-tabs.ts";
import { renderPanelTabStrip } from "./panel-tab-strip.ts";
import { Icon } from "./solid/icon.tsx";
import { PanelIconButton } from "./solid/panel-icon-button.tsx";

const panelStyles = `@scope (openclaw-link-reader-panel) { ${linkReaderViewStyles.map((style) => style.cssText.replace(/:host\(([^)]+)\)/gu, ":scope$1").replaceAll(":host", ":scope")).join("\n")} }`;

function PanelContent(props: { tab: ReaderTab; available: boolean; refresh: () => void }) {
  const target = () => tabTarget(props.tab);
  return (
    <>
      {!target() ? (
        <p class="lr-status">{t("linkReader.urlPlaceholder")}</p>
      ) : !props.available || props.tab.view.status === "error" ? (
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
            onClick={props.refresh}
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
        <p class="lr-status" role="status">
          {t("linkReader.loadingPreview")}
        </p>
      ) : (
        <LinkReaderContent
          detail={props.tab.view.detail}
          target={target()!}
          loadImage={props.tab.view.images?.load}
        />
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
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const owner = new LinkReaderPanelOwner(host, host, () => setRevision((value) => value + 1));
  owners.set(host, owner);
  Object.defineProperties(host, {
    hostedTabs: { configurable: true, get: () => owner.hostedTabs },
    activeHostedTabId: { configurable: true, get: () => owner.activeHostedTabId },
    hostedActions: { configurable: true, get: () => owner.hostedActions },
  });
  owner.connect();
  let previous: LinkReaderPanelProps | undefined;
  createRenderEffect(
    () => {
      revision();
      return {
        client: props.client,
        available: props.available,
        agentId: props.agentId,
        readers: props.readers,
        suppressed: props.suppressed,
        embedded: props.embedded,
        presented: props.presented,
        tabsInHeader: props.tabsInHeader,
        sessionKey: props.sessionKey,
        onClose: props.onClose,
      };
    },
    (current) => {
      owner.sync(previous);
      previous = current;
    },
  );
  onSettled(() => {
    owner.sync(previous);
  });
  createEffect(
    () => revision(),
    () => owner.afterRender(),
  );
  onCleanup(() => {
    owner.dispose();
    owners.delete(host);
  });
  const view = () => {
    revision();
    return owner;
  };
  const tab = () => view().activeTab;
  const target = () => view().target;
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
            <LitContent
              render={() => view().dockLayout.renderResizer("bp", t("linkReader.resize"))}
            />
          )}
          {!(props.embedded && props.tabsInHeader) && (
            <header class="rail-header bp-header lr-tab-header">
              <LitContent
                render={() =>
                  renderPanelTabStrip({
                    tabs: view().hostedTabs.map((item) => ({
                      id: item.id,
                      label: item.label,
                      url: item.url,
                      title: item.title,
                      icon: item.icon,
                      className: item.className,
                      domId: item.id + "-label",
                      closeLabel: t("linkReader.closeTab", { title: item.label }),
                    })),
                    activeId: view().activeId,
                    ariaControls: "link-reader-tab-panel",
                    onSelect: (id) => owner.selectHostedTab(id),
                    onClose: (id) => owner.closeTab(id),
                    onNew: () => owner.createTab(),
                    newLabel: t("linkReader.newTab"),
                    newDisabled: view().tabs.length >= 10,
                  })
                }
              />
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
              !target() || !props.available || !props.client || tab()!.view.status === "loading",
            )}
            <input
              class="lr-url"
              type="text"
              spellcheck="false"
              autocomplete="off"
              value={view().urlDraft}
              placeholder={t("linkReader.urlPlaceholder")}
              aria-label={t("linkReader.urlPlaceholder")}
              aria-invalid={view().invalidUrl ? "true" : "false"}
              onInput={(event) => {
                owner.urlDraft = event.currentTarget.value;
                owner.invalidUrl = false;
                owner.requestUpdate();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  owner.urlDraft = target()?.href ?? "";
                  owner.invalidUrl = false;
                  owner.requestUpdate();
                }
              }}
            />
            <button
              class="rail-header__action bp-icon lr-go"
              type="submit"
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
          {view().invalidUrl && (
            <p class="lr-note" role="alert">
              {t("linkReader.invalidUrl")}
            </p>
          )}
          {view().tabLimitUrl && (
            <p class="lr-note" role="alert">
              {t("linkReader.tabLimit")}
              <a
                href={view().tabLimitUrl!}
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
            <For each={[...view().tabs]} keyed={(item) => item.id}>
              {(item) => (
                <div
                  class="lr-content"
                  tabindex={-1}
                  hidden={item().id !== view().activeId}
                  aria-busy={item().view.status === "loading" ? "true" : "false"}
                >
                  <PanelContent
                    tab={(revision(), item())}
                    available={props.available && Boolean(props.client)}
                    refresh={() => owner.refresh()}
                  />
                </div>
              )}
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
