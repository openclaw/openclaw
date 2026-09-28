/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeChatHost } from "../chat-host.test-support.ts";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import {
  getChatSessionScrollPosition,
  saveChatSessionScrollPosition,
  handleChatScroll,
  handleChatScrollTakeover,
  restoreChatScrollPosition,
} from "../scroll.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import { CHAT_TRANSCRIPT_ZERO_MAX_SETTLE_FRAMES } from "./chat-transcript-session.ts";
import type { TestContentRow } from "./chat-transcript.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  resizeObservers,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

function fixture(
  paneId: string,
  options: {
    saved?: boolean;
    ready?: boolean;
    omitMessage?: number;
    deferredMeasurement?: boolean;
    viewportSlot?: boolean;
  } = {},
) {
  const flushFrames = stubAnimationFrames();
  const sessionKey = `agent:main:${paneId}`;
  const slot = options.viewportSlot
    ? document.body.appendChild(document.createElement("div"))
    : document.body;
  const container = slot.appendChild(document.createElement("div"));
  let presented = true;
  const policy = makeChatHost();
  let ready = options.ready ?? true;
  let height = 400;
  if (options.viewportSlot) {
    slot.style.padding = "0px";
    Object.defineProperty(slot, "clientHeight", { configurable: true, get: () => height });
    Object.defineProperty(container, "offsetWidth", { configurable: true, value: 800 });
  }
  let requested = true;
  let scrollTop = 0;
  let beforeFirstPaint = options.deferredMeasurement ?? false;
  const heights = Array.from({ length: 80 }, (_, index) => 80 + (index % 5) * 45);
  let rows: TestContentRow[] = heights.map((_, index) => ({
    kind: "content",
    key: `row:${index}`,
    content: html`<div class="chat-bubble" data-message-id=${`message:${index}`}>
      Message ${index}
    </div>`,
  }));
  const allRows = rows;
  rows = rows.filter((row) => row.key !== `row:${options.omitMessage}`);
  const maxOffset = () => Math.max(0, container.scrollHeight - height);
  Object.defineProperties(container, {
    clientHeight: { configurable: true, get: () => height },
    scrollHeight: {
      configurable: true,
      get: () =>
        Number.parseFloat(
          container.querySelector<HTMLElement>(".chat-thread-inner--virtual")?.style.height ?? "0",
        ) || 0,
    },
    scrollTop: {
      configurable: true,
      get: () => Math.min(scrollTop, maxOffset()),
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, maxOffset()));
      },
    },
  });
  container.scrollTo = (scrollOptions?: ScrollToOptions | number) => {
    if (typeof scrollOptions === "object") {
      container.scrollTop = scrollOptions.top ?? container.scrollTop;
    }
  };
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (!this.classList.contains("chat-virtual-row")) {
      return height;
    }
    // Chromium can keep auto-content-visibility rows at their intrinsic size
    // until rendering, unless the measurement owner explicitly resolves them.
    if (
      beforeFirstPaint &&
      !this.closest("[data-measuring-rows]") &&
      this.style.contentVisibility !== "visible"
    ) {
      return Number.parseFloat(this.style.containIntrinsicBlockSize) || 120;
    }
    return heights[Number(this.dataset.index)] ?? 100;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const row = this.closest<HTMLElement>(".chat-virtual-row");
    let top = 0;
    if (row) {
      top =
        (Number.parseFloat(row.parentElement!.style.transform.replace("translateY(", "")) || 0) -
        container.scrollTop;
      for (
        let sibling = row.previousElementSibling;
        sibling;
        sibling = sibling.previousElementSibling
      ) {
        top +=
          sibling instanceof HTMLElement
            ? sibling.classList.contains("chat-virtual-row")
              ? sibling.offsetHeight
              : Number.parseFloat(sibling.style.height) || 0
            : 0;
      }
    }
    const blockSize = row ? heights[Number(row.dataset.index)]! : height;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 800,
      bottom: top + blockSize,
      width: 800,
      height: blockSize,
      toJSON: () => ({}),
    };
  });
  if (!options.saved) {
    saveChatSessionScrollPosition(paneId, sessionKey, { scrollTop: 0, anchorToEnd: false });
  }
  const onReaderScroll = vi.fn((towardEnd?: boolean) => {
    handleChatScrollTakeover(policy, towardEnd);
  });
  const transcript = new ChatTranscriptController(
    {
      addController: vi.fn(),
      removeController: vi.fn(),
      requestUpdate: () => {
        requested = true;
      },
      updateComplete: Promise.resolve(true),
    },
    () => paneId,
    {
      visuallyPresented: () => presented,
      canFollowEnd: () => !policy.chatFollowLocked,
      onReaderScroll,
      onPositionRestored: (position) => restoreChatScrollPosition(policy, position),
    },
  );
  policy.chatScrollElement = () => transcript.scrollElement;
  policy.chatIsProgrammaticScroll = () => transcript.isProgrammaticScroll;
  policy.chatIsMaintenanceScroll = () => transcript.isMaintenanceScroll;
  container.addEventListener("scroll", (event) => handleChatScroll(policy, event));
  function commit() {
    requested = false;
    transcript.hostUpdate();
    render(
      transcript.renderSession(sessionKey, (session) => {
        session.setContentReady(ready);
        const messages = new Map(rows.map((row) => [row.key.replace("row:", "message:"), row.key]));
        session.syncMessageRows(messages, messages);
        return session.render(
          rows,
          (row) => (row.kind === "content" ? row.content : nothing),
          null,
          false,
        );
      }),
      container,
    );
    // A browser keeps the clamped offset when a committed short range later grows.
    scrollTop = Math.max(0, Math.min(scrollTop, maxOffset()));
    transcript.hostUpdated();
  }
  async function beforePaint() {
    // This host is manually rendered: drain the Lit/row-ref checkpoint without
    // granting frame-based retries. A real browser exhausts microtasks before paint.
    for (let checkpoint = 0; checkpoint < 24; checkpoint++) {
      await Promise.resolve();
      if (requested) {
        commit();
      }
    }
    beforeFirstPaint = false;
  }
  async function frames(count = 8) {
    for (let frame = 0; frame < count; frame++) {
      await beforePaint();
      // Browser-delivered maintenance offsets retire their receipts after native delivery.
      container.dispatchEvent(new Event("scroll"));
      flushFrames();
      await beforePaint();
    }
  }
  transcript.hostConnected();
  commit();
  return {
    container,
    transcript,
    sessionKey,
    onReaderScroll,
    frames,
    beforePaint,
    commitViewport() {
      for (const observer of resizeObservers) {
        observer.emitTarget(slot, 800, height);
        observer.emitTarget(container, 800, height);
      }
    },
    heights,
    allRows,
    get following() {
      return !policy.chatFollowLocked;
    },
    setReady(value: boolean) {
      ready = value;
      requested = true;
    },
    setRows(value: TestContentRow[]) {
      rows = value;
      requested = true;
    },
    setPresented(value: boolean) {
      presented = value;
      transcript.hostUpdate();
    },
    setHeight(value: number) {
      height = value;
      scrollTop = Math.max(0, Math.min(scrollTop, maxOffset()));
    },
    commit,
    readAt(offset: number) {
      container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      container.scrollTop = offset;
      container.dispatchEvent(new Event("scroll"));
    },
    save() {
      transcript.saveScrollPosition(true);
      return getChatSessionScrollPosition(paneId, sessionKey)!;
    },
    dispose() {
      transcript.hostDisconnected();
      render(nothing, container);
      container.remove();
      if (slot !== document.body) {
        slot.remove();
      }
    },
  };
}

it.each([false, true])(
  "positions a cold transcript before its first paint, history ready=%s",
  async (ready) => {
    const view = fixture("first-paint-end", { saved: true, deferredMeasurement: true, ready });
    try {
      await view.beforePaint();
      const tail = view.container.querySelector<HTMLElement>('[data-message-id="message:79"]')!;
      expect(tail).not.toBeNull();
      expect(tail.getBoundingClientRect().bottom).toBeCloseTo(400, 0);
      expect(view.container.scrollTop).toBe(view.container.scrollHeight - 400);
      expect(view.container.querySelectorAll(".chat-virtual-row").length).toBeLessThan(12);
      // Widening the overscan on the following frame must not move the tail.
      for (let frame = 0; frame < 2; frame++) {
        await view.frames(1);
        expect(tail.getBoundingClientRect().bottom).toBeCloseTo(400, 0);
      }
    } finally {
      view.dispose();
    }
  },
);

it("lets reader input supersede a queued initial positioning commit", async () => {
  const view = fixture("first-paint-takeover", { saved: true, deferredMeasurement: true });
  try {
    view.readAt(0);
    await view.beforePaint();
    expect(view.container.scrollTop).toBe(0);
    expect(view.following).toBe(false);
    await view.frames();
    expect(view.container.scrollTop).toBe(0);
  } finally {
    view.dispose();
  }
});

it("restores the same bubble after eviction discards variable-height row measurements", async () => {
  const first = fixture("evicted-reader");
  await first.frames();
  first.readAt(4500);
  await first.frames();
  const nativeGeometryReads = vi.spyOn(first.container, "querySelectorAll");
  first.transcript.saveScrollPosition();
  expect(nativeGeometryReads).not.toHaveBeenCalled();
  const before = first.save();
  expect(before.messageAnchor).toBeDefined();
  first.dispose();

  const returned = fixture("evicted-reader", { saved: true });
  try {
    await returned.beforePaint();
    const bubble = [...returned.container.querySelectorAll<HTMLElement>(".chat-bubble")].find(
      (node) => node.dataset.messageId === before.messageAnchor!.messageKey,
    )!;
    expect(bubble).toBeDefined();
    expect(bubble.getBoundingClientRect().top).toBeCloseTo(before.messageAnchor!.offset, 0);
    // Old absolute pixels are not a bookmark when unmounted rows have new estimates.
    expect(returned.container.scrollTop).not.toBe(before.scrollTop);
    await returned.frames();
    expect(returned.transcript.isProgrammaticScroll).toBe(false);
    returned.readAt(returned.container.scrollTop - 90);
    const takenOver = returned.container.scrollTop;
    await returned.frames();
    expect(returned.container.scrollTop).toBe(takenOver);
  } finally {
    returned.dispose();
  }
});

it.each([false, true])(
  "holds hidden presentation geometry without changing follow intent, following=%s",
  async (following) => {
    const view = fixture(`hidden-reader-${following}`);
    try {
      await view.frames();
      view.readAt(view.container.scrollHeight - 400 - 180);
      await view.frames();
      if (following) {
        view.transcript.scrollToEnd({ behavior: "auto" });
        view.container.dispatchEvent(new WheelEvent("wheel", { deltaY: 1 }));
      }
      const before = view.save();
      view.setPresented(false);
      // The progress card disappears after hostUpdate, enlarging the viewport and clamping it.
      view.setHeight(740);
      view.container.dispatchEvent(new Event("scroll"));
      view.transcript.saveScrollPosition();
      view.commit();
      await view.frames();
      expect(getChatSessionScrollPosition(`hidden-reader-${following}`, view.sessionKey)).toEqual(
        before,
      );
      view.setPresented(true);
      view.setHeight(400);
      view.commit();
      await view.frames();
      if (following) {
        expect(view.container.scrollTop).toBeCloseTo(view.container.scrollHeight - 400, 0);
      } else {
        const bubble = [...view.container.querySelectorAll<HTMLElement>(".chat-bubble")].find(
          (node) => node.dataset.messageId === before.messageAnchor!.messageKey,
        )!;
        expect(bubble.getBoundingClientRect().top).toBeCloseTo(before.messageAnchor!.offset, 0);
      }
      expect(view.following).toBe(following);
    } finally {
      view.dispose();
    }
  },
);

it.each(["arrives", "deleted", "reader takeover"] as const)(
  "keeps a preload bookmark until its message %s",
  async (outcome) => {
    const paneId = "preload-" + outcome;
    const position = {
      scrollTop: 420,
      anchorToEnd: false,
      messageAnchor: { messageKey: "message:40", offset: -20 },
    };
    saveChatSessionScrollPosition(paneId, "agent:main:" + paneId, position);
    const view = fixture(paneId, { saved: true, ready: false, omitMessage: 40 });
    try {
      await view.frames();
      expect(view.onReaderScroll).not.toHaveBeenCalled();
      expect(getChatSessionScrollPosition(paneId, view.sessionKey)).toEqual(position);
      if (outcome === "reader takeover") {
        view.readAt(200);
      }
      const takenOver = view.container.scrollTop;
      if (outcome !== "deleted") {
        view.setRows(view.allRows);
      }
      view.setReady(true);
      view.commit();
      await view.frames();
      expect(view.transcript.isProgrammaticScroll).toBe(false);
      if (outcome === "arrives") {
        const bubble = view.container.querySelector<HTMLElement>('[data-message-id="message:40"]')!;
        expect(bubble.getBoundingClientRect().top).toBeCloseTo(-20, 0);
      } else if (outcome === "deleted") {
        expect(getChatSessionScrollPosition(paneId, view.sessionKey)).toEqual({
          scrollTop: 420,
          anchorToEnd: false,
        });
      } else {
        expect(view.container.scrollTop).toBe(takenOver);
      }
    } finally {
      view.dispose();
    }
  },
);

it("resumes a bookmark in the initial viewport commit without waiting for another frame", async () => {
  const first = fixture("initial-viewport-reader");
  await first.frames();
  first.readAt(4500);
  await first.frames();
  const before = first.save();
  expect(before.messageAnchor).toBeDefined();
  first.dispose();

  const returned = fixture("initial-viewport-reader", { saved: true, viewportSlot: true });
  try {
    await returned.beforePaint();
    expect(returned.container.clientHeight).toBe(400);
    expect(returned.container.style.paddingTop).toBe("");
    expect(returned.transcript.isProgrammaticScroll).toBe(true);
    // The slot publishes its initial styles, but the already-sized viewport
    // has no dimension change to provide a second notification.
    returned.commitViewport();
    await returned.beforePaint();
    expect(returned.container.style.paddingTop).toBe("0px");
    const bubble = [...returned.container.querySelectorAll<HTMLElement>(".chat-bubble")].find(
      (node) => node.dataset.messageId === before.messageAnchor!.messageKey,
    )!;
    expect(bubble).toBeDefined();
    expect(bubble.getBoundingClientRect().top).toBeCloseTo(before.messageAnchor!.offset, 0);
  } finally {
    returned.dispose();
  }
});

it("keeps the cold end destination when hidden before initial positioning", async () => {
  const paneId = "initial-end-departure";
  const view = fixture(paneId, { saved: true, viewportSlot: true });
  try {
    // A short cached projection clamps the initial offset before the complete
    // history arrives, while the viewport style commit is still pending.
    view.setRows(view.allRows.slice(0, 1));
    view.commit();
    await view.beforePaint();
    view.setRows(view.allRows);
    view.commit();
    expect(view.transcript.isProgrammaticScroll).toBe(true);
    view.setPresented(false);
    view.commit();
    expect(getChatSessionScrollPosition(paneId, view.sessionKey)?.anchorToEnd).toBe(true);
    view.commitViewport();
    view.setPresented(true);
    view.commit();
    await view.beforePaint();
    expect(view.container.scrollTop).toBe(view.container.scrollHeight - 400);
    expect(view.following).toBe(true);
  } finally {
    view.dispose();
  }
});

it.each([0, 1])(
  "drops a deleted bookmark when authoritative history has %i fitting rows",
  async (count) => {
    const paneId = "deleted-zero-range-" + count;
    saveChatSessionScrollPosition(paneId, "agent:main:" + paneId, {
      scrollTop: 420,
      anchorToEnd: false,
      messageAnchor: { messageKey: "message:40", offset: -20 },
    });
    const view = fixture(paneId, { saved: true, ready: false, omitMessage: 40 });
    try {
      view.setRows(view.allRows.slice(0, count));
      view.commit();
      await view.frames();
      expect(getChatSessionScrollPosition(paneId, view.sessionKey)?.messageAnchor).toBeDefined();
      view.setReady(true);
      view.commit();
      await view.frames(CHAT_TRANSCRIPT_ZERO_MAX_SETTLE_FRAMES + 1);
      expect(view.transcript.isProgrammaticScroll).toBe(false);
      expect(getChatSessionScrollPosition(paneId, view.sessionKey)).toEqual({
        scrollTop: 0,
        anchorToEnd: false,
      });
      // Deleting content retires its bookmark, not the reader's explicit follow lock.
      expect(view.following).toBe(false);
    } finally {
      view.dispose();
    }
  },
);

it.each([false, true])(
  "restores a hidden end destination before paint while history ready=%s",
  async (ready) => {
    const view = fixture("hidden-end-measure-" + ready, { saved: true });
    try {
      await view.beforePaint();
      view.setPresented(false);
      // The mounted tail changes while the pane is hidden. Its old virtual
      // extent is not the end that the returning reader should see.
      view.heights[79] = 600;
      view.setRows([...view.allRows]);
      view.setReady(ready);
      view.commit();
      view.setPresented(true);
      view.commit();
      await view.beforePaint();
      const tail = view.container.querySelector<HTMLElement>('[data-message-id="message:79"]')!;
      expect(tail.getBoundingClientRect().bottom).toBeCloseTo(400, 0);
      expect(view.container.scrollTop).toBe(view.container.scrollHeight - 400);
      if (!ready) {
        // Cached rows may be positioned now without retiring the destination
        // before the authoritative history arrives.
        expect(view.transcript.isProgrammaticScroll).toBe(true);
        view.setReady(true);
        view.commit();
        await view.beforePaint();
      }
      await view.frames(1);
      expect(tail.getBoundingClientRect().bottom).toBeCloseTo(400, 0);
      expect(view.following).toBe(true);
    } finally {
      view.dispose();
    }
  },
);
