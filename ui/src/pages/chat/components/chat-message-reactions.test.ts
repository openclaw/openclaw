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
  return { onReact, pickers: render(initialReactions), render, role };
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
  await waitForSolid(() => expect(root.querySelector(".palette")).not.toBeNull());
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
  const tab = (id = "message-1") =>
    host.querySelector<HTMLButtonElement>(
      `.chat-message-reactions[data-message-id="${id}"] .chat-reaction-tab`,
    )!;
  const openTab = async (id?: string) => {
    const picker = tab(id).closest<HTMLElement>("openclaw-message-reaction-picker")!;
    tab(id).click();
    await waitForSolid(() => expect(picker.querySelector(".palette")).not.toBeNull());
    return picker;
  };

  it.each([
    [{ role: "user" }, "writable"],
    [{ role: "assistant" }, "writable"],
    [{ writable: false }, "readonly"],
    [{ persisted: false }, "ineligible"],
    [{ streaming: true }, "ineligible"],
    [{ role: "system" }, "ineligible"],
  ] as const)("renders %j reactions as %s", async (options, access) => {
    const { onReact, pickers, render, role } = show(options);
    if (access === "ineligible") {
      expect(pickers).toHaveLength(0);
      expect(host.querySelector(".chat-message-reactions")).toBeNull();
      return;
    }
    // A bubble carries one summary tab; a flat reply's leads its footer. The toolbar keeps
    // its own add-reaction picker.
    expect(pickers).toHaveLength(access === "writable" ? 2 : 1);
    const summary = host.querySelector(".chat-message-reactions")!;
    expect(
      summary.parentElement?.classList.contains(
        role === "assistant" ? "chat-group-footer" : "chat-bubble",
      ),
    ).toBe(true);
    expect(summary.classList.contains("chat-message-reactions--own")).toBe(true);
    // Most-used emoji lead; the total replaces per-emoji counts.
    expect(tab().textContent).toBe("🎉👍7");
    expect(tab().getAttribute("aria-label")).toBe("🎉 Ana, Ben, Cy and 2 others; 👍 You, Riley");
    expect(summary.querySelector(".chat-reaction-who")?.textContent).toBe(
      "🎉Ana, Ben, Cy and 2 others👍You, Riley",
    );
    if (access === "readonly") {
      const allReactions = [
        ...reactions,
        ...["👀", "🚀", "😂", "🙏", "🔥", "✅", "🦞"].map((emoji, index) => ({
          emoji,
          count: index + 1,
          identities: [{ id: "peer" }],
        })),
      ];
      render(new Map([["message-1", allReactions]]));
      expect(tab().disabled).toBe(false);
      tab().click();
      await waitForSolid(() =>
        expect(summary.querySelectorAll(".chat-reaction-chip")).toHaveLength(9),
      );
      for (const reaction of allReactions) {
        const chip = pickerButton(pickers[0]!, `${reaction.emoji} ${reaction.count}`)!;
        expect(chip.disabled).toBe(true);
        chip.click();
      }
      expect(summary.querySelector(".palette")).toBeNull();
      expect(onReact).not.toHaveBeenCalled();
      return;
    }
    const picker = await openTab();
    const chips = [...picker.querySelectorAll<HTMLButtonElement>(".chat-reaction-chip")];
    expect(chips.map((chip) => [chip.getAttribute("aria-label"), chip.ariaPressed])).toEqual([
      ["🎉 5", "false"],
      ["👍 2", "true"],
    ]);
    const didHide = hidden(picker);
    chips[1]!.click();
    expect(onReact).toHaveBeenLastCalledWith("message-1", "👍", true);
    await didHide;
    expect(picker.querySelector(".palette")).toBeNull();
    (await openTab()).querySelector<HTMLButtonElement>(".chat-reaction-chip")!.click();
    expect(onReact).toHaveBeenLastCalledWith("message-1", "🎉", false);
    expect(pickerButton(await openTab(), "👍")!.getAttribute("aria-pressed")).toBe("true");
    pickerButton(picker, "🚀")!.click();
    expect(onReact).toHaveBeenLastCalledWith("message-1", "🚀", false);
  });

  it("shows a lone reaction without a number and names an unlisted reactor", () => {
    show({}, new Map([["message-1", [{ emoji: "👀", count: 2, identities: [{ id: "peer" }] }]]]));
    expect(tab().textContent).toBe("👀2");
    expect(tab().getAttribute("aria-label")).toBe("👀 peer and 1 other");
    cleanupSolid();
    host.remove();
    show(
      {},
      new Map([
        ["message-1", [{ emoji: "👀", count: 1, identities: [{ id: "peer", label: "Riley" }] }]],
      ]),
    );
    expect(tab().textContent).toBe("👀");
    expect(host.querySelector(".chat-message-reactions--own")).toBeNull();
  });

  it("keeps the toolbar picker stable and disables open reactions when write access ends", async () => {
    const access = { role: "assistant", writable: true };
    const { render, onReact } = show(access, new Map());
    const locations = (messageReactions: Map<string, MessageReactionSummary[]>) =>
      render(messageReactions).map((picker) =>
        picker.closest(".chat-message-reactions") ? "tab" : "actions",
      );
    expect(locations(new Map())).toEqual(["actions"]);
    const toolbar = host.querySelector(".chat-reaction-action");
    expect(locations(new Map([["message-1", reactions]]))).toEqual(["tab", "actions"]);
    expect(host.querySelector(".chat-reaction-action")).toBe(toolbar);
    const picker = await openTab();
    const chip = picker.querySelector<HTMLButtonElement>(".chat-reaction-chip")!;
    access.writable = false;
    render(new Map([["message-1", reactions]]));
    expect(chip.disabled).toBe(true);
    expect(picker.querySelector(".palette")).toBeNull();
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onReact).not.toHaveBeenCalled();
    expect(locations(new Map([["message-1", []]]))).toEqual([]);
  });

  it("keeps a flat reply's reactions in its footer through an active continuation", async () => {
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
      // The summary leads the footer and stays put while identity and time come and go.
      expect(footer.firstElementChild?.classList.contains("chat-message-reactions")).toBe(true);
      expect(host.querySelectorAll(".chat-message-reactions")).toHaveLength(1);
      expect(footer.querySelector(".chat-group-footer__meta") !== null).toBe(!active);
      const picker = await openTab();
      const didHide = hidden(picker);
      pickerButton(picker, "🚀")!.click();
      expect(onReact).toHaveBeenLastCalledWith("message-1", "🚀", false);
      await didHide;
    }
  });

  it.each(["user", "assistant"])(
    "keeps each %s message's reactions with that message",
    async (role) => {
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
      const copy = host.querySelector<HTMLButtonElement>(
        ".chat-message-actions-row .chat-copy-btn",
      )!;
      copy.focus();
      render(
        new Map([
          ["first", reactions],
          ["last", reactions],
        ]),
      );
      // Reactions arriving must not rebuild the toolbar a keyboard user is on.
      expect(document.activeElement).toBe(copy);
      for (const id of ["first", "last"]) {
        // Bubbles carry their own tab; a flat reply's leads the row under that reply.
        if (role === "user") {
          expect(tab(id).closest(".chat-bubble")?.getAttribute("data-message-id")).toBe(id);
        } else if (id === "first") {
          expect(
            tab(id).closest(".chat-message-actions-row")?.getAttribute("data-message-actions-for"),
          ).toBe(id);
        } else {
          expect(tab(id).closest(".chat-group > .chat-group-footer")).not.toBeNull();
        }
        const picker = await openTab(id);
        const didHide = hidden(picker);
        picker.querySelector<HTMLButtonElement>(".chat-reaction-chip")!.click();
        await didHide;
      }
      expect(onReact.mock.calls.map(([id]) => id)).toEqual(["first", "last"]);
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
        "No emoji match your search.",
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
