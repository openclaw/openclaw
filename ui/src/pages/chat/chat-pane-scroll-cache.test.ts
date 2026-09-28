/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { stubAnimationFrames } from "./chat-view.test-helpers.ts";
import { renderChatThread } from "./components/chat-thread.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import {
  canAutoFollowChat,
  getChatSessionScrollPosition,
  scheduleCommittedChatScroll,
} from "./scroll.ts";

beforeEach(() => {
  installTranscriptDomMocks();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const row = this.closest<HTMLElement>(".chat-virtual-row");
    const thread = this.closest<HTMLElement>(".chat-thread");
    const top = row ? Number(row.dataset.index) * 100 - (thread?.scrollTop ?? 0) : 0;
    const height = row ? 100 : 600;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 800,
      bottom: top + height,
      width: 800,
      height,
      toJSON: () => ({}),
    };
  });
});
afterEach(resetTranscriptTestDom);

async function mountSession(
  paneId: string,
  sessionKey: string,
  viewportHeight = 600,
  loading = false,
) {
  const flushFrames = stubAnimationFrames();
  const { pane, state } = createRefreshChatPane();
  pane.paneId = paneId;
  pane.presentationId = JSON.stringify([paneId, sessionKey]);
  state.sessionKey = sessionKey;
  state.chatLoading = loading;
  state.chatMessages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `Message ${index}`,
    __openclaw: { id: `${sessionKey}:${index}` },
  }));
  pane.render();
  let props = expectDefined(pane.chatProps, "pane transcript props");
  const container = document.body.appendChild(document.createElement("div"));
  props.transcript.hostConnected();
  render(renderChatThread(props, props.transcript), container);
  const thread = expectDefined(container.querySelector<HTMLDivElement>(".chat-thread"), "thread");
  Object.defineProperties(thread, {
    clientHeight: { configurable: true, value: viewportHeight },
    scrollHeight: { configurable: true, value: 3_000 },
  });
  // initialize() omits connectedCallback's viewport binding; use its real owner contract.
  state.chatScrollElement = () => props.transcript.scrollElement;
  state.chatIsProgrammaticScroll = () => props.transcript.isProgrammaticScroll;
  state.chatIsMaintenanceScroll = () => props.transcript.isMaintenanceScroll;
  state.chatIsManualScroll = () => props.transcript.isManualScroll;
  state.chatScrollToEnd = (options) => props.transcript.scrollToEnd(options);
  state.chatCancelScroll = () => props.transcript.cancelScroll();
  thread.scrollTo = (options?: ScrollToOptions | number) => {
    if (typeof options === "object") {
      thread.scrollTop = Math.min(
        options.top ?? thread.scrollTop,
        thread.scrollHeight - thread.clientHeight,
      );
    }
  };
  async function commitFrames(count = 6) {
    for (let frame = 0; frame < count; frame++) {
      props.transcript.hostUpdated();
      await Promise.resolve();
      await Promise.resolve();
      flushFrames();
      render(renderChatThread(props, props.transcript), container);
    }
  }
  await commitFrames();
  return {
    flushFrames,
    commitFrames,
    setLoading(value: boolean) {
      state.chatLoading = value;
      pane.render();
      props = expectDefined(pane.chatProps, "updated pane transcript props");
      render(renderChatThread(props, props.transcript), container);
    },
    pane,
    state,
    transcript: props.transcript,
    thread,
    dispose: () => {
      pane.visuallyPresented = false;
      pane.presented = false;
      props.transcript.hostUpdate();
      props.transcript.hostDisconnected();
      render(nothing, container);
      container.remove();
    },
  };
}

it("restores each physical pane's reader after visiting nine retained sessions", async () => {
  const firstSession = "agent:main:scroll-cache-0";
  const positions = [
    { paneId: "scroll-main", offset: 420 },
    { paneId: "scroll-detail", offset: 840 },
  ];
  for (const { paneId, offset } of positions) {
    const { thread, dispose } = await mountSession(paneId, firstSession);
    thread.scrollTop = offset;
    thread.dispatchEvent(new Event("scroll"));
    dispose();
  }
  for (const { paneId, offset } of positions) {
    const { thread, dispose } = await mountSession(paneId, firstSession);
    expect(thread.scrollTop).toBe(offset);
    dispose();
  }
  for (let index = 1; index < 9; index++) {
    const { thread, dispose } = await mountSession(
      "scroll-main",
      `agent:main:scroll-cache-${index}`,
    );
    thread.scrollTop = 200;
    thread.dispatchEvent(new Event("scroll"));
    dispose();
  }
  for (const { paneId, offset } of positions) {
    const { thread, dispose } = await mountSession(paneId, firstSession);
    expect.soft(thread.scrollTop).toBe(offset);
    dispose();
  }
});

it("restores explicit reader intent when a larger returning viewport clamps its bookmark to the end", async () => {
  const paneId = "clamped-bookmark";
  const sessionKey = "agent:main:clamped-bookmark";
  const first = await mountSession(paneId, sessionKey);
  first.thread.scrollTop = 840;
  first.thread.dispatchEvent(new Event("scroll"));
  first.pane.visuallyPresented = false;
  first.pane.presented = false;
  first.transcript.hostUpdate();
  first.dispose();
  const returned = await mountSession(paneId, sessionKey, 2400);
  try {
    expect(returned.thread.scrollTop).toBe(600);
    expect(returned.state.chatFollowLocked).toBe(true);
    expect(returned.state.chatReadingHistory).toBe(true);
    // A delayed native event for restoration must not be mistaken for a user return.
    returned.thread.dispatchEvent(new Event("scroll"));
    expect(returned.state.chatFollowLocked).toBe(true);
    Object.defineProperty(returned.thread, "scrollHeight", { configurable: true, value: 3200 });
    expect(returned.transcript.scrollToEnd({ source: "auto" })).toBe(false);
    expect(returned.thread.scrollTop).toBe(600);
    returned.thread.scrollTop = 800;
    returned.thread.dispatchEvent(new WheelEvent("wheel", { deltaY: 1 }));
    expect(returned.state.chatFollowLocked).toBe(false);
  } finally {
    returned.dispose();
  }
});

it.each([false, true])(
  "positions the visible inert preview before route ownership, latest=%s",
  async (latest) => {
    const paneId = "preview-destination-" + latest;
    const view = await mountSession(paneId, "agent:main:" + paneId);
    try {
      view.thread.scrollTop = 840;
      view.thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
      view.thread.dispatchEvent(new Event("scroll"));
      if (latest) {
        scheduleCommittedChatScroll(view.state, true, false, { source: "manual" });
        await view.commitFrames();
        expect(view.thread.scrollTop).toBe(2400);
      }
      view.pane.visuallyPresented = false;
      view.pane.presented = false;
      view.transcript.hostUpdate();
      Object.defineProperty(view.thread, "scrollHeight", { configurable: true, value: 3200 });
      view.thread.scrollTop = 1200;
      await view.commitFrames();
      // Retained navigation makes the pane visible and inert while the old route
      // remains authoritative for input and external work. Geometry cannot wait.
      view.pane.toggleAttribute("inert", true);
      view.pane.visuallyPresented = true;
      view.transcript.hostUpdate();
      await view.commitFrames();
      expect(view.pane.presented).toBe(false);
      expect(view.pane.hasAttribute("inert")).toBe(true);
      expect(view.thread.scrollTop).toBe(latest ? 2600 : 840);
      expect(view.state.chatFollowLocked).toBe(!latest);
      view.pane.visuallyPresented = true;
      view.pane.presented = true;
      view.transcript.hostUpdate();
      await view.commitFrames();
      expect(view.thread.scrollTop).toBe(latest ? 2600 : 840);
    } finally {
      view.dispose();
    }
  },
);

it.each([
  "before first frame",
  "between measured frames",
  "active smooth command",
  "ordinary reader",
] as const)("preserves the selected destination on departure: %s", async (stage) => {
  const paneId = "departure-" + stage;
  const sessionKey = "agent:main:" + paneId;
  const view = await mountSession(paneId, sessionKey);
  try {
    view.thread.scrollTop = 840;
    view.thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
    view.thread.dispatchEvent(new Event("scroll"));
    expect(view.state.chatFollowLocked).toBe(true);
    const scrollTo = view.thread.scrollTo.bind(view.thread);
    const smoothTargets: number[] = [];
    view.thread.scrollTo = (options?: ScrollToOptions | number) => {
      if (typeof options === "object" && options.behavior === "smooth") {
        // Native smooth travel has started but has not delivered its first offset yet.
        smoothTargets.push(options.top ?? 0);
        return;
      }
      if (typeof options === "number") {
        scrollTo(options, 0);
      } else {
        scrollTo(options);
      }
    };
    const manual = stage !== "ordinary reader";
    if (manual) {
      scheduleCommittedChatScroll(view.state, true, true, { source: "manual" });
      if (stage !== "before first frame") {
        view.flushFrames();
      }
      if (stage === "active smooth command") {
        view.flushFrames();
      }
    }
    expect(smoothTargets.length).toBe(stage === "active smooth command" ? 1 : 0);
    expect(canAutoFollowChat(view.state)).toBe(stage === "active smooth command");
    expect(view.thread.scrollTop).toBe(840);
    view.pane.visuallyPresented = false;
    view.pane.presented = false;
    view.transcript.hostUpdate();
    expect(getChatSessionScrollPosition(paneId, sessionKey)?.anchorToEnd).toBe(manual);
    await view.commitFrames();
    view.pane.visuallyPresented = true;
    view.pane.presented = true;
    view.transcript.hostUpdate();
    await view.commitFrames();
    expect(view.thread.scrollTop).toBe(manual ? 2400 : 840);
    expect(view.state.chatFollowLocked).toBe(!manual);
  } finally {
    view.dispose();
  }
});

it.each([
  { departure: "hide", manual: true },
  { departure: "save before replacement", manual: true },
  { departure: "hide", manual: false },
  { departure: "save before replacement", manual: false },
])(
  "keeps the latest destination through pending restoration: $departure, manual=$manual",
  async ({ departure, manual }) => {
    const paneId = "pending-departure-" + departure + manual;
    const sessionKey = "agent:main:" + paneId;
    const first = await mountSession(paneId, sessionKey);
    first.thread.scrollTop = 840;
    first.thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
    first.thread.dispatchEvent(new Event("scroll"));
    first.dispose();
    const savedReader = getChatSessionScrollPosition(paneId, sessionKey);
    expect(savedReader?.messageAnchor).toBeDefined();
    // The returning pane has its saved bookmark but not measurable layout or authoritative content.
    const view = await mountSession(paneId, sessionKey, 0, true);
    try {
      expect(view.transcript.isProgrammaticScroll).toBe(true);
      if (manual) {
        scheduleCommittedChatScroll(view.state, true, true, { source: "manual" });
      }
      if (departure === "save before replacement") {
        view.transcript.saveScrollPosition(true);
        expect(getChatSessionScrollPosition(paneId, sessionKey)?.anchorToEnd).toBe(manual);
      }
      view.pane.visuallyPresented = false;
      view.pane.presented = false;
      view.transcript.hostUpdate();
      expect(getChatSessionScrollPosition(paneId, sessionKey)?.anchorToEnd).toBe(manual);
      if (!manual) {
        expect(getChatSessionScrollPosition(paneId, sessionKey)).toEqual(savedReader);
      }
      // Retire the queued attempt while hidden; its destination must now belong to restoration.
      await view.commitFrames();
      view.pane.visuallyPresented = true;
      view.pane.presented = true;
      view.transcript.hostUpdate();
      await view.commitFrames();
      expect(view.transcript.isProgrammaticScroll).toBe(true);
      Object.defineProperty(view.thread, "clientHeight", { configurable: true, value: 600 });
      await view.commitFrames();
      if (manual) {
        expect(view.transcript.isProgrammaticScroll).toBe(true);
        expect(getChatSessionScrollPosition(paneId, sessionKey)?.anchorToEnd).toBe(true);
      }
      view.setLoading(false);
      await view.commitFrames();
      expect(view.thread.scrollTop).toBe(manual ? 2400 : 840);
      expect(view.state.chatFollowLocked).toBe(!manual);
      expect(view.transcript.isProgrammaticScroll).toBe(false);
    } finally {
      view.dispose();
    }
  },
);
