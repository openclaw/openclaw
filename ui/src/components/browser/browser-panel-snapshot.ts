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
import type { BrowserPanelPendingInput } from "./browser-panel-pending-input.ts";
import type { BrowserPanelStream } from "./browser-panel-stream.ts";
import { loadBrowserPanelImage, type BrowserPanelView } from "./browser-panel-surface.ts";

const ACTION_REFRESH_DELAY_MS = 350;

type BrowserPanelSnapshotState = {
  running: boolean | null;
  canAutoResizeViewport: boolean;
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
  readonly pendingInput: Pick<BrowserPanelPendingInput, "scheduleRefresh">;
  readonly mode: "interact" | "annotate" | "inspect";
  readonly operations: Pick<
    BrowserPanelOperationOwnership,
    | "epoch"
    | "hasPendingCapture"
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
export function createBrowserPanelSnapshot(controller: BrowserPanelSnapshotHost) {
  function scheduleRefresh(epoch: number, current: () => boolean): void {
    controller.pendingInput.scheduleRefresh(
      ACTION_REFRESH_DELAY_MS,
      () => {
        if (current() && controller.activeTargetId) {
          void capture(controller.activeTargetId, epoch);
        }
      },
      () => !controller.operations.hasPendingCapture,
    );
  }

  async function listTabs(client: BrowserRequestClient) {
    const snapshot = await listBrowserTabs(client);
    const fixed = controller.host.fixedTab;
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

  async function refreshTabs(
    client: BrowserRequestClient,
    current: () => boolean,
  ): Promise<BrowserPanelSnapshotOutcome> {
    const invocation = controller.operations.beginSnapshot(client);
    try {
      const snapshot = await listTabs(client);
      if (
        current() &&
        controller.operations.acceptSnapshot(
          invocation,
          controller.activeTargetId,
          controller.activeTargetId,
        )
      ) {
        controller.setState("running", snapshot.running);
        controller.setState("canAutoResizeViewport", snapshot.canAutoResizeViewport);
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

  async function capture(targetId: string, epoch = controller.operations.epoch): Promise<void> {
    const client = controller.operations.captureClient();
    if (
      controller.native.activeTab ||
      !client ||
      !controller.operations.isLive(epoch, client) ||
      controller.activeTargetId !== targetId ||
      controller.mode !== "interact"
    ) {
      return;
    }
    if (controller.clearUnavailableView() || controller.stream.ownsView(targetId)) {
      return;
    }
    const current = controller.operations.beginCapture(
      client,
      targetId,
      () => controller.activeTargetId,
      epoch,
    );
    if (!current) {
      return;
    }
    controller.setState("loading", true);
    const stream = controller.stream;
    let captureRevision = stream.frameRevision;
    const captureCurrent = () =>
      current() &&
      controller.mode === "interact" &&
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
      const route = controller.operations.route;
      const host = controller.host;
      const shot = await captureBrowserScreenshot(client, targetId);
      if (!captureCurrent()) {
        return;
      }
      // Media transfer and page geometry are independent once the screenshot exists.
      const [dataUrl, observedMetrics] = await Promise.all([
        fetchBrowserScreenshotDataUrl({
          resourceBasePath: host.resourceBasePath,
          authToken: host.authToken,
          path: shot.path,
        }),
        readBrowserPanelOwnedMetrics(
          client,
          targetId,
          controller.evaluateUnavailable,
          captureCurrent,
          () => controller.setState("evaluateUnavailable", true),
        ),
      ]);
      if (!captureCurrent()) {
        return;
      }
      const image = await loadBrowserPanelImage(dataUrl);
      if (!captureCurrent()) {
        return;
      }
      // A navigation between screenshot and evaluation changes the coordinate document.
      const metrics =
        shot.url && observedMetrics?.url && shot.url !== observedMetrics.url
          ? null
          : observedMetrics;
      const view: BrowserPanelView = {
        targetId,
        dataUrl,
        image,
        url: shot.url,
        metrics,
        ...(route ? { browserTab: { ...route, targetId } } : {}),
      };
      // Tab snapshots can lag history and in-page navigation. Keep the stable
      // identity aligned with the document this capture owns.
      controller.setState(
        "tabs",
        controller.operations.capturedTabs(controller.tabs, targetId, metrics, view.url),
      );
      controller.setState("view", view);
      stream.releaseReplacedView();
      if (view.url) {
        controller.syncUrlDraft(view.url);
      }
    } catch (error) {
      if (captureCurrent()) {
        // A capture denial describes the selected tab; a denied navigation
        // describes the destination and must keep the valid source screenshot.
        if (isBrowserNavigationBlockedError(error)) {
          controller.setState(
            "tabs",
            controller.tabs.map((tab) =>
              tab.id === targetId
                ? { ...tab, url: "", urlUnavailableReason: "navigation_blocked" }
                : tab,
            ),
          );
          if (!controller.clearUnavailableView()) {
            controller.reportError(error);
          }
        } else {
          controller.reportError(error);
        }
      }
    } finally {
      if (current()) {
        controller.operations.completeCapture();
        controller.setState("loading", false);
      }
    }
  }
  return { scheduleRefresh, listTabs, refreshTabs, capture };
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
