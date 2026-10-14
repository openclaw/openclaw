import { expectDefined } from "@openclaw/normalization-core";
import { html } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../../app/context.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { createMountedPanes } from "../chat-pane-mounted.test-support.ts";
import { ChatPane } from "../chat-pane-render.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { subscribeTranscriptScroll } from "./chat-transcript-scroll-events.ts";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";

class GeometryPane extends ChatPane {
  session: ChatSessionVirtualizerHost | undefined;
  readonly renderedRects: Array<{ width: number; height: number } | null> = [];
  private readonly rows: TranscriptRow[] = Array.from({ length: 100 }, (_, index) => ({
    kind: "content",
    key: `row-${index}`,
    content: html`<div style="height: 120px">Row ${index}</div>`,
  }));

  initialize(context: ApplicationContext) {
    this.context = context;
    this.paneId = "geometry-render";
    this.sessionKey = "agent:main:geometry-render";
    saveChatSessionScrollPosition(this.paneId, this.sessionKey, {
      scrollTop: 0,
      anchorToEnd: false,
    });
  }

  override render() {
    return html`
      <div class="chat-thread-viewport" style="height: 400px; flex: none; padding: 20px 0">
        <div class="chat-thread" style="overflow-anchor: none">
          ${this.transcript.renderSession(this.sessionKey, (session) => {
            if (!(session instanceof ChatSessionVirtualizerHost)) {
              throw new Error("Expected the session virtualizer owner");
            }
            this.session = session;
            const virtualizer = session["virtualizer"];
            this.renderedRects.push(virtualizer.scrollRect && { ...virtualizer.scrollRect });
            return html`${session.render(
                this.rows,
                (row) => (row.kind === "content" ? row.content : null),
                null,
                false,
              )}<output>${virtualizer.getTotalSize()}</output>`;
          })}
        </div>
      </div>
    `;
  }
}
customElements.define("test-transcript-geometry-pane", GeometryPane);

let pane: GeometryPane | undefined;
afterEach(() => {
  pane?.remove();
  pane = undefined;
  vi.restoreAllMocks();
});

// Let real ResizeObservers and their resulting Lit commits finish between widths.
async function settleLayout() {
  for (let frame = 0; frame < 4; frame++) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await pane?.updateComplete;
  }
}

async function mountPane() {
  const fixture = createMountedPanes([
    { key: "agent:main:geometry-render", kind: "direct", updatedAt: 1 },
  ]);
  fixture.pane.applyGatewaySnapshot({
    ...fixture.context.gateway.snapshot,
    phase: "stopped",
    client: null,
  });
  pane = new GeometryPane();
  pane.initialize(fixture.context);
  pane.style.cssText = "display: block; width: 800px";
  document.body.append(pane);
  await pane.updateComplete;
  await vi.dynamicImportSettled();
  await settleLayout();
  const session = expectDefined(pane.session, "mounted transcript session");
  const viewport = expectDefined(session.scrollElement, "mounted transcript viewport");
  return { host: pane, session, viewport };
}

it("commits each settled pane width with its new transcript rect in exactly one render", async () => {
  const { host, viewport } = await mountPane();
  const updates = vi.spyOn(host, "performUpdate");
  const counts: number[] = [];
  for (const width of [760, 720, 680, 740, 1001.5, 999.75]) {
    updates.mockClear();
    host.renderedRects.length = 0;
    host.style.width = `${width}px`;
    await settleLayout();
    counts.push(updates.mock.calls.length);
    expect.soft(host.renderedRects[0]).toEqual({ width: Math.round(width), height: 400 });
    expect.soft(updates).toHaveBeenCalledTimes(1);
    expect(viewport.getBoundingClientRect().width).toBe(width);
  }
  console.info(`Settled width render counts: ${counts.join(", ")}`);
});

it.each(["pending", "hostUpdated"] as const)(
  "commits a non-sync measurement before paint with a %s pane update",
  async (phase) => {
    const { host, session } = await mountPane();
    const virtualizer = session["virtualizer"];
    const notification = vi.spyOn(virtualizer.options, "onChange");
    const updates = vi.spyOn(host, "performUpdate");
    const paint = vi.fn();
    const frame = requestAnimationFrame(paint);
    const measure = () => virtualizer.resizeItem(0, 180);
    const controller = {
      hostUpdated() {
        host.removeController(controller);
        measure();
      },
    };
    if (phase === "hostUpdated") {
      host.addController(controller);
    }
    host.requestUpdate();
    if (phase === "pending") {
      measure();
    }
    try {
      while (host.isUpdatePending) {
        await host.updateComplete;
      }
      expect(notification).toHaveBeenCalledExactlyOnceWith(virtualizer, false);
      expect(updates).toHaveBeenCalledTimes(phase === "pending" ? 1 : 2);
      expect(Number(host.querySelector("output")?.textContent)).toBeCloseTo(12060, 6);
      expect(paint).not.toHaveBeenCalled();
    } finally {
      cancelAnimationFrame(frame);
      host.removeController(controller);
    }
  },
);

it.each([
  { scale: 1, boxSizing: "border-box", width: 620.25, height: 460.5 },
  { scale: 0.8, boxSizing: "border-box", width: 620.25, height: 460.5 },
  { scale: 0.8, boxSizing: "content-box", width: 626.25, height: 506.5 },
])(
  "consumes the unscaled $boxSizing rect once at scale $scale",
  async ({ scale, boxSizing, width, height }) => {
    const { host, session, viewport } = await mountPane();
    const slot = expectDefined(viewport.parentElement, "viewport slot");
    const observed: Array<{ width: number; height: number }> = [];
    const observer = new ResizeObserver(([entry]) => {
      const size = expectDefined(entry?.borderBoxSize[0], "viewport border box");
      observed.push({ width: size.inlineSize, height: size.blockSize });
    });
    observer.observe(viewport, { box: "border-box" });
    const updates = vi.spyOn(host, "performUpdate");
    try {
      slot.style.cssText = `box-sizing: ${boxSizing}; width: 620.25px; height: 460.5px; flex: none; padding: 20px 0; border: 3px solid transparent; transform: scale(${scale})`;
      session.syncViewportGeometry();
      const rect = { width: Math.round(width), height: Math.round(height) };
      expect(session["virtualizer"].scrollRect).toEqual(rect);
      while (host.isUpdatePending) {
        await host.updateComplete;
      }
      const requests = vi.spyOn(host, "requestUpdate");
      await settleLayout();
      expect(observed).toEqual([{ width, height }]);
      expect(session["virtualizer"].scrollRect).toEqual(rect);
      expect(requests).not.toHaveBeenCalled();
      expect(updates).toHaveBeenCalledTimes(1);
    } finally {
      observer.disconnect();
    }
  },
);

it("synchronizes padding changes even when the viewport's outer rect stays the same", async () => {
  const { session, viewport } = await mountPane();
  const slot = expectDefined(viewport.parentElement, "viewport slot");
  const virtualizer = session["virtualizer"];
  const rect = virtualizer.scrollRect;
  expect(virtualizer.options.scrollMargin).toBe(20);
  slot.style.paddingTop = "24px";
  session.syncViewportGeometry();
  expect(viewport.style.paddingTop).toBe("24px");
  expect(virtualizer.scrollRect).toEqual(rect);
  expect(virtualizer.options.scrollMargin).toBe(24);
  expect(virtualizer.getVirtualItems()[0]?.start).toBe(24);
});

it.each(["border-box", "content-box"])(
  "syncs the unscaled %s viewport idempotently and publishes its native clamp once",
  async (boxSizing) => {
    const { session, viewport } = await mountPane();
    const slot = expectDefined(viewport.parentElement, "viewport slot");
    viewport.scrollTop = viewport.scrollHeight;
    const before = viewport.scrollTop;
    const resized = vi.fn();
    const stop = subscribeTranscriptScroll(viewport, (event) => {
      if (event.type === "resize") {
        resized(event);
      }
    });
    const mutations = new MutationObserver(() => {});
    mutations.observe(viewport, { attributes: true, attributeFilter: ["style"] });
    try {
      slot.style.cssText = `box-sizing: ${boxSizing}; width: 620.25px; height: 460.5px; flex: none; padding: 20px 0; transform: scale(0.8)`;
      session.layout.sync();
      expect(viewport.style.width).toBe("620.25px");
      expect(viewport.style.height).toBe(boxSizing === "border-box" ? "460.5px" : "500.5px");
      expect(viewport.scrollTop).toBeLessThan(before);
      expect(resized).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          scrollCorrection: { before, after: viewport.scrollTop },
        }),
      );
      expect(mutations.takeRecords().length).toBeGreaterThan(0);
      session.layout.sync();
      expect(mutations.takeRecords()).toEqual([]);
      expect(resized).toHaveBeenCalledTimes(1);
    } finally {
      mutations.disconnect();
      stop();
    }
  },
);

it("retains measured viewport geometry while its slot is hidden", async () => {
  const { session, viewport } = await mountPane();
  const slot = expectDefined(viewport.parentElement, "viewport slot");
  const before = viewport.style.cssText;
  const rect = session["virtualizer"].scrollRect;
  slot.style.display = "none";
  slot.style.width = "620px";
  slot.style.height = "500px";
  session.syncViewportGeometry();
  expect(viewport.style.cssText).toBe(before);
  expect(session["virtualizer"].scrollRect).toBe(rect);
  slot.style.display = "";
  session.syncViewportGeometry();
  expect(session["virtualizer"].scrollRect).toEqual({ width: 620, height: 500 });
});
