import { VirtualizerController } from "@tanstack/lit-virtual";
import {
  createTranscriptOffsetState,
  observeTranscriptOffset,
} from "../pages/chat/components/chat-transcript-offset-observer.ts";
import { TranscriptPrependAnchor } from "../pages/chat/components/chat-transcript-prepend-anchor.ts";

export function observeTranscript(container: HTMLElement, cleanups: Array<() => void>) {
  const thread = container.querySelector<HTMLDivElement>(".chat-thread")!;
  thread.scrollTop = 10_000;
  Object.defineProperties(thread, {
    clientHeight: { value: 200, configurable: true },
    scrollHeight: { value: 20_000, configurable: true },
  });
  const state = createTranscriptOffsetState();
  const owner = {
    state,
    getScrollElement: () => (thread.isConnected ? thread : null),
    prependAnchor: new TranscriptPrependAnchor(),
    isProgrammaticScroll: () => false,
    cancelScroll() {
      state.scrollCommand = null;
      state.pendingScrollOffset = null;
    },
    requestUpdate() {},
    onReaderScroll() {},
  };
  const virtualizer = new VirtualizerController<HTMLDivElement, HTMLElement>(
    {
      addController() {},
      removeController() {},
      requestUpdate() {},
      updateComplete: Promise.resolve(true),
    },
    {
      count: 200,
      estimateSize: () => 100,
      initialOffset: thread.scrollTop,
      getScrollElement: owner.getScrollElement,
      observeElementRect: (_, callback) => callback({ width: 800, height: 200 }),
      observeElementOffset: (instance, callback) =>
        observeTranscriptOffset(owner, instance, callback),
      scrollToFn: (offset, { adjustments = 0 }) => {
        thread.scrollTop = offset + adjustments;
      },
    },
  );
  virtualizer.hostConnected();
  virtualizer.hostUpdated();
  cleanups.push(() => virtualizer.hostDisconnected());
  // jsdom does not scroll from input. Simulate only the native offset boundary;
  // the E2E suite proves browser consumption, cancellation, and touch momentum.
  const scroll = (distance: number) => {
    thread.scrollTop -= distance;
    thread.dispatchEvent(new Event("scroll"));
  };
  const wheel = (distance: number, options: WheelEventInit = {}, offsetBeforeInput = false) => {
    if (!options.ctrlKey && offsetBeforeInput) {
      thread.scrollTop -= distance;
    }
    thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -distance, bubbles: true, ...options }));
    if (!options.ctrlKey) {
      scroll(offsetBeforeInput ? 0 : distance);
    }
  };
  return { thread, scroll, wheel };
}
