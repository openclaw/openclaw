import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { resolveTypefaces, syncTypefaceStylesheets } from "../../../app/typography.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import { createReplyPreviewResolver } from "./chat-reply-preview.ts";
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

it("keeps the unavailable-original label visible inside an own reply without a sender name", async () => {
  await page.viewport(1440, 800);
  host.style.width = "720px";
  render(
    renderMessageGroup(
      {
        kind: "group",
        key: "own-missing-reply",
        role: "user",
        timestamp: 1,
        isStreaming: false,
        visibleContent: "text",
        messages: [
          {
            key: "reply-paged",
            hasVisibleContent: true,
            message: {
              role: "user",
              content: "Follow up on the earlier synthetic answer.",
              __openclaw: { id: "reply-paged", replyToId: "earlier-answer" },
            },
          },
        ],
      },
      { showReasoning: false, resolveReplyPreview: () => ({ missing: true }) },
    ),
    host,
  );
  await document.fonts.ready;
  const fallback = host.querySelector<HTMLElement>(
    ".chat-reply-attribution--inline .chat-reply-attribution__unavailable",
  )!;
  expect(fallback.textContent?.trim()).toBe("Original message unavailable");
  expect(getComputedStyle(fallback).visibility).toBe("visible");
  const bounds = fallback.getBoundingClientRect();
  const bubble = fallback.closest(".chat-bubble")!.getBoundingClientRect();
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
  expect(bounds.left).toBeGreaterThanOrEqual(bubble.left);
  expect(bounds.right).toBeLessThanOrEqual(bubble.right);
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

it.each([1440, 390])(
  "keeps a reserved reply strip row at a fixed height through every lookup outcome at %d px",
  async (width) => {
    await page.viewport(width, 800);
    host.style.width = `${width - 32}px`;
    type Lookup = ReturnType<
      NonNullable<Parameters<typeof renderMessageGroup>[1]["resolveReplyPreview"]>
    >;
    const pending: Lookup = { pending: true };
    const missing: Lookup = { missing: true };
    const found: Lookup = {
      messageId: "older",
      sourceMessageId: "older",
      senderLabel: "Mira",
      sender: { id: "mira", name: "Mira" },
      text: "Checklist",
    };
    // A found original without renderable text (image-only, etc.) still names its author.
    const foundWithoutText = createReplyPreviewResolver(new Map(), {
      assistantName: "OpenClaw",
      replyMessageAccess: {
        read: () => ({
          role: "user",
          content: [],
          __openclaw: { id: "older", senderId: "mira", senderName: "Mira" },
        }),
      },
    })("older");
    // Live rows can remain pending until an authoritative history page supplies the source.
    const outcomes = [
      { name: "found with sender", snapshot: undefined, steps: [pending, found], text: "Mira" },
      {
        name: "found without text",
        snapshot: undefined,
        steps: [pending, foundWithoutText],
        text: "Mira",
      },
      {
        name: "sender-only snapshot, then missing",
        snapshot: { senderLabel: "Mira", text: "" },
        steps: [pending, missing],
        text: "MiraOriginal message unavailable",
      },
      {
        name: "missing without name",
        snapshot: undefined,
        steps: [pending, missing],
        text: "Original message unavailable",
      },
      {
        name: "unconfirmed until a later page",
        snapshot: undefined,
        steps: [pending, pending, found],
        text: "Mira",
      },
    ];
    const layoutShift = PerformanceObserver.supportedEntryTypes.includes("layout-shift");
    const shifts: Array<PerformanceEntry & { value?: number; sources?: Array<{ node?: Node }> }> =
      [];
    const observer = new PerformanceObserver((list) => shifts.push(...list.getEntries()));
    if (layoutShift) {
      observer.observe({ type: "layout-shift", buffered: true });
    }
    const frame = () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => resolve(null));
      });
    try {
      for (const outcome of outcomes) {
        const group: MessageGroup = {
          kind: "group",
          key: "answer",
          role: "assistant",
          timestamp: 0,
          isStreaming: false,
          visibleContent: "text",
          replyShared: true,
          messages: [
            {
              key: "answer-message",
              hasVisibleContent: true,
              message: {
                role: "assistant",
                content: "Step 3 moved to Friday.",
                __openclaw: {
                  id: "answer",
                  replyToId: "older",
                  ...(outcome.snapshot ? { replyToPreview: outcome.snapshot } : {}),
                },
              },
            },
          ],
        };
        const drawLookup = (lookup: Lookup) =>
          render(
            html`${renderMessageGroup(group, {
                showReasoning: false,
                showToolCalls: false,
                avatarPlacement: "gutter",
                onOpenReply: vi.fn(),
                resolveReplyPreview: () => lookup,
              })}
              <div class="after">Next</div>`,
            host,
          );
        const measure = () => {
          const row = host.querySelector(".chat-reply-attribution--reply")!.getBoundingClientRect();
          return {
            rowTop: row.top,
            rowHeight: row.height,
            text: host.querySelector(".chat-bubble .chat-text")!.getBoundingClientRect().top,
            after: host.querySelector(".after")!.getBoundingClientRect().top,
          };
        };
        render(null, host);
        drawLookup(outcome.steps[0]);
        await document.fonts.ready;
        await frame();
        await frame();
        const reserved = measure();
        expect(reserved.rowHeight).toBeGreaterThan(0);
        if (!outcome.snapshot) {
          // A pending row holds its place invisibly; the connector waits for the name.
          const row = host.querySelector(".chat-reply-attribution--reply")!;
          expect(getComputedStyle(row).visibility, outcome.name).toBe("hidden");
          expect(host.querySelector(".chat-reply-connector"), outcome.name).toBeNull();
        }
        // A sender-only snapshot paints the name before the lookup answers.
        expect(host.querySelector(".chat-reply-attribution__name")?.textContent, outcome.name).toBe(
          outcome.snapshot?.senderLabel,
        );
        const since = performance.now();
        for (const step of outcome.steps.slice(1)) {
          drawLookup(step);
          // Same geometry in the committing frame and the frames after it.
          expect(measure(), outcome.name).toEqual(reserved);
          await frame();
          expect(measure(), outcome.name).toEqual(reserved);
          await frame();
          expect(measure(), outcome.name).toEqual(reserved);
        }
        const row = host.querySelector<HTMLElement>(".chat-reply-attribution--reply")!;
        expect(getComputedStyle(row).visibility, outcome.name).toBe("visible");
        expect(
          row.querySelector(".chat-reply-attribution__label")?.textContent?.trim(),
          outcome.name,
        ).toBe("Replying to");
        expect(
          [
            ...row.querySelectorAll(
              ".chat-reply-attribution__name, .chat-reply-attribution__unavailable",
            ),
          ]
            .map((element) => element.textContent)
            .join(""),
          outcome.name,
        ).toBe(outcome.text);
        if (outcome.steps.at(-1) === missing) {
          expect(row.querySelector(".chat-author-avatar, button, a"), outcome.name).toBeNull();
        }
        if (outcome.steps.at(-1) === foundWithoutText) {
          expect(row.querySelector("button .chat-author-avatar"), outcome.name).not.toBeNull();
        }
        if (layoutShift) {
          shifts.push(...observer.takeRecords());
          const stripShifts = shifts
            .filter((entry) => entry.startTime >= since)
            .filter((entry) =>
              (entry.sources ?? []).some((source) => source.node && host.contains(source.node)),
            )
            .map((entry) => ({ value: entry.value, startTime: entry.startTime }));
          expect(stripShifts, outcome.name).toEqual([]);
        }
      }
    } finally {
      observer.disconnect();
    }
  },
);
