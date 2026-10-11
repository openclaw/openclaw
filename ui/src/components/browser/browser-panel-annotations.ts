import type {
  BrowserAnnotationCommand,
  BrowserAnnotationControlChange,
  BrowserAnnotationState,
} from "openclaw/plugin-sdk/browser-annotations";
import { t } from "../../i18n/index.ts";
import {
  captureBrowserScreenshot,
  fetchBrowserScreenshotDataUrl,
  type BrowserRequestClient,
} from "./browser-client.ts";
import type { BrowserPanelController } from "./browser-panel-controller.ts";
import {
  browserPanelRemotePoint,
  dispatchCompositedBrowserAnnotation,
  loadBrowserPanelImage,
} from "./browser-panel-surface.ts";

/** Session-owned projection of the page API. Page callbacks never send chat messages. */
export class BrowserPanelAnnotations {
  state: BrowserAnnotationState | null = null;
  busy = false;
  private generation = 0;

  constructor(private readonly controller: BrowserPanelController) {}

  reset(): void {
    this.generation += 1;
    this.state = null;
    this.busy = false;
  }

  private scope() {
    const controller = this.controller;
    const client = controller.operations.captureClient();
    const targetId = controller.activeTargetId;
    if (!client || !targetId || controller.native.activeTab || controller.evaluateUnavailable) {
      return null;
    }
    const epoch = controller.operations.epoch;
    const generation = this.generation;
    return {
      client,
      targetId,
      current: () =>
        generation === this.generation &&
        controller.operations.isLive(epoch, client) &&
        controller.activeTargetId === targetId,
    };
  }

  private request(
    client: BrowserRequestClient,
    targetId: string,
    command: BrowserAnnotationCommand,
  ): Promise<BrowserAnnotationState> {
    return client.request("browser.request", {
      method: "POST",
      path: "/annotations",
      body: { targetId, ...command },
    });
  }

  /** Refresh on attachment and completed user input, not on each video frame. */
  async refresh(): Promise<void> {
    if (this.busy) {
      return;
    }
    const scope = this.scope();
    if (!scope) {
      return;
    }
    const generation = ++this.generation;
    const epoch = this.controller.operations.epoch;
    try {
      const state = await this.request(scope.client, scope.targetId, { action: "state" });
      if (
        generation === this.generation &&
        this.controller.operations.isLive(epoch, scope.client) &&
        this.controller.activeTargetId === scope.targetId
      ) {
        this.state = state;
        this.controller.host.requestUpdate();
      }
    } catch {
      // Optional on existing-session/native transports; ordinary browsing stays available.
      if (generation === this.generation) {
        this.state = null;
        this.controller.host.requestUpdate();
      }
    }
  }

  private async run(command: BrowserAnnotationCommand): Promise<void> {
    if (this.busy) {
      return;
    }
    this.generation += 1;
    const scope = this.scope();
    if (!scope) {
      return;
    }
    this.busy = true;
    this.controller.host.requestUpdate();
    try {
      const state = await this.request(scope.client, scope.targetId, command);
      if (scope.current()) {
        this.state = state;
        this.controller.setState("errorText", null);
        await this.controller.refreshView(scope.targetId);
      }
    } catch (error) {
      if (scope.current()) {
        this.state = null;
        this.controller.reportError(error);
      }
    } finally {
      if (scope.current()) {
        this.busy = false;
        this.controller.host.requestUpdate();
      }
    }
  }

  select(event: MouseEvent): void {
    const state = this.state;
    const point = browserPanelRemotePoint(
      this.controller.host.renderRoot.querySelector(".bp-stage"),
      event,
      this.controller.view,
    );
    if (state?.active && point) {
      void this.run({
        action: "select",
        documentId: state.documentId,
        clientX: point.x,
        clientY: point.y,
      });
    }
  }

  control(change: BrowserAnnotationControlChange["action"], callback: string, value: string): void {
    const state = this.state;
    if (state?.selection) {
      void this.run({
        action: "control",
        documentId: state.documentId,
        change,
        callback,
        value,
        virtualTarget: { surfaceId: state.selection.surfaceId, targetId: state.selection.id },
      });
    }
  }

  stop(): Promise<void> {
    return this.state
      ? this.run({ action: "stop", documentId: this.state.documentId })
      : Promise.resolve();
  }

  async send(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.generation += 1;
    const scope = this.scope();
    const state = this.state;
    const view = this.controller.view;
    if (!scope || !state?.selection || !view) {
      return;
    }
    this.busy = true;
    this.controller.host.requestUpdate();
    try {
      // Capture the actual preview, not a cached frame from before a color change.
      const shot = await captureBrowserScreenshot(scope.client, scope.targetId);
      if (!scope.current()) {
        return;
      }
      const dataUrl = await fetchBrowserScreenshotDataUrl({
        path: shot.path,
        resourceBasePath: this.controller.host.resourceBasePath,
        authToken: this.controller.host.authToken,
      });
      const image = await loadBrowserPanelImage(dataUrl);
      if (!scope.current()) {
        return;
      }
      const current = await this.request(scope.client, scope.targetId, { action: "state" });
      if (!scope.current()) {
        return;
      }
      if (
        current.documentId !== state.documentId ||
        JSON.stringify(current.selection) !== JSON.stringify(state.selection) ||
        JSON.stringify(current.controls) !== JSON.stringify(state.controls)
      ) {
        this.state = current;
        throw new Error(t("browser.surfaceChanged"));
      }
      const selection = state.selection;
      const cssWidth = view.metrics?.cssWidth ?? image.naturalWidth;
      const cssHeight = view.metrics?.cssHeight ?? image.naturalHeight;
      const result = dispatchCompositedBrowserAnnotation(
        { ...view, dataUrl, image, url: shot.url },
        this.controller.tabs.find((tab) => tab.id === scope.targetId),
        [],
        null,
        {
          x: selection.rect.x / cssWidth,
          y: selection.rect.y / cssHeight,
          width: selection.rect.width / cssWidth,
          height: selection.rect.height / cssHeight,
        },
        { selection, controls: state.controls },
      );
      if (result !== "accepted") {
        throw new Error(
          t(result === "unhandled" ? "browser.noChatTarget" : "browser.annotationLimitReached"),
        );
      }
      this.controller.setState("noticeText", t("browser.annotationSent"));
      this.controller.setState("errorText", null);
    } catch (error) {
      if (scope.current()) {
        this.controller.reportError(error);
      }
    } finally {
      if (scope.current()) {
        this.busy = false;
        this.controller.host.requestUpdate();
      }
    }
  }
}
