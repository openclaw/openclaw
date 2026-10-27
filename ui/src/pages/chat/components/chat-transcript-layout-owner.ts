import type { Virtualizer } from "@tanstack/virtual-core";
import { CONTROL_UI_BUILD_INFO } from "../../../build-info.ts";
import { i18n } from "../../../i18n/index.ts";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import { getExpandedToolCards, getExpandedUserMessages } from "../chat-thread.ts";
import type { ChatWidgetLayout } from "../session-message-cache.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { measureTranscriptRow } from "./chat-transcript-geometry.ts";
import {
  publishTranscriptScroll,
  readTranscriptViewport,
} from "./chat-transcript-scroll-events.ts";

export type ComposerActivityLayout = {
  strip: HTMLElement;
  pills: ReadonlySet<HTMLElement>;
};

/** Match ResizeObserver's fractional border box without pane transition transforms. */
export function unscaledBorderBox(element: HTMLElement, style = getComputedStyle(element)) {
  const borderBox = style.boxSizing === "border-box";
  const dimension = (size: "width" | "height", start: "Left" | "Top", end: "Right" | "Bottom") =>
    Number.parseFloat(style[size]) +
    (borderBox
      ? 0
      : Number.parseFloat(style[`padding${start}`]) +
        Number.parseFloat(style[`padding${end}`]) +
        Number.parseFloat(style[`border${start}Width`]) +
        Number.parseFloat(style[`border${end}Width`]));
  return {
    width: dimension("width", "Left", "Right"),
    height: dimension("height", "Top", "Bottom"),
  };
}

/** The native scroll range changes only at these viewport and content writes. */
export class TranscriptLayoutOwner {
  ready = false;
  rows: readonly { key: string; revision?: string }[] = [];
  rowLayout?: ChatWidgetLayout;
  private rowPresentation = "";
  rowWidth = 0;
  paneWidth = 0;
  rowGutter = 0;
  private recordingRows = false;

  configureRows(props: ChatThreadProps, avatarPlacement: string, transient: boolean): void {
    this.ready = !props.loading;
    // Expanded and filtered rows are transient; the snapshot cannot restore them.
    this.rowLayout = transient ? undefined : props.widgetLayout;
    const theme = props.applicationContext?.theme;
    const font = theme?.settings;
    const presentation = JSON.stringify([
      CONTROL_UI_BUILD_INFO.buildId,
      avatarPlacement,
      props.chatBubbleMode,
      i18n.getLocale(),
      font?.fontChat,
      font?.fontUi,
      font?.terminalFontFamily,
      font?.textScale,
      font?.chatMessageMaxWidth,
      theme?.resolvedMode,
      font?.theme,
      font?.customTheme,
      props.showThinking,
      props.showToolCalls,
      props.persistCommentary,
      typeof window === "undefined" ? 1 : window.devicePixelRatio,
      ...getExpandedToolCards(props.sessionKey),
      ...getExpandedUserMessages(props.sessionKey),
    ]);
    this.rowPresentation = `${presentation.length}:${fnv1aUtf16(presentation)}`;
  }

  private rowLayoutKey(index: number, width = this.rowWidth): string | undefined {
    const row = this.rows[index];
    return width > 0 && this.paneWidth > 0 && row?.revision
      ? `row:v1:${width}:${this.paneWidth}:${window.innerHeight}:${this.rowGutter}:${this.rowPresentation}:${row.revision}:${JSON.stringify(row.key)}`
      : undefined;
  }

  readonly rowMinimum = (index: number): number => {
    const key = this.rowLayoutKey(index);
    return key ? (this.rowLayout?.read(key) ?? 0) : 0;
  };

  restoreRows(
    instance: Virtualizer<HTMLDivElement, HTMLElement>,
    width: number,
    paneWidth: number,
    gutter: number,
  ): void {
    this.rowWidth = width;
    this.paneWidth = paneWidth;
    this.rowGutter = gutter;
    this.rows.forEach((row, index) => {
      const minimum = this.rowMinimum(index);
      if (minimum > (instance.itemSizeCache.get(row.key) ?? 0)) {
        instance.resizeItem(index, minimum);
      }
    });
  }

  readonly measureRow: typeof measureTranscriptRow = (element, entry, instance) => {
    const size = measureTranscriptRow(element, entry, instance);
    return Math.max(size, this.rowMinimum(instance.indexFromElement(element)));
  };

  persistRows(instance: Virtualizer<HTMLDivElement, HTMLElement>): void {
    if (this.recordingRows || !this.rowLayout) {
      return;
    }
    this.recordingRows = true;
    // The reveal owner admits this work; reuse measured sizes after paint.
    requestAnimationFrame(() => {
      (globalThis.requestIdleCallback ?? requestAnimationFrame).call(globalThis, () => {
        this.recordingRows = false;
        if (
          !this.viewport?.isConnected ||
          !this.ready ||
          instance.scrollElement !== this.viewport
        ) {
          return;
        }
        this.rowLayout?.writeRows(
          Object.fromEntries(
            [...instance.elementsCache].flatMap(([id, element]) => {
              // Local disclosure state is not restored on reload.
              if (
                !element.isConnected ||
                element.matches(
                  ":has(details[open], .chat-tool-card__raw-toggle[aria-expanded='true'], .code-block-wrapper:is(.is-expanded, .is-wrapped, .is-json-raw))",
                )
              ) {
                return [];
              }
              const key = this.rowLayoutKey(instance.indexFromElement(element));
              const size = instance.itemSizeCache.get(id) ?? 0;
              return key && size > 0 && size <= 8000 ? [[key, size]] : [];
            }),
          ),
        );
      });
    });
  }

  private viewport: HTMLDivElement | null = null;
  private observers: ResizeObserver[] = [];
  private composerFloat: HTMLElement | null = null;
  private getComposerFloat: (() => HTMLElement | null) | undefined;
  private getComposerActivityLayout: (() => ComposerActivityLayout | null) | undefined;
  private activityLayout: ComposerActivityLayout | null = null;
  private activityFootprint: { left: number; right: number; top: number; bottom: number } | null =
    null;
  private readonly rangeHeights = new WeakMap<HTMLElement, number>();

  private geometryTarget: HTMLElement | undefined;

  constructor(private readonly onLayoutChange: (before: number, after: number) => void) {}

  get viewportResizePending(): boolean {
    const viewport = this.viewport;
    const slot = viewport?.parentElement;
    const height = slot?.clientHeight;
    if (!viewport || !slot || !height) {
      return false;
    }
    const style = getComputedStyle(slot);
    return (
      height !== viewport.clientHeight ||
      style.paddingTop !== viewport.style.paddingTop ||
      this.bottomPadding(style, this.composerGeometry(slot)?.overlap ?? 0) !==
        viewport.style.paddingBottom
    );
  }

  connect(
    viewport: HTMLDivElement | null,
    targets: {
      geometryEventTarget?: HTMLElement;
      getComposerFloat?: () => HTMLElement | null;
      getComposerActivityLayout?: () => ComposerActivityLayout | null;
    } = {},
  ): void {
    const sameViewport = viewport === this.viewport;
    if (!sameViewport) {
      this.disconnect();
    }
    this.geometryTarget = targets.geometryEventTarget;
    this.getComposerFloat = targets.getComposerFloat;
    this.getComposerActivityLayout = targets.getComposerActivityLayout;
    if (sameViewport) {
      return;
    }
    this.viewport = viewport;
    const slot = viewport?.parentElement;
    if (!viewport || !slot) {
      return;
    }
    const resize = (entries: ResizeObserverEntry[]) => {
      const entry = entries.find((candidate) => candidate.target === slot);
      if (this.viewport === viewport) {
        this.sync(entry?.borderBoxSize[0], true);
      }
    };
    // Padding and viewport size can change independently; neither box covers both.
    this.observers = (["content-box", "border-box"] as const).map((box) => {
      const observer = new ResizeObserver(resize);
      observer.observe(slot, { box });
      return observer;
    });
  }

  sync(size?: ResizeObserverSize, refreshActivity = false): void {
    const viewport = this.viewport;
    const slot = viewport?.parentElement;
    if (!viewport?.isConnected || !slot || (!size && slot.getClientRects().length === 0)) {
      return;
    }
    const style = getComputedStyle(slot);
    const rect = size
      ? { width: size.inlineSize, height: size.blockSize }
      : unscaledBorderBox(slot, style);
    if (!rect.width || !rect.height) {
      return;
    }
    const floating = this.getComposerFloat?.() ?? null;
    if (floating !== this.composerFloat) {
      if (this.composerFloat) {
        this.observers[0]?.unobserve(this.composerFloat);
      }
      this.composerFloat = floating;
      if (floating) {
        this.observers[0]?.observe(floating);
      }
    }
    const { paddingTop } = style;
    const geometry = this.composerGeometry(slot);
    const paddingBottom = this.bottomPadding(style, geometry?.overlap ?? 0);
    const activity = this.getComposerActivityLayout?.() ?? null;
    if (activity !== this.activityLayout || refreshActivity) {
      this.activityLayout = activity;
      this.measureActivityFootprint(geometry?.bounds);
    }
    const footprint = this.activityFootprint;
    const buttonHalf =
      Number.parseFloat(style.getPropertyValue("--chat-scroll-to-bottom-size")) / 2;
    const gap = Number.parseFloat(style.getPropertyValue("--chat-scroll-to-bottom-gap"));
    const center = geometry ? geometry.viewport.left + geometry.viewport.width / 2 : 0;
    const baselineBottom = geometry ? geometry.viewport.bottom - gap : 0;
    const overlapsCenter =
      geometry &&
      footprint &&
      geometry.bounds.left + footprint.left < center + buttonHalf &&
      geometry.bounds.left + footprint.right > center - buttonHalf &&
      geometry.bounds.top + footprint.top < baselineBottom &&
      geometry.bounds.top + footprint.bottom > baselineBottom - buttonHalf * 2;
    const clearance = `${
      overlapsCenter
        ? Math.max(0, geometry.viewport.bottom - geometry.bounds.top - footprint.top)
        : 0
    }px`;
    if (
      this.geometryTarget?.style.getPropertyValue("--chat-scroll-to-bottom-clearance") !== clearance
    ) {
      this.geometryTarget?.style.setProperty("--chat-scroll-to-bottom-clearance", clearance);
    }
    const width = `${rect.width}px`;
    const height = `${rect.height}px`;
    if (
      viewport.style.width === width &&
      viewport.style.height === height &&
      viewport.style.paddingTop === paddingTop &&
      viewport.style.paddingBottom === paddingBottom
    ) {
      return;
    }
    const before = viewport.style.height === "" ? null : viewport.scrollTop;
    viewport.style.width = width;
    viewport.style.height = height;
    viewport.style.paddingTop = paddingTop;
    viewport.style.paddingBottom = paddingBottom;
    if (before !== null) {
      this.publishResize(before);
    }
  }

  private composerGeometry(slot: HTMLElement) {
    const floating = this.composerFloat;
    if (!floating || floating.getClientRects().length === 0) {
      return null;
    }
    const bounds = floating.getBoundingClientRect();
    if (bounds.height === 0) {
      return null;
    }
    const viewport = slot.getBoundingClientRect();
    return { bounds, viewport, overlap: Math.max(0, viewport.bottom - bounds.top) };
  }

  // The existing resize/strip-scroll notifications refresh this footprint.
  // Transcript updates reuse it instead of measuring every activity button.
  private measureActivityFootprint(origin?: DOMRect): void {
    const activity = this.activityLayout;
    this.activityFootprint = null;
    if (!origin || !activity) {
      return;
    }
    const strip = activity.strip.getBoundingClientRect();
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const pill of activity.pills) {
      const bounds = pill.getBoundingClientRect();
      const visibleLeft = Math.max(bounds.left, strip.left);
      const visibleRight = Math.min(bounds.right, strip.right);
      if (bounds.height === 0 || visibleLeft >= visibleRight) {
        continue;
      }
      left = Math.min(left, visibleLeft);
      right = Math.max(right, visibleRight);
      top = Math.min(top, bounds.top);
      bottom = Math.max(bottom, bounds.bottom);
    }
    if (left < right) {
      this.activityFootprint = {
        left: left - origin.left,
        right: right - origin.left,
        top: top - origin.top,
        bottom: bottom - origin.top,
      };
    }
  }

  private bottomPadding(style: CSSStyleDeclaration, overlap: number): string {
    return overlap > 0
      ? `${Math.max(Number.parseFloat(style.paddingBottom) || 0, overlap + 4)}px`
      : style.paddingBottom;
  }

  commitRange(element: HTMLElement, height: number): void {
    const previous = this.rangeHeights.get(element);
    if (previous === height) {
      return;
    }
    const shrinking =
      element.parentElement === this.viewport && previous !== undefined && height < previous;
    const before = shrinking ? this.viewport?.scrollTop : undefined;
    this.rangeHeights.set(element, height);
    element.style.height = `${height}px`;
    if (before !== undefined) {
      this.publishResize(before);
    }
  }

  private publishResize(before: number): void {
    const viewport = this.viewport;
    if (!viewport) {
      return;
    }
    // Publish the native clamp before another measurement can move the anchor.
    const measuredViewport = readTranscriptViewport(viewport);
    const after = measuredViewport.scrollTop;
    // Padding can move the end without clamping the offset; its anchor still needs reconciliation.
    this.onLayoutChange(before, after);
    publishTranscriptScroll(viewport, {
      type: "resize",
      viewport: measuredViewport,
      ...(before !== after ? { scrollCorrection: { before, after } } : {}),
    });
  }

  disconnect(): void {
    for (const observer of this.observers) {
      observer.disconnect();
    }
    this.observers = [];
    this.geometryTarget?.style.removeProperty("--chat-scroll-to-bottom-clearance");
    this.geometryTarget = undefined;
    this.getComposerActivityLayout = undefined;
    this.activityLayout = null;
    this.activityFootprint = null;
    this.composerFloat = null;
    this.getComposerFloat = undefined;
    this.viewport = null;
  }
}
