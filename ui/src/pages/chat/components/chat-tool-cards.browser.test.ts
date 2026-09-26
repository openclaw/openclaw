import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { renderToolCard } from "./chat-tool-cards.ts";
import { renderToolPreview } from "./widget-card.ts";

let container: HTMLDivElement | undefined;
afterEach(() => {
  if (container) {
    render(nothing, container);
    container.remove();
    container = undefined;
  }
});

describe.runIf("__vitest_browser__" in globalThis)("narrow tool activity rows", () => {
  it("truncates long progress receipts while keeping short tool labels intact", () => {
    container = document.body.appendChild(document.createElement("div"));
    container.style.width = "220px";
    const step = "Verify the implementation and report the result. ".repeat(12).slice(0, 512);
    const options = { messageKey: "narrow", expanded: false, onToggleExpanded: vi.fn() };
    render(
      html`
        ${renderToolCard(
          {
            id: "receipt",
            name: "progress_card",
            args: { plan: [{ step, status: "completed" }] },
            completed: true,
          },
          options,
        )}
        ${renderToolCard(
          { id: "yield", name: "yield", args: { message: step }, completed: true },
          options,
        )}
      `,
      container,
    );

    const receipt = container.querySelector<HTMLElement>('[role="status"]')!;
    const text = receipt.querySelector<HTMLElement>(":scope > span:last-child")!;
    expect(receipt.textContent).toContain(step);
    expect(receipt.clientWidth).toBeGreaterThan(0);
    expect(receipt.scrollWidth).toBe(receipt.clientWidth);
    expect(container.scrollWidth).toBe(container.clientWidth);
    expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
    expect(getComputedStyle(text).textOverflow).toBe("ellipsis");

    const label = Array.from(
      container.querySelectorAll<HTMLElement>(".chat-tool-msg-summary__label"),
    ).find((element) => element.textContent === "Yield")!;
    expect(label).toBeDefined();
    expect(label.scrollWidth).toBe(label.clientWidth);
  });
});

describe.runIf("__vitest_browser__" in globalThis)("widget action placement", () => {
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
    const draw = () =>
      render(
        renderToolPreview(
          {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            url: "about:blank",
            sandbox: "strict",
          },
          "chat_message",
          { rawText: "Widget details" },
        ),
        container!,
      );
    let rerenderObserver: ResizeObserver | undefined;
    try {
      draw();
      const preview = container.querySelector<HTMLElement>(".chat-tool-card__preview")!;
      preview.style.width = "400px";
      const actions = preview.querySelector<HTMLElement>("[data-widget-actions]")!;
      await vi.waitFor(() =>
        expect(actions.getBoundingClientRect().bottom).toBe(preview.getBoundingClientRect().top),
      );
      expect(errors).toEqual([]);

      let rerendered = false;
      rerenderObserver = new ResizeObserver(() => {
        rerenderObserver?.disconnect();
        container!.style.width = "480px";
        draw();
        rerendered = true;
      });
      rerenderObserver.observe(preview);
      await vi.waitFor(() => {
        expect(rerendered).toBe(true);
        expect(actions.getBoundingClientRect().left).toBe(preview.getBoundingClientRect().right);
      });
      expect(errors).toEqual([]);

      container.style.width = "420px";
      await vi.waitFor(() =>
        expect(actions.getBoundingClientRect().bottom).toBe(preview.getBoundingClientRect().top),
      );
      expect(errors).toEqual([]);
    } finally {
      rerenderObserver?.disconnect();
      window.removeEventListener("error", recordError);
    }
  });
});
