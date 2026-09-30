/* @vitest-environment jsdom */
import type { LitElement } from "lit";
import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageReactionSummary } from "../../../../../packages/gateway-protocol/src/index.js";
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
    pickers: [...host.querySelectorAll<LitElement>("openclaw-message-reaction-picker")],
  };
}

function shadowButton(picker: LitElement, label: string) {
  // JSDOM's selector engine misses non-BMP attribute values in a shadow root.
  return [...picker.shadowRoot!.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.getAttribute("aria-label") === label,
  );
}

describe("transcript message reactions", () => {
  it.each(["user", "assistant"])(
    "renders %s chips with attribution and toggles the current user's reaction",
    (role) => {
      const { onReact, pickers } = show({ role });
      // One picker in the hover row and one trailing the chip row.
      expect(pickers).toHaveLength(2);
      const chips = host.querySelectorAll<HTMLButtonElement>("button.chat-reaction-chip");
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
    },
  );

  it("keeps chips visible for readers while hiding mutation controls", () => {
    const { pickers, onReact } = show({ writable: false });
    expect(pickers).toHaveLength(0);
    const chip = host.querySelector<HTMLButtonElement>(".chat-reaction-chip")!;
    expect(chip.disabled).toBe(true);
    chip.click();
    expect(onReact).not.toHaveBeenCalled();
  });

  it.each([{ persisted: false }, { streaming: true }, { role: "system" }])(
    "omits controls for ineligible messages: %j",
    (options) => {
      const { pickers } = show(options);
      expect(pickers).toHaveLength(0);
      expect(host.querySelector(".chat-message-reactions")).toBeNull();
    },
  );

  it("marks the user's own emoji in the palette and toggles it off", async () => {
    const { pickers, onReact } = show();
    const picker = pickers[0]!;
    await picker.updateComplete;
    const pressed = shadowButton(picker, "👍")!;
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    pressed.click();
    expect(onReact).toHaveBeenLastCalledWith("message-1", "👍", true);
    shadowButton(picker, "🚀")!.click();
    expect(onReact).toHaveBeenLastCalledWith("message-1", "🚀", false);
  });

  it.each(["abc", "👍👀"])("rejects custom input %s and accepts a single emoji", async (value) => {
    const { pickers, onReact } = show();
    const picker = pickers[0]!;
    await picker.updateComplete;
    const root = picker.shadowRoot!;
    root.querySelector<HTMLButtonElement>(".more")!.click();
    await picker.updateComplete;
    const input = root.querySelector<HTMLInputElement>('[aria-label="Emoji"]')!;
    input.value = value;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await picker.updateComplete;
    expect(onReact).not.toHaveBeenCalled();
    expect(input.value).toBe(value);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(root.querySelector(".hint")?.textContent).toContain("single emoji");
    input.value = " 🦞 ";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(onReact).toHaveBeenLastCalledWith("message-1", "🦞", false);
  });

  it("waits for IME composition to commit before applying an emoji", async () => {
    const { pickers, onReact } = show();
    const picker = pickers[0]!;
    await picker.updateComplete;
    const root = picker.shadowRoot!;
    root.querySelector<HTMLButtonElement>(".more")!.click();
    await picker.updateComplete;
    const input = root.querySelector<HTMLInputElement>('[aria-label="Emoji"]')!;
    input.value = "👍";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    expect(onReact).not.toHaveBeenCalled();
    input.value = "👀";
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "👀" }));
    expect(onReact).toHaveBeenLastCalledWith("message-1", "👀", false);
  });

  it("returns from the custom entry to the palette on backspace", async () => {
    const { pickers } = show();
    const picker = pickers[0]!;
    await picker.updateComplete;
    const root = picker.shadowRoot!;
    root.querySelector<HTMLButtonElement>(".more")!.click();
    await picker.updateComplete;
    const input = root.querySelector<HTMLInputElement>('[aria-label="Emoji"]')!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    await picker.updateComplete;
    expect(root.querySelector("input")).toBeNull();
    expect(root.querySelector(".palette")).not.toBeNull();
  });
});
