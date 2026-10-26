import { afterEach, beforeEach, expect, it, onTestFinished } from "vitest";
import { page } from "vitest/browser";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import { TranscriptTestHost, renderReadyRows } from "../test-helpers/chat-transcript-native.tsx";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { subscribeTranscriptScroll } from "./chat-transcript-scroll-events.ts";

class EndFollowFixture extends TranscriptTestHost {
  followEnabled = true;
  override readonly transcript = createChatTranscript(() => "end-follow-browser", {
    canFollowEnd: () => this.followEnabled,
  });
  viewportHeight = 400;
  viewportPadding = 60;
  earlierRowHeight = 400;
  lastRowHeight = 900;

  private readonly viewport = document.createElement("div");
  private readonly thread = document.createElement("div");
  private readonly earlier = document.createElement("div");
  private readonly last = document.createElement("div");
  private readonly dock = document.createElement("div");
  private readonly content = [this.viewport, this.dock];
  private appliedEarlierRowHeight: number | undefined;
  private appliedLastRowHeight: number | undefined;

  constructor() {
    super();
    this.viewport.className = "chat-thread-viewport";
    this.thread.className = "chat-thread";
    this.thread.style.overflowAnchor = "none";
    this.viewport.append(this.thread);
    this.earlier.textContent = "Earlier";
    this.last.textContent = "Growing run";
    this.dock.className = "chat-prs";
    this.dock.style.cssText = "position: relative; height: 38px; margin-top: -38px";
    this.dock.textContent = "Pull request";
  }

  override renderTranscript = () => {
    this.viewport.style.cssText = `height: ${this.viewportHeight}px; flex: none; padding: 0 0 ${this.viewportPadding}px`;
    // Preserve intrinsic DOM growth when only the controller requests a render.
    if (this.appliedEarlierRowHeight !== this.earlierRowHeight) {
      this.earlier.style.height = `${this.earlierRowHeight}px`;
      this.appliedEarlierRowHeight = this.earlierRowHeight;
    }
    if (this.appliedLastRowHeight !== this.lastRowHeight) {
      this.last.style.height = `${this.lastRowHeight}px`;
      this.appliedLastRowHeight = this.lastRowHeight;
    }
    const rows: TranscriptRow[] = [
      { kind: "content", key: "earlier", content: this.earlier },
      { kind: "content", key: "growing-run", content: this.last },
    ];
    const content = this.transcript.renderSession("agent:main:end-follow", (session) =>
      renderReadyRows(session, rows),
    );
    if (content.parentElement !== this.thread) {
      this.thread.replaceChildren(content);
    }
    return this.content;
  };
}
customElements.define("test-transcript-end-follow", EndFollowFixture);

let fixture: EndFollowFixture | undefined;
const browserErrors: string[] = [];
const recordBrowserError = (event: ErrorEvent) => browserErrors.push(event.message);
beforeEach(() => {
  browserErrors.length = 0;
  window.addEventListener("error", recordBrowserError);
});
afterEach(() => {
  fixture?.remove();
  fixture = undefined;
  window.removeEventListener("error", recordBrowserError);
  expect(browserErrors).toEqual([]);
});

async function mountEndFollowFixture(savedOffset?: number) {
  await page.viewport(1200, 900);
  saveChatSessionScrollPosition("end-follow-browser", "agent:main:end-follow", {
    scrollTop: savedOffset ?? 0,
    anchorToEnd: savedOffset === undefined,
  });
  const host = new EndFollowFixture();
  fixture = host;
  host.style.cssText = "display: block; width: 800px";
  document.body.append(host);
  await host.updateComplete;
  if (savedOffset === undefined) {
    // These growth cases start after navigation has measured both fixed-height rows.
    host.transcript.scrollToEnd();
  }
  const thread = host.querySelector<HTMLElement>(".chat-thread")!;
  const row = host.querySelector<HTMLElement>('[data-virtual-row-key="growing-run"]')!;
  const extent = host.querySelector<HTMLElement>(".chat-thread-inner--virtual")!;
  const dock = host.querySelector<HTMLElement>(".chat-prs")!;
  const distance = () => thread.scrollHeight - thread.clientHeight - thread.scrollTop;
  await expect.poll(() => extent.offsetHeight).toBe(1300);
  return { host, thread, row, extent, dock, distance };
}

async function mountFollowingFixture() {
  const view = await mountEndFollowFixture();
  view.host.transcript.scrollToEnd();
  await expect.poll(view.distance).toBe(0);
  await settleFrames();
  return view;
}

async function settleFrames() {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

it("keeps a newly measured tail visible in the first paint after growth", async () => {
  const { host, thread, row, distance } = await mountFollowingFixture();
  const gapAtPaint = await new Promise<number>((resolve) => {
    setTimeout(() => {
      const content = row.firstElementChild as HTMLElement;
      content.style.height = `${host.lastRowHeight + 88}px`;
      requestAnimationFrame(() => {
        const observer = new ResizeObserver(() => {
          observer.disconnect();
          resolve(distance());
        });
        observer.observe(thread);
      });
    }, 0);
  });
  expect(gapAtPaint).toBe(0);
});

it.each([true, false])(
  "preserves footer-only resize intent while following: %s",
  async (following) => {
    const { host, thread } = following
      ? await mountFollowingFixture()
      : await mountEndFollowFixture(200);
    host.followEnabled = following;
    if (!following) {
      await expect.poll(() => thread.scrollTop).toBe(200);
    }
    const before = thread.scrollTop;
    // An asynchronously resized footer changes padding without rendering transcript rows.
    host.viewportPadding = 69;
    thread.parentElement!.style.paddingBottom = "69px";
    await expect.poll(() => thread.style.paddingBottom).toBe("69px");
    await settleFrames();
    expect(thread.scrollTop).toBe(following ? before + 9 : before);
  },
);

async function resizeViewport(host: EndFollowFixture, thread: HTMLElement, height: number) {
  host.viewportHeight = height;
  host.requestRender();
  await expect.poll(() => thread.clientHeight).toBe(height);
}

async function growLastRow(host: EndFollowFixture, extent: HTMLElement) {
  host.lastRowHeight += 48;
  host.requestRender();
  await expect.poll(() => extent.offsetHeight).toBe(1348);
  await settleFrames();
}

function departAndClamp(host: EndFollowFixture, thread: HTMLElement) {
  host.followEnabled = false;
  thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -32 }));
  thread.scrollTop -= 32;
  host.viewportHeight = 600;
}

async function commitTask(host: EndFollowFixture, change: () => void) {
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      change();
      host.requestRender();
      void host.updateComplete.then(() => resolve());
    }, 0);
  });
}

// A measured extent can commit before its corrective scroll is delivered. Wait
// for that native event and the observer's receipt-retirement frame, not a fixed
// number of frames counted from the earlier DOM commit.
async function commitScrollTask(
  host: EndFollowFixture,
  thread: HTMLElement,
  target: number,
  change: () => void,
) {
  const listener = new AbortController();
  let frame: number | undefined;
  const scrolled = new Promise<void>((resolve) => {
    thread.addEventListener(
      "scroll",
      () => {
        if (thread.scrollTop === target) {
          frame = requestAnimationFrame(() => resolve());
        }
      },
      { signal: listener.signal },
    );
  });
  try {
    await commitTask(host, change);
    await scrolled;
  } finally {
    listener.abort();
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
    }
  }
}

it("paints a saved reader only after its measured range and offset commit together", async () => {
  const visible: Array<{ top: number; height: number }> = [];
  let frame = 0;
  const frames = new Promise<void>((resolve) => {
    let count = 0;
    const sample = () => {
      const thread = fixture?.querySelector<HTMLElement>(".chat-thread");
      const extent = thread?.querySelector<HTMLElement>(".chat-thread-inner--virtual");
      if (thread && extent && getComputedStyle(extent).visibility !== "hidden") {
        visible.push({ top: thread.scrollTop, height: extent.offsetHeight });
      }
      if (++count < 24 || visible.length === 0) {
        frame = requestAnimationFrame(sample);
      } else {
        resolve();
      }
    };
    frame = requestAnimationFrame(sample);
  });
  onTestFinished(() => cancelAnimationFrame(frame));
  await mountEndFollowFixture(400);
  await frames;
  expect(visible.length).toBeGreaterThan(0);
  expect(
    visible.every(({ top, height }) => top === 400 && height === 1300),
    JSON.stringify(visible),
  ).toBe(true);
});

it.each(["requested", "smooth no-op", "native observation"] as const)(
  "preserves the %s end through same-key row measurement growth",
  async (acquisition) => {
    const { host, thread, row, extent, dock, distance } = await mountEndFollowFixture();
    if (acquisition === "smooth no-op") {
      thread.scrollTop = 0;
      await settleFrames();
      await new Promise<void>((resolve) => {
        const stop = subscribeTranscriptScroll(thread, (event) => {
          if (event.type === "offset" && !event.scrolling && distance() === 0) {
            stop();
            resolve();
          }
        });
        host.transcript.scrollToEnd();
      });
      host.transcript.scrollToEnd({ source: "auto", behavior: "smooth" });
      await settleFrames();
    } else {
      if (acquisition === "native observation") {
        await commitTask(host, () => {
          thread.scrollTop = thread.scrollHeight;
        });
      } else {
        host.transcript.scrollToEnd();
      }
      await expect.poll(distance).toBe(0);
      if (acquisition === "native observation") {
        await settleFrames();
        await expect.poll(() => host.transcript.isProgrammaticScroll).toBe(false);
      }
    }

    const previousMax = thread.scrollHeight - thread.clientHeight;
    const growth = acquisition === "smooth no-op" ? 35 : 48;
    await commitScrollTask(host, thread, previousMax + growth, () => {
      // Reconciliation precedes the observer's measured-extent commit.
      if (acquisition === "requested") {
        host.transcript.scrollToEnd({ behavior: "auto" });
      }
      host.lastRowHeight += growth;
    });
    await expect.poll(() => extent.offsetHeight).toBe(1300 + growth);
    if (acquisition !== "smooth no-op") {
      await expect.poll(() => host.transcript.isProgrammaticScroll).toBe(false);
    }
    expect(distance()).toBe(0);
    if (acquisition === "requested") {
      expect(thread.scrollHeight - thread.clientHeight - previousMax).toBe(48);
      expect(
        row.getBoundingClientRect().bottom - dock.getBoundingClientRect().top,
      ).toBeLessThanOrEqual(0);
    }
  },
);

it.each([null, 400, 380])(
  "preserves native reader departure through growth or a deferred %s px viewport commit",
  async (viewportHeight) => {
    const { host, thread, extent, distance } = await mountFollowingFixture();
    const previousEnd = thread.scrollTop;
    if (viewportHeight === null) {
      expect(host.transcript.isProgrammaticScroll).toBe(false);
      await commitTask(host, () => {
        thread.scrollTop -= 300;
      });
    } else {
      // Keep reconciliation queued while native movement follows the DOM commit.
      await commitTask(host, () => {
        host.viewportHeight = viewportHeight;
      });
      thread.scrollTop -= 8;
    }
    const movedPosition = thread.scrollTop;
    if (viewportHeight === null) {
      expect(previousEnd - movedPosition).toBe(300);
      await commitTask(host, () => {
        host.lastRowHeight += 48;
      });
      await expect.poll(() => extent.offsetHeight).toBe(1348);
    } else {
      expect(host.transcript.isMaintenanceScroll).toBe(false);
    }
    await settleFrames();
    if (viewportHeight === null) {
      expect(Math.abs(thread.scrollTop - movedPosition)).toBeLessThanOrEqual(1);
    } else {
      expect(thread.scrollTop).toBe(movedPosition);
      expect(distance()).toBe(408 - viewportHeight);
    }
  },
);

it.each([
  [120, 0],
  [-120, 0],
  [120, 11],
  [-120, 11],
])(
  "preserves wheel intent through late growth (%i, %i px above the viewport)",
  async (deltaY, earlierGrowth) => {
    const { host, thread, extent, row, dock, distance } = await mountFollowingFixture();

    // Intrinsic growth must trigger its own measured-range commit. Growth above
    // the viewport also queues compensation clamped by the still-old range.
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        thread.dispatchEvent(new WheelEvent("wheel", { deltaY }));
        const earlier = host.querySelector<HTMLElement>('[data-virtual-row-key="earlier"] > div')!;
        earlier.style.height = `${400 + earlierGrowth}px`;
        (row.firstElementChild as HTMLElement).style.height = "1100px";
        resolve();
      }, 0);
    });
    await expect.poll(() => extent.offsetHeight).toBe(1500 + earlierGrowth);
    await settleFrames();
    expect(distance()).toBe(deltaY > 0 ? 0 : 200);
    if (deltaY > 0) {
      expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        dock.getBoundingClientRect().top,
      );
    }
  },
);

it("does not turn a resize-clamped reader into permission to follow", async () => {
  const { host, thread, extent, distance } = await mountFollowingFixture();
  await commitTask(host, () => departAndClamp(host, thread));
  await expect.poll(distance).toBe(0);
  const clamped = thread.scrollTop;
  expect(host.transcript.scrollToEnd({ source: "auto" })).toBe(false);
  await commitTask(host, () => {
    host.lastRowHeight += 48;
  });
  await expect.poll(() => extent.offsetHeight).toBe(1348);
  await settleFrames();
  expect(Math.abs(thread.scrollTop - clamped)).toBeLessThanOrEqual(1);
  expect(distance()).toBe(48);
  expect(host.transcript.scrollToEnd({ source: "manual" })).toBe(true);
  host.followEnabled = true;
  await expect.poll(distance).toBe(0);
});

it("preserves compensation provenance for later native scroll listeners", async () => {
  const { host, thread, extent, distance } = await mountFollowingFixture();
  const readerIdle = new Promise<void>((resolve) => {
    let sawScrolling = false;
    const unsubscribe = subscribeTranscriptScroll(thread, (observation) => {
      // Startup scrolling cannot establish that the later resize clamp is idle.
      if (observation.type !== "offset" || thread.clientHeight !== 600 || distance() !== 0) {
        return;
      }
      // The clamp receipt can consume the delta before the native observation.
      sawScrolling ||= observation.scrolling;
      if (sawScrolling && !observation.scrolling) {
        unsubscribe();
        resolve();
      }
    });
  });
  await commitTask(host, () => departAndClamp(host, thread));
  await readerIdle;
  await expect.poll(() => thread.clientHeight).toBe(600);
  await expect.poll(distance).toBe(0);
  await settleFrames();
  expect(host.transcript.isProgrammaticScroll).toBe(false);

  const expectedOffset = thread.scrollTop + 48;
  const observations: Array<{ trusted: boolean; programmatic: boolean }> = [];
  // Mount already installed the offset observer. Native dispatch has no outer
  // JavaScript stack, so microtasks may run before this later listener.
  thread.addEventListener("scroll", (event) => {
    observations.push({
      trusted: event.isTrusted,
      programmatic: host.transcript.isProgrammaticScroll,
    });
  });
  await commitScrollTask(host, thread, expectedOffset, () => {
    host.earlierRowHeight += 48;
  });
  await expect.poll(() => extent.offsetHeight).toBe(1348);
  expect(observations.length).toBeGreaterThan(0);
  expect(observations[0]).toEqual({ trusted: true, programmatic: true });
  thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
  expect(host.transcript.isProgrammaticScroll).toBe(false);
});

it.each([
  [0, false],
  [8, false],
  [8, true],
] as const)(
  "preserves layout clamps versus %i px reader movement (before clamp: %s)",
  async (readerMovement, beforeClamp) => {
    const { host, thread, extent } = await mountFollowingFixture();
    const original = thread.scrollTop;
    if (beforeClamp) {
      thread.scrollTop -= readerMovement;
    }

    await resizeViewport(host, thread, 500);
    expect(thread.scrollTop).toBe(original - 100);
    if (!beforeClamp) {
      thread.scrollTop -= readerMovement;
    }
    const readerPosition = thread.scrollTop;

    await resizeViewport(host, thread, 400);
    await settleFrames();
    expect(thread.scrollTop).toBe(readerMovement ? readerPosition : original);

    await growLastRow(host, extent);
    expect(thread.scrollTop).toBe(readerMovement ? readerPosition : original + 48);
  },
);

it.each([
  ["auto", true],
  ["auto", false],
  ["smooth", true],
  ["smooth", false],
] as const)(
  "preserves a departed reader through clamped idle (%s, starts at end: %s)",
  async (behavior, fromEnd) => {
    const { host, thread, extent, distance } = await mountEndFollowFixture();
    if (fromEnd) {
      host.transcript.scrollToEnd({ behavior });
      await expect.poll(distance).toBe(0);
    } else {
      await new Promise<void>((resolve) => {
        host.transcript.scrollToOffset(0, () => resolve());
      });
      let arrived = false;
      const stop = subscribeTranscriptScroll(thread, (event) => {
        if (event.type === "offset" && event.scrolling && distance() === 0) {
          arrived = true;
        }
      });
      try {
        host.transcript.scrollToEnd({ behavior });
        await expect
          .poll(() => ({ arrived, distance: distance() }))
          .toEqual({ arrived: true, distance: 0 });
      } finally {
        stop();
      }
    }
    await settleFrames();
    const original = thread.scrollTop;
    let scrollingAtClamp = false;
    let idleAtClamp = false;
    const unsubscribe = subscribeTranscriptScroll(thread, (event) => {
      if (event.type === "offset" && thread.clientHeight === 500) {
        scrollingAtClamp ||= event.scrolling;
        idleAtClamp ||= scrollingAtClamp && !event.scrolling;
      }
    });
    try {
      thread.scrollTop -= 8;
      await resizeViewport(host, thread, 500);
      expect(thread.scrollTop).toBe(original - 100);
      const readerPosition = thread.scrollTop;
      // The existing native observer must settle while layout holds the reader
      // at a temporary end, not after the original viewport has returned.
      await expect.poll(() => idleAtClamp).toBe(true);
      await resizeViewport(host, thread, 400);
      await settleFrames();
      expect(thread.scrollTop).toBe(readerPosition);
      await growLastRow(host, extent);
      expect(thread.scrollTop).toBe(readerPosition);
    } finally {
      unsubscribe();
    }
  },
);

it("does not expose unmeasured intrinsic overflow as an independent scroll range", async () => {
  const { host, thread, row, extent, distance } = await mountFollowingFixture();
  const original = thread.scrollTop;
  const range = thread.scrollHeight;
  const body = row.firstElementChild;
  expect(body).toBeInstanceOf(HTMLElement);
  if (!(body instanceof HTMLElement)) {
    throw new Error("Missing growing row body");
  }

  body.style.height = "1100px";
  expect(thread.scrollHeight).toBe(range);
  expect(thread.scrollTop).toBe(original);
  thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
  host.lastRowHeight = 1100;
  host.requestRender();
  await expect.poll(() => extent.offsetHeight).toBe(1500);
  await settleFrames();
  expect(thread.scrollTop).toBe(original);
  expect(distance()).toBe(200);
});

it("publishes padding changes when either viewport box stays the same size", async () => {
  const { host, thread, distance } = await mountFollowingFixture();
  const original = thread.scrollTop;

  host.viewportPadding = 40;
  host.requestRender();
  await expect.poll(() => getComputedStyle(thread).paddingBottom).toBe("40px");
  expect(thread.clientHeight).toBe(400);
  expect(thread.scrollTop).toBe(original - 20);

  // Border-box growth and matching padding growth leave the observed content box unchanged.
  host.viewportHeight = 420;
  host.viewportPadding = 60;
  host.requestRender();
  await expect.poll(() => thread.clientHeight).toBe(420);
  expect(getComputedStyle(thread).paddingBottom).toBe("60px");
  expect(distance()).toBe(0);
});

it("keeps a shrinking end target smooth during a native scroll", async () => {
  const { host, thread, extent, distance } = await mountEndFollowFixture(800);
  await expect.poll(() => thread.scrollTop).toBe(800);
  const nativeScrollTo = thread.scrollTo.bind(thread);
  const writes: Array<{ behavior?: ScrollBehavior; jump: number }> = [];
  function observeScroll(options?: ScrollToOptions): void;
  function observeScroll(x: number, y: number): void;
  function observeScroll(options: ScrollToOptions | number | undefined, y?: number): void {
    const before = thread.scrollTop;
    if (typeof options === "number") {
      nativeScrollTo(options, y ?? 0);
    } else {
      nativeScrollTo(options);
    }
    writes.push({
      behavior: typeof options === "number" ? undefined : options?.behavior,
      jump: thread.scrollTop - before,
    });
  }
  thread.scrollTo = observeScroll;
  try {
    host.transcript.scrollToEnd({ behavior: "smooth" });
    host.lastRowHeight -= 17;
    host.requestRender();
    await expect.poll(() => extent.offsetHeight).toBe(1283);
    await expect.poll(distance).toBe(0);
    expect(writes.filter((write) => write.behavior === "smooth").length).toBeGreaterThan(1);
    expect(writes.every((write) => Math.abs(write.jump) <= 1)).toBe(true);
  } finally {
    thread.scrollTo = nativeScrollTo;
  }
});

it("holds the canceled viewport after a smooth journey's automatic final approach", async () => {
  const { host, thread, extent, distance } = await mountEndFollowFixture(0);
  const earlier = host.querySelector<HTMLElement>('[data-virtual-row-key="earlier"]')!;
  const nativeScrollTo = thread.scrollTo.bind(thread);
  let finalApproach = false;
  let grewNearEnd = false;
  let canceledOffset: number | undefined;
  function observeScroll(options?: ScrollToOptions): void;
  function observeScroll(x: number, y: number): void;
  function observeScroll(options: ScrollToOptions | number | undefined, y?: number): void {
    if (typeof options === "number") {
      nativeScrollTo(options, y ?? 0);
    } else {
      finalApproach ||= grewNearEnd && options?.behavior === "auto";
      nativeScrollTo(options);
    }
  }
  thread.scrollTo = observeScroll;
  const listener = new AbortController();
  const canceled = new Promise<number>((resolve) => {
    thread.addEventListener(
      "scroll",
      () => {
        if (canceledOffset !== undefined) {
          return;
        }
        if (finalApproach) {
          canceledOffset = thread.scrollTop;
          earlier.style.height = "442px";
          host.transcript.cancelScroll();
          resolve(canceledOffset);
        } else if (!grewNearEnd && distance() <= thread.clientHeight) {
          grewNearEnd = true;
          host.lastRowHeight += 48;
          host.requestRender();
        }
      },
      { capture: true, signal: listener.signal },
    );
  });
  try {
    host.transcript.scrollToEnd({ behavior: "smooth" });
    const offset = await canceled;
    await settleFrames();
    expect(extent.offsetHeight).toBe(1390);
    expect(thread.scrollTop).toBe(offset);
  } finally {
    listener.abort();
    thread.scrollTo = nativeScrollTo;
  }
});
