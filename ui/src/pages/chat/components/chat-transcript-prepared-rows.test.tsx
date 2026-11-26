/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareChatMessageRender } from "../../../lib/chat/message-display.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { prepareGroupedMessage } from "./chat-message-bubble-presentation.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { prepareMessageMarkdown } from "./chat-message-text-preparation.ts";
import { ChatTimestamp } from "./chat-message-timestamp-view.tsx";
import { createMessageGroup } from "./chat-message.test-support.ts";
import { emitTranscriptResize } from "./chat-transcript-fixture.test-support.tsx";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { GuardedTranscriptItem } from "./chat-transcript-render-guard.ts";
import { prewarmGroupedMessage } from "./chat-transcript-row-prewarm.ts";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
  transcriptRows,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  resetTranscriptTestDom();
  vi.useRealTimers();
});

async function settle() {
  // Row refs and the retained root's commit each cross a microtask boundary.
  for (let turn = 0; turn < 6; turn++) {
    await Promise.resolve();
    flush();
  }
}

async function transcriptFixture(
  initialOffset: number | null = 0,
  idlePreparation = false,
  plainFirstRow = false,
  ordinary: boolean | "retained" | "data-only" = false,
  viewportHeight = 600,
  completedFrame: boolean | "toolCall" = false,
  streamingTail = false,
) {
  let now = 1;
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  let nextIdle = 0;
  const idleCallbacks = new Map<number, IdleRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  if (idlePreparation) {
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: IdleRequestCallback) => {
        idleCallbacks.set(++nextIdle, callback);
        return nextIdle;
      }),
    );
    vi.stubGlobal(
      "cancelIdleCallback",
      vi.fn((id: number) => idleCallbacks.delete(id)),
    );
  }
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, viewportHeight),
  );
  const container = document.body.appendChild(document.createElement("div"));
  Object.defineProperties(container, {
    clientHeight: { configurable: true, value: viewportHeight },
    offsetWidth: { configurable: true, value: 800 },
    offsetHeight: { configurable: true, value: viewportHeight },
    scrollHeight: {
      configurable: true,
      get: () => Number.parseFloat(host.contentElement?.style.height ?? "0") || 0,
    },
  });
  container.scrollTo = (options?: ScrollToOptions | number) => {
    if (typeof options === "object") {
      container.scrollTop = Math.max(
        0,
        Math.min(options.top ?? container.scrollTop, container.scrollHeight - viewportHeight),
      );
    }
  };
  const rows: TranscriptRow<number>[] = Array.from({ length: 256 }, (_, index) => {
    const retainDom = ordinary !== true && !(index === 0 && plainFirstRow);
    return {
      kind: "item",
      key: `fragment:${index}`,
      item: index,
      estimatedSize: index === 0 && plainFirstRow ? undefined : 100,
      retainDom,
      streaming: streamingTail && index === 255,
      prewarm: Boolean(ordinary) && (!retainDom || ordinary === "data-only"),
    };
  });
  const groups = ordinary
    ? rows.map((_, index) =>
        createMessageGroup(
          {
            role: "assistant",
            content: `${ordinary === true ? `Unretained ${viewportHeight}` : "Idle"} ordinary message ${index}`,
            timestamp: index,
          },
          "assistant",
          completedFrame
            ? {
                messages: ["first", "second"].map((part) => ({
                  key: `idle-frame-${index}-${part}`,
                  message: {
                    role: "assistant",
                    content:
                      completedFrame === "toolCall"
                        ? [
                            { type: "text", text: `**idle-frame-${index}-${part}-toolCall**` },
                            {
                              type: "toolCall",
                              id: `idle-tool-${index}-${part}`,
                              name: "read",
                              arguments: {},
                            },
                          ]
                        : `**idle-frame-${index}-${part}**`,
                    timestamp: index,
                  },
                })),
              }
            : {},
        ),
      )
    : [];
  let presented = true;
  let queued = false;
  let disposed = false;
  let preparationCost = 0;
  const rowHeights = new WeakMap<HTMLElement, number>();
  const resizeRow = (row: HTMLElement, height: number) => {
    rowHeights.set(row, height);
    emitTranscriptResize(row, 800, height);
  };
  const renderRow = vi.fn((row: TranscriptRow<number>) => {
    now += preparationCost;
    if (!ordinary) {
      return <span>Message {row.kind === "item" ? row.item : ""}</span>;
    }
    const group = groups[row.kind === "item" ? row.item : 0]!;
    return new GuardedTranscriptItem(
      [group],
      completedFrame
        ? {
            kind: "frame",
            frame: {
              kind: "agent-run-frame",
              key: `frame:${group.key}`,
              runId: group.key,
              boundaryId: group.key,
              outcome: { kind: "completed", actionOwner: group.messages.at(-1)! },
              parts: [group],
            },
            options: {
              streamOptions: {},
              partDependencies: (part) => [part],
              renderGroupOptions: () => ({ showReasoning: false }),
              isWorkExpanded: () => false,
              onToggleWork: () => {},
            },
          }
        : {
            kind: "group",
            group,
            options: { showReasoning: false },
          },
    );
  });
  let renderer = renderRow;
  const draw = vi.fn(() => {
    const root = host.render(rows, renderer, null, false, null, presented);
    if (root.parentElement !== container) {
      container.append(root);
    }
    host.update();
    flush();
  });
  const host = new ChatSessionVirtualizerHost(
    () => {
      if (!queued) {
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (!disposed) {
            draw();
          }
        });
      }
    },
    initialOffset,
    undefined,
  );
  disposers.push(() => {
    disposed = true;
    host.dispose();
  });
  host.layout.configureRows(
    threadProps("prepared-rows", "agent:main:prepared-rows", []),
    "gutter",
    false,
  );
  host.connect();
  draw();
  await settle();
  emitTranscriptResize(container, 800, viewportHeight);
  await settle();
  return {
    container,
    host,
    draw,
    renderRow,
    groups,
    resizeRow,
    elapse(milliseconds: number) {
      now += milliseconds;
    },
    async updateRow(index: number, item: number) {
      rows[index] = {
        kind: "item",
        key: `fragment:${index}`,
        item,
        estimatedSize: 100,
        retainDom: true,
      };
      draw();
      await settle();
    },
    async replaceRenderer() {
      renderer = vi.fn((row: TranscriptRow<number>) => (
        <span>Updated {row.kind === "item" ? row.item : ""}</span>
      ));
      draw();
      await settle();
    },
    async frame(count = 1, measure = true, timestampLag = 0) {
      for (let index = 0; index < count; index++) {
        now += 16;
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) {
          callback(now - timestampLag);
        }
        await settle();
        if (measure) {
          for (const row of container.querySelectorAll<HTMLElement>(
            ".chat-virtual-row:not([data-prepared-row]), [data-preparing-row]",
          )) {
            emitTranscriptResize(row, 800, rowHeights.get(row) ?? 100);
          }
        }
        await settle();
      }
    },
    async idle(available = 10, costPerRow = 0) {
      preparationCost = costPerRow;
      const pending = [...idleCallbacks.values()];
      idleCallbacks.clear();
      for (const callback of pending) {
        callback({ didTimeout: false, timeRemaining: () => available });
      }
      preparationCost = 0;
      await settle();
      for (const row of container.querySelectorAll<HTMLElement>(
        ".chat-virtual-row:not([data-prepared-row]), [data-preparing-row]",
      )) {
        emitTranscriptResize(row, 800, rowHeights.get(row) ?? 100);
      }
      await settle();
    },
    async task(elapsed = 0) {
      now += elapsed;
      if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(0);
      } else {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      }
      await settle();
    },
    async scrollTo(index: number) {
      container.scrollTop = index * 100;
      container.dispatchEvent(new Event("scroll"));
      await settle();
    },
    async present(value: boolean) {
      presented = value;
      draw();
      await settle();
    },
  };
}

it("warms medium row data while idle and paces preparation during fast scroll", async () => {
  const view = await transcriptFixture(0, true, false, "data-only", 600, true);
  const initialRows = transcriptRows(view.container);
  for (let turn = 0; turn < 160; turn++) {
    await view.idle(10, 1);
    await view.frame(2, false);
  }
  expect(prewarmGroupedMessage(view.groups[9]!.messages[0]!.message, {}, "html")).toBe(false);
  expect(transcriptRows(view.container)).toEqual(initialRows);

  await view.scrollTo(8);
  await view.frame(1, false);
  await view.task();
  expect(view.container.querySelector("[data-preparing-row]")).not.toBeNull();
  const rows = transcriptRows(view.container);
  const active = rows.filter((row) => !row.hasAttribute("inert"));
  expect(rows.length).toBeLessThanOrEqual(Math.max(6, active.length + 4));
});

it("bounds initial HTML warming and keeps distant rows out of the DOM", async () => {
  const view = await transcriptFixture(0, true, false, "retained");
  const count = () => view.container.querySelectorAll(".chat-virtual-row").length;
  const elements = count();
  await view.idle(0);
  for (let turn = 0; turn < 160; turn++) {
    await view.idle(10, 1);
    await view.frame(2, false);
  }
  await view.frame(1, false);
  // Cover the first gesture without preparing the whole untouched transcript.
  expect(prewarmGroupedMessage(view.groups[96]!.messages[0]!.message, {})).toBe(false);
  expect(prewarmGroupedMessage(view.groups[200]!.messages[0]!.message, {})).toBe(true);
  expect(view.container.querySelector('[data-virtual-row-key="fragment:9"]')).not.toBeNull();
  expect(view.container.querySelector('[data-virtual-row-key="fragment:200"]')).toBeNull();
  expect(count()).toBeLessThanOrEqual(elements + 12);
  expect(view.container.querySelector("[data-preparing-row]")).toBeNull();

  view.elapse(150);
  const idleRequests = vi.mocked(requestIdleCallback).mock.calls.length;
  for (let update = 0; update < 5; update++) {
    view.draw();
    await settle();
    await view.idle();
  }
  expect(requestIdleCallback).toHaveBeenCalledTimes(idleRequests);
});

it("mounts prewarmed assistant text around an image without parsing it again", async () => {
  const message = {
    role: "assistant",
    content: [
      { type: "text", text: "**Prepared image caption**" },
      {
        type: "image",
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a34sAAAAASUVORK5CYII=",
        alt: "Synthetic prepared image",
      },
      { type: "text", text: "Text after the image." },
    ],
  };
  expect(prewarmGroupedMessage(message, {}, "fragment")).toBe(true);
  const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
  const view = mountSolid(GroupedMessage, {
    preparation: prepareChatMessageRender(message),
    messageKey: "prepared-image",
    options: { isStreaming: false, showReasoning: false },
  });
  disposers.push(view.dispose);
  await settle();
  expect(view.container.textContent).toContain("Prepared image caption");
  expect(view.container.textContent).toContain("Text after the image.");
  await waitForSolid(() =>
    expect(view.container.querySelector('img[alt="Synthetic prepared image"]')).not.toBeNull(),
  );
  expect(view.container.textContent).not.toContain("OPENCLAWMEDIASLOT");
  expect(parse).not.toHaveBeenCalled();
});

it("warms an embedded widget's caption without mounting the widget", () => {
  const message = {
    role: "assistant",
    content:
      '**Prepared widget caption**\n\n[embed ref="prepared-caption-chart" title="Synthetic chart" height="220" /]',
  };
  const state = prepareGroupedMessage(prepareChatMessageRender(message), "prepared-widget", {
    isStreaming: false,
    showReasoning: false,
  });
  expect(state.assistantViewBlocks).toHaveLength(1);
  expect(state.bodyMarkdown).not.toContain("[embed");
  expect(prewarmGroupedMessage(message, {}, "fragment")).toBe(true);
  const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
  const prepared = prepareMessageMarkdown(
    state.bodyMarkdown!,
    "prepared-widget",
    { role: "assistant", isStreaming: false },
    state.markdownRenderOptions,
  );
  expect(prepared.parts()[0]).toEqual(
    expect.objectContaining({
      html: expect.stringContaining("<strong>Prepared widget caption</strong>"),
    }),
  );
  expect(parse).not.toHaveBeenCalled();
});

it.each([600, 1400])(
  "warms ordinary HTML without retaining offscreen DOM (%i px)",
  async (height) => {
    const view = await transcriptFixture(0, true, false, true, height);
    const elements = view.container.querySelectorAll(".chat-virtual-row").length;
    for (let turn = 0; turn < 160; turn++) {
      await view.idle(10, 1);
      await view.frame(2, false);
    }
    expect(prewarmGroupedMessage(view.groups[96]!.messages[0]!.message, {}, "html")).toBe(false);
    expect(view.container.querySelectorAll(".chat-virtual-row")).toHaveLength(elements);
    expect(view.container.querySelector("[data-prepared-row]")).toBeNull();

    await view.scrollTo(96);
    expect(view.container.textContent).toContain(`Unretained ${height} ordinary message 96`);
    const afterScroll = view.container.querySelectorAll(".chat-virtual-row").length;
    await view.idle();
    await view.frame(2, false);
    expect(view.container.querySelectorAll(".chat-virtual-row")).toHaveLength(afterScroll);
    expect(view.container.querySelector("[data-prepared-row]")).toBeNull();
  },
);

it("keeps large-jump boundary rows and cancels queued scroll warming when hidden", async () => {
  const view = await transcriptFixture(0, true, false, true);
  const indexes = () => transcriptRows(view.container).map((row) => Number(row.dataset.index));
  await view.scrollTo(60);
  expect(indexes()).toEqual([60, 61, 62, 63, 64, 65, 66]);
  await view.scrollTo(61);
  expect(indexes()).toEqual([60, 61, 62, 63, 64, 65, 66, 67]);
  await view.frame();
  await view.present(false);
  const rendered = view.renderRow.mock.calls.length;
  await view.task();
  expect(view.renderRow.mock.calls).toHaveLength(rendered);
});

it("keeps reverse medium forecasts through size compensation while the tail streams", async () => {
  const view = await transcriptFixture(24_000, true, false, "data-only", 600, false, true);
  await view.scrollTo(180);
  await view.frame();
  await view.scrollTo(120.5);
  const first = view.container.querySelector<HTMLElement>(
    ".chat-virtual-row:not([data-prepared-row])",
  )!;
  const beforeResize = view.container.scrollTop;
  view.resizeRow(first, 500);
  await settle();
  await view.frame(1, false);
  expect(view.container.scrollTop).toBeGreaterThan(beforeResize);
  await view.task();
  await view.frame(1, false);
  await view.task();
  const forecasts = [
    ...view.container.querySelectorAll<HTMLElement>("[data-preparing-row][data-prepared-row]"),
  ];
  expect(forecasts.length).toBeGreaterThan(0);
  expect(Math.max(...forecasts.map((row) => Number(row.dataset.index)))).toBeLessThan(
    Number(first.dataset.index),
  );
});

it("reuses a nearby completed row after scrolling away and back, with a bounded DOM cache", async () => {
  const view = await transcriptFixture();
  await view.frame(8);
  const first = view.container.querySelector('[data-virtual-row-key="fragment:5"]');
  expect(first).not.toBeNull();
  const preparations = () =>
    view.renderRow.mock.calls.filter(([row]) => row.key === "fragment:5").length;
  const initialPreparations = preparations();
  await view.scrollTo(8);
  await view.frame(3);
  expect(view.container.querySelector('[data-virtual-row-key="fragment:5"]')).toBe(first);
  expect(first?.getAttribute("data-prepared-row")).toBe("true");
  expect(first?.hasAttribute("inert")).toBe(true);
  expect(first?.getAttribute("aria-hidden")).toBe("true");
  await view.scrollTo(0);
  expect(view.container.querySelector('[data-virtual-row-key="fragment:5"]')).toBe(first);
  expect(first?.hasAttribute("data-prepared-row")).toBe(false);
  expect(first?.hasAttribute("inert")).toBe(false);
  expect(first?.hasAttribute("aria-hidden")).toBe(false);
  expect(preparations()).toBe(initialPreparations);
  await view.updateRow(5, 2005);
  expect(preparations()).toBe(initialPreparations + 1);
  expect(first?.textContent).toBe("Message 2005");
  await view.replaceRenderer();
  expect(first?.textContent).toBe("Updated 2005");

  for (let index = 16; index < 240; index += 8) {
    await view.scrollTo(index);
    await view.frame(2);
    expect(transcriptRows(view.container).length).toBeLessThan(40);
    expect(
      view.container.querySelector(`[data-virtual-row-key="fragment:${index}"]`),
    ).not.toBeNull();
  }
  expect(first?.isConnected).toBe(false);
});

it("pauses queued preparation while hidden and retires it on disconnect", async () => {
  const view = await transcriptFixture();
  await view.frame(8);
  await view.scrollTo(80);
  await view.present(false);
  const hiddenRows = transcriptRows(view.container);
  await view.frame(8);
  expect(transcriptRows(view.container)).toEqual(hiddenRows);

  await view.present(true);
  await view.frame(3);
  expect(transcriptRows(view.container).some((row) => !hiddenRows.includes(row))).toBe(true);
  await view.scrollTo(160);
  view.host.disconnect();
  await settle();
  expect(transcriptRows(view.container)).toHaveLength(0);
  await view.frame(8);
  expect(transcriptRows(view.container)).toHaveLength(0);
});

it.each([
  { direction: "down", initialOffset: 0, destination: 60 },
  { direction: "up", initialOffset: 24_000, destination: 180.25 },
])(
  // An unmeasured row's estimated slot is not where it lands; painting it there shows text that moves.
  "prepares the $direction forecast outside active flow, unpainted until measured",
  async ({ direction, initialOffset, destination }) => {
    const view = await transcriptFixture(initialOffset, true);
    const before = transcriptRows(view.container);
    await view.scrollTo(destination);
    const active = transcriptRows(view.container)
      .filter((row) => !row.hasAttribute("data-prepared-row"))
      .map((row) => Number(row.dataset.index));
    const forecasts = [
      ...view.container.querySelectorAll<HTMLElement>("[data-preparing-row][data-prepared-row]"),
    ].filter((row) => !before.includes(row));
    expect(forecasts.length).toBeGreaterThan(0);
    for (const row of forecasts) {
      expect(row.hasAttribute("inert")).toBe(true);
      expect(row.getAttribute("aria-hidden")).toBe("true");
      expect(row.style.position).toBe("absolute");
      expect(row.style.opacity).toBe("0");
      expect(row.style.display).not.toBe("none");
      if (direction === "up") {
        expect(Number(row.dataset.index)).toBeLessThan(Math.min(...active));
      } else {
        expect(Number(row.dataset.index)).toBeGreaterThan(Math.max(...active));
      }
    }
    const mounted = transcriptRows(view.container);
    const rendered = view.renderRow.mock.calls.length;
    await view.frame(2, false);
    await view.task();
    expect(transcriptRows(view.container)).toEqual(mounted);
    expect(view.renderRow.mock.calls).toHaveLength(rendered);
    expect(view.container.scrollTop).toBe(destination * 100);
  },
);

it("releases initial viewport rows when the tail grows before reader navigation", async () => {
  const view = await transcriptFixture(null);
  await view.frame(32);
  const tail = view.container.querySelector<HTMLElement>('[data-virtual-row-key="fragment:255"]');
  expect(tail).not.toBeNull();
  expect(transcriptRows(view.container).length).toBeGreaterThan(1);

  view.resizeRow(tail!, 900);
  await settle();
  await view.frame(32);

  expect(view.container.querySelector("[data-prepared-row]")).toBeNull();
  expect(transcriptRows(view.container)).toEqual([tail]);
});

it("retains nearby geometry while scrolling back into the prepared window", async () => {
  const view = await transcriptFixture(null);
  await view.frame(32);
  expect(view.container.scrollTop).toBeGreaterThan(24_000);
  expect(view.container.querySelector('[data-virtual-row-key="fragment:255"]')).not.toBeNull();
  expect(transcriptRows(view.container).every((row) => Number(row.dataset.index) >= 230)).toBe(
    true,
  );
  await view.scrollTo(249);
  await view.scrollTo(250);
  await view.frame(320);
  expect(transcriptRows(view.container).some((row) => Number(row.dataset.index) < 250)).toBe(true);
  // Retained rows share the DOM with the active viewport and its neighbours.
  expect(view.container.querySelectorAll("[data-prepared-row]").length).toBeLessThanOrEqual(12);
  expect(transcriptRows(view.container).length).toBeLessThanOrEqual(22);
  const ahead = view.container.querySelector('[data-virtual-row-key="fragment:246"]');
  expect(ahead).not.toBeNull();
  const preparations = view.renderRow.mock.calls.length;
  expect(view.container.querySelector('[data-virtual-row-key="fragment:0"]')).toBeNull();
  const calls = () => view.renderRow.mock.calls.filter(([row]) => row.key === "fragment:246");
  const aheadPreparations = calls().length;
  await view.frame(16);
  expect(view.renderRow.mock.calls).toHaveLength(preparations);
  await view.scrollTo(246);
  expect(view.container.querySelector('[data-virtual-row-key="fragment:246"]')).toBe(ahead);
  expect(calls()).toHaveLength(aheadPreparations);
});

it("keeps manual end-follow from measuring history before reader navigation", async () => {
  const view = await transcriptFixture(null, true);
  await view.frame(8);
  const initialRows = transcriptRows(view.container);
  view.host.scrollToEnd({ source: "manual", behavior: "smooth" });
  await settle();
  for (let turn = 0; turn < 8; turn++) {
    await view.idle();
    await view.frame();
  }
  expect(transcriptRows(view.container)).toEqual(initialRows);
  await view.scrollTo(240);
  await view.frame(8);
  await view.task();
  expect(transcriptRows(view.container).some((row) => Number(row.dataset.index) < 240)).toBe(true);
});

it("keeps upward forecasts outside active flow without moving the reader", async () => {
  const view = await transcriptFixture(24_000, true, true);
  await view.scrollTo(9);
  await view.frame(2);
  await view.scrollTo(5);
  const firstActiveIndex = Math.min(
    ...transcriptRows(view.container)
      .filter((row) => !row.hasAttribute("data-prepared-row"))
      .map((row) => Number(row.dataset.index)),
  );

  await view.frame(1, false);
  await view.task();
  await view.frame(1, false);
  await view.task();
  await view.frame(1, false);
  await view.task();

  const prepared = view.container.querySelector<HTMLElement>(
    "[data-preparing-row][data-prepared-row]",
  );
  expect(prepared).not.toBeNull();
  expect(Number(prepared!.dataset.index)).toBeLessThan(firstActiveIndex);
  expect(view.container.scrollTop).toBe(500);
});

it("advances a relative timestamp without refreshing its message", async () => {
  const now = Date.UTC(2026, 9, 26, 12);
  vi.useFakeTimers({ now });
  try {
    const view = mountSolid<Parameters<typeof ChatTimestamp>[0]>(ChatTimestamp, {
      timestamp: now - 60_000,
    });
    disposers.push(view.dispose);
    const time = view.container.querySelector("time");
    expect(time?.textContent).toBe("1m ago");

    await vi.advanceTimersByTimeAsync(60_000);
    await settle();

    expect(view.container.querySelector("time")).toBe(time);
    expect(time?.textContent).toBe("2m ago");
  } finally {
    vi.useRealTimers();
  }
});

it("updates the settled scroll window without re-entering the caller renderer", async () => {
  const view = await transcriptFixture(0, true);
  await view.frame(8);
  const draws = view.draw.mock.calls.length;
  await view.scrollTo(120);
  expect(view.draw.mock.calls).toHaveLength(draws);
  expect(view.container.querySelector('[data-virtual-row-key="fragment:120"]')).not.toBeNull();
  expect(view.container.scrollTop).toBe(12_000);
});
