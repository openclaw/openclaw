import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ControlUiLinkReaderDocument,
  ControlUiLinkReaderDetailParams,
  ControlUiLinkReaderDescriptor,
} from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import { registerLinkReaderEnglish } from "../i18n/locales/en-link-reader.ts";
import { DockLayoutController } from "./dock-layout-controller.ts";
import { icons } from "./icons.ts";
import { linkReaderErrorMessage } from "./link-reader-error.ts";
import { LinkReaderImages } from "./link-reader-images.ts";
import {
  readerIcon,
  linkReaderPanelLayout,
  tabTarget,
  tabLabel,
  type ReaderTab,
} from "./link-reader-panel-view.ts";
import { linkReaderResponseMatchesTarget } from "./link-reader-response.ts";
import {
  resolveLinkReaderTarget,
  linkReaderTargetKey as targetKey,
  type LinkReaderTarget,
} from "./link-reader-target.ts";
import { PANEL_HOSTED_TABS_CHANGE_EVENT, type PanelHostedTab } from "./panel-hosted-tabs.ts";
import { renderPanelIconButton } from "./panel-icon-button.ts";
import { LINK_READER_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";

registerLinkReaderEnglish();

const HISTORY_LIMIT = 30;
const TAB_LIMIT = 10;
// Only the still-shared dock controller participates in this lifecycle adapter.
type DockController = { hostConnected?(): void; hostDisconnected?(): void };
export type LinkReaderPanelProps = {
  client: GatewayBrowserClient | null;
  available: boolean;
  agentId: string | undefined;
  readers: readonly ControlUiLinkReaderDescriptor[];
  suppressed: boolean;
  embedded: boolean;
  presented: boolean;
  tabsInHeader: boolean;
  sessionKey: string;
  onClose: (() => void) | undefined;
};

/** Browser-style, memory-only tabs for plugin-provided read-only documents. */
export class LinkReaderPanelOwner {
  constructor(
    readonly host: HTMLElement,
    readonly props: LinkReaderPanelProps,
    private readonly invalidate: () => void,
  ) {}
  get client() {
    return this.props.client;
  }
  get available() {
    return this.props.available;
  }
  get agentId() {
    return this.props.agentId;
  }
  get readers() {
    return this.props.readers;
  }
  get suppressed() {
    return this.props.suppressed;
  }
  get embedded() {
    return this.props.embedded;
  }
  get presented() {
    return this.props.presented;
  }
  get tabsInHeader() {
    return this.props.tabsInHeader;
  }
  get sessionKey() {
    return this.props.sessionKey;
  }
  get onClose() {
    return this.props.onClose;
  }
  get isConnected() {
    return this.host.isConnected;
  }
  private controllers: DockController[] = [];
  addController(controller: DockController) {
    this.controllers.push(controller);
  }
  removeController(controller: DockController) {
    this.controllers = this.controllers.filter((item) => item !== controller);
  }
  requestUpdate() {
    this.invalidate();
  }
  dispatchEvent(event: Event) {
    return this.host.dispatchEvent(event);
  }
  get updateComplete() {
    return Promise.resolve(true);
  }
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
    return renderPanelIconButton({
      className: "rail-header__action bp-icon",
      label: t("linkReader.newTab"),
      icon: icons.plus,
      onClick: () => this.createTab(),
      disabled: this.tabs.length >= TAB_LIMIT || !this.available || !this.readers.length,
    });
  }
  async closeHostedTab(id: string): Promise<void> {
    this.closeTab(id);
    await this.updateComplete;
  }
  urlDraft = "";
  invalidUrl = false;
  tabLimitUrl: string | null = null;
  tabs: ReaderTab[] = [];
  activeId: string | null = null;
  private nextTabId = 0;
  private requestAbort: AbortController | null = null;
  private returnFocus: HTMLElement | null = null;
  private scrollContent = false;
  private focusAddress = false;
  refreshRequested = false;
  readonly dockLayout = new DockLayoutController(this, {
    layout: linkReaderPanelLayout,
    reservationPrefix: "link-reader",
    isAvailable: () => this.tabs.length > 0 && !this.suppressed && !this.embedded,
    // Embedded geometry belongs to the region, never the standalone dock store.
    isFullscreen: () => this.embedded,
  });

  get activeTab(): ReaderTab | undefined {
    return this.tabs.find((tab) => tab.id === this.activeId);
  }
  get target(): LinkReaderTarget | null {
    return tabTarget(this.activeTab);
  }

  get panelPresented(): boolean {
    return !this.suppressed && (this.embedded ? this.presented : this.dockLayout.open);
  }

  connect(): void {
    for (const controller of this.controllers) {
      controller.hostConnected?.();
    }
    if (!this.embedded) {
      window.addEventListener(LINK_READER_PANEL_TOGGLE_EVENT, this.handleToggleRequest);
      this.dockLayout.setSuppressed(this.suppressed);
    }
  }
  dispose(): void {
    this.resetTabViews();
    this.tabs = [];
    this.activeId = null;
    this.returnFocus = null;
    window.removeEventListener(LINK_READER_PANEL_TOGGLE_EVENT, this.handleToggleRequest);
    for (const controller of this.controllers) {
      controller.hostDisconnected?.();
    }
  }
  sync(previous?: LinkReaderPanelProps): void {
    const changed = {
      has: (key: keyof LinkReaderPanelProps) => !previous || previous[key] !== this.props[key],
      get: <K extends keyof LinkReaderPanelProps>(key: K): LinkReaderPanelProps[K] | undefined =>
        previous?.[key],
    };
    // SAFETY: PanelView supplies the complete, explicitly keyed props snapshot.
    if (!previous || (Object.keys(previous) as (keyof LinkReaderPanelProps)[]).some(changed.has)) {
      this.requestUpdate();
    }
    if (changed.has("embedded")) {
      window.removeEventListener(LINK_READER_PANEL_TOGGLE_EVENT, this.handleToggleRequest);
      if (!this.embedded && this.isConnected) {
        window.addEventListener(LINK_READER_PANEL_TOGGLE_EVENT, this.handleToggleRequest);
      }
    }
    if (changed.has("sessionKey") && changed.get("sessionKey") !== undefined) {
      this.resetTabViews();
      this.tabs = [];
      this.activeId = null;
      this.urlDraft = "";
      this.invalidUrl = false;
      this.tabLimitUrl = null;
      this.returnFocus = null;
      this.focusAddress = false;
      this.scrollContent = false;
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
      // Cached documents belong to this connection epoch, never a replacement gateway.
      this.resetTabViews();
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
      this.focusAddress = false;
    }
    if (this.isConnected && this.panelPresented && this.activeTab?.view.status === "idle") {
      void this.loadDetail();
    }
  }
  afterRender(): void {
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
      this.host.querySelector<HTMLInputElement>(".lr-url")?.focus();
    }
    const content = this.host.querySelector<HTMLElement>(".lr-content:not([hidden])");
    if (this.scrollContent && content && this.activeTab?.view.status === "ready") {
      this.scrollContent = false;
      content.scrollTop = 0;
      const hash = this.target ? new URL(this.target.href).hash.slice(1) : "";
      const anchor = [...content.querySelectorAll<HTMLElement>("[id]")].find(
        (node) => node.id === hash,
      );
      anchor?.scrollIntoView?.({ block: "start" });
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
  private resetTabViews(): void {
    this.abortRequest();
    for (const tab of this.tabs) {
      this.setTabView(tab, { status: "idle" });
    }
  }
  selectHostedTab(id: string): void {
    if (id === this.activeId || !this.tabs.some((tab) => tab.id === id)) {
      return;
    }
    this.abortRequest();
    this.activeId = id;
    this.urlDraft = this.target?.href ?? "";
    this.invalidUrl = false;
    this.tabLimitUrl = null;
    this.scrollContent = false;
    this.requestUpdate();
  }
  createTab(target?: LinkReaderTarget): void {
    if (this.tabs.length >= TAB_LIMIT) {
      this.tabLimitUrl = target?.href ?? null;
      this.requestUpdate();
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
    this.scrollContent = Boolean(target);
    if (!this.embedded) {
      this.dockLayout.setOpen(true);
    } else {
      this.requestUpdate();
    }
  }
  closeTab(id: string): void {
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
        this.selectHostedTab(fallback.id);
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
    this.focusAddress = false;
    this.scrollContent = true;
    this.requestUpdate();
  }
  readonly handleToggleRequest = (event: Event): void => {
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
          : active instanceof HTMLElement && active !== this.host
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
        this.selectHostedTab(existing.id);
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
  };
  closePanel(): void {
    this.abortRequest();
    if (!this.embedded) {
      this.dockLayout.setOpen(false);
    } else {
      this.onClose?.();
      this.requestUpdate();
    }
    this.scrollContent = false;
    this.focusAddress = false;
    if (this.returnFocus?.isConnected) {
      this.returnFocus.focus({ preventScroll: true });
    }
    this.returnFocus = null;
  }
  refresh(): void {
    this.abortRequest();
    if (this.activeTab) {
      this.setTabView(this.activeTab, { status: "idle" });
    }
    this.refreshRequested = true;
    this.requestUpdate();
  }
  goHistory(offset: number): void {
    const tab = this.activeTab;
    if (!tab || tab.index + offset < 0 || tab.index + offset >= tab.history.length) {
      return;
    }
    this.abortRequest();
    tab.index += offset;
    this.setTabView(tab, { status: "idle" });
    this.urlDraft = this.target?.href ?? "";
    this.invalidUrl = false;
    this.scrollContent = true;
    this.requestUpdate();
  }
  commitUrl(event: Event): void {
    event.preventDefault();
    const draft = this.urlDraft.trim();
    const target = resolveLinkReaderTarget(
      /^[a-z][a-z0-9+.-]*:/iu.test(draft) ? draft : "https://" + draft,
      this.readers,
    );
    this.invalidUrl = !target;
    if (target) {
      this.navigate(target);
    } else {
      this.requestUpdate();
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
}
