import {
  captureBrowserScreenshot,
  fetchBrowserScreenshotDataUrl,
  isBrowserEvaluateDisabledError,
  isBrowserNavigationBlockedError,
  listBrowserTabs,
  readBrowserPageMetrics,
  type BrowserPageMetrics,
  type BrowserPanelTab,
  type BrowserRequestClient,
} from "./browser-client.ts";
import type { BrowserPanelNativeController } from "./browser-panel-native-controller.ts";
import type {
  BrowserPanelControllerHost,
  BrowserPanelOperationOwnership,
  BrowserPanelSnapshotOutcome,
} from "./browser-panel-operation-ownership.ts";
import type { BrowserPanelStream } from "./browser-panel-stream.ts";
import { loadBrowserPanelImage, type BrowserPanelView } from "./browser-panel-surface.ts";
import type { BrowserRoute } from "./browser-target.ts";

type BrowserPanelSnapshotState = {
  running: boolean | null;
  tabs: BrowserPanelTab[];
  view: BrowserPanelView | null;
  loading: boolean;
  evaluateUnavailable: boolean;
};

interface BrowserPanelSnapshotHost extends BrowserPanelSnapshotState {
  readonly host: Pick<BrowserPanelControllerHost, "resourceBasePath" | "authToken" | "fixedTab">;
  readonly native: Pick<BrowserPanelNativeController, "activeTab" | "mergeRemoteTabs">;
  readonly stream: Pick<
    BrowserPanelStream,
    "ownsView" | "ensure" | "frameRevision" | "releaseReplacedView"
  >;
  readonly activeTargetId: string | null;
  readonly mode: "interact" | "annotate" | "inspect";
  readonly operations: Pick<
    BrowserPanelOperationOwnership,
    | "epoch"
    | "captureClient"
    | "isLive"
    | "beginCapture"
    | "capturedTabs"
    | "route"
    | "completeCapture"
    | "beginSnapshot"
    | "acceptSnapshot"
    | "retainTabSnapshot"
  >;
  setState<Key extends keyof BrowserPanelSnapshotState>(
    key: Key,
    value: BrowserPanelSnapshotState[Key],
  ): void;
  clearUnavailableView(): boolean;
  syncUrlDraft(url: string): void;
  reportError(error: unknown): void;
}

/** Coordinates remote tab snapshots and their owned page images and input metrics. */
export class BrowserPanelSnapshotController {
  constructor(private readonly controller: BrowserPanelSnapshotHost) {}

  async listTabs(client: BrowserRequestClient) {
    const snapshot = await listBrowserTabs(client);
    const fixed = this.controller.host.fixedTab;
    if (!fixed) {
      return snapshot;
    }
    const tabs = snapshot.tabs.filter(
      (tab) => tab.id === fixed.targetId || tab.targetId === fixed.targetId,
    );
    for (const tab of tabs) {
      tab.id = fixed.targetId;
    }
    return { ...snapshot, tabs };
  }

  async refreshTabs(
    client: BrowserRequestClient,
    current: () => boolean,
  ): Promise<BrowserPanelSnapshotOutcome> {
    const controller = this.controller;
    const invocation = controller.operations.beginSnapshot(client);
    try {
      const snapshot = await this.listTabs(client);
      if (
        current() &&
        controller.operations.acceptSnapshot(
          invocation,
          controller.activeTargetId,
          controller.activeTargetId,
        )
      ) {
        controller.setState("running", snapshot.running);
        controller.setState(
          "tabs",
          controller.native.mergeRemoteTabs(
            controller.operations.retainTabSnapshot(client, snapshot.tabs),
          ),
        );
        controller.clearUnavailableView();
        return "accepted";
      }
      return "rejected";
    } catch {
      // Best-effort tab reconciliation must not let an older failure settle
      // loading or advance a document owned by a newer operation.
      return current() && invocation.isCurrent() ? "failed" : "rejected";
    }
  }

  async capture(targetId: string, epoch = this.controller.operations.epoch): Promise<void> {
    const client = this.controller.operations.captureClient();
    if (
      this.controller.native.activeTab ||
      !client ||
      !this.controller.operations.isLive(epoch, client) ||
      this.controller.activeTargetId !== targetId ||
      this.controller.mode !== "interact"
    ) {
      return;
    }
    if (this.controller.clearUnavailableView() || this.controller.stream.ownsView(targetId)) {
      return;
    }
    const current = this.controller.operations.beginCapture(
      client,
      targetId,
      () => this.controller.activeTargetId,
      epoch,
    );
    if (!current) {
      return;
    }
    this.controller.setState("loading", true);
    const stream = this.controller.stream;
    let captureRevision = stream.frameRevision;
    const captureCurrent = () =>
      current() &&
      this.controller.mode === "interact" &&
      captureRevision === stream.frameRevision &&
      !stream.ownsView(targetId);
    try {
      if (
        (await stream.ensure(targetId, client, epoch)) ||
        !current() ||
        stream.ownsView(targetId)
      ) {
        return;
      }
      captureRevision = stream.frameRevision;
      const view = await captureBrowserPanelOwnedView({
        client,
        targetId,
        route: this.controller.operations.route,
        host: this.controller.host,
        isEvaluateUnavailable: () => this.controller.evaluateUnavailable,
        current: captureCurrent,
        markEvaluateUnavailable: () => this.controller.setState("evaluateUnavailable", true),
      });
      if (!view || !captureCurrent()) {
        return;
      }
      const { metrics } = view;
      // Tab snapshots can lag history and in-page navigation. Keep the stable
      // identity aligned with the document this capture owns.
      this.controller.setState(
        "tabs",
        this.controller.operations.capturedTabs(this.controller.tabs, targetId, metrics, view.url),
      );
      this.controller.setState("view", view);
      stream.releaseReplacedView();
      if (view.url) {
        this.controller.syncUrlDraft(view.url);
      }
    } catch (error) {
      if (captureCurrent()) {
        // A capture denial describes the selected tab; a denied navigation
        // describes the destination and must keep the valid source screenshot.
        if (isBrowserNavigationBlockedError(error)) {
          this.controller.setState(
            "tabs",
            this.controller.tabs.map((tab) =>
              tab.id === targetId
                ? { ...tab, url: "", urlUnavailableReason: "navigation_blocked" }
                : tab,
            ),
          );
          if (!this.controller.clearUnavailableView()) {
            this.controller.reportError(error);
          }
        } else {
          this.controller.reportError(error);
        }
      }
    } finally {
      if (current()) {
        this.controller.operations.completeCapture();
        this.controller.setState("loading", false);
      }
    }
  }
}

/** A stale gateway must not disable evaluation on the replacement browser. */
async function readBrowserPanelOwnedMetrics(
  client: BrowserRequestClient,
  targetId: string,
  evaluateUnavailable: boolean,
  current: () => boolean,
  markEvaluateUnavailable: () => void,
): Promise<BrowserPageMetrics | null> {
  if (evaluateUnavailable || !current()) {
    return null;
  }
  try {
    return await readBrowserPageMetrics(client, targetId);
  } catch (error) {
    if (current() && isBrowserNavigationBlockedError(error)) {
      throw error;
    }
    if (current() && isBrowserEvaluateDisabledError(error)) {
      markEvaluateUnavailable();
    }
    return null;
  }
}

async function captureBrowserPanelOwnedView(params: {
  client: BrowserRequestClient;
  targetId: string;
  route?: BrowserRoute;
  host: Pick<BrowserPanelControllerHost, "resourceBasePath" | "authToken">;
  isEvaluateUnavailable: () => boolean;
  current: () => boolean;
  markEvaluateUnavailable: () => void;
}): Promise<BrowserPanelView | null> {
  const shot = await captureBrowserScreenshot(params.client, params.targetId);
  if (!params.current()) {
    return null;
  }
  // Media transfer and page geometry are independent once the screenshot exists.
  const [dataUrl, observedMetrics] = await Promise.all([
    fetchBrowserScreenshotDataUrl({
      resourceBasePath: params.host.resourceBasePath,
      authToken: params.host.authToken,
      path: shot.path,
    }),
    readBrowserPanelOwnedMetrics(
      params.client,
      params.targetId,
      params.isEvaluateUnavailable(),
      params.current,
      params.markEvaluateUnavailable,
    ),
  ]);
  if (!params.current()) {
    return null;
  }
  const image = await loadBrowserPanelImage(dataUrl);
  if (!params.current()) {
    return null;
  }
  // A navigation between screenshot and evaluation changes the coordinate document.
  const metrics =
    shot.url && observedMetrics?.url && shot.url !== observedMetrics.url ? null : observedMetrics;
  return {
    targetId: params.targetId,
    dataUrl,
    image,
    url: shot.url,
    metrics,
    ...(params.route ? { browserTab: { ...params.route, targetId: params.targetId } } : {}),
  };
}
