import { LitElement, html } from "lit";
import { afterEach, expect, it } from "vitest";
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
        class="chat-thread"
        style="height: 400px; flex: none; padding: 0 0 60px; overflow-anchor: none"
      >
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
      <div class="chat-prs" style="position: relative; height: 38px; margin-top: -38px">
        Pull request
      </div>
    `;
  }
}
customElements.define("test-transcript-end-follow", EndFollowFixture);

let fixture: EndFollowFixture | undefined;
afterEach(() => {
  fixture?.remove();
  fixture = undefined;
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
  const sizer = host.querySelector<HTMLElement>(".chat-virtual-sizer")!;
  const dock = host.querySelector<HTMLElement>(".chat-prs")!;
  const distance = () => thread.scrollHeight - thread.clientHeight - thread.scrollTop;
  await expect.poll(() => sizer.offsetHeight).toBe(1300);
  return { host, thread, row, sizer, dock, distance };
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

it("tracks an outstanding end command after same-key row measurement grows the sizer", async () => {
  const { host, thread, row, sizer, dock, distance } = await mountEndFollowFixture();
  host.transcript.scrollToEnd();
  await expect.poll(distance).toBe(0);

  const previousMax = thread.scrollHeight - thread.clientHeight;
  // A task commits growth while an end command is outstanding. Its first
  // reconciliation frame precedes ResizeObserver's measured-sizer commit.
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      host.transcript.scrollToEnd({ behavior: "auto" });
      host.lastRowHeight += 48;
      host.requestUpdate();
      void host.updateComplete.then(() => resolve());
    }, 0);
  });
  await expect.poll(() => sizer.offsetHeight).toBe(1348);
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
  const { host, thread, sizer, distance } = await mountEndFollowFixture();
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
  await expect.poll(() => sizer.offsetHeight).toBe(1348);
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

it("keeps a reader observed at the end pinned when a row grows without a follow", async () => {
  const { host, thread, sizer, distance } = await mountEndFollowFixture();
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
  await expect.poll(() => sizer.offsetHeight).toBe(1348);
  await settleFrames();
  expect(distance()).toBe(0);
  expect(host.transcript.isProgrammaticScroll).toBe(false);
});

it.each([
  { deltaY: 120, follows: true },
  { deltaY: -120, follows: false },
])(
  "preserves wheel intent when content grows at the end ($deltaY)",
  async ({ deltaY, follows }) => {
    const { host, thread, sizer, row, dock, distance } = await mountEndFollowFixture();
    host.transcript.scrollToEnd();
    await expect.poll(distance).toBe(0);
    await settleFrames();

    await commitTask(host, () => {
      thread.dispatchEvent(new WheelEvent("wheel", { deltaY }));
      host.lastRowHeight += 200;
    });
    await expect.poll(() => sizer.offsetHeight).toBe(1500);
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
  const { host, thread, sizer, distance } = await mountEndFollowFixture();
  host.transcript.scrollToEnd();
  await expect.poll(distance).toBe(0);
  await settleFrames();
  await commitTask(host, () => {
    host.followEnabled = false;
    thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -32 }));
    thread.scrollTop -= 32;
    thread.style.height = "600px";
  });
  await expect.poll(distance).toBe(0);
  const clamped = thread.scrollTop;
  expect(host.transcript.scrollToEnd({ source: "auto" })).toBe(false);
  await commitTask(host, () => {
    host.lastRowHeight += 48;
  });
  await expect.poll(() => sizer.offsetHeight).toBe(1348);
  await settleFrames();
  expect(Math.abs(thread.scrollTop - clamped)).toBeLessThanOrEqual(1);
  expect(distance()).toBe(48);
  expect(host.transcript.scrollToEnd({ source: "manual" })).toBe(true);
  host.followEnabled = true;
  await expect.poll(distance).toBe(0);
});

it("preserves compensation provenance for later native scroll listeners", async () => {
  const { host, thread, sizer, distance } = await mountEndFollowFixture();
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
    thread.style.height = "600px";
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
  await expect.poll(() => sizer.offsetHeight).toBe(1348);
  await expect.poll(() => observations.length).toBeGreaterThan(0);
  expect(observations[0]).toEqual({ trusted: true, programmatic: true });
  thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
  expect(host.transcript.isProgrammaticScroll).toBe(false);
});
