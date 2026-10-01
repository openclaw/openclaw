import { html, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { MessageReactionSummary } from "../../../../../packages/gateway-protocol/src/index.js";
import { renderCopyAsMarkdownButton } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import type { OpenClawModalDialog } from "../../../components/modal-dialog.ts";
import "../../../styles.css";
import "../../../styles/chat/grouped.css";
import { renderRewindButton } from "./chat-message-confirmation.ts";
import { ChatMessageReactions } from "./chat-message-reactions.ts";

const identities = [
  { id: "maya", label: "Maya" },
  { id: "noah", label: "Noah" },
];

let host: HTMLElement;
afterEach(() => {
  if (host) {
    render(null, host);
    host.remove();
  }
});

it("supports keyboard picker selection, focus names and non-mutating people dialog", async () => {
  const onReact = vi.fn();
  const reactions: MessageReactionSummary[] = [{ emoji: "👍", count: 2, identities }];
  host = document.body.appendChild(document.createElement("div"));
  render(
    html`<openclaw-chat-message-reactions
      .reactions=${reactions}
      .onReact=${onReact}
      .userId=${"viewer"}
      .messageId=${"saved"}
    ></openclaw-chat-message-reactions>`,
    host,
  );
  const element = host.querySelector<ChatMessageReactions>("openclaw-chat-message-reactions")!;
  await element.updateComplete;
  await expect.element(page.getByRole("button", { name: "👍, 2 reactions" })).toBeVisible();
  const chip = host.querySelector<HTMLButtonElement>("[data-emoji]")!;
  chip.focus();
  expect(chip.getAttribute("aria-describedby")).toBeTruthy();
  const tooltip = host.querySelector("openclaw-tooltip")!;
  expect(tooltip.querySelector(".chat-reaction-details-link")?.textContent?.trim()).toBe(
    "Maya, Noah reacted with 👍",
  );
  const add = host.querySelector<HTMLButtonElement>('[aria-label="Add reaction"]')!;
  add.focus();
  await userEvent.keyboard("{Enter}");
  await element.updateComplete;
  await page.getByRole("searchbox", { name: "Search emoji" }).fill("rocket");
  await element.updateComplete;
  const rocket = host.querySelector<HTMLButtonElement>('[aria-label="rocket"]')!;
  rocket.focus();
  await userEvent.keyboard("{Enter}");
  await element.updateComplete;
  expect(onReact).toHaveBeenCalledWith("saved", "🚀", false);
  chip.focus();
  await expect
    .element(page.getByRole("button", { name: "Who reacted with 👍", exact: true }))
    .toBeVisible();
  await userEvent.keyboard("{Tab}{Enter}");
  await element.updateComplete;
  await Promise.resolve();
  await element.updateComplete;
  const modal = host.querySelector<OpenClawModalDialog>("openclaw-modal-dialog")!;
  await modal.updateComplete;
  await expect.element(page.getByRole("dialog", { name: "Who reacted" })).toBeVisible();
  await expect.element(page.getByText("Maya", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Noah", { exact: true })).toBeVisible();
  expect(onReact).toHaveBeenCalledTimes(1);
  await userEvent.keyboard("{Escape}");
  await element.updateComplete;
  await expect.element(page.getByRole("dialog", { name: "Who reacted" })).not.toBeInTheDocument();
  expect(document.activeElement).toBe(chip);
});

it("bounds measured reactions without moving actions and keeps expanded details and collapse reachable", async () => {
  const emojis = [
    "👨‍👩‍👧‍👦",
    ...Array.from(
      "👍👀🎉🚀🔥👏💯✅🙌💪🤔😊😂😍🥳😎🤩🙏💡🐛🦞🎯🏆⭐🌟✨🎈🎁🎊🎵🎮🎨📚📝📌📎🔍🔑🔒🔔📣💬💭☕🍕🍿🍪🍰🌈🌞🌙🌍🌱🌻🍀🐈🐕🐢🦋🐝🐙🦀🐳",
    ),
  ];
  const reactions: MessageReactionSummary[] = emojis.map((emoji, index) => {
    const count = index % 4 === 0 ? 1 : index % 4 === 1 ? 2 : index % 4 === 2 ? 127 : 999_999_999;
    return {
      emoji,
      count,
      identities: identities.slice(0, count),
    };
  });
  const onReact = vi.fn();
  const inventory = (items: MessageReactionSummary[]) => {
    host.querySelector<ChatMessageReactions>("openclaw-chat-message-reactions")!.reactions = items;
  };
  host = document.body.appendChild(document.createElement("div"));
  host.style.cssText = "display:block; width:420px; margin:0; padding:0";
  render(
    html`<p style="margin:0">A message above the controls.</p>
      <div class="chat-message-action-line">
        <openclaw-chat-message-reactions
          .onReact=${onReact}
          .userId=${"maya"}
          .messageId=${"saved"}
          .actions=${html`<div class="chat-message-actions-row">${renderCopyAsMarkdownButton("Fixture message")}${renderRewindButton(() => {})}<button aria-label="Reply">${icons.messageSquare}</button></div>`}
        ></openclaw-chat-message-reactions>
      </div>`,
    host,
  );
  const element = host.querySelector<ChatMessageReactions>("openclaw-chat-message-reactions")!;
  const layoutComplete = async () => {
    await element.updateComplete;
    // One frame delivers ResizeObserver, the next performs the owner's deferred measurement.
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    await element.updateComplete;
  };
  for (const orientation of ["own", "peer", "assistant"]) {
    host.className =
      orientation === "assistant"
        ? "chat-group assistant"
        : "chat-group user" + (orientation === "peer" ? " chat-group--peer" : "");
    element.layout = orientation === "assistant" ? "assistant" : "user";
    for (const width of [200, 420]) {
      host.style.width = width + "px";
      inventory([]);
      await layoutComplete();
      const actions = element.querySelector<HTMLElement>(".chat-reaction-actions")!;
      const before = actions.getBoundingClientRect();
      for (const items of [reactions.slice(0, 1), reactions]) {
        inventory(items);
        await layoutComplete();
        const after = actions.getBoundingClientRect();
        expect([after.x, after.y, after.width]).toEqual([before.x, before.y, before.width]);
        expect(element.getBoundingClientRect().width).toBe(width);
        const strip = element.querySelector<HTMLElement>(".chat-reaction-strip")!;
        expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth + 1);
        if (orientation !== "assistant") {
          const chips = strip.getBoundingClientRect();
          expect(
            orientation === "own" ? chips.right <= after.left : after.right <= chips.left,
          ).toBe(true);
        }
      }
      const visible = element.querySelectorAll(".chat-reaction-strip .chat-reaction-toggle").length;
      expect(visible).toBeLessThanOrEqual(8);
      const more = element.querySelector<HTMLButtonElement>("button.chat-reaction-more")!;
      expect(more.textContent?.trim()).toBe("+" + (reactions.length - visible));
      more.click();
      await element.updateComplete;
      const panel = element.querySelector<HTMLElement>(".chat-reaction-overflow")!;
      expect(
        [...panel.querySelectorAll<HTMLElement>(".chat-reaction-toggle")].map(
          (chip) => chip.dataset.emoji,
        ),
      ).toEqual(emojis);
      expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);
      expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
      expect(element.getBoundingClientRect().width).toBe(width);
      expect(actions.getBoundingClientRect().y).toBe(before.y);
      element.querySelector<HTMLButtonElement>(".chat-reaction-collapse")!.click();
      await element.updateComplete;
      expect(document.activeElement).toBe(more);
    }
  }
  host.className = "chat-group user";
  host.style.width = "fit-content";
  host.querySelector("p")!.textContent = "Hi";
  element.layout = "user";
  inventory([]);
  await layoutComplete();
  const shortWidth = host.getBoundingClientRect().width;
  const shortActions = element
    .querySelector<HTMLElement>(".chat-reaction-actions")!
    .getBoundingClientRect();
  expect(shortWidth).toBeGreaterThanOrEqual(shortActions.width + 50);
  inventory(reactions);
  await layoutComplete();
  expect(host.getBoundingClientRect().width).toBe(shortWidth);
  const actionButtons = [
    ...element.querySelectorAll<HTMLButtonElement>(".chat-reaction-actions button"),
  ];
  expect(actionButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
    "Copy as markdown",
    "Rewind",
    "Reply",
    "Add reaction",
  ]);
  for (const button of actionButtons) {
    const svg = button.querySelector("svg")!;
    expect(getComputedStyle(svg).strokeWidth).toBe("1.75px");
    const glyph = svg.getBoundingClientRect();
    const control = button.getBoundingClientRect();
    expect(glyph.width).toBe(18);
    expect(glyph.x + glyph.width / 2).toBe(control.x + control.width / 2);
    expect(glyph.y + glyph.height / 2).toBe(control.y + control.height / 2);
  }
  element.querySelector<HTMLButtonElement>("button.chat-reaction-more")!.click();
  await element.updateComplete;
  const chip = element.querySelector<HTMLButtonElement>(
    ".chat-reaction-overflow .chat-reaction-toggle",
  )!;
  chip.focus();
  const tooltip = chip.closest("openclaw-tooltip")!;
  await tooltip.updateComplete;
  expect(tooltip.placement).toBe("bottom");
  await page
    .elementLocator(tooltip.querySelector<HTMLButtonElement>(".chat-reaction-details-link")!)
    .click();
  await element.updateComplete;
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await element.updateComplete;
  expect(document.activeElement).toBe(chip);
  const collapse = element.querySelector<HTMLButtonElement>(".chat-reaction-collapse")!;
  await page.elementLocator(collapse).click();
  await element.updateComplete;
  expect(element.querySelector(".chat-reaction-overflow")).toBeNull();
  expect(onReact).not.toHaveBeenCalled();
});

it("keeps short bubble text intrinsic while its footer reserves action space", async () => {
  host = document.body.appendChild(document.createElement("div"));
  for (const peer of [false, true]) {
    host.className = "chat-group user" + (peer ? " chat-group--peer" : "");
    render(
      html`<div class="chat-message-with-reactions">
        <div class="chat-bubble">Hi</div>
        <div class="chat-message-action-line">
          <openclaw-chat-message-reactions
            .layout=${"user"}
            .actions=${html`<button>Copy</button><button>Reply</button>`}
          ></openclaw-chat-message-reactions>
        </div>
      </div>`,
      host,
    );
    await host.querySelector<ChatMessageReactions>("openclaw-chat-message-reactions")!
      .updateComplete;
    const bubble = host.querySelector<HTMLElement>(".chat-bubble")!.getBoundingClientRect();
    const frame = host
      .querySelector<HTMLElement>(".chat-message-with-reactions")!
      .getBoundingClientRect();
    expect(bubble.width).toBeLessThan(100);
    expect(frame.width).toBeGreaterThan(bubble.width);
    expect(peer ? bubble.left : bubble.right).toBe(peer ? frame.left : frame.right);
  }
});

it("keeps keyboard focus on a surviving reaction when resizing removes overflow", async () => {
  const onReact = vi.fn();
  const reactions: MessageReactionSummary[] = ["👍", "👀", "🎉"].map((emoji) => ({
    emoji,
    count: 2,
    identities,
  }));
  host = document.body.appendChild(document.createElement("div"));
  host.style.cssText = "width:180px;display:block";
  render(
    html`<openclaw-chat-message-reactions
      .reactions=${reactions}
      .onReact=${onReact}
      .userId=${"viewer"}
      .messageId=${"saved"}
      .layout=${"user"}
      .actions=${html`<button>Copy</button><button>Rewind</button><button>Reply</button>`}
    ></openclaw-chat-message-reactions>`,
    host,
  );
  const element = host.querySelector<ChatMessageReactions>("openclaw-chat-message-reactions")!;
  const settle = async () => {
    await element.updateComplete;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    await element.updateComplete;
  };
  await settle();
  const more = element.querySelector<HTMLButtonElement>("button.chat-reaction-more")!;
  more.click();
  await element.updateComplete;
  element.querySelector<HTMLButtonElement>('.chat-reaction-overflow [data-emoji="👀"]')!.focus();
  host.style.width = "600px";
  await settle();
  await settle();
  expect(element.querySelector(".chat-reaction-overflow")).toBeNull();
  expect(element.querySelector("button.chat-reaction-more")).toBeNull();
  expect(document.activeElement).toBe(
    element.querySelector('.chat-reaction-strip [data-emoji="👀"]'),
  );
});
