import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { ChatToolCard } from "./chat-tool-cards.solid.tsx";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";
import { ToolPreview } from "./widget-card-view.tsx";

let container: HTMLDivElement | undefined;
afterEach(() => {
  cleanupSolid();
  container?.remove();
  container = undefined;
});

describe.runIf("__vitest_browser__" in globalThis)("tool activity layout", () => {
  it("truncates long progress receipts while keeping tool identity visible", async () => {
    container = document.body.appendChild(document.createElement("div"));
    container.style.width = "220px";
    const step = "Verify the implementation and report the result. ".repeat(12).slice(0, 512);
    const options = { messageKey: "narrow", expanded: false, onToggleExpanded: vi.fn() };
    const cards = [
      { id: "receipt", name: "progress_card", args: { plan: [{ step, status: "completed" }] } },
      { id: "yield", name: "yield", args: { message: step } },
    ];
    mountSolid(
      () =>
        cards.map((card) => <ChatToolCard card={{ ...card, completed: true }} options={options} />),
      { container },
    );
    flush();

    await settleToolBridges(container);
    const receipt = container.querySelector<HTMLElement>('[role="status"]')!;
    const text = receipt.querySelector<HTMLElement>(":scope > span:last-child")!;
    expect(receipt.textContent).toContain(step);
    expect(receipt.clientWidth).toBeGreaterThan(0);
    expect(receipt.scrollWidth).toBe(receipt.clientWidth);
    expect(container.scrollWidth).toBe(container.clientWidth);
    expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
    expect(getComputedStyle(text).textOverflow).toBe("ellipsis");

    const icon = container.querySelector<HTMLElement>('[role="img"][aria-label="yield"]')!;
    expect(icon).toMatchObject({ title: "yield", scrollWidth: icon.clientWidth });
    expect(icon.clientWidth).toBeGreaterThan(0);
  });

  it("mounts and rerenders during resize delivery without observer loop errors", async () => {
    container = document.body.appendChild(document.createElement("div"));
    container.className = "chat-thread";
    container.style.cssText = "width: 420px; height: 300px";
    const errors: string[] = [];
    const recordError = (event: ErrorEvent) => {
      if (event.message.includes("ResizeObserver loop")) {
        errors.push(event.message);
      }
    };
    window.addEventListener("error", recordError);
    let redraw!: () => void;
    mountSolid(
      () => {
        const [options, setOptions] = createSignal({ rawText: "Widget details" });
        redraw = () => setOptions({ rawText: "Widget details" });
        return (
          <ToolPreview
            preview={{
              kind: "canvas",
              surface: "assistant_message",
              render: "url",
              url: "about:blank",
              sandbox: "strict",
            }}
            surface="chat_message"
            options={options()}
          />
        );
      },
      { container },
    );
    const draw = () => {
      redraw();
      flush();
    };
    let rerenderObserver: ResizeObserver | undefined;
    try {
      draw();
      const preview = container.querySelector<HTMLElement>(".chat-tool-card__preview")!;
      preview.style.width = "400px";
      const actions = preview.querySelector<HTMLElement>("[data-widget-actions]")!;
      const expectPlacement = async (edge: "top" | "right") => {
        await vi.waitFor(() => {
          const actual = actions.getBoundingClientRect()[edge === "top" ? "bottom" : "left"];
          expect(actual).toBe(preview.getBoundingClientRect()[edge]);
        });
        expect(errors).toEqual([]);
      };
      await expectPlacement("top");

      let rerendered = false;
      rerenderObserver = new ResizeObserver(() => {
        rerenderObserver?.disconnect();
        draw();
        rerendered = true;
      });
      rerenderObserver.observe(preview);
      await vi.waitFor(() => expect(rerendered).toBe(true));
      expect(errors).toEqual([]);

      // Resize the observed ancestor after delivery; doing it in the callback creates a loop.
      container.style.width = "480px";
      await expectPlacement("right");

      container.style.width = "420px";
      await expectPlacement("top");
    } finally {
      rerenderObserver?.disconnect();
      window.removeEventListener("error", recordError);
    }
  });
});
