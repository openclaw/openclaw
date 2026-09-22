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
const originalTheme = document.documentElement.getAttribute("data-theme-mode");

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
  if (originalTheme === null) {
    document.documentElement.removeAttribute("data-theme-mode");
  } else {
    document.documentElement.setAttribute("data-theme-mode", originalTheme);
  }
  await page.viewport(1280, 720);
});

async function draw(name: string, excerpt: string | null, onOpenReply = vi.fn()) {
  const group: MessageGroup = {
    kind: "group",
    key: "answer",
    role: "assistant",
    timestamp: 0,
    isStreaming: false,
    visibleContent: "text",
    replyToSender: { id: "casey", name },
    replyToMessage: {
      key: "prompt",
      message:
        excerpt === null ? null : { role: "user", content: excerpt, __openclaw: { id: "prompt" } },
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
        text: excerpt ?? "",
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
    excerpt: row.querySelector<HTMLElement>(".chat-reply-attribution__excerpt-text"),
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
    ".chat-reply-attribution__label, .chat-reply-attribution__name, .chat-reply-attribution__excerpt-text, .chat-reply-attribution__unavailable",
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

const cells = ["light", "dark"].flatMap((theme) =>
  [1440, 390, 360].map((width) => ({ theme, width })),
);

describe.each(cells)("reply attribution ($theme, $width px)", ({ theme, width }) => {
  beforeEach(async () => {
    await page.viewport(width, 800);
    document.documentElement.dataset.themeMode = theme;
    host.style.width = `${width - 32}px`;
  });

  it.each(["ltr", "rtl"])(
    "shows the viewport-appropriate reply cue in %s layout",
    async (direction) => {
      host.dir = direction;
      const { row } = await draw("Casey Morgan", "Original question");
      const group = row.closest(".chat-group")!;
      const icon = row.querySelector<HTMLElement>(".chat-reply-attribution__mobile-icon")!;
      if (width < 768) {
        const avatar = group.querySelector(":scope > .chat-avatar, :scope > .chat-avatar-slot")!;
        expect(avatar.getBoundingClientRect().width).toBe(0);
        expect(group.querySelector(".chat-reply-connector")!.getBoundingClientRect().width).toBe(0);
        expect(icon.getBoundingClientRect().width).toBe(14);
        expect(icon.getBoundingClientRect().height).toBe(14);
        const transform = new DOMMatrixReadOnly(getComputedStyle(icon).transform);
        expect(transform.a).toBe(direction === "rtl" ? -1 : 1);
        expect(row.querySelector(".chat-author-avatar")!.getBoundingClientRect().width).toBe(16);
        const bounds = group.getBoundingClientRect();
        const rowBounds = row.getBoundingClientRect();
        expect(Math.abs(rowBounds.left - bounds.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(rowBounds.right - bounds.right)).toBeLessThanOrEqual(1);
        const content = group.querySelector(".chat-bubble > .chat-text")!.getBoundingClientRect();
        expect(content.top - rowBounds.bottom).toBeCloseTo(8, 1);
        return;
      }
      expect(icon.getBoundingClientRect().width).toBe(0);
      const speaker = group.querySelector(":scope > .chat-avatar, :scope > .chat-avatar-slot")!;
      const text = group.querySelector(".chat-bubble > .chat-text")!;
      expect(
        Math.abs(speaker.getBoundingClientRect().top - text.getBoundingClientRect().top),
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
            Math.abs(svg.top + start.y - avatar.top - avatar.height / 2),
            Math.abs(svg.left + end.x - expectedEndX),
            Math.abs(svg.top + end.y - label.top - label.height / 2),
          );
        })
        .toBeLessThanOrEqual(1);
    },
  );

  it("keeps Casey Morgan complete with an emoji and sacrifices a long excerpt first", async () => {
    const short = await draw("Casey Morgan", "👩🏽‍💻");
    expectSingleLine(short.row);
    expect(short.name.textContent).toBe("Casey Morgan");
    expect(short.name.scrollWidth - short.name.clientWidth).toBeLessThanOrEqual(1);
    const nameWidth = short.name.getBoundingClientRect().width;
    const long = await draw("Casey Morgan", "Please review the release checklist. ".repeat(30));
    expectSingleLine(long.row);
    expect(long.name.scrollWidth - long.name.clientWidth).toBeLessThanOrEqual(1);
    expect(Math.abs(long.name.getBoundingClientRect().width - nameWidth)).toBeLessThanOrEqual(1);
    if (width < 768) {
      expect(long.excerpt).toBeNull();
    } else {
      expect(long.excerpt!.scrollWidth).toBeGreaterThan(long.excerpt!.clientWidth);
    }
  });

  it("keeps long text, unbroken URLs, emoji, RTL and unavailable sources on one line", async () => {
    for (const [name, excerpt] of [
      ["Casey Morgan", `https://example.test/${"release-checklist".repeat(60)}`],
      ["Casey Morgan", "👩🏽‍💻".repeat(80)],
      ["ليلى منصور", "يرجى مراجعة خطة الإصدار ".repeat(40)],
      ["Casey Morgan", null],
      ["A very long participant name ".repeat(40), null],
    ] as const) {
      const result = await draw(name, excerpt);
      expectSingleLine(result.row);
      if (width < 768) {
        expect(
          result.row.querySelector(
            ".chat-reply-attribution__excerpt, .chat-reply-attribution__unavailable",
          ),
        ).toBeNull();
      }
    }
  });

  it("keeps the name usable and the desktop excerpt visible when a name cannot fit", async () => {
    const result = await draw("Casey Morgan ".repeat(80), "Original question ".repeat(40));
    expectSingleLine(result.row);
    expect(result.name.scrollWidth).toBeGreaterThan(result.name.clientWidth);
    expect(result.name.clientWidth).toBeGreaterThan(0);
    if (width < 768) {
      expect(result.excerpt).toBeNull();
    } else {
      expect(result.excerpt!.getBoundingClientRect().width).toBeGreaterThan(0);
    }
  });
});

it("updates a mounted reply across the mobile breakpoint without losing navigation", async () => {
  await page.viewport(1440, 800);
  const onOpenReply = vi.fn();
  const { row } = await draw("Casey Morgan", "Original question", onOpenReply);
  expect(row.querySelector(".chat-reply-attribution__excerpt-text")?.textContent).toBe(
    "Original question",
  );
  for (const width of [390, 360, 1440]) {
    await page.viewport(width, 800);
    await expect
      .poll(() => Boolean(host.querySelector(".chat-reply-attribution__excerpt-text")))
      .toBe(width === 1440);
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
      const excerpt = row.querySelector<HTMLElement>(".chat-reply-attribution__excerpt-text")!;
      expect(name.scrollWidth - name.clientWidth).toBeLessThanOrEqual(1);
      expect(label.scrollWidth - label.clientWidth).toBeLessThanOrEqual(1);
      expect(excerpt.scrollWidth).toBeGreaterThan(excerpt.clientWidth);
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
