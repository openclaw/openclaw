import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { resolveTypefaces, syncTypefaceStylesheets } from "../../../app/typography.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import "../../../styles/base.css";
import "../../../styles/chat/startup-layout.css";
import "../../../styles/chat/message-layout.css";
import "../../../styles/chat/grouped.css";
import "../../../styles/chat/text.css";

let host: HTMLDivElement;

beforeEach(async () => {
  const typefaces = resolveTypefaces("claw");
  syncTypefaceStylesheets(typefaces);
  await expect
    .poll(() =>
      Boolean(document.querySelector<HTMLLinkElement>(`#openclaw-typeface-${typefaces.ui}`)?.sheet),
    )
    .toBe(true);
  host = document.body.appendChild(document.createElement("div"));
  host.className = "chat-thread";
});

afterEach(async () => {
  render(null, host);
  host.remove();
  await page.viewport(1280, 720);
});

async function draw(name: string, source = true, onOpenReply = vi.fn()) {
  const group: MessageGroup = {
    kind: "group",
    key: "answer",
    role: "assistant",
    timestamp: 0,
    isStreaming: false,
    visibleContent: "text",
    replyToSender: { id: "casey", name, identity: { type: "agent", id: "casey" } },
    replyToMessage: {
      key: "prompt",
      message: source
        ? { role: "user", content: "Original question", __openclaw: { id: "prompt" } }
        : null,
    },
    messages: [
      {
        key: "answer-message",
        hasVisibleContent: true,
        message: { role: "assistant", content: "OK." },
      },
    ],
  };
  render(
    renderMessageGroup(group, {
      showReasoning: false,
      showToolCalls: false,
      avatarPlacement: "gutter",
      onOpenReply,
      resolveReplyPreview: () => ({
        messageId: "prompt",
        sourceMessageId: "prompt",
        senderLabel: name,
        sender: { id: "casey", name },
        agentAvatar: { avatar: null, textAvatar: "🦀" },
        text: "Original question",
        isLoaded: true,
      }),
    }),
    host,
  );
  await document.fonts.ready;
  const row = host.querySelector<HTMLElement>(".chat-reply-attribution--reply")!;
  return {
    row,
    name: row.querySelector<HTMLElement>(".chat-reply-attribution__name")!,
  };
}

function expectSingleLine(row: HTMLElement) {
  const box = row.getBoundingClientRect();
  const label = row.querySelector<HTMLElement>(".chat-reply-attribution__label")!;
  const labelBox = label.getBoundingClientRect();
  expect(box.height).toBeGreaterThan(0);
  expect(row.scrollWidth - row.clientWidth).toBeLessThanOrEqual(1);
  expect(box.right).toBeLessThanOrEqual(host.getBoundingClientRect().right + 1);
  for (const text of row.querySelectorAll<HTMLElement>(
    ".chat-reply-attribution__label, .chat-reply-attribution__name, .chat-reply-attribution__unavailable",
  )) {
    const textBox = text.getBoundingClientRect();
    // A second flex line must not hide below an otherwise single-line label.
    expect(textBox.top).toBeLessThan(labelBox.bottom);
    expect(textBox.bottom).toBeGreaterThan(labelBox.top);
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
    const lines: DOMRect[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) {
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      lines.push(...[...range.getClientRects()].filter((rect) => rect.height > 0));
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(
      Math.max(...lines.map((rect) => rect.top)) - Math.min(...lines.map((rect) => rect.top)),
    ).toBeLessThanOrEqual(1);
  }
}

// Theme changes colors only; geometry is proven once per width.
describe.each([1440, 390, 360])("reply attribution (%d px)", (width) => {
  beforeEach(async () => {
    await page.viewport(width, 800);
    host.style.width = `${width - 32}px`;
  });

  it.each(["ltr", "rtl"])(
    "shows the viewport-appropriate reply cue in %s layout",
    async (direction) => {
      host.dir = direction;
      const { row } = await draw("Casey Morgan");
      const group = row.closest(".chat-group")!;
      const icon = row.querySelector<HTMLElement>(".chat-reply-attribution__mobile-icon")!;
      // The hidden text fallback must not stretch the agent image past its 16px circle.
      const face = row.querySelector(".chat-author-avatar .identity-avatar__fallback")!;
      expect([face.getBoundingClientRect().width, face.getBoundingClientRect().height]).toEqual([
        16, 16,
      ]);
      if (width < 768) {
        const avatar = group.querySelector(":scope > .chat-avatar, :scope > .chat-avatar-slot")!;
        expect(avatar.getBoundingClientRect().width).toBe(0);
        expect(group.querySelector(".chat-reply-connector")!.getBoundingClientRect().width).toBe(0);
        expect(icon.getBoundingClientRect().width).toBe(14);
        expect(icon.getBoundingClientRect().height).toBe(14);
        const transform = new DOMMatrixReadOnly(getComputedStyle(icon).transform);
        expect(transform.a).toBe(direction === "rtl" ? -1 : 1);
        const bounds = group.getBoundingClientRect();
        const rowBounds = row.getBoundingClientRect();
        expect(Math.abs(rowBounds.left - bounds.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(rowBounds.right - bounds.right)).toBeLessThanOrEqual(1);
        const bubble = group.querySelector(".chat-bubble")!;
        const content = bubble.querySelector(".chat-text")!.getBoundingClientRect();
        expect(content.top - bubble.getBoundingClientRect().top).toBeCloseTo(4, 1);
        expect(content.top - rowBounds.bottom).toBeCloseTo(12, 1);
        return;
      }
      expect(icon.getBoundingClientRect().width).toBe(0);
      const speaker = group.querySelector(":scope > .chat-avatar, :scope > .chat-avatar-slot")!;
      const text = group.querySelector(".chat-bubble > .chat-text")!;
      const speakerBounds = speaker.getBoundingClientRect();
      const textBounds = text.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
      expect(
        Math.abs(speakerBounds.top + speakerBounds.height / 2 - textBounds.top - lineHeight / 2),
      ).toBeLessThanOrEqual(1);
      await expect
        .poll(() => {
          const path = group.querySelector<SVGPathElement>(".chat-reply-connector path")!;
          const svg = path.ownerSVGElement!.getBoundingClientRect();
          const avatar = group
            .querySelector(":scope > .chat-avatar, :scope > .chat-avatar-slot")!
            .getBoundingClientRect();
          const label = row
            .querySelector(".chat-reply-attribution__label")!
            .getBoundingClientRect();
          const start = path.getPointAtLength(0);
          const end = path.getPointAtLength(path.getTotalLength());
          const labelEdge = direction === "rtl" ? label.right : label.left;
          const expectedEndX = labelEdge + (direction === "rtl" ? 5 : -5);
          return Math.max(
            Math.abs(svg.left + start.x - avatar.left - avatar.width / 2),
            Math.abs(svg.top + start.y - avatar.top),
            Math.abs(svg.left + end.x - expectedEndX),
            Math.abs(svg.top + end.y - label.top - label.height / 2),
          );
        })
        .toBeLessThanOrEqual(1);
    },
  );

  it.each([
    { name: "Casey Morgan 👩🏽‍💻", source: true, fits: true },
    { name: "ليلى منصور", source: true, fits: true },
    { name: "Casey Morgan", source: false, fits: true },
    { name: "A very long participant name ".repeat(40), source: true, fits: false },
  ])("keeps the label and name $name on one line", async ({ name, source, fits }) => {
    const result = await draw(name, source);
    expectSingleLine(result.row);
    const label = result.row.querySelector<HTMLElement>(".chat-reply-attribution__label")!;
    expect(label.scrollWidth - label.clientWidth).toBeLessThanOrEqual(1);
    expect(result.name.clientWidth).toBeGreaterThan(0);
    expect(result.name.scrollWidth - result.name.clientWidth > 1).toBe(!fits);
  });
});

it("updates a mounted reply across the mobile breakpoint without losing navigation", async () => {
  await page.viewport(1440, 800);
  const onOpenReply = vi.fn();
  await draw("Casey Morgan", true, onOpenReply);
  for (const width of [390, 360, 1440]) {
    await page.viewport(width, 800);
    const target = page.getByRole("button", { name: "Replying to Casey Morgan", exact: true });
    await target.click();
    expect(onOpenReply).toHaveBeenLastCalledWith("prompt");
    const button = host.querySelector<HTMLButtonElement>(".chat-reply-attribution button")!;
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpenReply).toHaveBeenLastCalledWith("prompt");
  }
  expect(onOpenReply).toHaveBeenCalledTimes(6);
});

it.each([1440, 390])(
  "keeps a short own reply readable without overlapping its label at %d px",
  async (width) => {
    await page.viewport(width, 800);
    const onOpenReply = vi.fn();
    for (const direction of ["ltr", "rtl"]) {
      host.dir = direction;
      host.style.width = width - 32 + "px";
      render(
        renderMessageGroup(
          {
            kind: "group",
            key: "own",
            role: "user",
            timestamp: 1,
            isStreaming: false,
            visibleContent: "text",
            messages: [
              {
                key: "reply",
                hasVisibleContent: true,
                message: {
                  role: "user",
                  content: "OK",
                  __openclaw: {
                    id: "reply",
                    replyToId: "source",
                    replyToPreview: {
                      senderLabel: "Casey Morgan",
                      text: "Please review the release checklist. ".repeat(20),
                    },
                  },
                },
              },
            ],
          },
          { showReasoning: false, onOpenReply },
        ),
        host,
      );
      await document.fonts.ready;
      const row = host.querySelector<HTMLElement>(".chat-reply-attribution--inline")!;
      const name = row.querySelector<HTMLElement>(".chat-reply-attribution__name")!;
      const label = row.querySelector<HTMLElement>(".chat-reply-attribution__label")!;
      const button = row.querySelector<HTMLButtonElement>("button")!;
      expect(name.scrollWidth - name.clientWidth).toBeLessThanOrEqual(1);
      expect(label.scrollWidth - label.clientWidth).toBeLessThanOrEqual(1);
      const a = label.getBoundingClientRect(),
        b = button.getBoundingClientRect();
      const bubble = row.closest(".chat-bubble")!.getBoundingClientRect();
      // The padded hit area may extend past the row, but not its containing bubble.
      expect(b.left).toBeGreaterThanOrEqual(bubble.left);
      expect(b.right).toBeLessThanOrEqual(bubble.right);
      expect(a.right <= b.left || b.right <= a.left).toBe(true);
      button.click();
      expect(onOpenReply).toHaveBeenLastCalledWith("source");
    }
  },
);
