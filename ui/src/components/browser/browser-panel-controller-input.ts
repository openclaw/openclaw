import { t } from "../../i18n/index.ts";
import type { AnnotationStroke } from "./browser-annotation.ts";
import type {
  BrowserRequestClient,
  BrowserInspectedNode,
  BrowserPanelTab,
} from "./browser-client.ts";
import {
  clickBrowserCoords,
  inspectBrowserElementAt,
  insertBrowserText,
  isBrowserEvaluateDisabledError,
  pressBrowserKey,
  scrollBrowserBy,
} from "./browser-client.ts";
import type { BrowserPanelOperationOwnership } from "./browser-panel-operation-ownership.ts";
import type { BrowserPanelPendingInput } from "./browser-panel-pending-input.ts";
import {
  browserPanelInspectHighlightRegion,
  browserPanelNormalizedPoint,
  browserPanelRemotePoint,
  browserPanelShouldForwardKey,
  dispatchCompositedBrowserAnnotation,
  paintBrowserPanelOverlay,
  type BrowserPanelView,
} from "./browser-panel-surface.ts";

const INSPECT_THROTTLE_MS = 120;
const SCROLL_DRAG_THRESHOLD = 6;

type BrowserPanelInputState = {
  mode: "interact" | "annotate" | "inspect";
  strokes: AnnotationStroke[];
  view: BrowserPanelView | null;
  tabs: BrowserPanelTab[];
  activeTargetId: string | null;
  inspected: BrowserInspectedNode | null;
  inspectPointer: { x: number; y: number } | null;
  evaluateUnavailable: boolean;
  errorText: string | null;
  noticeText: string | null;
};

interface BrowserPanelInputHost extends BrowserPanelInputState {
  readonly host: {
    readonly renderRoot: HTMLElement | DocumentFragment;
    readonly updateComplete: Promise<boolean>;
  };
  readonly operations: Pick<
    BrowserPanelOperationOwnership,
    "beginInspection" | "captureClient" | "epoch" | "isLive"
  >;
  readonly pendingInput: Pick<
    BrowserPanelPendingInput,
    "clearInput" | "queueInspection" | "queueWheel"
  >;
  setState<Key extends keyof BrowserPanelInputState>(
    key: Key,
    value: BrowserPanelInputState[Key],
  ): void;
  runAction(
    action: (client: BrowserRequestClient) => Promise<void>,
    refreshView?: boolean,
  ): Promise<boolean>;
  reportError(error: unknown): void;
  exitCaptureModes(preserveStageClick?: boolean): void;
}

type BrowserPanelDrawingGesture = {
  pointerId: number;
  captureTarget: HTMLElement;
  stroke: AnnotationStroke;
};

type BrowserPanelScrollGesture = {
  pointerId: number;
  captureTarget: HTMLElement;
  startX: number;
  startY: number;
  lastPoint: { x: number; y: number };
  moved: boolean;
};

/** Owns pointer, keyboard, annotation, and inspection input for the browser surface. */
export class BrowserPanelInputController {
  // An annotation stroke belongs to one pointer until that owner or the panel lifecycle ends.
  private drawingGesture: BrowserPanelDrawingGesture | null = null;
  private scrollGesture: BrowserPanelScrollGesture | null = null;
  private suppressStageClick = false;
  private inspectionError: string | null = null;
  private pendingClick: Promise<boolean> | null = null;
  private clickSequence = 0;
  private inputGeneration = 0;

  constructor(private readonly host: BrowserPanelInputHost) {}

  resetCaptureState(preserveStageClick = false): void {
    this.host.pendingInput.clearInput();
    this.cancelOverlayPointerGesture();
    if (!preserveStageClick) {
      this.suppressStageClick = false;
    }
    this.pendingClick = null;
    this.clickSequence += 1;
    this.inputGeneration += 1;
  }

  private stageElement(): HTMLElement | null {
    return this.host.host.renderRoot.querySelector<HTMLElement>(".bp-stage");
  }

  private remotePoint(event: MouseEvent): { x: number; y: number } | null {
    return browserPanelRemotePoint(this.stageElement(), event, this.host.view);
  }

  inspectHighlightRegion() {
    return browserPanelInspectHighlightRegion(this.host.view, this.host.inspected);
  }

  handleStageClick(event: MouseEvent): void {
    if (this.suppressStageClick) {
      // The click that follows an inspect-capture pointerdown lands after the
      // mode already returned to interact; it must not reach the remote page.
      this.suppressStageClick = false;
      return;
    }
    if (this.host.mode !== "interact") {
      return;
    }
    // The empty input gives WebKit native Paste commands for the remote page.
    this.host.host.renderRoot
      .querySelector<HTMLElement>(".bp-input")
      ?.focus({ preventScroll: true });
    const point = this.remotePoint(event);
    const targetId = this.host.activeTargetId;
    const client = this.host.operations.captureClient();
    if (!point || !targetId || !client) {
      return;
    }
    const epoch = this.host.operations.epoch;
    const generation = this.inputGeneration;
    const click = () => {
      if (
        this.inputGeneration !== generation ||
        !this.host.operations.isLive(epoch, client) ||
        this.host.activeTargetId !== targetId ||
        this.host.mode !== "interact"
      ) {
        return Promise.resolve(false);
      }
      return this.host.runAction((actionClient) =>
        clickBrowserCoords(actionClient, { targetId, x: point.x, y: point.y }),
      );
    };
    this.clickSequence += 1;
    // Preserve click order and failure: a failed click can leave the previous field focused.
    this.pendingClick = this.pendingClick ? this.pendingClick.then(click) : click();
  }

  handleWheel(event: WheelEvent): void {
    if (this.host.mode !== "interact" || !this.host.view) {
      return;
    }
    const client = this.host.operations.captureClient();
    const targetId = this.host.activeTargetId;
    if (!client || !targetId) {
      return;
    }
    event.preventDefault();
    this.queueScroll(client, targetId, event.deltaX, event.deltaY);
  }

  private queueScroll(
    client: BrowserRequestClient,
    targetId: string,
    deltaX: number,
    deltaY: number,
  ): void {
    const epoch = this.host.operations.epoch;
    this.host.pendingInput.queueWheel(deltaX, deltaY, 150, (pendingX, pendingY) => {
      if (
        !this.host.operations.isLive(epoch, client) ||
        this.host.activeTargetId !== targetId ||
        this.host.mode !== "interact"
      ) {
        return;
      }
      void this.host.runAction(async (actionClient) => {
        if (this.host.evaluateUnavailable) {
          // No page JS allowed: fall back to a coarse keyboard scroll.
          await pressBrowserKey(actionClient, {
            targetId,
            key: pendingY >= 0 ? "PageDown" : "PageUp",
          });
          return;
        }
        await scrollBrowserBy(actionClient, { targetId, deltaX: pendingX, deltaY: pendingY });
      });
    });
  }

  handleViewportKeydown(event: KeyboardEvent): void {
    if (this.host.mode !== "interact" || !this.host.view) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const key = event.key;
    if (!browserPanelShouldForwardKey(key)) {
      return;
    }
    event.preventDefault();
    this.runAfterClick((client, targetId) => pressBrowserKey(client, { targetId, key }));
  }

  handleViewportPaste(event: ClipboardEvent): void {
    // Clipboard bytes belong to the remote field, never the local textarea or chat.
    event.preventDefault();
    event.stopPropagation();
    if (!event.clipboardData?.types.includes("text/plain")) {
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (text) {
      this.runAfterClick((client, targetId) => insertBrowserText(client, { targetId, text }));
    }
  }

  private runAfterClick(
    action: (client: BrowserRequestClient, targetId: string) => Promise<void>,
  ): void {
    const targetId = this.host.activeTargetId;
    const client = this.host.operations.captureClient();
    if (
      !client ||
      !targetId ||
      this.host.view?.targetId !== targetId ||
      this.host.mode !== "interact"
    ) {
      return;
    }
    const epoch = this.host.operations.epoch;
    const clickSequence = this.clickSequence;
    const run = () => {
      if (
        !this.host.operations.isLive(epoch, client) ||
        this.host.activeTargetId !== targetId ||
        this.host.view?.targetId !== targetId ||
        this.host.mode !== "interact" ||
        this.clickSequence !== clickSequence
      ) {
        return;
      }
      void this.host.runAction((actionClient) => action(actionClient, targetId));
    };
    if (this.pendingClick) {
      void this.pendingClick.then((succeeded) => {
        if (succeeded) {
          run();
        }
      });
    } else {
      run();
    }
  }

  handleOverlayPointerDown(event: PointerEvent): void {
    this.suppressStageClick = false;
    if (this.host.mode === "inspect") {
      this.suppressStageClick = true;
      void this.sendAnnotation({ element: this.host.inspected });
      return;
    }
    if (
      this.host.mode === "interact" &&
      this.host.view &&
      this.host.view.kind !== "native" &&
      (event.pointerType === "touch" || event.pointerType === "pen") &&
      event.button === 0 &&
      !this.scrollGesture
    ) {
      const point = this.remotePoint(event);
      const captureTarget =
        event.currentTarget instanceof HTMLElement
          ? event.currentTarget
          : event.target instanceof HTMLElement
            ? event.target
            : null;
      if (!point || !captureTarget) {
        return;
      }
      try {
        captureTarget.setPointerCapture(event.pointerId);
      } catch {
        // Detached and synthetic targets can reject capture; owner filtering still applies.
      }
      this.scrollGesture = {
        pointerId: event.pointerId,
        captureTarget,
        startX: event.clientX,
        startY: event.clientY,
        lastPoint: point,
        moved: false,
      };
      return;
    }
    if (this.host.mode !== "annotate" || event.button !== 0 || this.drawingGesture) {
      return;
    }
    const point = browserPanelNormalizedPoint(this.stageElement(), event);
    if (!point) {
      return;
    }
    const captureTarget =
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget
        : event.target instanceof HTMLElement
          ? event.target
          : null;
    if (!captureTarget) {
      return;
    }
    event.preventDefault();
    try {
      captureTarget.setPointerCapture(event.pointerId);
    } catch {
      // Detached and synthetic targets can reject capture; owner filtering still applies.
    }
    const gesture = {
      pointerId: event.pointerId,
      captureTarget,
      stroke: { points: [point] },
    };
    this.drawingGesture = gesture;
    this.host.setState("strokes", [...this.host.strokes, gesture.stroke]);
    this.paintOverlay();
  }

  handleOverlayPointerMove(event: PointerEvent): void {
    const scrollGesture = this.scrollGesture;
    if (this.host.mode === "interact" && scrollGesture?.pointerId === event.pointerId) {
      const point = this.remotePoint(event);
      if (!point) {
        return;
      }
      if (
        !scrollGesture.moved &&
        Math.hypot(event.clientX - scrollGesture.startX, event.clientY - scrollGesture.startY) <
          SCROLL_DRAG_THRESHOLD
      ) {
        return;
      }
      scrollGesture.moved = true;
      const client = this.host.operations.captureClient();
      const targetId = this.host.activeTargetId;
      if (client && targetId) {
        this.queueScroll(
          client,
          targetId,
          scrollGesture.lastPoint.x - point.x,
          scrollGesture.lastPoint.y - point.y,
        );
      }
      scrollGesture.lastPoint = point;
      return;
    }
    if (this.host.mode === "annotate") {
      const gesture = this.drawingGesture;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      const point = browserPanelNormalizedPoint(this.stageElement(), event);
      if (point) {
        gesture.stroke.points.push(point);
        this.paintOverlay();
      }
      return;
    }
    if (this.host.mode === "inspect") {
      this.queueInspect(event);
    }
  }

  handleOverlayPointerUp(event: PointerEvent): void {
    if (event.pointerId === this.scrollGesture?.pointerId) {
      if (this.scrollGesture.moved) {
        this.suppressStageClick = true;
      }
      this.scrollGesture = null;
    }
    if (event.pointerId === this.drawingGesture?.pointerId) {
      this.drawingGesture = null;
    }
  }

  cancelOverlayPointerGesture(): void {
    const gestures = [this.drawingGesture, this.scrollGesture];
    this.drawingGesture = null;
    this.scrollGesture = null;
    for (const gesture of gestures) {
      if (!gesture) {
        continue;
      }
      try {
        if (gesture.captureTarget.hasPointerCapture(gesture.pointerId)) {
          gesture.captureTarget.releasePointerCapture(gesture.pointerId);
        }
      } catch {
        // Capture may already be gone because its target was detached.
      }
    }
  }

  private queueInspect(event: PointerEvent): void {
    const client = this.host.operations.captureClient();
    const point = this.remotePoint(event);
    const stagePoint = browserPanelNormalizedPoint(this.stageElement(), event);
    const targetId = this.host.activeTargetId;
    if (!client || !point || !stagePoint || !targetId || this.host.evaluateUnavailable) {
      return;
    }
    const current = this.host.operations.beginInspection(
      client,
      () =>
        this.host.activeTargetId === targetId &&
        this.host.view?.targetId === targetId &&
        this.host.mode === "inspect",
    );
    this.host.setState("inspected", null);
    this.host.setState("inspectPointer", stagePoint);
    this.paintOverlay();
    this.host.pendingInput.queueInspection(INSPECT_THROTTLE_MS, current, () => {
      void inspectBrowserElementAt(client, { targetId, x: point.x, y: point.y })
        .then((node) => {
          if (current()) {
            if (this.inspectionError !== null && this.host.errorText === this.inspectionError) {
              this.host.setState("errorText", null);
            }
            this.inspectionError = null;
            this.host.setState("inspected", node);
            this.paintOverlay();
          }
        })
        .catch((error: unknown) => {
          if (!current()) {
            return;
          }
          if (isBrowserEvaluateDisabledError(error)) {
            this.host.setState("evaluateUnavailable", true);
            this.host.setState("errorText", t("browser.inspectUnavailable"));
            this.host.setState("mode", "interact");
            return;
          }
          this.host.reportError(error);
          this.inspectionError = this.host.errorText;
        });
    });
  }

  undoStroke(): void {
    this.cancelOverlayPointerGesture();
    this.host.setState("strokes", this.host.strokes.slice(0, -1));
    this.paintOverlay();
  }

  clearStrokes(): void {
    this.cancelOverlayPointerGesture();
    this.host.setState("strokes", []);
    this.paintOverlay();
  }

  async sendAnnotation(params: { element?: BrowserInspectedNode | null }): Promise<void> {
    this.cancelOverlayPointerGesture();
    const view = this.host.view;
    const tab = this.host.tabs.find((entry) => entry.id === this.host.activeTargetId);
    const element = params.element ?? null;
    if (!view || (this.host.strokes.length === 0 && !element)) {
      return;
    }
    const highlight = element ? this.inspectHighlightRegion() : null;
    let result: ReturnType<typeof dispatchCompositedBrowserAnnotation>;
    try {
      result = dispatchCompositedBrowserAnnotation(
        view,
        tab,
        this.host.strokes,
        element,
        highlight,
      );
    } catch (error) {
      this.host.reportError(error);
      return;
    }
    if (result !== "accepted") {
      this.host.setState("noticeText", null);
      this.host.setState(
        "errorText",
        t(result === "unhandled" ? "browser.noChatTarget" : "browser.annotationLimitReached"),
      );
      return;
    }
    this.host.setState("errorText", null);
    this.host.setState("noticeText", t("browser.annotationSent"));
    this.host.exitCaptureModes(this.suppressStageClick);
  }

  /** Repaints the live stroke/highlight overlay; cheap, runs after render. */
  paintOverlay(): void {
    paintBrowserPanelOverlay(
      this.host.host.renderRoot.querySelector<HTMLCanvasElement>(".bp-overlay"),
      this.stageElement(),
      this.host.strokes,
      this.host.mode === "inspect" ? this.inspectHighlightRegion() : null,
    );
  }
}
