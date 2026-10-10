import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageReactionSummary } from "../../../../../packages/gateway-protocol/src/index.js";
/* @vitest-environment jsdom */
import type { SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import { createMessageGroup } from "./chat-message.test-support.ts";

const reactions: MessageReactionSummary[] = [
  {
    emoji: "👍",
    count: 2,
    identities: [
      { id: "peer", label: "Riley" },
      { id: "self", label: "Alex" },
    ],
  },
  {
    emoji: "🎉",
    count: 5,
    identities: [
      { id: "a", label: "Ana" },
      { id: "b", label: "Ben" },
      { id: "c", label: "Cy" },
      { id: "d", label: "Dee" },
      { id: "e", label: "Eli" },
    ],
  },
];
let host: HTMLDivElement;
afterEach(() => {
  if (host) {
    render(nothing, host);
    host.remove();
  }
});

function show(
  options: { role?: string; persisted?: boolean; streaming?: boolean; writable?: boolean } = {},
) {
  host = document.body.appendChild(document.createElement("div"));
  const role = options.role ?? "user";
  const onReact = vi.fn();
  const message = {
    role,
    content: [{ type: "text", text: "A shared prompt" }],
    timestamp: 1,
    ...(options.persisted === false ? {} : { __openclaw: { id: "message-1" } }),
  };
  render(
    renderMessageGroup(
      createMessageGroup(message, role, { isStreaming: options.streaming ?? false }),
      {
        showReasoning: false,
        userId: "self",
        messageReactions: new Map([["message-1", reactions]]),
        onReact: options.writable === false ? undefined : onReact,
      },
    ),
    host,
  );
  return {
    onReact,
    pickers: [
      ...host.querySelectorAll<SolidBridgeElement<object>>("openclaw-message-reaction-picker"),
    ],
  };
}

function pickerButton(picker: SolidBridgeElement<object>, label: string) {
  // Compare emoji labels directly; JSDOM selectors do not reliably match non-BMP values.
  return [...picker.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.getAttribute("aria-label") === label,
  );
}

async function customEntry() {
  const { pickers, onReact } = show();
  const picker = pickers[0]!;
  await picker.updateComplete;
  const root = picker;
  root.querySelector<HTMLButtonElement>(".more")!.click();
  flush();
  return {
    picker,
    root,
    onReact,
    input: root.querySelector<HTMLInputElement>('[aria-label="Emoji"]')!,
  };
}

describe("transcript message reactions", () => {
  it.each([
    [{ role: "user" }, "writable"],
    [{ role: "assistant" }, "writable"],
    [{ writable: false }, "readonly"],
    [{ persisted: false }, "ineligible"],
    [{ streaming: true }, "ineligible"],
    [{ role: "system" }, "ineligible"],
  ] as const)("renders %j reactions as %s", async (options, access) => {
    const { onReact, pickers } = show(options);
    expect(pickers).toHaveLength(access === "writable" ? 2 : 0);
    if (access === "ineligible") {
      expect(host.querySelector(".chat-message-reactions")).toBeNull();
      return;
    }
    const chips = host.querySelectorAll<HTMLButtonElement>("button.chat-reaction-chip");
    if (access === "readonly") {
      expect(chips[0]!.disabled).toBe(true);
      chips[0]!.click();
      expect(onReact).not.toHaveBeenCalled();
      return;
    }
    expect(chips).toHaveLength(2);
    const [own, crowd] = [...chips] as [HTMLButtonElement, HTMLButtonElement];
    expect(own.getAttribute("aria-pressed")).toBe("true");
    expect(own.getAttribute("aria-label")).toBe("👍 2");
    expect((own.parentElement as HTMLElement & { content: string }).content).toBe(
      "You, Riley reacted with 👍",
    );
    expect((crowd.parentElement as HTMLElement & { content: string }).content).toBe(
      "Ana, Ben, Cy and 2 others reacted with 🎉",
    );
    own.click();
    expect(onReact).toHaveBeenCalledWith("message-1", "👍", true);
    crowd.click();
    expect(onReact).toHaveBeenCalledWith("message-1", "🎉", false);
    const picker = pickers[0]!;
    await picker.updateComplete;
    const pressed = pickerButton(picker, "👍")!;
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    pressed.click();
    expect(onReact).toHaveBeenLastCalledWith("message-1", "👍", true);
    pickerButton(picker, "🚀")!.click();
    expect(onReact).toHaveBeenLastCalledWith("message-1", "🚀", false);
  });

  it.each(["abc", "👍👀"])("rejects custom input %s and accepts a single emoji", async (value) => {
    const { root, onReact, input } = await customEntry();
    input.value = value;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    flush();
    expect(onReact).not.toHaveBeenCalled();
    expect(input.value).toBe(value);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(root.querySelector(".hint")?.textContent).toContain("single emoji");
    input.value = " 🦞 ";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(onReact).toHaveBeenLastCalledWith("message-1", "🦞", false);
  });

  it("waits for IME composition to commit before applying an emoji", async () => {
    const { onReact, input } = await customEntry();
    input.value = "👍";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    expect(onReact).not.toHaveBeenCalled();
    input.value = "👀";
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "👀" }));
    expect(onReact).toHaveBeenLastCalledWith("message-1", "👀", false);
  });

  it("returns from the custom entry to the palette on backspace", async () => {
    const { root, input } = await customEntry();
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    flush();
    expect(root.querySelector("input")).toBeNull();
    expect(root.querySelector(".palette")).not.toBeNull();
    expect(document.activeElement).toBe(pickerButton(root, "👍"));
  });

  it("resets a closed custom picker without moving focus into its hidden palette", async () => {
    const { root } = await customEntry();
    const nextControl = host.appendChild(document.createElement("button"));
    nextControl.focus();
    root.querySelector("wa-popover")!.dispatchEvent(new CustomEvent("wa-after-hide"));
    flush();
    expect(root.querySelector("input")).toBeNull();
    expect(document.activeElement).toBe(nextControl);
  });
});
