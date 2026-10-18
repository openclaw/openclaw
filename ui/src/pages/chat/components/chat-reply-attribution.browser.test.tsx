import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { resolveTypefaces, syncTypefaceStylesheets } from "../../../app/typography.ts";
import type { MessageGroup as MessageGroupData } from "../../../lib/chat/chat-types.ts";
import type { NativeMessageGroupOptions } from "./chat-message-group-view.tsx";
import { createMessageGroupHarness } from "./chat-message-native.test-support.tsx";
import { createReplyPreviewResolver } from "./chat-reply-preview.ts";
import "../../../styles/base.css";
import "../../../styles/chat/startup-layout.css";
import "../../../styles/chat/message-layout.css";
import "../../../styles/chat/grouped.css";
import "../../../styles/chat/text.css";

let host: HTMLDivElement;
let view: ReturnType<typeof createMessageGroupHarness>;
function drawGroup(group: MessageGroupData, options: NativeMessageGroupOptions, after = false) {
  view.render(group, options);
  if (after && !host.querySelector(".after")) {
    const sibling = document.createElement("div");
    sibling.className = "after";
    sibling.textContent = "Next";
    host.append(sibling);
  }
}

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
  view = createMessageGroupHarness(host);
});

afterEach(async () => {
  view.unmount();
  host.remove();
  await page.viewport(1280, 720);
});

function messageGroup(
  message: MessageGroupData["messages"][number]["message"],
  overrides: Partial<MessageGroupData> = {},
  messageKey = "answer-message",
): MessageGroupData {
  return {
    kind: "group",
    key: "answer",
    role: "assistant",
    timestamp: 0,
    isStreaming: false,
    visibleContent: "text",
    messages: [{ key: messageKey, hasVisibleContent: true, message }],
    ...overrides,
  };
}
const replyOptions = {
  showReasoning: false,
  showToolCalls: false,
  avatarPlacement: "gutter",
} satisfies NativeMessageGroupOptions;
const bounds = (element: Element) => element.getBoundingClientRect();
const select = <T extends Element = HTMLElement>(selector: string, root: ParentNode = host) =>
  root.querySelector<T>(selector)!;
const part = (name: string, root: ParentNode = host) =>
  select(`.chat-reply-attribution__${name}`, root);
const avatarSelector = ":scope > .chat-avatar, :scope > .chat-avatar-slot";
const replyRow = () => select(".chat-reply-attribution--reply");
const replyText = (row: HTMLElement) =>
  [...row.querySelectorAll(".chat-reply-attribution__name, .chat-reply-attribution__unavailable")]
    .map((element) => element.textContent)
    .join("");
function ownReply(missing: boolean) {
  const replyToPreview = missing
    ? undefined
    : {
        senderLabel: "Casey Morgan",
        text: "Please review the release checklist. ".repeat(20),
      };
  return messageGroup(
    {
      role: "user",
      content: missing ? "Follow up on the earlier synthetic answer." : "OK",
      __openclaw: { id: "reply", replyToId: "source", replyToPreview },
    },
    { role: "user", timestamp: 1 },
    "reply",
  );
}
async function viewport(width: number) {
  await page.viewport(width, 800);
  host.style.width = `${width - 32}px`;
}

async function draw(name: string, source = true, onOpenReply = vi.fn()) {
  const sender = { id: "casey", name };
  const group = messageGroup(
    { role: "assistant", content: "OK." },
    {
      replyToSender: { ...sender, identity: { type: "agent", id: "casey" } },
      replyToMessage: {
        key: "prompt",
        message: source
          ? { role: "user", content: "Original question", __openclaw: { id: "prompt" } }
          : null,
      },
    },
  );
  drawGroup(group, {
    ...replyOptions,
    onOpenReply,
    resolveReplyPreview: () => ({
      messageId: "prompt",
      sourceMessageId: "prompt",
      senderLabel: name,
      sender,
      agentAvatar: { avatar: null, textAvatar: "🦀" },
      text: "Original question",
    }),
  });
  await document.fonts.ready;
  const row = replyRow();
  return { row, name: part("name", row) };
}

function expectSingleLine(row: HTMLElement) {
  const box = bounds(row);
  const label = part("label", row);
  const labelBox = bounds(label);
  expect(box.height).toBeGreaterThan(0);
  expect(row.scrollWidth - row.clientWidth).toBeLessThanOrEqual(1);
  expect(box.right).toBeLessThanOrEqual(bounds(host).right + 1);
  for (const text of row.querySelectorAll<HTMLElement>(
    ".chat-reply-attribution__label, .chat-reply-attribution__name, .chat-reply-attribution__unavailable",
  )) {
    const textBox = bounds(text);
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

describe.each([1440, 360])("reply attribution (%d px)", (width) => {
  beforeEach(() => viewport(width));

  it.each(["ltr", "rtl"])("shows the responsive reply cue in %s", async (direction) => {
    host.dir = direction;
    const { row } = await draw("Casey Morgan");
    const group = row.closest(".chat-group")!;
    const icon = part("mobile-icon", row);
    const face = select(".chat-author-avatar .identity-avatar__fallback", row);
    expect([bounds(face).width, bounds(face).height]).toEqual([16, 16]);
    if (width < 768) {
      const avatar = select(avatarSelector, group);
      expect(bounds(avatar).width).toBe(0);
      expect(bounds(select(".chat-reply-connector", group)).width).toBe(0);
      expect(bounds(icon)).toMatchObject({ width: 14, height: 14 });
      const transform = new DOMMatrixReadOnly(getComputedStyle(icon).transform);
      expect(transform.a).toBe(direction === "rtl" ? -1 : 1);
      const groupBounds = bounds(group);
      const rowBounds = bounds(row);
      expect(Math.abs(rowBounds.left - groupBounds.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(rowBounds.right - groupBounds.right)).toBeLessThanOrEqual(1);
      const bubble = select(".chat-bubble", group);
      const content = bounds(select(".chat-text", bubble));
      expect(content.top - bounds(bubble).top).toBeCloseTo(4, 1);
      expect(content.top - rowBounds.bottom).toBeCloseTo(12, 1);
      return;
    }
    expect(bounds(icon).width).toBe(0);
    const speaker = select(avatarSelector, group);
    const text = select(".chat-bubble > .chat-text", group);
    const speakerBounds = bounds(speaker);
    const textBounds = bounds(text);
    const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
    expect(
      Math.abs(speakerBounds.top + speakerBounds.height / 2 - textBounds.top - lineHeight / 2),
    ).toBeLessThanOrEqual(1);
    await expect
      .poll(() => {
        const path = select<SVGPathElement>(".chat-reply-connector path", group);
        const svg = bounds(path.ownerSVGElement!);
        const avatar = bounds(speaker);
        const label = bounds(part("label", row));
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
  });

  it.each([
    { name: "Casey Morgan 👩🏽‍💻", source: true, fits: true },
    { name: "ليلى منصور", source: true, fits: true },
    { name: "Casey Morgan", source: false, fits: true },
    { name: "A very long participant name ".repeat(40), source: true, fits: false },
  ])("keeps the label and name $name on one line", async ({ name, source, fits }) => {
    const result = await draw(name, source);
    expectSingleLine(result.row);
    const label = part("label", result.row);
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
    const button = select<HTMLButtonElement>(".chat-reply-attribution button");
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpenReply).toHaveBeenLastCalledWith("prompt");
  }
  expect(onOpenReply).toHaveBeenCalledTimes(6);
});

it.each([
  [1440, true],
  [1440, false],
  [390, false],
] as const)("own reply at %d px, missing=%s", async (width, missing) => {
  await viewport(width);
  if (missing) {
    host.style.width = "720px";
  }
  const onOpenReply = vi.fn();
  for (const direction of missing ? ["ltr"] : ["ltr", "rtl"]) {
    host.dir = direction;
    drawGroup(ownReply(missing), {
      showReasoning: false,
      onOpenReply,
      resolveReplyPreview: missing ? () => ({ missing: true }) : undefined,
    });
    await document.fonts.ready;
    const row = select(".chat-reply-attribution--inline");
    const target = missing ? part("unavailable", row) : select<HTMLButtonElement>("button", row);
    const box = bounds(target),
      bubble = bounds(row.closest(".chat-bubble")!);
    // The padded hit area may extend past the row, but not its containing bubble.
    expect(box.left).toBeGreaterThanOrEqual(bubble.left);
    expect(box.right).toBeLessThanOrEqual(bubble.right);
    if (missing) {
      expect(target.textContent?.trim()).toBe("Original message unavailable");
      expect(getComputedStyle(target).visibility).toBe("visible");
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
    } else {
      for (const text of [part("name", row), part("label", row)]) {
        expect(text.scrollWidth - text.clientWidth).toBeLessThanOrEqual(1);
      }
      const label = bounds(part("label", row));
      expect(label.right <= box.left || box.right <= label.left).toBe(true);
      target.click();
      expect(onOpenReply).toHaveBeenLastCalledWith("source");
    }
  }
});

it.each([1440, 390])(
  "reserves reply-strip height across all lookup outcomes at %d px",
  async (width) => {
    await viewport(width);
    type Lookup = ReturnType<NonNullable<NativeMessageGroupOptions["resolveReplyPreview"]>>;
    const pending: Lookup = { pending: true };
    const missing: Lookup = { missing: true };
    const found: Lookup = {
      messageId: "older",
      sourceMessageId: "older",
      senderLabel: "Mira",
      sender: { id: "mira", name: "Mira" },
      text: "Checklist",
    };
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
    const outcomes: Array<[string, boolean, Lookup[], string]> = [
      ["found with sender", false, [pending, found], "Mira"],
      ["found without text", false, [pending, foundWithoutText], "Mira"],
      [
        "sender-only snapshot, then missing",
        true,
        [pending, missing],
        "MiraOriginal message unavailable",
      ],
      ["missing without name", false, [pending, missing], "Original message unavailable"],
      ["unconfirmed until a later page", false, [pending, pending, found], "Mira"],
    ];
    const layoutShift = PerformanceObserver.supportedEntryTypes.includes("layout-shift");
    const shifts: Array<PerformanceEntry & { value?: number; sources?: Array<{ node?: Node }> }> =
      [];
    const observer = new PerformanceObserver((list) => shifts.push(...list.getEntries()));
    if (layoutShift) {
      observer.observe({ type: "layout-shift", buffered: true });
    }
    const frame = () => new Promise(requestAnimationFrame);
    try {
      for (const [name, snapshot, steps, text] of outcomes) {
        const group = messageGroup(
          {
            role: "assistant",
            content: "Step 3 moved to Friday.",
            __openclaw: {
              id: "answer",
              replyToId: "older",
              ...(snapshot ? { replyToPreview: { senderLabel: "Mira", text: "" } } : {}),
            },
          },
          { replyShared: true },
        );
        const drawLookup = (lookup: Lookup) =>
          drawGroup(
            group,
            {
              ...replyOptions,
              onOpenReply: vi.fn(),
              resolveReplyPreview: () => lookup,
            },
            true,
          );
        const measure = () => {
          const row = bounds(replyRow());
          return {
            rowTop: row.top,
            rowHeight: row.height,
            text: bounds(select(".chat-bubble .chat-text")).top,
            after: bounds(select(".after")).top,
          };
        };
        view.unmount();
        drawLookup(steps[0]);
        await document.fonts.ready;
        await frame();
        await frame();
        const reserved = measure();
        expect(reserved.rowHeight).toBeGreaterThan(0);
        if (!snapshot) {
          // A pending row holds its place invisibly; the connector waits for the name.
          expect(getComputedStyle(replyRow()).visibility, name).toBe("hidden");
          expect(host.querySelector(".chat-reply-connector"), name).toBeNull();
        }
        // A sender-only snapshot paints the name before the lookup answers.
        expect(part("name")?.textContent, name).toBe(snapshot ? "Mira" : undefined);
        const since = performance.now();
        for (const step of steps.slice(1)) {
          drawLookup(step);
          // Same geometry in the committing frame and the frames after it.
          for (let frameIndex = 0; frameIndex < 3; frameIndex++) {
            if (frameIndex) {
              await frame();
            }
            expect(measure(), name).toEqual(reserved);
          }
        }
        const row = replyRow();
        expect(getComputedStyle(row).visibility, name).toBe("visible");
        expect(part("label", row)?.textContent?.trim(), name).toBe("Replying to");
        expect(replyText(row), name).toBe(text);
        if (steps.at(-1) === missing) {
          expect(row.querySelector(".chat-author-avatar, button, a"), name).toBeNull();
        }
        if (steps.at(-1) === foundWithoutText) {
          expect(row.querySelector("button .chat-author-avatar"), name).not.toBeNull();
        }
        if (layoutShift) {
          shifts.push(...observer.takeRecords());
          const stripShifts = shifts
            .filter((entry) => entry.startTime >= since)
            .filter((entry) =>
              (entry.sources ?? []).some((source) => source.node && host.contains(source.node)),
            )
            .map((entry) => ({ value: entry.value, startTime: entry.startTime }));
          expect(stripShifts, name).toEqual([]);
        }
      }
    } finally {
      observer.disconnect();
    }
  },
);
