import type { ProgressCard } from "@openclaw/gateway-protocol";
import { Virtualizer } from "@tanstack/virtual-core";
import { flush, Show } from "solid-js";
import { afterEach, beforeEach, vi } from "vitest";
import { ContentPresentation } from "../lib/solid/presentation.ts";
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
    prependAnchor: new TranscriptPrependAnchor(new Map(), vi.fn()),
    endAnchor: new TranscriptEndAnchor(() => {}),
    canFollowEnd: () => true,
    isProgrammaticScroll: () => false,
    cancelScroll() {
      state.scrollCommand = null;
      state.pendingScrollOffset = null;
    },
    onLayoutCorrection() {},
    invalidate() {},
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
  let transcript: HTMLDivElement | undefined;
  const getTranscriptElement = () => (transcript?.isConnected ? transcript : null);
  return (
    <ContentPresentation value={() => props.presented}>
      <Show when={props.input.transcript} fallback={<SessionProgressCard {...props.input} />}>
        <div class="chat-main">
          <Show when={props.input.showTranscript !== false}>
            <div class="chat-thread" ref={(element) => (transcript = element)} />
          </Show>
          <SessionProgressCard
            {...props.input}
            composerDisclosureContext={{
              ...props.input.composerDisclosureContext,
              getTranscriptElement:
                props.input.composerDisclosureContext?.getTranscriptElement ?? getTranscriptElement,
            }}
          />
        </div>
      </Show>
    </ContentPresentation>
  );
}
const mounts = new WeakMap<
  HTMLElement,
  { view: ReturnType<typeof mountSolid<FixtureProps>>; props: FixtureProps }
>();

export const NOW_MS = Date.UTC(2026, 7, 26, 13, 37);
export const RUN_STARTED_MS = NOW_MS - 3 * 60_000;
export const RUN_ENDED_MS = NOW_MS - 30_000;
export const progressCard: ProgressCard = {
  sessionKey: "agent:main:work",
  revision: 2,
  updatedAt: NOW_MS - 2 * 60_000,
  markdown: '**Focused change**\n\n<progress value="1" max="3"></progress>',
  steps: [
    { step: "Inspect the route", status: "completed" },
    { step: "Wire the checklist", status: "in_progress" },
    { step: "Run focused tests", status: "pending" },
  ],
};

export function progressCardFixture() {
  const containers: HTMLDivElement[] = [];
  const transcriptCleanups: Array<() => void> = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => {
    for (const cleanup of transcriptCleanups.splice(0)) {
      cleanup();
    }
    for (const container of containers.splice(0)) {
      renderProgressCard(null, container);
      container.remove();
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  function createContainer() {
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    return container;
  }
  function render(input: Partial<Input> | null, container: HTMLElement) {
    return renderProgressCard(
      input && { card: progressCard, placement: "composer", ...input },
      container,
    );
  }
  return {
    transcriptCleanups,
    createContainer,
    render,
    createView(this: void, defaults: Partial<Input> = {}) {
      const container = createContainer();
      return {
        container,
        show: (input: Partial<Input> | null) =>
          render(input && { ...defaults, ...input }, container),
      };
    },
    mountCard(this: void, input: Partial<Input>) {
      const container = createContainer();
      render(input, container);
      return container;
    },
  };
}

export function advance(ms: number) {
  vi.advanceTimersByTime(ms);
  flush();
}

export function cardPart(root: ParentNode | null | undefined, name: string) {
  return root?.querySelector<HTMLElement>(`.session-progress-card__${name}`);
}

function renderProgressCard(input: Input | null, container: HTMLElement) {
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
