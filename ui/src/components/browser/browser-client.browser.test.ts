import { afterEach, expect, it, vi } from "vitest";
import { scrollBrowserBy } from "./browser-client.ts";

let messages: HTMLDivElement | undefined;
afterEach(() => messages?.remove());

it.each([
  {
    display: "flex",
    direction: "column-reverse",
    rtl: false,
    axis: "scrollTop" as const,
    sign: -1,
  },
  { display: "flex", direction: "row-reverse", rtl: false, axis: "scrollLeft" as const, sign: -1 },
  { display: "flex", direction: "row-reverse", rtl: true, axis: "scrollLeft" as const, sign: 1 },
  { display: "grid", direction: "row-reverse", rtl: false, axis: "scrollLeft" as const, sign: 1 },
])(
  "scrolls $display $direction (RTL: $rtl) in both directions and stops at its start",
  async ({ display, direction, rtl, axis, sign }) => {
    messages = document.createElement("div");
    messages.style.cssText = `position:fixed;inset:0;display:${display};grid-auto-flow:column;grid-auto-columns:100px;flex-direction:${direction};direction:${rtl ? "rtl" : "ltr"};overflow:auto`;
    for (let index = 0; index < 30; index++) {
      const row = document.createElement("div");
      row.style.minHeight = "100px";
      row.style.minWidth = "100px";
      row.textContent = `Message ${index + 1}`;
      messages.append(row);
    }
    document.body.append(messages);
    // Execute the outgoing browser action against real Chromium layout and scroll offsets.
    const request = vi
      .fn()
      .mockImplementation(async (_method: string, params: { body: { fn: string } }) => ({
        // eslint-disable-next-line @typescript-eslint/no-implied-eval -- Execute generated browser RPC code, not user input.
        result: new Function(`return (${params.body.fn})()`)(),
      }));
    const scroll = (delta: number) =>
      scrollBrowserBy(
        { request },
        {
          targetId: "chat",
          deltaX: axis === "scrollLeft" ? delta : 0,
          deltaY: axis === "scrollTop" ? delta : 0,
          point: { x: 20, y: 20 },
        },
      );
    await scroll(240 * sign);
    expect(messages[axis]).toBe(240 * sign);
    await scroll(-120 * sign);
    expect(messages[axis]).toBe(120 * sign);
    await scroll(-240 * sign);
    expect(messages[axis]).toBe(0);
    await scroll(-120 * sign);
    expect(messages[axis]).toBe(0);
  },
);
