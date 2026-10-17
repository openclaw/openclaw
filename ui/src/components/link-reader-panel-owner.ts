import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ControlUiLinkReaderDocument,
  ControlUiLinkReaderDetailParams,
  ControlUiLinkReaderDescriptor,
} from "../../../src/shared/control-ui-link-reader.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import { registerLinkReaderEnglish } from "../i18n/locales/en-link-reader.ts";
import { createDockLayout } from "./dock-layout.ts";
import { linkReaderErrorMessage } from "./link-reader-error.ts";
import { LinkReaderImages } from "./link-reader-images.ts";
import {
  readerIcon,
  linkReaderPanelLayout,
  tabTarget,
  tabLabel,
  type ReaderTab,
  type ReaderSection,
  createReaderReadyView,
} from "./link-reader-panel-view.ts";
import { linkReaderResponseMatchesTarget } from "./link-reader-response.ts";
import {
  resolveLinkReaderTarget,
  linkReaderTargetKey as targetKey,
  type LinkReaderTarget,
} from "./link-reader-target.ts";
import { PANEL_HOSTED_TABS_CHANGE_EVENT, type PanelHostedTab } from "./panel-hosted-tabs.ts";

registerLinkReaderEnglish();

const HISTORY_LIMIT = 30;
export const LINK_READER_TAB_LIMIT = 10;
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

/** Browser-style, memory-only tabs and connection-scoped document authority. */
export function createLinkReaderPanel(host: HTMLElement, props: LinkReaderPanelProps) {
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  let hostedSignature = "";

  function hostedTabs() {
    return state.tabs.map((tab) => ({
      id: tab.id,
      label: tabLabel(tab),
      url: tabTarget(tab)?.href,
      title: tabTarget(tab)?.href,
      icon: readerIcon(tabTarget(tab)?.reader.icon, host.ownerDocument),
      className: tab.view.status === "loading" ? "is-connecting" : "",
    })) satisfies PanelHostedTab[];
  }
  // Request admission and tab identity are synchronous; the projection only observes them.
  const state: {
    urlDraft: string;
    invalidUrl: boolean;
    tabLimitUrl: string | null;
    tabs: ReaderTab[];
    activeId: string | null;
  } = {
    urlDraft: "",
    invalidUrl: false,
    tabLimitUrl: null,
    tabs: [],
    activeId: null,
  };
  let refreshRequested = false;
  let nextTabId = 0;
  let requestAbort: AbortController | null = null;
  let returnFocus: HTMLElement | null = null;
  let scrollContent = false;
  let focusAddress = false;
  const dockLayout = createDockLayout({
    notify: publish,
    isEmbedded: () => props.embedded,
    layout: linkReaderPanelLayout,
    reservationPrefix: "link-reader",
    isAvailable: () => state.tabs.length > 0 && !props.suppressed && !props.embedded,
    // Embedded geometry belongs to the region, never the standalone dock store.
    isFullscreen: () => props.embedded,
  });

  function activeTab(): ReaderTab | undefined {
    return state.tabs.find((tab) => tab.id === state.activeId);
  }
  function currentTarget(): LinkReaderTarget | null {
    return tabTarget(activeTab());
  }

  function panelPresented(): boolean {
    return !props.suppressed && (props.embedded ? props.presented : dockLayout.open);
  }

  function dispose(): void {
    resetTabViews();
    state.tabs = [];
    state.activeId = null;
    returnFocus = null;
    dockLayout.dispose();
  }
  function sync(previous?: LinkReaderPanelProps): void {
    const changed = {
      has: (key: keyof LinkReaderPanelProps) => !previous || previous[key] !== props[key],
      get: <K extends keyof LinkReaderPanelProps>(key: K): LinkReaderPanelProps[K] | undefined =>
        previous?.[key],
    };
    // SAFETY: PanelView supplies the complete, explicitly keyed props snapshot.
    if (!previous || (Object.keys(previous) as (keyof LinkReaderPanelProps)[]).some(changed.has)) {
      publish();
    }
    if (changed.has("sessionKey") && changed.get("sessionKey") !== undefined) {
      resetTabViews();
      state.tabs = [];
      state.activeId = null;
      state.urlDraft = "";
      state.invalidUrl = false;
      state.tabLimitUrl = null;
      returnFocus = null;
      focusAddress = false;
      scrollContent = false;
    }
    if (props.embedded && !props.presented) {
      abortRequest();
    }
    const previousReaders = changed.get("readers");
    const readersChanged =
      changed.has("readers") &&
      (!previousReaders ||
        previousReaders.length !== props.readers.length ||
        previousReaders.some((reader, index) => reader !== props.readers[index]));
    if (
      changed.has("client") ||
      changed.has("available") ||
      changed.has("agentId") ||
      readersChanged
    ) {
      // Cached documents belong to this connection epoch, never a replacement gateway.
      resetTabViews();
    }
    if (readersChanged && props.available) {
      // Disabled or replaced contributions cannot retain old data or request authority.
      state.tabs = state.tabs.flatMap((tab) => {
        const current = tabTarget(tab);
        if (!current) {
          return props.readers.length > 0 ? [tab] : [];
        }
        if (!resolveLinkReaderTarget(current.href, props.readers)) {
          return [];
        }
        tab.history = tab.history.flatMap((entry) => {
          const resolved = resolveLinkReaderTarget(entry.href, props.readers);
          return resolved ? [resolved] : [];
        });
        tab.index = tab.history.findIndex((entry) => entry.href === current.href);
        return [tab];
      });
      if (!state.tabs.some((tab) => tab.id === state.activeId)) {
        state.activeId = state.tabs[0]?.id ?? null;
      }
      state.urlDraft = currentTarget()?.href ?? "";
      if (state.tabs.length === 0 && previousReaders?.length) {
        closePanel();
      }
    }
    if (changed.has("suppressed")) {
      abortRequest();
    }
    if (!props.embedded) {
      dockLayout.setSuppressed(props.suppressed);
      dockLayout.restoreOpenState();
      dockLayout.syncReservation();
    }
    // A menu-opened slot starts with an address draft. Closing its last tab
    // lets the region remove the slot instead of recreating it on every update.
    if (
      props.embedded &&
      panelPresented() &&
      state.tabs.length === 0 &&
      props.available &&
      props.readers.length > 0 &&
      (["embedded", "presented", "sessionKey", "available"] as const).some((key) =>
        changed.has(key),
      )
    ) {
      createTab();
      focusAddress = false;
    }
    resume();
  }
  function resume(): void {
    const active = activeTab();
    if (
      host.isConnected &&
      panelPresented() &&
      (active?.view.status === "idle" || refreshRequested)
    ) {
      void loadDetail();
    }
    if (
      host.isConnected &&
      panelPresented() &&
      active?.view.status === "ready" &&
      !active.view.refreshing
    ) {
      for (const section of ["checks", "discussion"] as const) {
        if (active.view.sections[section] === "idle") {
          void loadDetail(section);
        }
      }
    }
  }
  function afterRender(
    address: HTMLInputElement | undefined,
    content: HTMLElement | undefined,
  ): void {
    const signature = JSON.stringify([
      state.activeId,
      props.available,
      props.readers.length,
      state.tabs.map((tab) => [
        tab.id,
        tabLabel(tab),
        tabTarget(tab)?.href,
        tabTarget(tab)?.reader.icon,
        tab.view.status,
      ]),
    ]);
    if (signature !== hostedSignature) {
      hostedSignature = signature;
      host.dispatchEvent(
        new Event(PANEL_HOSTED_TABS_CHANGE_EVENT, { bubbles: true, composed: true }),
      );
    }
    if (!panelPresented()) {
      return;
    }
    if (focusAddress) {
      focusAddress = false;
      address?.focus();
    }
    if (scrollContent && content && activeTab()?.view.status === "ready") {
      scrollContent = false;
      content.scrollTop = 0;
      const target = currentTarget();
      const hash = target ? new URL(target.href).hash.slice(1) : "";
      const anchor = [...content.querySelectorAll<HTMLElement>("[id]")].find(
        (node) => node.id === hash,
      );
      anchor?.scrollIntoView?.({ block: "start" });
    }
  }
  function abortRequest(): void {
    const active = activeTab();
    requestAbort?.abort();
    requestAbort = null;
    if (active?.view.status === "loading") {
      active.view = { status: "idle" };
    }
    if (active?.view.status === "ready") {
      active.view.refreshing = false;
      for (const section of ["checks", "files", "discussion"] as const) {
        if (active.view.sections[section] === "loading") {
          active.view.sections[section] = "idle";
        }
      }
    }
    refreshRequested = false;
  }
  function setTabView(tab: ReaderTab, view: ReaderTab["view"]): void {
    if (tab.view.status === "ready") {
      tab.view.images?.dispose();
    }
    tab.view = view;
  }
  function resetTabViews(): void {
    abortRequest();
    for (const tab of state.tabs) {
      setTabView(tab, { status: "idle" });
    }
  }
  function selectHostedTab(id: string): void {
    if (id === state.activeId || !state.tabs.some((tab) => tab.id === id)) {
      return;
    }
    abortRequest();
    state.activeId = id;
    state.urlDraft = currentTarget()?.href ?? "";
    state.invalidUrl = false;
    state.tabLimitUrl = null;
    scrollContent = false;
    publish();
  }
  function createTab(target?: LinkReaderTarget): void {
    if (state.tabs.length >= LINK_READER_TAB_LIMIT) {
      state.tabLimitUrl = target?.href ?? null;
      publish();
      return;
    }
    abortRequest();
    const tab: ReaderTab = {
      id: "link-reader-tab-" + ++nextTabId,
      history: target ? [target] : [],
      index: target ? 0 : -1,
      view: { status: "idle" },
    };
    state.tabs.push(tab);
    state.activeId = tab.id;
    state.urlDraft = target?.href ?? "";
    state.invalidUrl = false;
    state.tabLimitUrl = null;
    focusAddress = !target;
    scrollContent = Boolean(target);
    if (!props.embedded) {
      dockLayout.setOpen(true);
    } else {
      publish();
    }
  }
  function closeTab(id: string): void {
    const index = state.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) {
      return;
    }
    const active = id === state.activeId;
    if (active) {
      abortRequest();
    }
    setTabView(state.tabs[index]!, { status: "idle" });
    state.tabs.splice(index, 1);
    state.tabLimitUrl = null;
    if (state.tabs.length === 0) {
      state.activeId = null;
      closePanel();
      return;
    }
    if (active) {
      state.activeId = null;
      const fallback = state.tabs[Math.min(index, state.tabs.length - 1)];
      if (fallback) {
        selectHostedTab(fallback.id);
      }
    }
    publish();
  }
  function navigate(target: LinkReaderTarget): void {
    const tab = activeTab();
    if (!tab) {
      createTab(target);
      return;
    }
    const previous = tabTarget(tab);
    if (previous?.href !== target.href) {
      abortRequest();
      tab.history = [...tab.history.slice(0, tab.index + 1), target].slice(-HISTORY_LIMIT);
      tab.index = tab.history.length - 1;
      if (!previous || targetKey(previous) !== targetKey(target)) {
        setTabView(tab, { status: "idle" });
      }
    }
    state.urlDraft = target.href;
    state.invalidUrl = false;
    focusAddress = false;
    scrollContent = true;
    publish();
  }
  const handleToggleRequest = (event: Event): void => {
    const payload: unknown = event instanceof CustomEvent ? event.detail : undefined;
    const detail = isRecord(payload) ? payload : null;
    if (detail?.open === false) {
      closePanel();
      return;
    }
    const target =
      typeof detail?.url === "string" ? resolveLinkReaderTarget(detail.url, props.readers) : null;
    if (
      !host.isConnected ||
      !props.available ||
      !props.client ||
      props.suppressed ||
      (props.embedded && !props.presented) ||
      !props.readers.length ||
      (detail?.url !== undefined && !target)
    ) {
      return;
    }
    event.preventDefault();
    if (!panelPresented() || (props.embedded && !returnFocus)) {
      const active = document.activeElement;
      returnFocus =
        detail?.trigger instanceof HTMLElement
          ? detail.trigger
          : active instanceof HTMLElement && active !== host
            ? active
            : null;
    }
    if (!target && detail?.newTab) {
      createTab();
      return;
    }
    if (target) {
      const existing =
        detail?.newTab !== false
          ? state.tabs.find((tab) => {
              const current = tabTarget(tab);
              return current && targetKey(current) === targetKey(target);
            })
          : undefined;
      if (existing) {
        selectHostedTab(existing.id);
        navigate(target);
      } else if (detail?.newTab === false || (activeTab() && !currentTarget())) {
        navigate(target);
      } else {
        createTab(target);
      }
    } else if (!activeTab()) {
      createTab();
    }
    if (!props.embedded) {
      dockLayout.setOpen(true);
    } else {
      publish();
    }
  };
  function closePanel(): void {
    abortRequest();
    if (!props.embedded) {
      dockLayout.setOpen(false);
    } else {
      props.onClose?.();
      publish();
    }
    scrollContent = false;
    focusAddress = false;
    if (returnFocus?.isConnected) {
      returnFocus.focus({ preventScroll: true });
    }
    returnFocus = null;
  }
  function refreshDocument(): void {
    abortRequest();
    refreshRequested = true;
    publish();
  }
  function goHistory(offset: number): void {
    const tab = activeTab();
    if (!tab || tab.index + offset < 0 || tab.index + offset >= tab.history.length) {
      return;
    }
    abortRequest();
    tab.index += offset;
    setTabView(tab, { status: "idle" });
    state.urlDraft = currentTarget()?.href ?? "";
    state.invalidUrl = false;
    scrollContent = true;
    publish();
  }
  function commitUrl(event: Event): void {
    event.preventDefault();
    const draft = state.urlDraft.trim();
    const target = resolveLinkReaderTarget(
      /^[a-z][a-z0-9+.-]*:/iu.test(draft) ? draft : "https://" + draft,
      props.readers,
    );
    state.invalidUrl = !target;
    if (target) {
      navigate(target);
    } else {
      publish();
    }
  }
  function requestSection(section: ReaderSection): void {
    const view = activeTab()?.view;
    if (view?.status !== "ready" || view.refreshing || !view.sections[section]) {
      return;
    }
    const refresh = view.sections[section] === "error";
    if (refresh) {
      view.sections[section] = "idle";
    }
    void loadDetail(section, refresh);
  }
  async function loadDetail(section?: ReaderSection, refresh = refreshRequested): Promise<void> {
    const target = currentTarget();
    const tab = activeTab();
    const client = props.client;
    const agentId = props.agentId;
    const sessionKey = props.sessionKey;
    const generation = client?.connectionGeneration;
    const recoveryScope = client?.recoveryScope;
    if (!target || !tab || !client || !props.available || !panelPresented()) {
      return;
    }
    const previous = tab.view.status === "ready" ? tab.view : undefined;
    if (section && (!previous || previous.refreshing || previous.sections[section] !== "idle")) {
      return;
    }
    const request = section ? (requestAbort ??= new AbortController()) : new AbortController();
    if (section && previous) {
      previous.sections[section] = "loading";
    } else {
      requestAbort = request;
      if (previous) {
        previous.refreshing = true;
        previous.message = undefined;
      } else {
        tab.view = { status: "loading" };
      }
    }
    const isCurrent = () =>
      requestAbort === request &&
      !request.signal.aborted &&
      host.isConnected &&
      props.client === client &&
      props.agentId === agentId &&
      props.sessionKey === sessionKey &&
      client.connectionGeneration === generation &&
      client.recoveryScope === recoveryScope &&
      props.available &&
      panelPresented() &&
      activeTab() === tab &&
      currentTarget()?.href === target.href &&
      props.readers.includes(target.reader);
    const requestParams: ControlUiLinkReaderDetailParams = {
      url: target.href,
      ...(target.reader.linkReader.sessionScoped ? { sessionKey } : {}),
      ...(agentId ? { agentId } : {}),
      ...(refresh ? { refresh: true } : {}),
      ...(target.reader.linkReader.progressive ? { section: section ?? "overview" } : {}),
    };
    refreshRequested = false;
    publish();
    try {
      const detail = await client.request<ControlUiLinkReaderDocument>(
        target.reader.linkReader.detailMethod,
        requestParams,
        { signal: request.signal },
      );
      if (isCurrent()) {
        if (!detail || !linkReaderResponseMatchesTarget(target, detail.url)) {
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Link document does not match the requested target",
          });
        }
        if (section && previous) {
          if (detail.revision !== previous.detail.revision) {
            previous.sections[section] = "error";
            previous.message = t("linkReader.revisionChanged");
          } else if (
            // Optional upstream failures can arrive as successful, empty partial documents.
            (section === "checks" &&
              previous.detail.checks &&
              detail.checks?.truncated &&
              !detail.checks.items.length) ||
            (section === "files" &&
              previous.detail.files?.length &&
              detail.filesTruncated &&
              !detail.files?.length) ||
            (section === "discussion" &&
              previous.detail.comments?.length &&
              detail.commentsTruncated &&
              !detail.comments?.length)
          ) {
            previous.sections[section] = "error";
          } else {
            const fields =
              section === "checks"
                ? { checks: detail.checks }
                : section === "files"
                  ? {
                      files: detail.files,
                      filesTotal: detail.filesTotal,
                      filesTruncated: detail.filesTruncated,
                    }
                  : {
                      comments: detail.comments,
                      commentsTotal: detail.commentsTotal,
                      commentsTruncated: detail.commentsTruncated,
                    };
            previous.detail = { ...previous.detail, ...fields };
            delete previous.sections[section];
          }
          publish();
          return;
        }
        const next = createReaderReadyView(detail, previous);
        const imageMethod = target.reader.linkReader.imageMethod;
        const images = imageMethod
          ? new LinkReaderImages(
              client,
              imageMethod,
              () =>
                host.isConnected &&
                props.available &&
                props.client === client &&
                props.agentId === agentId &&
                props.sessionKey === sessionKey &&
                client.connectionGeneration === generation &&
                client.recoveryScope === recoveryScope &&
                state.tabs.includes(tab) &&
                props.readers.includes(target.reader) &&
                tab.view === next,
            )
          : undefined;
        next.images = images;
        setTabView(tab, next);
        if (next.sections.files && previous?.detail.files) {
          void loadDetail("files");
        }
        publish();
      }
    } catch (error) {
      if (isCurrent()) {
        // Access/identity failures remove retained content and retire sibling reads.
        const retryable =
          !(error instanceof GatewayRequestError) ||
          error.retryable ||
          (isRecord(error.details) && error.details.retryable === true);
        if (previous && retryable) {
          previous.refreshing = false;
          if (section) {
            previous.sections[section] = "error";
          } else {
            previous.message = linkReaderErrorMessage(error);
          }
        } else {
          abortRequest();
          setTabView(tab, { status: "error", message: linkReaderErrorMessage(error) });
        }
        publish();
      }
    }
  }
  return {
    state,
    props,
    dockLayout,
    activeTab,
    target: currentTarget,
    hostedTabs,
    sync,
    resume,
    afterRender,
    dispose,
    selectHostedTab,
    createTab,
    closeTab,
    handleToggleRequest,
    closePanel,
    refresh: refreshDocument,
    goHistory,
    commitUrl,
    requestSection,
    editUrl(value: string) {
      state.urlDraft = value;
      state.invalidUrl = false;
      publish();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type LinkReaderPanelOwner = ReturnType<typeof createLinkReaderPanel>;
