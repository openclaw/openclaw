import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageReactionSummary } from "../../../../../packages/gateway-protocol/src/index.js";
/* @vitest-environment jsdom */
import { cleanupSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createMessageGroupHarness } from "./chat-message-native.test-support.tsx";
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
    identities: ["Ana", "Ben", "Cy", "Dee", "Eli"].map((label) => ({ id: label, label })),
  },
];
let host: HTMLDivElement;
afterEach(() => {
  cleanupSolid();
  host?.remove();
});

function enter(input: HTMLInputElement, value: string, isComposing = false) {
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing }));
}

function show(
  options: { role?: string; persisted?: boolean; streaming?: boolean; writable?: boolean } = {},
  initialReactions = new Map([["message-1", reactions]]),
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
  const harness = createMessageGroupHarness(host);
  const group = createMessageGroup(message, role, { isStreaming: options.streaming ?? false });
  const render = (messageReactions: Map<string, MessageReactionSummary[]>) => {
    harness.render(group, {
      showReasoning: false,
      userId: "self",
      messageReactions,
      onReact: options.writable === false ? undefined : onReact,
    });
    return [...host.querySelectorAll<HTMLElement>("openclaw-message-reaction-picker")];
  };
  return { onReact, pickers: render(initialReactions), render };
}

function pickerButton(picker: HTMLElement, label: string) {
  // Compare emoji labels directly; JSDOM selectors do not reliably match non-BMP values.
  return [...picker.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.getAttribute("aria-label") === label,
  );
}

async function customEntry() {
  const { pickers, onReact } = show();
  const root = pickers[0]!;
  flush();
  root.querySelector<HTMLButtonElement>(".trigger")!.click();
  root.querySelector<HTMLButtonElement>(".more")!.click();
  await waitForSolid(() =>
    expect(root.querySelector<HTMLInputElement>(".emoji-search-panel__search")).not.toBeNull(),
  );
  return {
    root,
    onReact,
    input: root.querySelector<HTMLInputElement>(".emoji-search-panel__search")!,
  };
}

function hidden(picker: Element) {
  return new Promise<void>((resolve) => {
    picker
      .querySelector(".chat-reaction-picker")!
      .addEventListener("overlay-after-hide", () => resolve(), { once: true });
  });
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
    // Reactions exist, so only the chip row carries a picker; the action row drops its own.
    expect(pickers).toHaveLength(access === "writable" ? 1 : 0);
    expect(pickers[0]?.closest(".chat-message-reactions") ?? null).toBe(
      access === "writable" ? host.querySelector(".chat-message-reactions") : null,
    );
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
    expect(own.parentElement).toHaveProperty("content", "You, Riley reacted with 👍");
    expect(crowd.parentElement).toHaveProperty(
      "content",
      "Ana, Ben, Cy and 2 others reacted with 🎉",
    );
    own.click();
    expect(onReact).toHaveBeenCalledWith("message-1", "👍", true);
    crowd.click();
    expect(onReact).toHaveBeenCalledWith("message-1", "🎉", false);
    const picker = pickers[0]!;
    flush();
    expect(picker.querySelector(".palette")).toBeNull();
    picker.querySelector<HTMLButtonElement>(".trigger")!.click();
    const pressed = pickerButton(picker, "👍")!;
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    const didHide = hidden(picker);
    pressed.click();
    expect(onReact).toHaveBeenLastCalledWith("message-1", "👍", true);
    await didHide;
    expect(picker.querySelector(".palette")).toBeNull();
    picker.querySelector<HTMLButtonElement>(".trigger")!.click();
    pickerButton(picker, "🚀")!.click();
    expect(onReact).toHaveBeenLastCalledWith("message-1", "🚀", false);
  });

  it("moves the add-reaction picker from the action row to the chip row once reacted", () => {
    const { render } = show({ role: "assistant" }, new Map());
    const locations = (messageReactions: Map<string, MessageReactionSummary[]>) =>
      render(messageReactions).map((picker) =>
        picker.closest(".chat-message-reactions") ? "chips" : "actions",
      );
    expect(locations(new Map())).toEqual(["actions"]);
    expect(locations(new Map([["message-1", reactions]]))).toEqual(["chips"]);
    expect(host.querySelector(".chat-message-reactions")?.parentElement).toBe(
      host.querySelector(".chat-group > .chat-group-footer"),
    );
    expect(locations(new Map([["message-1", []]]))).toEqual(["actions"]);
  });

  it("keeps reactions actionable in the reserved footer through an active continuation", () => {
    host = document.body.appendChild(document.createElement("div"));
    const harness = createMessageGroupHarness(host);
    const group = createMessageGroup(
      {
        role: "assistant",
        content: [{ type: "text", text: "A saved reply" }],
        timestamp: 1,
        __openclaw: { id: "message-1" },
      },
      "assistant",
    );
    const onReact = vi.fn();
    for (const active of [false, true, false]) {
      harness.render(group, {
        showReasoning: false,
        userId: "self",
        messageReactions: new Map([["message-1", reactions]]),
        onReact,
        activeContinuation: active ? { parts: [], options: {} } : undefined,
      });
      const footer = host.querySelector(".chat-group > .chat-group-footer")!;
      expect(host.querySelectorAll(".chat-message-reactions")).toHaveLength(1);
      expect(footer.querySelectorAll("openclaw-message-reaction-picker")).toHaveLength(1);
      expect(footer.hasAttribute("aria-hidden")).toBe(false);
      expect(footer.querySelector(".chat-group-footer__meta") !== null).toBe(!active);
      footer.querySelector<HTMLButtonElement>(".chat-reaction-chip")!.click();
      expect(onReact).toHaveBeenLastCalledWith("message-1", "👍", true);
      const picker = footer.querySelector<HTMLElement>("openclaw-message-reaction-picker")!;
      picker.querySelector<HTMLButtonElement>(".trigger")!.click();
      pickerButton(picker, "🚀")!.click();
      expect(onReact).toHaveBeenLastCalledWith("message-1", "🚀", false);
    }
  });

  it.each(["user", "assistant"])(
    "shares each %s message's existing footer without merging reaction targets",
    (role) => {
      host = document.body.appendChild(document.createElement("div"));
      const harness = createMessageGroupHarness(host);
      const message = (id: string) => ({
        role,
        content: [{ type: "text", text: `Shared message ${id}` }],
        timestamp: 1,
        __openclaw: { id },
      });
      const first = message("first");
      const group = createMessageGroup(first, role, {
        messages: [
          { key: "first", message: first },
          { key: "last", message: message("last") },
        ],
      });
      const onReact = vi.fn();
      const render = (messageReactions: Map<string, MessageReactionSummary[]>) =>
        harness.render(group, { showReasoning: false, userId: "self", messageReactions, onReact });
      render(new Map());
      const footer = host.querySelector(".chat-group > .chat-group-footer")!;
      const earlier = host.querySelector(".chat-message-actions-row")!;
      const copy = earlier.querySelector<HTMLButtonElement>(".chat-copy-btn")!;
      copy.focus();
      render(
        new Map([
          ["first", reactions],
          ["last", reactions],
        ]),
      );
      expect(document.activeElement).toBe(copy);
      expect(
        host.querySelector('[data-message-id="first"].chat-message-reactions')?.parentElement,
      ).toBe(earlier);
      expect(
        host.querySelector('[data-message-id="last"].chat-message-reactions')?.parentElement,
      ).toBe(footer);
      for (const id of ["first", "last"]) {
        host
          .querySelector<HTMLButtonElement>(
            `[data-message-id="${id}"].chat-message-reactions .chat-reaction-chip`,
          )!
          .click();
      }
      expect(onReact.mock.calls.map(([id]) => id)).toEqual(["first", "last"]);
      expect(footer.querySelector(".chat-group-footer__meta")).not.toBeNull();
      expect(host.querySelectorAll(".chat-message-reactions")).toHaveLength(2);
    },
  );

  it("searches emoji by name and selects the first match on Enter", async () => {
    const { root, onReact, input } = await customEntry();
    enter(input, ":banana");
    flush();
    expect(onReact).not.toHaveBeenCalled();
    expect(pickerButton(root, "banana")?.textContent).toBe("🍌");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onReact).toHaveBeenLastCalledWith("message-1", "🍌", false);
  });

  it("shows an empty state for unmatched text and applies a pasted emoji", async () => {
    const { root, onReact, input } = await customEntry();
    for (const value of ["zzqx", "👍👀"]) {
      enter(input, value);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      flush();
      expect(onReact).not.toHaveBeenCalled();
      expect(root.querySelector(".emoji-search-panel__empty")?.textContent).toBe(
        "No matching emoji",
      );
    }
    enter(input, " 🦞 ");
    expect(onReact).toHaveBeenLastCalledWith("message-1", "🦞", false);
  });

  it("waits for IME composition to commit before applying an emoji", async () => {
    const { onReact, input } = await customEntry();
    enter(input, "👍", true);
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
    const didHide = hidden(root);
    nextControl.focus();
    await didHide;
    flush();
    expect(root.querySelector("input")).toBeNull();
    expect(document.activeElement).toBe(nextControl);
  });
});
