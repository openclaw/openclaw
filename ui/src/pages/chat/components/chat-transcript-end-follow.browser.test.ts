import { LitElement, html } from "lit";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { subscribeTranscriptScroll } from "./chat-transcript-scroll-events.ts";

class EndFollowFixture extends LitElement {
  followEnabled = true;
  readonly transcript = new ChatTranscriptController(this, () => "end-follow-browser", {
    canFollowEnd: () => this.followEnabled,
  });
  viewportHeight = 400;
  viewportPadding = 60;
  earlierRowHeight = 400;
  lastRowHeight = 900;

  protected override createRenderRoot() {
    return this;
  }

  protected override render() {
    const rows: TranscriptRow[] = [
      {
        kind: "content",
        key: "earlier",
        content: html`<div style=${`height: ${this.earlierRowHeight}px`}>Earlier</div>`,
      },
      {
        kind: "content",
        key: "growing-run",
        content: html`<div style=${`height: ${this.lastRowHeight}px`}>Growing run</div>`,
      },
    ];
    return html`
      <div
        class="chat-thread-viewport"
        style=${`height: ${this.viewportHeight}px; flex: none; padding: 0 0 ${this.viewportPadding}px`}
      >
        <div class="chat-thread" style="overflow-anchor: none">
          ${this.transcript.renderSession("agent:main:end-follow", (session) => {
            session.setContentReady(true);
            return session.render(
              rows,
              (row) => (row.kind === "content" ? row.content : null),
              null,
              false,
            );
          })}
        </div>
      </div>
      <div class="chat-prs" style="position: relative; height: 38px; margin-top: -38px">
        Pull request
      </div>
    `;
  }
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

async function mountEndFollowFixture() {
  await page.viewport(1200, 900);
  const host = new EndFollowFixture();
  fixture = host;
  host.style.cssText = "display: block; width: 800px";
  document.body.append(host);
  await host.updateComplete;
  const thread = host.querySelector<HTMLElement>(".chat-thread")!;
  const row = host.querySelector<HTMLElement>('[data-virtual-row-key="growing-run"]')!;
  const extent = host.querySelector<HTMLElement>(".chat-thread-inner--virtual")!;
  const dock = host.querySelector<HTMLElement>(".chat-prs")!;
  const distance = () => thread.scrollHeight - thread.clientHeight - thread.scrollTop;
  await expect.poll(() => extent.offsetHeight).toBe(1300);
  // These cases mutate settled geometry. Row measurement can finish before the
  // viewport owner copies slot padding, which independently changes the range.
  await expect.poll(() => thread.style.paddingTop).toBe("0px");
  await expect.poll(() => thread.style.paddingBottom).toBe("60px");
  expect(thread.clientHeight).toBe(400);
  return { host, thread, row, extent, dock, distance };
}

async function settleFrames() {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

async function commitTask(host: EndFollowFixture, change: () => void) {
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      change();
      host.requestUpdate();
      void host.updateComplete.then(() => resolve());
    }, 0);
  });
}

it("tracks an outstanding end command after same-key row measurement grows the extent", async () => {
  const { host, thread, row, extent, dock, distance } = await mountEndFollowFixture();
  host.transcript.scrollToEnd();
  await expect.poll(distance).toBe(0);

  const previousMax = thread.scrollHeight - thread.clientHeight;
  // A task commits growth while an end command is outstanding. Its first
  // reconciliation frame precedes ResizeObserver's measured-extent commit.
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      host.transcript.scrollToEnd({ behavior: "auto" });
      host.lastRowHeight += 48;
      host.requestUpdate();
      void host.updateComplete.then(() => resolve());
    }, 0);
  });
  await expect.poll(() => extent.offsetHeight).toBe(1348);
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  const geometry = {
    distance: distance(),
    overhang: row.getBoundingClientRect().bottom - dock.getBoundingClientRect().top,
    growth: thread.scrollHeight - thread.clientHeight - previousMax,
    programmatic: host.transcript.isProgrammaticScroll,
  };
  expect(geometry, "48px growth must reach the true end").toMatchObject({
    distance: 0,
    growth: 48,
    programmatic: false,
  });
  expect(geometry.overhang).toBeLessThanOrEqual(0);
});

it("does not yank a reader who left the end programmatically", async () => {
  const { host, thread, extent, distance } = await mountEndFollowFixture();
  host.transcript.scrollToEnd();
  await expect.poll(distance).toBe(0);
  await settleFrames();
  expect(host.transcript.isProgrammaticScroll).toBe(false);

  const previousEnd = thread.scrollTop;
  await commitTask(host, () => {
    thread.scrollTop -= 300;
  });
  const movedPosition = thread.scrollTop;
  expect(previousEnd - movedPosition).toBe(300);
  await commitTask(host, () => {
    host.lastRowHeight += 48;
  });
  await expect.poll(() => extent.offsetHeight).toBe(1348);
  await settleFrames();

  // A never-moved instant end command may linger until reader input or the
  // next end settle; the reader's position is the contract here.
  const geometry = {
    previousEnd,
    movedPosition,
    scrollTop: thread.scrollTop,
    displacement: thread.scrollTop - movedPosition,
  };
  expect(Math.abs(geometry.displacement)).toBeLessThanOrEqual(1);
});

it.each([400, 380])(
  "preserves native movement between the DOM commit and deferred end reconciliation (%ipx viewport)",
  async (viewportHeight) => {
    const { host, thread, distance } = await mountEndFollowFixture();
    host.transcript.scrollToEnd();
    await expect.poll(distance).toBe(0);
    await settleFrames();

    // Finish the DOM commit, but keep its end reconciliation queued for the frame.
    await commitTask(host, () => {
      host.viewportHeight = viewportHeight;
    });
    thread.scrollTop -= 8;
    const movedPosition = thread.scrollTop;
    expect(host.transcript.isMaintenanceScroll).toBe(false);
    await settleFrames();

    expect(thread.scrollTop).toBe(movedPosition);
    expect(distance()).toBe(408 - viewportHeight);
  },
);

it("keeps a reader observed at the end pinned when a row grows without a follow", async () => {
  const { host, thread, extent, distance } = await mountEndFollowFixture();
  // Reach the end through native observation without ever issuing an end command.
  await commitTask(host, () => {
    thread.scrollTop = thread.scrollHeight;
  });
  await expect.poll(distance).toBe(0);
  await settleFrames();
  expect(host.transcript.isProgrammaticScroll).toBe(false);

  await commitTask(host, () => {
    host.lastRowHeight += 48;
  });
  await expect.poll(() => extent.offsetHeight).toBe(1348);
  await settleFrames();
  expect(distance()).toBe(0);
  expect(host.transcript.isProgrammaticScroll).toBe(false);
});

it.each([
  { deltaY: 120, follows: true, earlierGrowth: 0 },
  { deltaY: -120, follows: false, earlierGrowth: 0 },
  { deltaY: 120, follows: true, earlierGrowth: 11 },
  { deltaY: -120, follows: false, earlierGrowth: 11 },
])(
  "preserves wheel intent through late growth ($deltaY, $earlierGrowth px above the viewport)",
  async ({ deltaY, follows, earlierGrowth }) => {
    const { host, thread, extent, row, dock, distance } = await mountEndFollowFixture();
    host.transcript.scrollToEnd();
    await expect.poll(distance).toBe(0);
    await settleFrames();

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
    expect(distance()).toBe(follows ? 0 : 200);
    if (follows) {
      expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        dock.getBoundingClientRect().top,
      );
    }
  },
);

it("does not turn a resize-clamped reader into permission to follow", async () => {
  const { host, thread, extent, distance } = await mountEndFollowFixture();
  host.transcript.scrollToEnd();
  await expect.poll(distance).toBe(0);
  await settleFrames();
  await commitTask(host, () => {
    host.followEnabled = false;
    thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -32 }));
    thread.scrollTop -= 32;
    host.viewportHeight = 600;
  });
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
  const { host, thread, extent, distance } = await mountEndFollowFixture();
  host.transcript.scrollToEnd();
  await expect.poll(distance).toBe(0);
  await settleFrames();
  const readerIdle = new Promise<void>((resolve) => {
    let moved = false;
    const unsubscribe = subscribeTranscriptScroll(thread, (observation) => {
      if (observation.type !== "offset") {
        return;
      }
      moved ||= observation.scrolling && observation.delta !== 0;
      if (moved && !observation.scrolling) {
        unsubscribe();
        resolve();
      }
    });
  });
  await commitTask(host, () => {
    host.followEnabled = false;
    thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -32 }));
    thread.scrollTop -= 32;
    host.viewportHeight = 600;
  });
  await readerIdle;
  await expect.poll(distance).toBe(0);
  await settleFrames();
  expect(host.transcript.isProgrammaticScroll).toBe(false);

  const observations: Array<{ trusted: boolean; programmatic: boolean }> = [];
  // Mount already installed the offset observer. Native dispatch has no outer
  // JavaScript stack, so microtasks may run before this later listener.
  thread.addEventListener("scroll", (event) => {
    observations.push({
      trusted: event.isTrusted,
      programmatic: host.transcript.isProgrammaticScroll,
    });
  });
  await commitTask(host, () => {
    host.earlierRowHeight += 48;
  });
  await expect.poll(() => extent.offsetHeight).toBe(1348);
  await expect.poll(() => observations.length).toBeGreaterThan(0);
  expect(observations[0]).toEqual({ trusted: true, programmatic: true });
  thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
  expect(host.transcript.isProgrammaticScroll).toBe(false);
});

it.each([
  { readerMovement: 0, beforeClamp: false },
  { readerMovement: 8, beforeClamp: false },
  { readerMovement: 8, beforeClamp: true },
])(
  "preserves layout clamps versus $readerMovement px reader movement (before clamp: $beforeClamp)",
  async ({ readerMovement, beforeClamp }) => {
    const { host, thread, extent, distance } = await mountEndFollowFixture();
    host.transcript.scrollToEnd();
    await expect.poll(distance).toBe(0);
    await settleFrames();
    const original = thread.scrollTop;
    if (beforeClamp) {
      thread.scrollTop -= readerMovement;
    }

    host.viewportHeight = 500;
    host.requestUpdate();
    await expect.poll(() => thread.clientHeight).toBe(500);
    expect(thread.scrollTop).toBe(original - 100);
    if (!beforeClamp) {
      thread.scrollTop -= readerMovement;
    }
    const readerPosition = thread.scrollTop;

    host.viewportHeight = 400;
    host.requestUpdate();
    await expect.poll(() => thread.clientHeight).toBe(400);
    await settleFrames();
    expect(thread.scrollTop).toBe(readerMovement ? readerPosition : original);

    host.lastRowHeight += 48;
    host.requestUpdate();
    await expect.poll(() => extent.offsetHeight).toBe(1348);
    await settleFrames();
    expect(thread.scrollTop).toBe(readerMovement ? readerPosition : original + 48);
  },
);

it("does not expose unmeasured intrinsic overflow as an independent scroll range", async () => {
  const { host, thread, row, extent, distance } = await mountEndFollowFixture();
  host.transcript.scrollToEnd();
  await expect.poll(distance).toBe(0);
  await settleFrames();
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
  host.requestUpdate();
  await expect.poll(() => extent.offsetHeight).toBe(1500);
  await settleFrames();
  expect(thread.scrollTop).toBe(original);
  expect(distance()).toBe(200);
});

it("publishes padding changes when either viewport box stays the same size", async () => {
  const { host, thread, distance } = await mountEndFollowFixture();
  host.transcript.scrollToEnd();
  await expect.poll(distance).toBe(0);
  await settleFrames();
  const original = thread.scrollTop;

  host.viewportPadding = 40;
  host.requestUpdate();
  await expect.poll(() => getComputedStyle(thread).paddingBottom).toBe("40px");
  expect(thread.clientHeight).toBe(400);
  expect(thread.scrollTop).toBe(original - 20);

  // Border-box growth and matching padding growth leave the observed content box unchanged.
  host.viewportHeight = 420;
  host.viewportPadding = 60;
  host.requestUpdate();
  await expect.poll(() => thread.clientHeight).toBe(420);
  expect(getComputedStyle(thread).paddingBottom).toBe("60px");
  expect(distance()).toBe(0);
});
