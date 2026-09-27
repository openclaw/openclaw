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
  exitCaptureModes(): void;
}

type BrowserPanelDrawingGesture = {
  pointerId: number;
  captureTarget: HTMLElement;
  stroke: AnnotationStroke;
};

/** Owns pointer, keyboard, annotation, and inspection input for the browser surface. */
export class BrowserPanelInputController {
  // An annotation stroke belongs to one pointer until that owner or the panel lifecycle ends.
  private drawingGesture: BrowserPanelDrawingGesture | null = null;
  private suppressStageClick = false;
  private inspectionError: string | null = null;
  private pendingClick: Promise<boolean> | null = null;
  private clickSequence = 0;
  private inputGeneration = 0;
  private pendingText: Promise<boolean | undefined> | null = null;
  private compositionCurrent: (() => boolean) | null = null;
  private touchScroll: {
    pointerId: number;
    startX: number;
    startY: number;
    point: { x: number; y: number };
    scrolling: boolean;
    current: () => boolean;
  } | null = null;

  constructor(private readonly host: BrowserPanelInputHost) {}

  resetCaptureState(): void {
    this.host.pendingInput.clearInput();
    this.cancelOverlayPointerGesture();
    this.pendingClick = null;
    this.pendingText = null;
    this.compositionCurrent = null;
    this.touchScroll = null;
    const input = this.host.host.renderRoot.querySelector<HTMLTextAreaElement>(".bp-input");
    if (input) {
      input.value = "";
      input.blur();
    }
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
      // Inspect capture and touch scrolling must not also click the remote page.
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
    const previous = this.pendingText
      ? Promise.all([this.pendingClick, this.pendingText])
      : this.pendingClick;
    this.pendingClick = previous ? previous.then(click) : click();
  }

  handleWheel(event: WheelEvent): void {
    if (this.queueScroll(event.deltaX, event.deltaY)) {
      event.preventDefault();
    }
  }

  private queueScroll(horizontal: number, vertical: number): boolean {
    if (this.host.mode !== "interact" || !this.host.view) {
      return false;
    }
    const client = this.host.operations.captureClient();
    const targetId = this.host.activeTargetId;
    if (!client || !targetId || this.host.view.targetId !== targetId) {
      return false;
    }
    const epoch = this.host.operations.epoch;
    this.host.pendingInput.queueWheel(horizontal, vertical, 150, (deltaX, deltaY) => {
      if (
        !this.host.operations.isLive(epoch, client) ||
        this.host.activeTargetId !== targetId ||
        this.host.view?.targetId !== targetId ||
        this.host.mode !== "interact"
      ) {
        return;
      }
      void this.host.runAction(async (actionClient) => {
        if (this.host.evaluateUnavailable) {
          // No page JS allowed: fall back to a coarse keyboard scroll.
          await pressBrowserKey(actionClient, {
            targetId,
            key: deltaY >= 0 ? "PageDown" : "PageUp",
          });
          return;
        }
        await scrollBrowserBy(actionClient, { targetId, deltaX, deltaY });
      });
    });
    return true;
  }

  private captureInputCurrent(): () => boolean {
    const client = this.host.operations.captureClient();
    const targetId = this.host.activeTargetId;
    const epoch = this.host.operations.epoch;
    const generation = this.inputGeneration;
    const clickSequence = this.clickSequence;
    return () =>
      Boolean(
        client &&
        targetId &&
        this.host.operations.isLive(epoch, client) &&
        this.host.activeTargetId === targetId &&
        this.host.view?.targetId === targetId &&
        this.inputGeneration === generation &&
        this.clickSequence === clickSequence &&
        this.host.mode === "interact",
      );
  }

  handleTouchPointerDown(event: PointerEvent): void {
    if (this.touchScroll) {
      return;
    }
    this.suppressStageClick = false;
    if (event.pointerType !== "touch" || this.host.mode !== "interact") {
      return;
    }
    const point = this.remotePoint(event);
    const current = this.captureInputCurrent();
    if (point && current()) {
      this.touchScroll = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        point,
        scrolling: false,
        current,
      };
    }
  }

  handleTouchPointerMove(event: PointerEvent): void {
    const gesture = this.touchScroll;
    if (!gesture || gesture.pointerId !== event.pointerId || !gesture.current()) {
      return;
    }
    if (
      !gesture.scrolling &&
      Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 8
    ) {
      return;
    }
    const point = this.remotePoint(event);
    if (!point) {
      return;
    }
    event.preventDefault();
    gesture.scrolling = true;
    this.suppressStageClick = true;
    this.queueScroll(gesture.point.x - point.x, gesture.point.y - point.y);
    gesture.point = point;
  }

  handleTouchPointerEnd(event: PointerEvent): void {
    if (this.touchScroll?.pointerId === event.pointerId) {
      this.touchScroll = null;
    }
  }

  handleCompositionStart(): void {
    this.compositionCurrent = this.captureInputCurrent();
  }

  handleCompositionEnd(event: CompositionEvent): void {
    const current = this.compositionCurrent;
    this.compositionCurrent = null;
    if (current?.() && event.data) {
      this.runAfterClick((client, targetId) =>
        insertBrowserText(client, { targetId, text: event.data }),
      );
    }
    if (event.currentTarget instanceof HTMLTextAreaElement) {
      event.currentTarget.value = "";
    }
  }

  handleTextInput(event: InputEvent): void {
    // Let the IME own its local composition; only its final text goes to the remote field.
    if (event.isComposing || this.compositionCurrent) {
      return;
    }
    if (event.type === "beforeinput" && !event.cancelable) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const input = event.currentTarget;
    const text = event.data ?? (input instanceof HTMLTextAreaElement ? input.value : "");
    if (
      ["insertText", "insertReplacementText", "insertFromPaste"].includes(event.inputType) &&
      text
    ) {
      this.runAfterClick((client, targetId) => insertBrowserText(client, { targetId, text }));
    } else {
      const key =
        event.inputType === "deleteContentBackward"
          ? "Backspace"
          : event.inputType === "deleteContentForward"
            ? "Delete"
            : event.inputType === "insertLineBreak" || event.inputType === "insertParagraph"
              ? "Enter"
              : null;
      if (key) {
        this.runAfterClick((client, targetId) => pressBrowserKey(client, { targetId, key }));
      }
    }
    // insertFromComposition follows compositionend on WebKit; the end event already sent it.
    if (input instanceof HTMLTextAreaElement) {
      input.value = "";
    }
  }

  handleViewportKeydown(event: KeyboardEvent): void {
    if (this.host.mode !== "interact" || !this.host.view) {
      return;
    }
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      this.compositionCurrent ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
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
    const generation = this.inputGeneration;
    const run = (): Promise<boolean> | undefined => {
      if (
        !this.host.operations.isLive(epoch, client) ||
        this.host.activeTargetId !== targetId ||
        this.host.view?.targetId !== targetId ||
        this.host.mode !== "interact" ||
        this.inputGeneration !== generation
      ) {
        return undefined;
      }
      return this.host.runAction((actionClient) => action(actionClient, targetId));
    };
    const click = this.pendingClick;
    const afterClick = () =>
      click ? click.then((succeeded) => (succeeded ? run() : undefined)) : run();
    // Text, deletion and submit must reach the same focused field in input order.
    this.pendingText = this.pendingText
      ? this.pendingText.then(afterClick)
      : Promise.resolve(afterClick());
  }

  handleOverlayPointerDown(event: PointerEvent): void {
    if (this.host.mode === "inspect") {
      this.suppressStageClick = true;
      void this.sendAnnotation({ element: this.host.inspected });
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
    if (event.pointerId === this.drawingGesture?.pointerId) {
      this.drawingGesture = null;
    }
  }

  cancelOverlayPointerGesture(): void {
    const gesture = this.drawingGesture;
    this.drawingGesture = null;
    if (!gesture) {
      return;
    }
    try {
      if (gesture.captureTarget.hasPointerCapture(gesture.pointerId)) {
        gesture.captureTarget.releasePointerCapture(gesture.pointerId);
      }
    } catch {
      // Capture may already be gone because its canvas was detached.
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
    this.host.exitCaptureModes();
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
