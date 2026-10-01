import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageReactionSummary } from "../../../../../packages/gateway-protocol/src/index.js";
import { installDialogPolyfill } from "../../../test-helpers/modal-dialog.ts";
import { ChatMessageReactions } from "./chat-message-reactions.ts";

let restoreDialog: () => void;
let container: HTMLElement;
beforeEach(() => {
  restoreDialog = installDialogPolyfill();
  container = document.body.appendChild(document.createElement("div"));
});
afterEach(() => {
  render(null, container);
  container.remove();
  restoreDialog();
  vi.useRealTimers();
});

const maya = { id: "maya", label: "Maya" };
const noah = { id: "noah", label: "Noah" };
const summary: MessageReactionSummary = { emoji: "👍", count: 2, identities: [maya, noah] };

async function setup(
  canReact = true,
  reaction: MessageReactionSummary | MessageReactionSummary[] = summary,
) {
  const onReact = vi.fn();
  render(
    html`<openclaw-chat-message-reactions
      .reactions=${Array.isArray(reaction) ? reaction : [reaction]}
      .userId=${"viewer"}
      .onReact=${canReact ? onReact : undefined}
      .messageId=${"saved"}
    ></openclaw-chat-message-reactions>`,
    container,
  );
  const element = container.querySelector<ChatMessageReactions>("openclaw-chat-message-reactions")!;
  await element.updateComplete;
  return { element, onReact };
}
async function settle(element: ChatMessageReactions) {
  await element.updateComplete;
}
function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.getAttribute("aria-label") === label,
  )!;
}

describe("message reaction presentation", () => {
  it("uses authoritative identities for own state and blocks callbacks while pending", async () => {
    const { element, onReact } = await setup(true, {
      ...summary,
      identities: [maya, { id: "viewer", label: "Viewer" }],
    });
    const chip = element.querySelector<HTMLButtonElement>(".chat-reaction-toggle")!;
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    chip.click();
    expect(onReact).toHaveBeenCalledWith("saved", "👍", true);
    element.pending = true;
    await element.updateComplete;
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(button("Add reaction").disabled).toBe(true);
    chip.click();
    expect(onReact).toHaveBeenCalledTimes(1);
    expect(element.querySelector(".chat-reactions")?.getAttribute("aria-busy")).toBe("true");
    element.pending = false;
    await element.updateComplete;
    expect(chip.getAttribute("aria-disabled")).toBe("false");
    // The UI never fabricates optimistic success or owns a retry/write cache.
    expect(chip.getAttribute("aria-pressed")).toBe("true");
  });

  it("searches the emoji catalog and invokes Peter's remove flag callback", async () => {
    const { element, onReact } = await setup();
    button("Add reaction").click();
    await element.updateComplete;
    expect(container.querySelectorAll(".chat-reaction-picker button")).toHaveLength(8);
    const search = container.querySelector<HTMLInputElement>("input[type=search]")!;
    search.value = "rocket";
    search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await element.updateComplete;
    button("rocket").click();
    await element.updateComplete;
    expect(onReact).toHaveBeenCalledWith("saved", "🚀", false);
    expect(container.querySelector("wa-popup")).toBeNull();
  });

  it("lets readers inspect all existing identities without RPCs or pagination", async () => {
    const identities = Array.from({ length: 120 }, (_, i) => ({
      id: String(i),
      label: "Person " + i,
    }));
    const { element, onReact } = await setup(false, {
      ...summary,
      count: identities.length,
      identities,
    });
    expect(container.querySelector('[aria-label="Add reaction"]')).toBeNull();
    button("Who reacted with 👍").click();
    await element.updateComplete;
    expect(container.querySelectorAll(".chat-reaction-people li")).toHaveLength(120);
    expect(container.textContent).not.toContain("Load more");
    element.reactions = [{ ...summary, count: 1, identities: [noah] }];
    await element.updateComplete;
    expect(container.querySelectorAll(".chat-reaction-people li")).toHaveLength(1);
    expect(container.querySelector(".chat-reaction-people")?.textContent).toContain("Noah");
    expect(onReact).not.toHaveBeenCalled();
    element.messageId = "new";
    await element.updateComplete;
    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
  });
  it("hides singleton counts in chips and details without losing the accessible count", async () => {
    const { element } = await setup(false, { ...summary, count: 1, identities: [maya] });
    const chip = container.querySelector<HTMLButtonElement>(".chat-reaction-toggle")!;
    expect(chip.textContent?.trim()).toBe("👍");
    expect(chip.getAttribute("aria-label")).toBe("👍, 1 reactions");
    button("Who reacted with 👍").click();
    expect(document.activeElement).toBe(chip);
    await settle(element);
    const tab = container.querySelector(".chat-reaction-tabs button")!;
    expect(tab.textContent?.trim()).toBe("👍");
    expect(tab.getAttribute("aria-label")).toBe("👍, 1 reactions");
  });

  it("waits the full hover dwell, cancels on leave, and opens immediately for keyboard focus", async () => {
    const { element } = await setup();
    const tooltip = element.querySelector("openclaw-tooltip")!;
    await tooltip.updateComplete;
    await tooltip.shadowRoot?.querySelector("wa-tooltip")?.updateComplete;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const chip = element.querySelector<HTMLButtonElement>(".chat-reaction-toggle")!;
    chip.dispatchEvent(new MouseEvent("pointerenter"));
    vi.advanceTimersByTime(399);
    expect(tooltip.hasAttribute("open")).toBe(false);
    chip.dispatchEvent(new MouseEvent("pointerleave"));
    vi.advanceTimersByTime(1_000);
    expect(tooltip.hasAttribute("open")).toBe(false);
    chip.dispatchEvent(new MouseEvent("pointerenter"));
    vi.advanceTimersByTime(399);
    expect(tooltip.hasAttribute("open")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(tooltip.hasAttribute("open")).toBe(true);
    chip.dispatchEvent(new MouseEvent("pointerleave"));
    vi.advanceTimersByTime(100);
    expect(tooltip.hasAttribute("open")).toBe(false);
    chip.focus();
    expect(tooltip.hasAttribute("open")).toBe(true);
  });

  it("reveals names on the first touch and toggles only on the second tap", async () => {
    const { onReact, element } = await setup();
    const chip = element.querySelector<HTMLButtonElement>(".chat-reaction-toggle")!;
    const tooltip = chip.closest("openclaw-tooltip")!;
    await tooltip.updateComplete;
    const touch = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(touch, "pointerType", { value: "touch" });
    chip.dispatchEvent(touch);
    chip.click();
    expect(tooltip.hasAttribute("open")).toBe(true);
    expect(onReact).not.toHaveBeenCalled();
    chip.dispatchEvent(touch);
    chip.click();
    await settle(element);
    expect(onReact).toHaveBeenCalledWith("saved", "👍", false);
  });

  it("reveals every overflow group for readers and restores disclosure focus on collapse", async () => {
    const reactions = Array.from("👍👀🎉🚀🔥👏💯✅🙌💪🤔😊").map((emoji) => ({
      emoji,
      count: summary.count,
      identities: summary.identities,
    }));
    const { onReact, element } = await setup(false, reactions);
    const more = element.querySelector<HTMLButtonElement>("button.chat-reaction-more")!;
    expect(more.textContent?.trim()).toBe("+4");
    more.click();
    await element.updateComplete;
    expect(
      [
        ...element.querySelectorAll<HTMLElement>(".chat-reaction-overflow .chat-reaction-toggle"),
      ].map((chip) => chip.dataset.emoji),
    ).toEqual(reactions.map((item) => item.emoji));
    const overflowChip = element.querySelector<HTMLButtonElement>(
      ".chat-reaction-overflow .chat-reaction-toggle",
    )!;
    expect(overflowChip.getAttribute("aria-disabled")).toBe("true");
    overflowChip.click();
    expect(onReact).not.toHaveBeenCalled();
    element.querySelector<HTMLButtonElement>(".chat-reaction-collapse")!.click();
    await element.updateComplete;
    expect(element.querySelector(".chat-reaction-overflow")).toBeNull();
    expect(document.activeElement).toBe(more);
    more.click();
    await element.updateComplete;
    more.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await element.updateComplete;
    expect(element.querySelector(".chat-reaction-overflow")).toBeNull();
    more.click();
    await element.updateComplete;
    element.messageId = "different";
    await settle(element);
    expect(element.querySelector(".chat-reaction-overflow")).toBeNull();
  });

  it("does not restart layout observation for an update queued after disconnect", async () => {
    const { element } = await setup();
    element.remove();
    const resizeObserver = vi.fn(function () {
      return { observe: vi.fn(), disconnect: vi.fn() };
    });
    vi.stubGlobal("ResizeObserver", resizeObserver);
    try {
      element.requestUpdate();
      await element.updateComplete;
      expect(resizeObserver).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
