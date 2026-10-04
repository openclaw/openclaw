import { expectDefined } from "@openclaw/normalization-core";
import { html } from "lit";
import { afterEach, expect, it } from "vitest";
import type { ApplicationContext } from "../../../app/context.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { createMountedPanes } from "../chat-pane-mounted.test-support.ts";
import { ChatPane } from "../chat-pane-render.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import { maxTranscriptScrollOffset } from "./chat-transcript-geometry.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";

const ROW_COUNT = 30;
// The next to last row spans the viewport top; the reader is on its second paragraph.
const SPANNING_ROW = ROW_COUNT - 2;

class ClampPane extends ChatPane {
  session: ChatSessionVirtualizerHost | undefined;
  private readonly rows: TranscriptRow[] = Array.from({ length: ROW_COUNT }, (_, index) => ({
    kind: "content",
    key: `row-${index}`,
    content:
      index === SPANNING_ROW
        ? html`<div class="chat-bubble" data-message-id="spanning">
            <p data-test="cut" style="height: 200px; margin: 0">cut</p>
            <p data-test="read" style="height: 200px; margin: 0">read</p>
          </div>`
        : html`<div style="height: 120px">Row ${index}</div>`,
  }));

  initialize(context: ApplicationContext) {
    this.context = context;
    this.paneId = "resize-clamp";
    this.sessionKey = "agent:main:resize-clamp";
    saveChatSessionScrollPosition(this.paneId, this.sessionKey, {
      scrollTop: 0,
      anchorToEnd: false,
    });
  }

  override render() {
    return html`
      <div class="chat-thread-viewport" style="height: 400px; flex: none; padding: 0">
        <div class="chat-thread" style="overflow-anchor: none">
          ${this.transcript.renderSession(this.sessionKey, (session) => {
            if (!(session instanceof ChatSessionVirtualizerHost)) {
              throw new Error("Expected the session virtualizer owner");
            }
            this.session = session;
            return session.render(
              this.rows,
              (row) => (row.kind === "content" ? row.content : null),
              null,
              false,
            );
          })}
        </div>
      </div>
    `;
  }
}
customElements.define("test-transcript-resize-clamp-pane", ClampPane);

let pane: ClampPane | undefined;
afterEach(() => {
  pane?.remove();
  pane = undefined;
});

// Let real ResizeObservers and their resulting Lit commits finish.
async function settleLayout() {
  for (let frame = 0; frame < 6; frame++) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await pane?.updateComplete;
  }
}

/** Mount the transcript and park a paused reader 20 px above the end. */
async function mountNearEnd() {
  const fixture = createMountedPanes([
    { key: "agent:main:resize-clamp", kind: "direct", updatedAt: 1 },
  ]);
  fixture.pane.applyGatewaySnapshot({
    ...fixture.context.gateway.snapshot,
    phase: "stopped",
    client: null,
  });
  pane = new ClampPane();
  pane.initialize(fixture.context);
  pane.style.cssText = "display: block; width: 800px";
  document.body.append(pane);
  await pane.updateComplete;
  await settleLayout();
  const session = expectDefined(pane.session, "mounted transcript session");
  const viewport = expectDefined(session.scrollElement, "mounted transcript viewport");
  // Mount every row so later sizes are re-measurements, not first estimates.
  for (const offset of [viewport.scrollHeight, 0, viewport.scrollHeight]) {
    viewport.scrollTop = offset;
    await settleLayout();
  }
  viewport.scrollTop = (maxTranscriptScrollOffset(viewport) ?? 0) - 20;
  await settleLayout();
  const cut = expectDefined(
    viewport.querySelector<HTMLElement>('[data-test="cut"]'),
    "cut paragraph",
  );
  const read = expectDefined(
    viewport.querySelector<HTMLElement>('[data-test="read"]'),
    "read paragraph",
  );
  // The reader's paragraph starts inside the viewport and its row spans the top edge.
  const viewportTop = viewport.getBoundingClientRect().top;
  const rowTop = expectDefined(cut.parentElement, "spanning bubble").getBoundingClientRect().top;
  expect(rowTop).toBeLessThan(viewportTop);
  expect(read.getBoundingClientRect().top).toBeGreaterThan(viewportTop);
  return { viewport, cut, read };
}

it("applies the clamped part of a correction once the grown range commits", async () => {
  const { viewport, cut, read } = await mountNearEnd();
  const max = maxTranscriptScrollOffset(viewport) ?? 0;
  const readTop = read.getBoundingClientRect().top;

  // The row grows 100 px, 40 px of it above the reader. That partial correction
  // asks for max + 20 before the virtualizer has grown the range.
  cut.style.height = "240px";
  read.style.height = "260px";
  await settleLayout();

  expect(maxTranscriptScrollOffset(viewport)).toBe(max + 100);
  expect(viewport.scrollTop).toBe(max + 20);
  expect(read.getBoundingClientRect().top).toBeCloseTo(readTop, 0);
});

it("keeps the reader still when the same content shrinks near the end", async () => {
  const { viewport, cut, read } = await mountNearEnd();
  const max = maxTranscriptScrollOffset(viewport) ?? 0;
  const readTop = read.getBoundingClientRect().top;

  // The row shrinks 60 px, 40 px of it above the reader.
  cut.style.height = "160px";
  read.style.height = "180px";
  await settleLayout();

  expect(maxTranscriptScrollOffset(viewport)).toBe(max - 60);
  expect(viewport.scrollTop).toBe(max - 60);
  expect(read.getBoundingClientRect().top).toBeCloseTo(readTop, 0);

  // Growing back is clamped at the shrunken end, then lands exactly.
  cut.style.height = "200px";
  read.style.height = "200px";
  await settleLayout();
  expect(maxTranscriptScrollOffset(viewport)).toBe(max);
  expect(viewport.scrollTop).toBe(max - 20);
  expect(read.getBoundingClientRect().top).toBeCloseTo(readTop, 0);
});
