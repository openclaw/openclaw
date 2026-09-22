import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type {
  ControlUiLinkReaderDocument,
  ControlUiLinkReaderDetailParams,
  ControlUiLinkReaderDescriptor,
} from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import { registerLinkReaderEnglish } from "../i18n/locales/en-link-reader.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { DockLayoutController } from "./dock-layout-controller.ts";
import { icons } from "./icons.ts";
import { linkReaderErrorMessage } from "./link-reader-error.ts";
import { LinkReaderImages } from "./link-reader-images.ts";
import {
  renderLinkReaderPanelContent,
  renderReaderButton,
  readerIcon,
  linkReaderViewStyles,
  linkReaderPanelLayout,
  tabTarget,
  tabLabel,
  type ReaderTab,
} from "./link-reader-panel-view.ts";
import { linkReaderResponseMatchesTarget } from "./link-reader-response.ts";
import {
  resolveLinkReaderTarget,
  linkReaderTargetKey as targetKey,
  EMPTY_LINK_READERS,
  type LinkReaderTarget,
} from "./link-reader-target.ts";
import {
  PANEL_HOSTED_TABS_CHANGE_EVENT,
  type PanelHostedTab,
  type PanelHostedTabsElement,
} from "./panel-hosted-tabs.ts";
import { renderPanelTabStrip } from "./panel-tab-strip.ts";
import { LINK_READER_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";

registerLinkReaderEnglish();

const HISTORY_LIMIT = 30;
const TAB_LIMIT = 10;
/** Browser-style, memory-only tabs for plugin-provided read-only documents. */
class OpenClawLinkReaderPanel extends OpenClawLitElement implements PanelHostedTabsElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) available = false;
  @property() agentId: string | undefined;
  @property({ attribute: false }) readers: readonly ControlUiLinkReaderDescriptor[] =
    EMPTY_LINK_READERS;
  @property({ type: Boolean }) suppressed = false;
  @property({ type: Boolean, reflect: true }) embedded = false;
  @property({ type: Boolean }) presented = false;
  @property({ type: Boolean }) tabsInHeader = false;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) onClose?: () => void;
  private hostedSignature = "";

  get hostedTabs(): PanelHostedTab[] {
    return this.tabs.map((tab) => ({
      id: tab.id,
      label: tabLabel(tab),
      url: tabTarget(tab)?.href,
      title: tabTarget(tab)?.href,
      icon: readerIcon(tabTarget(tab)?.reader.icon),
      className: tab.view.status === "loading" ? "is-connecting" : "",
    }));
  }
  get activeHostedTabId(): string | null {
    return this.activeId;
  }
  get hostedActions() {
    return renderReaderButton(
      t("linkReader.newTab"),
      icons.plus,
      () => this.createTab(),
      this.tabs.length >= TAB_LIMIT || !this.available || !this.readers.length,
    );
  }
  selectHostedTab(id: string): void {
    this.selectTab(id);
  }
  async closeHostedTab(id: string): Promise<void> {
    this.closeTab(id);
    await this.updateComplete;
  }
  @state() private urlDraft = "";
  @state() private invalidUrl = false;
  @state() private tabLimitUrl: string | null = null;
  private tabs: ReaderTab[] = [];
  private activeId: string | null = null;
  private nextTabId = 0;
  private requestAbort: AbortController | null = null;
  private returnFocus: HTMLElement | null = null;
  private focusContent = false;
  private focusAddress = false;
  private refreshRequested = false;
  private readonly dockLayout = new DockLayoutController(this, {
    layout: linkReaderPanelLayout,
    reservationPrefix: "link-reader",
    isAvailable: () => this.tabs.length > 0 && !this.suppressed && !this.embedded,
    // Embedded geometry belongs to the region, never the standalone dock store.
    isFullscreen: () => this.embedded,
  });
  private readonly onToggleRequest = (event: Event) => this.handleToggleRequest(event);
  static override styles = linkReaderViewStyles;

  private get activeTab(): ReaderTab | undefined {
    return this.tabs.find((tab) => tab.id === this.activeId);
  }
  private get target(): LinkReaderTarget | null {
    return tabTarget(this.activeTab);
  }

  private get panelPresented(): boolean {
    return !this.suppressed && (this.embedded ? this.presented : this.dockLayout.open);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (!this.embedded) {
      window.addEventListener(LINK_READER_PANEL_TOGGLE_EVENT, this.onToggleRequest);
      this.dockLayout.setSuppressed(this.suppressed);
    }
  }
  override disconnectedCallback(): void {
    this.abortRequest();
    for (const tab of this.tabs) {
      this.setTabView(tab, { status: "idle" });
    }
    this.tabs = [];
    this.activeId = null;
    this.returnFocus = null;
    window.removeEventListener(LINK_READER_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    super.disconnectedCallback();
  }
  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("embedded")) {
      window.removeEventListener(LINK_READER_PANEL_TOGGLE_EVENT, this.onToggleRequest);
      if (!this.embedded && this.isConnected) {
        window.addEventListener(LINK_READER_PANEL_TOGGLE_EVENT, this.onToggleRequest);
      }
    }
    if (changed.has("sessionKey") && changed.get("sessionKey") !== undefined) {
      this.abortRequest();
      for (const tab of this.tabs) {
        this.setTabView(tab, { status: "idle" });
      }
      this.tabs = [];
      this.activeId = null;
      this.urlDraft = "";
      this.invalidUrl = false;
      this.tabLimitUrl = null;
      this.returnFocus = null;
      this.focusAddress = false;
      this.focusContent = false;
    }
    if (this.embedded && !this.presented) {
      this.abortRequest();
    }
    const previousReaders = changed.get("readers");
    const readersChanged =
      changed.has("readers") &&
      (!previousReaders ||
        previousReaders.length !== this.readers.length ||
        previousReaders.some((reader, index) => reader !== this.readers[index]));
    if (
      changed.has("client") ||
      changed.has("available") ||
      changed.has("agentId") ||
      readersChanged
    ) {
      this.abortRequest();
      // Cached documents belong to this connection epoch, never a replacement gateway.
      for (const tab of this.tabs) {
        this.setTabView(tab, { status: "idle" });
      }
    }
    if (readersChanged && this.available) {
      // Disabled or replaced contributions cannot retain old data or request authority.
      this.tabs = this.tabs.flatMap((tab) => {
        const current = tabTarget(tab);
        if (!current) {
          return this.readers.length > 0 ? [tab] : [];
        }
        if (!resolveLinkReaderTarget(current.href, this.readers)) {
          return [];
        }
        tab.history = tab.history.flatMap((entry) => {
          const resolved = resolveLinkReaderTarget(entry.href, this.readers);
          return resolved ? [resolved] : [];
        });
        tab.index = tab.history.findIndex((entry) => entry.href === current.href);
        return [tab];
      });
      if (!this.tabs.some((tab) => tab.id === this.activeId)) {
        this.activeId = this.tabs[0]?.id ?? null;
      }
      this.urlDraft = this.target?.href ?? "";
      if (this.tabs.length === 0 && previousReaders?.length) {
        this.closePanel();
      }
    }
    if (changed.has("suppressed")) {
      this.abortRequest();
    }
    if (!this.embedded) {
      this.dockLayout.setSuppressed(this.suppressed);
      this.dockLayout.restoreOpenState();
      this.dockLayout.syncReservation();
    }
    // A menu-opened slot starts with an address draft. Closing its last tab
    // lets the region remove the slot instead of recreating it on every update.
    if (
      this.embedded &&
      this.panelPresented &&
      this.tabs.length === 0 &&
      this.available &&
      this.readers.length > 0 &&
      (["embedded", "presented", "sessionKey", "available"] as const).some((key) =>
        changed.has(key),
      )
    ) {
      this.createTab();
    }
    if (this.isConnected && this.panelPresented && this.activeTab?.view.status === "idle") {
      void this.loadDetail();
    }
  }
  override updated(): void {
    const signature = JSON.stringify([
      this.activeId,
      this.available,
      this.readers.length,
      this.tabs.map((tab) => [
        tab.id,
        tabLabel(tab),
        tabTarget(tab)?.href,
        tabTarget(tab)?.reader.icon,
        tab.view.status,
      ]),
    ]);
    if (signature !== this.hostedSignature) {
      this.hostedSignature = signature;
      this.dispatchEvent(
        new Event(PANEL_HOSTED_TABS_CHANGE_EVENT, { bubbles: true, composed: true }),
      );
    }
    if (!this.panelPresented) {
      return;
    }
    if (this.focusAddress) {
      this.focusAddress = false;
      this.renderRoot.querySelector<HTMLInputElement>(".lr-url")?.focus();
    }
    const content = this.renderRoot.querySelector<HTMLElement>(".lr-content:not([hidden])");
    if (this.focusContent && content) {
      content.focus();
      if (this.activeTab?.view.status === "ready") {
        this.focusContent = false;
        content.scrollTop = 0;
        const hash = this.target ? new URL(this.target.href).hash.slice(1) : "";
        const anchor = [...content.querySelectorAll<HTMLElement>("[id]")].find(
          (node) => node.id === hash,
        );
        anchor?.scrollIntoView?.({ block: "start" });
      }
    }
  }
  private abortRequest(): void {
    this.requestAbort?.abort();
    this.requestAbort = null;
    if (this.activeTab?.view.status === "loading") {
      this.activeTab.view = { status: "idle" };
    }
    this.refreshRequested = false;
  }
  private setTabView(tab: ReaderTab, view: ReaderTab["view"]): void {
    if (tab.view.status === "ready") {
      tab.view.images?.dispose();
    }
    tab.view = view;
  }
  private selectTab(id: string): void {
    if (id === this.activeId || !this.tabs.some((tab) => tab.id === id)) {
      return;
    }
    this.abortRequest();
    this.activeId = id;
    this.urlDraft = this.target?.href ?? "";
    this.invalidUrl = false;
    this.tabLimitUrl = null;
    this.focusContent = false;
    this.requestUpdate();
  }
  private createTab(target?: LinkReaderTarget): void {
    if (this.tabs.length >= TAB_LIMIT) {
      this.tabLimitUrl = target?.href ?? null;
      return;
    }
    this.abortRequest();
    const tab: ReaderTab = {
      id: "link-reader-tab-" + ++this.nextTabId,
      history: target ? [target] : [],
      index: target ? 0 : -1,
      view: { status: "idle" },
    };
    this.tabs.push(tab);
    this.activeId = tab.id;
    this.urlDraft = target?.href ?? "";
    this.invalidUrl = false;
    this.tabLimitUrl = null;
    this.focusAddress = !target;
    this.focusContent = Boolean(target);
    if (!this.embedded) {
      this.dockLayout.setOpen(true);
    } else {
      this.requestUpdate();
    }
  }
  private closeTab(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) {
      return;
    }
    const active = id === this.activeId;
    if (active) {
      this.abortRequest();
    }
    this.setTabView(this.tabs[index]!, { status: "idle" });
    this.tabs.splice(index, 1);
    this.tabLimitUrl = null;
    if (this.tabs.length === 0) {
      this.activeId = null;
      this.closePanel();
      return;
    }
    if (active) {
      this.activeId = null;
      const fallback = this.tabs[Math.min(index, this.tabs.length - 1)];
      if (fallback) {
        this.selectTab(fallback.id);
      }
    }
    this.requestUpdate();
  }
  private navigate(target: LinkReaderTarget): void {
    const tab = this.activeTab;
    if (!tab) {
      this.createTab(target);
      return;
    }
    const previous = tabTarget(tab);
    if (previous?.href !== target.href) {
      this.abortRequest();
      tab.history = [...tab.history.slice(0, tab.index + 1), target].slice(-HISTORY_LIMIT);
      tab.index = tab.history.length - 1;
      if (!previous || targetKey(previous) !== targetKey(target)) {
        this.setTabView(tab, { status: "idle" });
      }
    }
    this.urlDraft = target.href;
    this.invalidUrl = false;
    this.focusContent = true;
    this.requestUpdate();
  }
  handleToggleRequest(event: Event): void {
    const payload: unknown = event instanceof CustomEvent ? event.detail : undefined;
    const detail = isRecord(payload) ? payload : null;
    if (detail?.open === false) {
      this.closePanel();
      return;
    }
    const target =
      typeof detail?.url === "string" ? resolveLinkReaderTarget(detail.url, this.readers) : null;
    if (
      !this.isConnected ||
      !this.available ||
      !this.client ||
      this.suppressed ||
      (this.embedded && !this.presented) ||
      !this.readers.length ||
      (detail?.url !== undefined && !target)
    ) {
      return;
    }
    event.preventDefault();
    if (!this.panelPresented || (this.embedded && !this.returnFocus)) {
      const active = document.activeElement;
      this.returnFocus =
        detail?.trigger instanceof HTMLElement
          ? detail.trigger
          : active instanceof HTMLElement && active !== this
            ? active
            : null;
    }
    if (!target && detail?.newTab) {
      this.createTab();
      return;
    }
    if (target) {
      const existing =
        detail?.newTab !== false
          ? this.tabs.find((tab) => {
              const current = tabTarget(tab);
              return current && targetKey(current) === targetKey(target);
            })
          : undefined;
      if (existing) {
        this.selectTab(existing.id);
        this.navigate(target);
      } else if (detail?.newTab === false || (this.activeTab && !this.target)) {
        this.navigate(target);
      } else {
        this.createTab(target);
      }
    } else if (!this.activeTab) {
      this.createTab();
    }
    if (!this.embedded) {
      this.dockLayout.setOpen(true);
    } else {
      this.requestUpdate();
    }
  }
  private closePanel(): void {
    this.abortRequest();
    if (!this.embedded) {
      this.dockLayout.setOpen(false);
    } else {
      this.onClose?.();
      this.requestUpdate();
    }
    this.focusContent = false;
    this.focusAddress = false;
    if (this.returnFocus?.isConnected) {
      this.returnFocus.focus({ preventScroll: true });
    }
    this.returnFocus = null;
  }
  private refresh(): void {
    this.abortRequest();
    if (this.activeTab) {
      this.setTabView(this.activeTab, { status: "idle" });
    }
    this.refreshRequested = true;
    this.requestUpdate();
  }
  private goHistory(offset: number): void {
    const tab = this.activeTab;
    if (!tab || tab.index + offset < 0 || tab.index + offset >= tab.history.length) {
      return;
    }
    this.abortRequest();
    tab.index += offset;
    this.setTabView(tab, { status: "idle" });
    this.urlDraft = this.target?.href ?? "";
    this.invalidUrl = false;
    this.focusContent = true;
    this.requestUpdate();
  }
  private commitUrl(event: Event): void {
    event.preventDefault();
    const draft = this.urlDraft.trim();
    const target = resolveLinkReaderTarget(
      /^[a-z][a-z0-9+.-]*:/iu.test(draft) ? draft : "https://" + draft,
      this.readers,
    );
    this.invalidUrl = !target;
    if (target) {
      this.navigate(target);
    }
  }
  private async loadDetail(): Promise<void> {
    const target = this.target;
    const tab = this.activeTab;
    const client = this.client;
    const agentId = this.agentId;
    const sessionKey = this.sessionKey;
    const generation = client?.connectionGeneration;
    const recoveryScope = client?.recoveryScope;
    if (!target || !tab || !client || !this.available || !this.panelPresented) {
      return;
    }
    const request = new AbortController();
    this.requestAbort = request;
    tab.view = { status: "loading" };
    const isCurrent = () =>
      this.requestAbort === request &&
      !request.signal.aborted &&
      this.isConnected &&
      this.client === client &&
      this.agentId === agentId &&
      this.sessionKey === sessionKey &&
      client.connectionGeneration === generation &&
      client.recoveryScope === recoveryScope &&
      this.available &&
      this.panelPresented &&
      this.activeTab === tab &&
      this.target?.href === target.href &&
      this.readers.includes(target.reader);
    const requestParams: ControlUiLinkReaderDetailParams = {
      url: target.href,
      ...(agentId ? { agentId } : {}),
      ...(this.refreshRequested ? { refresh: true } : {}),
    };
    this.refreshRequested = false;
    this.requestUpdate();
    try {
      const detail = await client.request<ControlUiLinkReaderDocument>(
        target.reader.linkReader.detailMethod,
        requestParams,
        { signal: request.signal },
      );
      if (isCurrent()) {
        if (!detail || !linkReaderResponseMatchesTarget(target, detail.url)) {
          throw new Error("Link document does not match the requested target");
        }
        const imageMethod = target.reader.linkReader.imageMethod;
        const images = imageMethod
          ? new LinkReaderImages(
              client,
              imageMethod,
              () =>
                this.isConnected &&
                this.available &&
                this.client === client &&
                this.agentId === agentId &&
                this.sessionKey === sessionKey &&
                client.connectionGeneration === generation &&
                client.recoveryScope === recoveryScope &&
                this.tabs.includes(tab) &&
                this.readers.includes(target.reader) &&
                tab.view.status === "ready" &&
                tab.view.detail === detail,
            )
          : undefined;
        this.setTabView(tab, { status: "ready", detail, images });
        this.requestUpdate();
      }
    } catch (error) {
      if (isCurrent()) {
        tab.view = { status: "error", message: linkReaderErrorMessage(error) };
        this.requestUpdate();
      }
    }
  }
  override render() {
    const tab = this.activeTab;
    const target = this.target;
    if (!tab || this.suppressed || (!this.embedded && !this.dockLayout.open)) {
      return nothing;
    }
    return html`<section
      class="bp bp--${this.embedded ? "embedded" : "right"} link-reader-panel"
      style=${this.embedded ? nothing : `width:${this.dockLayout.width}px`}
      aria-label=${t("linkReader.title")}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          this.closePanel();
        }
      }}
    >
      ${this.embedded ? nothing : this.dockLayout.renderResizer("bp", t("linkReader.resize"))}
      ${
        this.embedded && this.tabsInHeader
          ? nothing
          : html`<header class="rail-header bp-header lr-tab-header">
              ${renderPanelTabStrip({
                tabs: this.tabs.map((item) => ({
                  id: item.id,
                  domId: item.id + "-label",
                  label: tabLabel(item),
                  title: tabTarget(item)?.href,
                  icon: readerIcon(tabTarget(item)?.reader.icon),
                  className: item.view.status === "loading" ? "is-connecting" : "",
                  closeLabel: t("linkReader.closeTab", { title: tabLabel(item) }),
                })),
                activeId: this.activeId,
                ariaControls: "link-reader-tab-panel",
                onSelect: (id) => this.selectTab(id),
                onClose: (id) => this.closeTab(id),
                onNew: () => this.createTab(),
                newLabel: t("linkReader.newTab"),
                newDisabled: this.tabs.length >= TAB_LIMIT,
              })}
              ${this.embedded ? nothing : renderReaderButton(t("linkReader.close"), icons.x, () => this.closePanel())}
            </header>`
      }
      <form class="lr-toolbar" @submit=${(event: Event) => this.commitUrl(event)}>
        ${renderReaderButton(
          t("linkReader.back"),
          icons.chevronLeft,
          () => this.goHistory(-1),
          tab.index <= 0,
        )}
        ${renderReaderButton(
          t("linkReader.forward"),
          icons.chevronRight,
          () => this.goHistory(1),
          tab.index >= tab.history.length - 1,
        )}
        ${renderReaderButton(
          t("linkReader.refresh"),
          icons.refresh,
          () => this.refresh(),
          !target || !this.available || !this.client || tab.view.status === "loading",
        )}
        <input
          class="lr-url"
          type="text"
          spellcheck="false"
          autocomplete="off"
          .value=${this.urlDraft}
          placeholder=${t("linkReader.urlPlaceholder")}
          aria-label=${t("linkReader.urlPlaceholder")}
          aria-invalid=${this.invalidUrl}
          @input=${(event: Event) => {
            if (!(event.currentTarget instanceof HTMLInputElement)) {
              return;
            }
            this.urlDraft = event.currentTarget.value;
            this.invalidUrl = false;
          }}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Escape") {
              event.preventDefault();
              this.urlDraft = target?.href ?? "";
              this.invalidUrl = false;
            }
          }}
        />
        <button
          class="rail-header__action bp-icon lr-go"
          type="submit"
          title=${t("linkReader.openUrl")}
          aria-label=${t("linkReader.openUrl")}
        >
          ${icons.chevronRight}
        </button>
        ${
          target
            ? html`<a
                class="lr-external"
                href=${target.href}
                target="_blank"
                rel="noopener noreferrer"
                data-link-reader-external
                >${icons.externalLink}<span
                  >${t("linkReader.openExternal", { provider: target.reader.label })}</span
                ></a
              >`
            : nothing
        }
      </form>
      ${
        this.invalidUrl
          ? html`<p class="lr-note" role="alert">${t("linkReader.invalidUrl")}</p>`
          : nothing
      }
      ${
        this.tabLimitUrl
          ? html`<p class="lr-note" role="alert">
              ${t("linkReader.tabLimit")}
              <a
                href=${this.tabLimitUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-link-reader-external
                >${t("linkReader.openOriginal")}</a
              >
            </p>`
          : nothing
      }
      <div
        id="link-reader-tab-panel"
        class="lr-panels"
        role="tabpanel"
        aria-labelledby=${this.embedded && this.tabsInHeader ? nothing : tab.id + "-label"}
        aria-label=${this.embedded && this.tabsInHeader ? tabLabel(tab) : nothing}
      >
        ${repeat(
          this.tabs,
          (item) => item.id,
          (item) =>
            html`<div
              class="lr-content"
              tabindex="-1"
              ?hidden=${item.id !== this.activeId}
              aria-busy=${item.view.status === "loading"}
            >
              ${renderLinkReaderPanelContent(item, this.available && Boolean(this.client), () => this.refresh())}
            </div>`,
        )}
      </div>
    </section>`;
  }
}
if (!customElements.get("openclaw-link-reader-panel")) {
  customElements.define("openclaw-link-reader-panel", OpenClawLinkReaderPanel);
}
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-link-reader-panel": OpenClawLinkReaderPanel;
  }
}
