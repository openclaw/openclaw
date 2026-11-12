import { expectDefined } from "@openclaw/normalization-core";
import { Virtualizer } from "@tanstack/virtual-core";
import { onTestFinished, vi } from "vitest";
import { resetChatThreadState } from "../chat-thread.ts";
import { resetThreadPresentation, type ChatThreadProps } from "./chat-thread-interactions.ts";
import { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import {
  isTranscriptProgrammaticScroll,
  isTranscriptMaintenanceScroll,
  observeTranscriptOffset,
  scrollTranscriptOffset,
  TranscriptOffsetState,
} from "./chat-transcript-offset-observer.ts";
import { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";
import { createTranscriptPresentation } from "./chat-transcript-session.ts";

export const observedElements = new Set<Element>();
export const resizeObservers = new Set<RecordingResizeObserver>();
export const transcriptDomState = { measuredRowHeight: 100, detachedRowHeight: 100 };

class RecordingResizeObserver implements ResizeObserver {
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.add(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
    observedElements.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
    observedElements.delete(target);
  }

  disconnect(): void {
    for (const target of this.targets) {
      this.unobserve(target);
    }
    resizeObservers.delete(this);
  }

  emit(width: number, height: number): void {
    const entries = [...this.targets].map((target) => this.entry(target, width, height));
    if (entries.length > 0) {
      this.callback(entries, this);
    }
  }

  emitTarget(target: Element, width: number, height: number): void {
    if (this.targets.has(target)) {
      this.callback([this.entry(target, width, height)], this);
    }
  }

  observes(target: Element): boolean {
    return this.targets.has(target);
  }

  private entry(target: Element, width: number, height: number): ResizeObserverEntry {
    return {
      target,
      borderBoxSize: [{ inlineSize: width, blockSize: height }],
    } as unknown as ResizeObserverEntry;
  }
}

const defaultMessages = [
  { role: "user", content: "message one", timestamp: 1_000 },
  { role: "assistant", content: "reply one", timestamp: 2_000 },
  { role: "user", content: "message two", timestamp: 3_000 },
  { role: "assistant", content: "reply two", timestamp: 4_000 },
];

export function threadProps(
  paneId: string,
  sessionKey = "agent:main:main",
  messages: unknown[] = defaultMessages,
  overrides: Partial<ChatThreadProps> = {},
): ChatThreadProps {
  return {
    paneId,
    sessionKey,
    selectedSession: undefined,
    loading: false,
    messages,
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showThinking: false,
    showToolCalls: false,
    sessions: null,
    assistantName: "Molty",
    assistantAvatar: null,
    ...overrides,
  };
}

export const transcriptMessage = <Content>(
  role: string,
  content: Content,
  timestamp = 1_000,
  extra = {},
) => ({ role, content, timestamp, ...extra });

export function requireElement(container: ParentNode, selector: string): HTMLElement {
  return expectDefined(container.querySelector<HTMLElement>(selector), selector);
}

export function transcriptRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".chat-virtual-row")];
}

export function transcriptSize(container: ParentNode): number {
  const extent = requireElement(container, ".chat-thread-inner--virtual");
  return Number.parseFloat(extent.style.height);
}

export async function flushDeferredRowPrune(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  if (!vi.isFakeTimers() && !vi.isMockFunction(requestAnimationFrame)) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }
}

export function installTranscriptDomMocks(): void {
  observedElements.clear();
  resizeObservers.clear();
  transcriptDomState.measuredRowHeight = 100;
  transcriptDomState.detachedRowHeight = 100;
  vi.stubGlobal("ResizeObserver", RecordingResizeObserver);
  // These geometry fixtures publish native offsets and observer receipts explicitly.
  vi.spyOn(Element.prototype, "scrollTo").mockImplementation(() => {});
  const clientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!;
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("chat-thread") ? 600 : clientHeight.get!.call(this);
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.isConnected
      ? transcriptDomState.measuredRowHeight
      : transcriptDomState.detachedRowHeight;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 600));
}

export function resetTranscriptTestDom(): void {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetThreadPresentation();
  resetChatThreadState();
  document.body.replaceChildren();
}

export type TestContentRow = Extract<TranscriptRow, { kind: "content" }>;

const offsetOwnerDefaults = (state: TranscriptOffsetState, element: HTMLDivElement) => ({
  state,
  getScrollElement: () => element,
  endAnchor: new TranscriptEndAnchor(() => {}),
  prependAnchor: new TranscriptPrependAnchor(new Map(), vi.fn(), () => false),
  canFollowEnd: () => false,
  isProgrammaticScroll: () => isTranscriptProgrammaticScroll(state, element),
  isMaintenanceScroll: () => isTranscriptMaintenanceScroll(state, element),
  cancelScroll: vi.fn(),
  onLayoutCorrection: vi.fn(),
  invalidate: vi.fn(),
  onOffset: vi.fn(),
  onReaderScroll: vi.fn(),
  onComposerLayout: vi.fn(),
});

// Infer overrides from their values, not the observer's contextual owner type.
export const offsetOwner = <
  Overrides extends Partial<Parameters<typeof observeTranscriptOffset>[0]>,
>(
  state: TranscriptOffsetState,
  element: HTMLDivElement,
  overrides: Overrides,
): ReturnType<typeof offsetOwnerDefaults> & NoInfer<Overrides> => ({
  ...offsetOwnerDefaults(state, element),
  ...overrides,
});

export function clampedMeasurements() {
  installTranscriptDomMocks();
  const element = document.body.appendChild(document.createElement("div"));
  const range = { height: 400 };
  let scrollTop = 300;
  Object.defineProperties(element, {
    clientHeight: { value: 100 },
    scrollHeight: { get: () => range.height },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, range.height - 100));
      },
    },
    scrollTo: {
      value: (options: ScrollToOptions) => {
        element.scrollTop = options.top ?? element.scrollTop;
      },
    },
  });
  const heights = [100, 100, 100, 100];
  const rows = Array.from({ length: 4 }, (_, index) => {
    const row = element.appendChild(document.createElement("div"));
    row.dataset.index = String(index);
    Object.defineProperty(row, "offsetHeight", { get: () => heights[index]! });
    return row;
  });
  const state = new TranscriptOffsetState();
  const owner = offsetOwner(state, element, {});
  const host = { layout: new TranscriptLayoutOwner(vi.fn()), contentElement: null };
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: rows.length,
    initialOffset: 300,
    overscan: 3,
    getScrollElement: () => element,
    estimateSize: () => 100,
    scrollToFn: (offset, options, instance) =>
      scrollTranscriptOffset(state, host, 0, offset, options, instance),
    observeElementRect: (_, callback) => callback({ width: 800, height: 100 }),
    observeElementOffset: (instance, callback) =>
      observeTranscriptOffset(owner, instance, callback),
    measureElement: (row, entry) => presentation.measureElement(row, entry),
  });
  const presentation = createTranscriptPresentation(
    () => element,
    virtualizer,
    () => rows,
    () => state.syncNativeOffset?.(),
  );
  const { _didMount: mount, _willUpdate: update } = virtualizer;
  const dispose = mount();
  onTestFinished(() => {
    dispose();
    resetTranscriptTestDom();
  });
  update();
  for (const row of rows) {
    virtualizer.measureElement(row);
  }
  const measure = (index: number, height: number) => {
    heights[index] = height;
    for (const observer of resizeObservers) {
      observer.emitTarget(rows[index]!, 800, height);
    }
  };
  return { element, range, state, virtualizer, update, owner, measure };
}
