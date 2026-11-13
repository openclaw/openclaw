import { createSignal } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { resolveToolDisplay } from "../../../lib/chat/tool-display.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { ToolCardRow } from "./chat-tool-card-row.solid.tsx";
import { ChatToolCard } from "./chat-tool-cards.solid.tsx";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";
import { ToolPreview } from "./widget-card-view.tsx";

vi.mock("../../../lib/chat/tool-display.ts", { spy: true });

function containerFor(cssText: string) {
  const container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = cssText;
  onTestFinished(() => container.remove());
  return container;
}

describe.runIf("__vitest_browser__" in globalThis)("tool activity layout", () => {
  it("derives details only for a visible generic row while retaining command identity and transitions", () => {
    const direct: ToolCard = {
      id: "retained-row",
      name: "exec",
      args: { command: "export DEMO=1; cd /tmp; printf first" },
    };
    const [card, setCard] = createSignal(direct);
    const onToggleExpanded = vi.fn();
    const display = vi.mocked(resolveToolDisplay);
    display.mockClear();
    const { container } = mountSolid(() => (
      <ToolCardRow
        card={card()}
        options={{ messageKey: "dedicated-row", expanded: false, onToggleExpanded }}
      />
    ));
    flush();
    const row = container.querySelector<HTMLButtonElement>(".chat-tool-row")!;
    const command = () => container.querySelector(".chat-tool-row__cmd")?.textContent;
    const icon = () => container.querySelector('[role="img"]')?.getAttribute("aria-label");
    expect(command()).toBe("printf first");
    expect(icon()).toBe("exec");
    expect.soft(display.mock.calls.length, "unused command detail derivation").toBe(0);
    row.focus();

    display.mockClear();
    setCard({
      ...direct,
      name: "dispatch_action",
      args: { id: "openclaw:core:exec", args: { command: "cd /tmp && printf wrapped" } },
    });
    flush();
    expect(command()).toBe("printf wrapped");
    expect(icon()).toBe("exec");
    expect(container.querySelector(".chat-tool-row")).toBe(row);
    expect(document.activeElement).toBe(row);
    expect.soft(display.mock.calls.length, "unused wrapped command detail derivation").toBe(0);

    display.mockClear();
    setCard({ ...direct, args: { command: "printf titled", title: "Inspect the result" } });
    flush();
    expect(container.querySelector(".chat-tool-row__title")?.textContent).toBe(
      "Inspect the result",
    );
    expect.soft(display.mock.calls.length, "unused titled command detail derivation").toBe(0);

    for (const message of ["First widget", "Updated widget"]) {
      display.mockClear();
      setCard({ ...direct, name: "inspect_widget", args: { message } });
      flush();
      expect(container.querySelector(".chat-tool-msg-summary__label")).toBeNull();
      expect(container.querySelector(".chat-tool-msg-summary__names")?.textContent).toBe(message);
      expect(display.mock.calls.length).toBeGreaterThan(0);
      expect(icon()).toBe("inspect_widget");
      expect(container.querySelector(".chat-tool-row")).toBe(row);
    }

    display.mockClear();
    setCard({ ...direct, args: { command: "printf returned" } });
    flush();
    expect(command()).toBe("printf returned");
    expect(container.querySelector(".chat-tool-msg-summary__names")).toBeNull();
    expect.soft(display.mock.calls.length, "retired generic detail derivation").toBe(0);
    row.click();
    expect(onToggleExpanded).toHaveBeenCalledWith("retained-row");
  });

  it("truncates long progress receipts while keeping tool identity visible", async () => {
    const container = containerFor("width: 220px");
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
    const container = containerFor("width: 420px; height: 300px");
    container.className = "chat-thread";
    const errors: string[] = [];
    const recordError = (event: ErrorEvent) => {
      if (event.message.includes("ResizeObserver loop")) {
        errors.push(event.message);
      }
    };
    window.addEventListener("error", recordError);
    onTestFinished(() => window.removeEventListener("error", recordError));
    const [options, setOptions] = createSignal({ rawText: "Widget details" });
    mountSolid(
      () => (
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
      ),
      { container },
    );
    const draw = () => {
      setOptions({ rawText: "Widget details" });
      flush();
    };
    draw();
    const preview = container.querySelector<HTMLElement>(".chat-tool-card__preview")!;
    preview.style.width = "400px";
    const actions = preview.querySelector<HTMLElement>("[data-widget-actions]")!;
    const expectPlacement = async (edge: "top" | "right") => {
      await vi.waitFor(() => {
        const actual = actions.getBoundingClientRect()[edge === "top" ? "bottom" : "left"];
        expect(actual).toBe(preview.getBoundingClientRect()[edge]);
      });
    };
    await expectPlacement("top");

    let rerendered = false;
    const rerenderObserver = new ResizeObserver(() => {
      rerenderObserver.disconnect();
      draw();
      rerendered = true;
    });
    onTestFinished(() => rerenderObserver.disconnect());
    rerenderObserver.observe(preview);
    await vi.waitFor(() => expect(rerendered).toBe(true));

    // Resize the observed ancestor after delivery; doing it in the callback creates a loop.
    for (const [width, edge] of [
      [480, "right"],
      [420, "top"],
    ] as const) {
      container.style.width = `${width}px`;
      await expectPlacement(edge);
    }
    expect(errors).toEqual([]);
  });
});
