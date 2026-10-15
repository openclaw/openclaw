import { Virtualizer } from "@tanstack/virtual-core";
import { Show } from "solid-js";
import { SolidContentPresentation } from "../lit/solid-content.tsx";
import { TranscriptEndAnchor } from "../pages/chat/components/chat-transcript-end-anchor.ts";
import {
  observeTranscriptOffset,
  TranscriptOffsetState,
} from "../pages/chat/components/chat-transcript-offset-observer.ts";
import { TranscriptPrependAnchor } from "../pages/chat/components/chat-transcript-prepend-anchor.ts";
import { mountSolid } from "../test-helpers/solid-render.tsx";
import {
  SessionProgressCard,
  type SessionProgressCardProps,
} from "./session-progress-card-solid.tsx";

export function observeTranscript(container: HTMLElement, cleanups: Array<() => void>) {
  const thread = container.querySelector<HTMLDivElement>(".chat-thread")!;
  thread.scrollTop = 10_000;
  Object.defineProperties(thread, {
    clientHeight: { value: 200, configurable: true },
    scrollHeight: { value: 20_000, configurable: true },
  });
  const state = new TranscriptOffsetState();
  const owner = {
    state,
    getScrollElement: () => (thread.isConnected ? thread : null),
    prependAnchor: new TranscriptPrependAnchor(),
    endAnchor: new TranscriptEndAnchor(),
    canFollowEnd: () => true,
    isProgrammaticScroll: () => false,
    cancelScroll() {
      state.scrollCommand = null;
      state.pendingScrollOffset = null;
    },
    onLayoutCorrection() {},
    requestUpdate() {},
    onOffset() {
      return false;
    },
    onReaderScroll() {},
    onComposerLayout() {},
  };
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
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
    onChange() {},
  });
  // The core virtualizer exposes its adapter lifecycle with underscore names.
  // eslint-disable-next-line no-underscore-dangle
  const cleanup = virtualizer._didMount();
  // eslint-disable-next-line no-underscore-dangle
  virtualizer._willUpdate();
  cleanups.push(cleanup);
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

type Input = SessionProgressCardProps & { transcript?: boolean; showTranscript?: boolean };
type FixtureProps = { input: Input; presented: boolean };
function Fixture(props: FixtureProps) {
  return (
    <SolidContentPresentation value={() => props.presented}>
      <Show when={props.input.transcript} fallback={<SessionProgressCard {...props.input} />}>
        <div class="chat-main">
          <Show when={props.input.showTranscript !== false}>
            <div class="chat-thread" />
          </Show>
          <SessionProgressCard {...props.input} />
        </div>
      </Show>
    </SolidContentPresentation>
  );
}
const mounts = new WeakMap<
  HTMLElement,
  { view: ReturnType<typeof mountSolid<FixtureProps>>; props: FixtureProps }
>();

export function renderProgressCard(input: Input | null, container: HTMLElement) {
  let mounted = mounts.get(container);
  if (!input) {
    mounted?.view.dispose();
    mounts.delete(container);
  } else if (mounted) {
    mounted.props.input = input;
    mounted.view.update({ ...mounted.props });
  } else {
    const props = { input, presented: true };
    mounted = { view: mountSolid(Fixture, props, container), props };
    mounts.set(container, mounted);
  }
  return {
    setPresented(presented: boolean) {
      if (mounted) {
        mounted.props.presented = presented;
        mounted.view.update({ ...mounted.props });
      }
    },
  };
}
