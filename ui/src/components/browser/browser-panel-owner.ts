import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { hasNativeBrowserBridge } from "../../app/native-browser-bridge.ts";
import { postNativeExternalLink } from "../../app/native-link-routing.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { openExternalUrlSafe } from "../../lib/open-external-url.ts";
import type { AnnotationStroke } from "./browser-annotation.ts";
import type {
  BrowserRequestClient,
  BrowserInspectedNode,
  BrowserPanelTab,
} from "./browser-client.ts";
import {
  closeBrowserTab,
  focusBrowserTab,
  goBrowserHistory,
  isBrowserEvaluateDisabledError,
  isBrowserNavigationBlockedError,
  navigateBrowser,
  openBrowserTab,
  startBrowser,
} from "./browser-client.ts";
import { createBrowserPanelDownload, type BrowserPanelDownload } from "./browser-panel-download.ts";
import { BrowserPanelInputOwner } from "./browser-panel-input-owner.ts";
import { createBrowserPanelNative, type BrowserPanelNative } from "./browser-panel-native-owner.ts";
import {
  createBrowserPanelOperations,
  type BrowserPanelHost,
} from "./browser-panel-operation-ownership.ts";
import { BrowserPanelPendingInput } from "./browser-panel-pending-input.ts";
import { createBrowserPanelSnapshot } from "./browser-panel-snapshot.ts";
import { BrowserPanelStream } from "./browser-panel-stream.ts";
import type { BrowserPanelView } from "./browser-panel-surface.ts";
import { BrowserPanelViewportOwner } from "./browser-panel-viewport-owner.ts";
import { browserRouteKey, type BrowserRoute } from "./browser-target.ts";
import { normalizeBrowserUrlDraft } from "./browser-url.ts";

type BrowserPanelMode = "interact" | "annotate" | "inspect";
type BrowserPanelState = {
  running: boolean | null;
  canAutoResizeViewport: boolean;
  tabs: BrowserPanelTab[];
  /** Stable tab handle (plugin alias when available), not a raw CDP target id. */
  activeTargetId: string | null;
  view: BrowserPanelView | null;
  loading: boolean;
  errorText: string | null;
  noticeText: string | null;
  mode: BrowserPanelMode;
  strokes: AnnotationStroke[];
  inspected: BrowserInspectedNode | null;
  inspectPointer: { x: number; y: number } | null;
  evaluateUnavailable: boolean;
  urlDraft: string;
  pendingNewTab: boolean;
  urlDraftEditing: boolean;
  addressInput: HTMLInputElement | undefined;
};

export type { BrowserPanelHost } from "./browser-panel-operation-ownership.ts";

/** Synchronous browser navigation, capture and input authority; the view owns its lifetime. */
export function createBrowserPanel(host: BrowserPanelHost, notify: () => void) {
  let activeClient: GatewayBrowserClient | null = null;
  const operations = createBrowserPanelOperations(host);
  const pendingInput = new BrowserPanelPendingInput();
  const initialState: BrowserPanelState = {
    running: null,
    canAutoResizeViewport: false,
    tabs: [],
    activeTargetId: null,
    view: null,
    loading: false,
    errorText: null,
    noticeText: null,
    mode: "interact",
    strokes: [],
    inspected: null,
    inspectPointer: null,
    evaluateUnavailable: false,
    urlDraft: "",
    pendingNewTab: false,
    urlDraftEditing: false,
    addressInput: undefined,
  };
  const panel = {
    ...initialState,
    host,
    get native(): BrowserPanelNative {
      return native;
    },
    operations,
    pendingInput,
    get download(): BrowserPanelDownload {
      return download;
    },
    get input(): BrowserPanelInputOwner {
      return input;
    },
    get stream(): BrowserPanelStream {
      return stream;
    },
    suspendView(): void {
      native.cancelCapture();
      native.presentation.hide();
      input.resetCaptureState();
      invalidateViewOperations();
      if (panel.view?.dataUrl.startsWith("blob:")) {
        panel.setState("view", null);
      }
      panel.setState("loading", false);
    },

    setState<Key extends keyof BrowserPanelState>(key: Key, value: BrowserPanelState[Key]): void {
      if (Object.is(panel[key], value)) {
        return;
      }
      if ((key === "view" && value === null) || key === "activeTargetId") {
        stream.close();
      }
      Object.assign(panel, { [key]: value });
      if (key === "view" && panel.view) {
        viewport.captured();
      }
      notify();
      if (key === "activeTargetId" || key === "mode") {
        native.presentation.update();
      }
    },

    synchronizeClient(): boolean {
      if (host.client !== activeClient) {
        activeClient = host.client;
        operations.resetRoute();
        panel.resetBrowserState();
        return true;
      }
      return false;
    },

    get unavailableTabText(): string | null {
      const reason = panel.tabs.find(
        (tab) => tab.id === panel.activeTargetId,
      )?.urlUnavailableReason;
      return reason
        ? t(
            reason === "navigation_blocked"
              ? "browser.navigationBlocked"
              : "browser.navigationCheckFailed",
          )
        : null;
    },

    clearUnavailableView(): boolean {
      if (!panel.unavailableTabText) {
        return false;
      }
      invalidateViewOperations();
      panel.setState("view", null);
      panel.setState("loading", false);
      panel.setState("urlDraft", "");
      panel.setState("errorText", null);
      panel.exitCaptureModes();
      return true;
    },

    resetBrowserState(): void {
      invalidateViewOperations();
      panel.setState("running", null);
      panel.setState("canAutoResizeViewport", false);
      const nativeTab = native.activeTab ?? native.tabs[0];
      panel.setState("tabs", native.tabs);
      panel.setState("activeTargetId", nativeTab?.id ?? null);
      panel.setState("view", null);
      panel.setState("loading", false);
      panel.setState("errorText", null);
      panel.setState("noticeText", null);
      panel.setState("mode", "interact");
      panel.setState("strokes", []);
      input.resetCaptureState();
      panel.setState("inspected", null);
      panel.setState("inspectPointer", null);
      panel.urlDraftEditing = false;
      panel.setState("urlDraft", nativeTab?.url ?? "");
      panel.setState("pendingNewTab", false);
      // Re-probe per connection: another gateway may have evaluate enabled.
      panel.setState("evaluateUnavailable", false);
    },

    reportError(error: unknown): void {
      const detail = isBrowserNavigationBlockedError(error)
        ? t("browser.navigationBlocked")
        : formatUiError(error);
      panel.setState("errorText", t("browser.errors.requestFailed", { error: detail }));
    },

    async refreshAll(): Promise<void> {
      native.presentation.update();
      const client = operations.captureClient();
      if (!client) {
        return;
      }
      const invocation = operations.beginSnapshot(client);
      panel.setState("errorText", null);
      if (!native.activeTab && !stream.ownsView(panel.activeTargetId)) {
        panel.setState("loading", true);
      }
      try {
        const snapshot = await snapshots.listTabs(client);
        // Tool results carry raw targets; preserve that selection when the list supplies its alias.
        const selected = snapshot.tabs.find(
          (tab) => tab.id === panel.activeTargetId || tab.targetId === panel.activeTargetId,
        );
        const active =
          selected ?? snapshot.tabs.find((tab) => !tab.urlUnavailableReason) ?? snapshot.tabs[0];
        if (!operations.acceptSnapshot(invocation, panel.activeTargetId, active?.id ?? null)) {
          return;
        }
        panel.setState("running", snapshot.running);
        panel.setState("canAutoResizeViewport", snapshot.canAutoResizeViewport);
        panel.setState(
          "tabs",
          native.mergeRemoteTabs(operations.retainTabSnapshot(client, snapshot.tabs)),
        );
        if (native.activeTab) {
          return;
        }
        // A mutation may adopt the same tab while this snapshot is pending.
        // Reconcile its tab strip, but never let it own document or loading state.
        if (!invocation.isCurrent()) {
          return;
        }
        if (!snapshot.running) {
          panel.setState("view", null);
        }
        if (panel.activeTargetId !== null && !selected) {
          invalidateViewOperations();
          invocation.epoch = operations.epoch;
          panel.setState("view", null);
          panel.exitCaptureModes();
        }
        panel.setState("activeTargetId", active?.id ?? null);
        panel.syncUrlDraft(active?.url ?? "");
        if (active) {
          await panel.refreshView(active.id, invocation.epoch);
        } else {
          panel.setState("view", null);
        }
      } catch (error) {
        if (invocation.isCurrent()) {
          panel.reportError(error);
        }
      } finally {
        if (invocation.isCurrent() && !native.activeTab) {
          panel.setState("loading", false);
        }
      }
    },

    refreshView: (targetId: string, epoch = operations.epoch) => snapshots.capture(targetId, epoch),

    async runAction(
      action: (client: BrowserRequestClient) => Promise<void>,
      refreshView = true,
    ): Promise<boolean> {
      const client = operations.captureClient();
      if (!client) {
        return false;
      }
      const epoch = operations.epoch;
      const current = () => operations.isLive(epoch, client);
      try {
        panel.setState("errorText", null);
        await action(client);
        if (current() && refreshView) {
          snapshots.scheduleRefresh(epoch, current);
        }
        return current();
      } catch (error) {
        if (!current()) {
          return false;
        }
        if (isBrowserEvaluateDisabledError(error)) {
          panel.setState("evaluateUnavailable", true);
        }
        panel.reportError(error);
        if (!operations.hasPendingCapture) {
          panel.setState("loading", false);
        }
        return false;
      }
    },

    get observedViewportSize(): { width: number; height: number } | null {
      return viewport.observedViewportSize;
    },

    handleViewportResize(width: number, height: number): void {
      viewport.resize(width, height);
      stream.resize();
    },

    async startBrowserNow(): Promise<void> {
      if (host.fixedTab || !operations.captureClient()) {
        return;
      }
      const epoch = operations.epoch;
      panel.setState("loading", true);
      await panel.runAction(async (actionClient) => {
        await startBrowser(actionClient);
        if (operations.isLive(epoch, actionClient)) {
          await panel.refreshAll();
        }
      }, false);
    },

    async openUrl(url: string, options: { newTab: boolean; native?: boolean }): Promise<void> {
      if (host.fixedTab && (options.newTab || options.native || !panel.activeTargetId)) {
        panel.reportError(t("browser.tabUnavailable"));
        return;
      }
      if (
        hasNativeBrowserBridge() &&
        (options.native || options.newTab || native.activeTab || !panel.activeTargetId)
      ) {
        await native.open(url, options.newTab || !native.activeTab);
        return;
      }
      const client = operations.captureClient();
      if (!client) {
        return;
      }
      const invocation = operations.beginMutation(client);
      panel.setState("loading", true);
      panel.setState("errorText", null);
      panel.setState("pendingNewTab", false);
      let previousNavigationQueued = false;
      try {
        if (options.newTab || !panel.activeTargetId) {
          const tab = await openBrowserTab(client, url);
          if (!invocation.isCurrent()) {
            // An already-created stale tab still belongs in the surviving tab strip.
            await snapshots.refreshTabs(client, operations.survivingInvocation(invocation, client));
            return;
          }
          const nextTargetId = tab?.id ?? panel.activeTargetId;
          if (nextTargetId !== panel.activeTargetId) {
            invalidateViewOperations();
            invocation.epoch = operations.epoch;
            panel.setState("view", null);
            panel.exitCaptureModes();
          }
          panel.setState("activeTargetId", nextTargetId);
        } else {
          // Keep the stable alias as the active handle; navigate may swap the
          // raw target underneath and the alias migrates server-side.
          invalidateViewOperations();
          invocation.epoch = operations.epoch;
          panel.exitCaptureModes();
          const targetId = panel.activeTargetId;
          previousNavigationQueued = operations.hasPendingNavigation(client, targetId);
          await operations.queueNavigation(client, targetId, async () => {
            if (invocation.isCurrent()) {
              await navigateBrowser(client, { url, targetId });
              operations.markNavigationCommitted(client, targetId);
            }
          });
          if (!invocation.isCurrent()) {
            return;
          }
          panel.setState("view", null);
        }
        const refreshed = await snapshots.refreshTabs(client, () => invocation.isCurrent());
        if (refreshed !== "rejected" && invocation.isCurrent() && panel.activeTargetId) {
          const targetId = panel.activeTargetId;
          await panel.refreshView(targetId, invocation.epoch);
          if (!options.newTab && invocation.isCurrent() && panel.view?.targetId === targetId) {
            operations.forgetNavigation(client, targetId);
          }
        }
      } catch (error) {
        if (invocation.isCurrent()) {
          if (previousNavigationQueued && panel.activeTargetId) {
            const targetId = panel.activeTargetId;
            // An earlier queued navigation may already have committed remotely.
            // Recover its actual document without replacing an unchanged view.
            const refreshed = await snapshots.refreshTabs(client, () => invocation.isCurrent());
            const active = panel.tabs.find((tab) => tab.id === targetId);
            if (refreshed === "accepted" && invocation.isCurrent() && active) {
              panel.setState("view", null);
              await panel.refreshView(targetId, invocation.epoch);
              if (invocation.isCurrent() && panel.view?.targetId === targetId) {
                operations.forgetNavigation(client, targetId);
              }
            }
            if (invocation.isCurrent() && operations.hasUnreconciledNavigation(client, targetId)) {
              panel.setState("activeTargetId", null);
              panel.setState("view", null);
              panel.syncUrlDraft("");
            }
          }
          panel.reportError(error);
        }
      } finally {
        if (invocation.isCurrent()) {
          panel.setState("loading", false);
        }
      }
    },

    async selectTab(
      targetId: string,
      route?: BrowserRoute,
      options?: { focusBrowserTab?: boolean },
    ): Promise<void> {
      const fixed = host.fixedTab;
      if (
        fixed &&
        ((route && browserRouteKey(route) !== browserRouteKey(fixed)) ||
          (targetId !== fixed.targetId &&
            !panel.tabs.some((tab) => tab.id === targetId && tab.targetId === fixed.targetId)))
      ) {
        return;
      }
      native.cancelPendingActivation(targetId);
      const nativeTab = native.tabs.find((tab) => tab.id === targetId);
      if (nativeTab) {
        invalidateViewOperations();
        panel.exitCaptureModes();
        panel.setState("activeTargetId", targetId);
        panel.setState("view", null);
        panel.setState("urlDraft", nativeTab.url);
        panel.setState("loading", native.activeTab?.loading ?? false);
        panel.setState("errorText", null);
        native.presentation.renew();
        return;
      }
      if (route && browserRouteKey(operations.route) !== browserRouteKey(route)) {
        operations.resetRoute(route);
        panel.resetBrowserState();
      } else if (targetId === panel.activeTargetId && !route) {
        return;
      }
      const client = operations.captureClient();
      const previous = { targetId: panel.activeTargetId, view: panel.view };
      invalidateViewOperations();
      const epoch = operations.epoch;
      panel.setState("activeTargetId", route ? null : targetId);
      panel.setState("view", null);
      panel.exitCaptureModes();
      if (!route && panel.clearUnavailableView()) {
        return;
      }
      const selectionSucceeded = await panel.runAction(async (actionClient) => {
        if (route) {
          // Listing can observe stopped or blocked tabs; focus and capture need a
          // running, accessible tab. A historical target cannot survive a browser restart.
          const refreshed = await snapshots.refreshTabs(actionClient, () =>
            operations.isLive(epoch, actionClient),
          );
          if (!operations.isLive(epoch, actionClient)) {
            return;
          }
          const selected = panel.tabs.find(
            (tab) => tab.id === targetId || tab.targetId === targetId,
          );
          panel.setState(
            "activeTargetId",
            panel.running === false ? null : (selected?.id ?? targetId),
          );
          if (refreshed === "accepted" && panel.running !== false && !selected) {
            throw new Error(t("browser.tabUnavailable"));
          }
          if (panel.clearUnavailableView()) {
            return;
          }
        }
        const selectedTargetId = panel.activeTargetId;
        if (!selectedTargetId) {
          return;
        }
        if (options?.focusBrowserTab !== false) {
          await focusBrowserTab(actionClient, selectedTargetId);
        }
        if (!operations.isLive(epoch, actionClient)) {
          return;
        }
        await panel.refreshView(selectedTargetId, epoch);
        if (
          operations.isLive(epoch, actionClient) &&
          panel.activeTargetId === selectedTargetId &&
          panel.view?.targetId === selectedTargetId
        ) {
          operations.forgetNavigation(actionClient, selectedTargetId);
        }
      }, false);
      if (!selectionSucceeded && operations.isLive(epoch) && panel.activeTargetId === targetId) {
        if (operations.hasPendingNavigation(client, previous.targetId)) {
          // The prior remote document changed while selection failed. Expose an
          // unavailable state instead of restoring a screenshot that no longer owns it.
          panel.setState("activeTargetId", null);
          panel.syncUrlDraft("");
          return;
        }
        panel.setState("activeTargetId", previous.targetId);
        panel.setState("view", previous.view?.dataUrl.startsWith("blob:") ? null : previous.view);
        if (previous.targetId && previous.view?.dataUrl.startsWith("blob:")) {
          await panel.refreshView(previous.targetId);
        }
      }
    },

    async closeTab(targetId: string): Promise<void> {
      if (host.fixedTab) {
        return;
      }
      if (native.tabs.some((tab) => tab.id === targetId)) {
        await native.send({ type: "close", tabId: targetId });
        return;
      }
      await panel.runAction(async (client) => {
        const epoch = operations.epoch;
        await closeBrowserTab(client, targetId);
        operations.forgetNavigation(client, targetId);
        if (!operations.isLive(epoch, client)) {
          if (operations.isLive(operations.epoch, client)) {
            await panel.refreshAll();
          }
          return;
        }
        // DELETE already committed; a failed tab snapshot must not resurrect its
        // target or make the next screenshot address a tab that no longer exists.
        panel.setState(
          "tabs",
          panel.tabs.filter((tab) => tab.id !== targetId),
        );
        const snapshot = await snapshots.refreshTabs(client, () =>
          operations.isLive(epoch, client),
        );
        if (!operations.isLive(epoch, client)) {
          return;
        }
        if (panel.activeTargetId !== targetId) {
          if (snapshot !== "rejected" && !operations.hasPendingCapture) {
            panel.setState("loading", false);
          }
          return;
        }
        const next = panel.tabs.find((tab) => !tab.urlUnavailableReason) ?? panel.tabs[0] ?? null;
        if (next?.kind === "native") {
          await panel.selectTab(next.id);
          return;
        }
        invalidateViewOperations();
        panel.setState("activeTargetId", next?.id ?? null);
        panel.setState("view", null);
        panel.exitCaptureModes();
        if (next) {
          await panel.refreshView(next.id);
        } else {
          panel.setState("loading", false);
        }
      }, false);
      await host.updateComplete;
    },

    /** Real page reload: re-navigate to the current URL, then re-capture. A bare
     * screenshot refresh would leave the remote document untouched. */
    reloadPage(): void {
      if (native.activeTab) {
        panel.exitCaptureModes();
        void native.send({
          type: native.activeTab.loading ? "stop" : "reload",
          tabId: native.activeTab.id,
        });
        return;
      }
      if (panel.unavailableTabText) {
        void panel.refreshAll();
        return;
      }
      const url = panel.view?.metrics?.url || panel.view?.url || panel.urlDraft;
      const normalized = normalizeBrowserUrlDraft(url);
      if (panel.activeTargetId) {
        void (normalized
          ? panel.openUrl(normalized, { newTab: false })
          : panel.refreshView(panel.activeTargetId));
      }
    },

    goHistory(delta: -1 | 1): void {
      if (native.activeTab) {
        panel.exitCaptureModes();
        void native.send({
          type: delta === -1 ? "back" : "forward",
          tabId: native.activeTab.id,
        });
        return;
      }
      const targetId = panel.activeTargetId;
      if (!targetId || !panel.view) {
        return;
      }
      void panel.runAction((client) => goBrowserHistory(client, { targetId, delta }));
    },

    commitUrlDraft(): void {
      const url = normalizeBrowserUrlDraft(panel.urlDraft);
      if (!url) {
        return;
      }
      void panel.openUrl(url, { newTab: panel.pendingNewTab || panel.tabs.length === 0 });
    },

    beginNewTab(): void {
      if (host.fixedTab) {
        return;
      }
      if (hasNativeBrowserBridge()) {
        void native.beginNewTab();
        return;
      }
      panel.setState("pendingNewTab", true);
      panel.setState("urlDraft", "");
      const epoch = operations.epoch;
      void host.updateComplete.then(() => {
        if (operations.isLive(epoch)) {
          panel.addressInput?.focus();
        }
      });
    },

    resetUrlDraftFromView(): void {
      panel.setState(
        "urlDraft",
        native.activeTab?.url || panel.view?.metrics?.url || panel.view?.url || "",
      );
    },

    syncUrlDraft(url: string): void {
      if (!panel.urlDraftEditing) {
        panel.setState("urlDraft", url);
      }
    },

    openExternal(): void {
      const url =
        native.activeTab?.url || panel.view?.metrics?.url || panel.view?.url || panel.urlDraft;
      if (url && !(native.activeTab && postNativeExternalLink(url))) {
        openExternalUrlSafe(url);
      }
    },

    exitCaptureModes(): void {
      native.cancelCapture();
      if (native.activeTab) {
        panel.setState("view", null);
      }
      operations.invalidateInspection();
      input.resetCaptureState();
      panel.setState("mode", "interact");
      panel.setState("strokes", []);
      panel.setState("inspected", null);
      panel.setState("inspectPointer", null);
      stream.flushPendingFrame();
    },

    setMode(mode: BrowserPanelMode): void {
      if (panel.mode === mode) {
        panel.exitCaptureModes();
        return;
      }
      panel.exitCaptureModes();
      if (native.activeTab && mode !== "interact") {
        void native.capture(mode);
        return;
      }
      panel.setState("mode", mode);
      panel.setState("noticeText", null);
      if (mode === "inspect" && panel.evaluateUnavailable) {
        panel.setState("errorText", t("browser.inspectUnavailable"));
        panel.setState("mode", "interact");
      }
    },

    handleOverlayPointerMove(event: PointerEvent): void {
      if (native.activeTab && panel.mode === "inspect") {
        native.inspect(event);
      } else {
        input.handleOverlayPointerMove(event);
      }
    },
  };
  const download = createBrowserPanelDownload(panel, notify);
  const input = new BrowserPanelInputOwner(panel);
  const stream = new BrowserPanelStream(panel);
  const native = createBrowserPanelNative(panel);
  const viewport = new BrowserPanelViewportOwner(panel);
  const snapshots = createBrowserPanelSnapshot(panel);

  function invalidateViewOperations(): void {
    download.cancel();
    stream.close();
    operations.invalidate();
    pendingInput.clear();
    viewport.invalidate();
  }
  return panel;
}

export type BrowserPanel = ReturnType<typeof createBrowserPanel>;
