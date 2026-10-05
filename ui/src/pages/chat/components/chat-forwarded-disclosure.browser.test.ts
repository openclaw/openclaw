import { render } from "lit";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resolveTypefaces, syncTypefaceStylesheets } from "../../../app/typography.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import baseCss from "../../../styles/base.css?inline";
import groupedCss from "../../../styles/chat/grouped.css?inline";
import messageCss from "../../../styles/chat/message-layout.css?inline";
import startupCss from "../../../styles/chat/startup-layout.css?inline";
import textCss from "../../../styles/chat/text.css?inline";
import mobileCss from "../../../styles/layout.mobile.css?inline";

let stylesheet: HTMLStyleElement;

// Match the app's default font before measuring the disclosure's inline baseline.
beforeEach(async () => {
  stylesheet = document.createElement("style");
  stylesheet.textContent = [baseCss, mobileCss, startupCss, messageCss, textCss, groupedCss].join(
    "\n",
  );
  document.head.append(stylesheet);
  const typefaces = resolveTypefaces("claw");
  syncTypefaceStylesheets(typefaces);
  await expect
    .poll(() =>
      Boolean(document.querySelector<HTMLLinkElement>(`#openclaw-typeface-${typefaces.ui}`)?.sheet),
    )
    .toBe(true);
});

let host: HTMLDivElement;
let avatarUrl: string | undefined;
afterEach(async () => {
  if (host) {
    render(null, host);
    host.remove();
  }
  if (avatarUrl) {
    URL.revokeObjectURL(avatarUrl);
    avatarUrl = undefined;
  }
  stylesheet.remove();
  const { page } = await import("vitest/browser");
  await page.viewport(1280, 720);
  document.documentElement.removeAttribute("data-theme-mode");
});

const longText = Array.from({ length: 24 }, (_, i) => `Instruction ${i + 1}.`).join("\n");
function fixture(
  role: string,
  width: number,
  senderAgentAvatars?: ReadonlyMap<string, string | null>,
) {
  host = document.createElement("div");
  host.className = "chat-thread";
  host.style.width = `${width}px`;
  document.body.append(host);
  const group: MessageGroup = {
    kind: "group",
    key: "forwarded",
    role,
    timestamp: 0,
    visibleContent: "text",
    senderSession: { sessionKey: "agent:research:main" },
    isStreaming: false,
    messages: [longText, longText, "First line.\nSecond line.", "One.\nTwo.\nThree."].map(
      (content, i) => ({
        key: `message-${i}`,
        hasVisibleContent: true,
        message: { role, content },
      }),
    ),
  };
  const expanded = new Set<string>();
  const draw = () =>
    render(
      renderMessageGroup(group, {
        agentId: "main",
        mainKey: "main",
        senderAgentAvatars,
        agents: [{ id: "research", identity: { name: "research" } }],
        showReasoning: true,
        showToolCalls: true,
        avatarPlacement: "none",
        isUserMessageExpanded: (id) => expanded.has(id),
        onToggleUserMessageExpanded: (id) => {
          if (expanded.has(id)) {
            expanded.delete(id);
          } else {
            expanded.add(id);
          }
          draw();
        },
      }),
      host,
    );
  draw();
  return { group, draw };
}

it.each([
  { role: "user", theme: "light", width: 1440 },
  { role: "user", theme: "dark", width: 390 },
  { role: "assistant", theme: "dark", width: 1440 },
  { role: "assistant", theme: "light", width: 390 },
])(
  "collapses forwarded $role messages independently in $theme at $width",
  async ({ role, theme, width }) => {
    const { page } = await import("vitest/browser");
    await page.viewport(width, 800);
    document.documentElement.dataset.themeMode = theme;
    const { draw } = fixture(role, width);
    await document.fonts.ready;
    const bubbles = host.querySelectorAll<HTMLElement>(".chat-bubble");
    const content = bubbles[0]!.querySelector<HTMLElement>(".chat-message-disclosure__content");
    expect(content).not.toBeNull();
    const toggle = bubbles[0]!.querySelector<HTMLButtonElement>(
      ".chat-message-disclosure__toggle",
    )!;
    await expect.poll(() => toggle.hidden).toBe(false);
    expect(getComputedStyle(content!).maskImage).toBe("none");
    expect(content!.scrollHeight - content!.clientHeight).toBeLessThanOrEqual(1);
    expect(content!.textContent?.trim()).toBe("Instruction 1.\nInstruction 2.\nInstruction 3.");
    const box = bubbles[0]!.getBoundingClientRect();
    const button = toggle.getBoundingClientRect();
    const above = button.top - content!.getBoundingClientRect().bottom;
    const below =
      box.bottom -
      Number.parseFloat(getComputedStyle(bubbles[0]!).borderBottomWidth) -
      button.bottom;
    expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
    for (const bubble of [bubbles[2]!, bubbles[3]!]) {
      const shortToggle = bubble.querySelector<HTMLButtonElement>(
        ".chat-message-disclosure__toggle",
      );
      await expect.poll(() => !shortToggle || shortToggle.hidden).toBe(true);
      const short = bubble.querySelector<HTMLElement>(".chat-text")!;
      expect(getComputedStyle(short).maskImage).toBe("none");
      expect(short.scrollHeight - short.clientHeight).toBeLessThanOrEqual(1);
    }
    const link = host.querySelector<HTMLAnchorElement>(".chat-reply-attribution a")!;
    expect(link).not.toBeNull();
    expect(getComputedStyle(link).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(link).borderTopWidth).toBe("0px");
    const label = link.querySelector<HTMLElement>(".session-label")!;
    expect(label.textContent).toBe("research");
    expect(getComputedStyle(label, "::first-letter").textTransform).toBe("uppercase");
    toggle.click();
    await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
    expect(getComputedStyle(content!).maskImage).toBe("none");
    expect(content!.scrollHeight - content!.clientHeight).toBeLessThanOrEqual(1);
    expect(content!.textContent?.trim()).toBe(longText);
    expect(bubbles[1]!.querySelector("button[aria-expanded='false']")).not.toBeNull();
    draw();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  },
);

it("keeps a forwarded stream open until final while collapsing prior messages", async () => {
  const { group, draw } = fixture("assistant", 700);
  group.messages = group.messages.slice(0, 2);
  group.isStreaming = true;
  draw();
  const bubbles = host.querySelectorAll(".chat-bubble");
  expect(bubbles[0]!.querySelector(".chat-message-disclosure")).not.toBeNull();
  expect(bubbles[1]!.querySelector(".chat-message-disclosure")).toBeNull();
  group.isStreaming = false;
  draw();
  await expect
    .poll(() => bubbles[1]!.querySelector("button[aria-expanded='false']") !== null)
    .toBe(true);
});

it("reflows the same complete sentences when the transcript width changes", async () => {
  const { group, draw } = fixture("assistant", 1000);
  const sentence = "A scheduled update keeps the complete instruction available. ";
  group.messages = [
    {
      key: "wrapped",
      hasVisibleContent: true,
      message: { role: "assistant", content: sentence.repeat(10) },
    },
  ];
  draw();
  const content = host.querySelector<HTMLElement>(".chat-message-disclosure__content")!;
  const preview = content.textContent;
  const desktopHeight = content.clientHeight;
  host.style.width = "240px";
  expect(content.clientHeight).toBeGreaterThan(desktopHeight);
  expect(content.textContent).toBe(preview);
  expect(getComputedStyle(content).maskImage).toBe("none");
  expect(content.scrollHeight - content.clientHeight).toBeLessThanOrEqual(1);
  host.style.width = "1000px";
  expect(content.clientHeight).toBe(desktopHeight);
});

it.each([
  { loaded: true, width: 1440 },
  { loaded: false, width: 390 },
])(
  "shows one inline agent avatar with image loaded=$loaded at $width",
  async ({ loaded, width }) => {
    const { page } = await import("vitest/browser");
    await page.viewport(width, 800);
    avatarUrl = URL.createObjectURL(
      new Blob(
        [
          '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><rect width="18" height="18" fill="blue"/></svg>',
        ],
        { type: "image/svg+xml" },
      ),
    );
    if (!loaded) {
      URL.revokeObjectURL(avatarUrl);
    }
    fixture("assistant", width, new Map([["research", avatarUrl]]));
    const slot = host.querySelector<HTMLElement>(
      ".chat-reply-attribution__agent-avatar .chat-avatar-slot",
    )!;
    await expect.poll(() => slot.dataset.avatarState).toBe(loaded ? "loaded" : "failed");
    const image = slot.querySelector<HTMLImageElement>("img")!;
    const fallback = slot.querySelector<HTMLElement>(":scope > .identity-avatar--agent")!;
    await expect.poll(() => fallback.querySelector("svg") !== null).toBe(true);
    expect(image.getBoundingClientRect().height).toBe(loaded ? 18 : 0);
    expect(fallback.getBoundingClientRect().height).toBe(loaded ? 0 : 18);
    expect(slot.scrollHeight).toBe(18);
  },
);

it.each([390, 1280])(
  "keeps complete glyph rows and full Markdown accessible at %i px",
  async (width) => {
    const { page } = await import("vitest/browser");
    await page.viewport(width, 800);
    const { group, draw } = fixture("assistant", width);
    const tail = "Supporting details remain in the full report. ".repeat(18);
    const cases = [
      "A **complete** sentence with [the review](https://example.com/review). " + tail,
      "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\n" + tail,
      "- First item.\n- Second item.\n- Third item.\n- " + tail,
      "~~~ts\nconst first = 1;\nconst second = 2;\nconst third = 3;\nconst fourth = 4;\n~~~",
      "https://example.com/" + "longpath".repeat(120),
      "unpunctuated words ".repeat(80),
    ];
    group.messages = cases.map((content, index) => ({
      key: "case-" + index,
      hasVisibleContent: true,
      message: { role: "assistant", content },
    }));
    draw();
    await document.fonts.ready;
    const contents = host.querySelectorAll<HTMLElement>(".chat-message-disclosure__content");
    expect(contents).toHaveLength(cases.length);
    for (const content of contents) {
      const style = getComputedStyle(content);
      expect(style.maskImage).toBe("none");
      expect(style.maxHeight).toBe("none");
      // List-marker ink can extend past the line box; it must remain visible.
      expect(style.overflowY).toBe("visible");
      const bottom = content.getBoundingClientRect().bottom;
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim() || !node.parentElement?.checkVisibility()) {
          continue;
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          expect(rect.bottom, "all preview glyphs fit, including descenders").toBeLessThanOrEqual(
            bottom + 1,
          );
        }
      }
    }
    expect(contents[0]!.querySelector("strong")?.textContent).toBe("complete");
    expect(contents[0]!.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/review",
    );
    expect(contents[1]!.querySelectorAll("p")).toHaveLength(3);
    expect(contents[2]!.querySelectorAll("li")).toHaveLength(3);
    expect(contents[3]!.querySelector("pre code")).not.toBeNull();
    expect(contents[3]!.querySelector("button")).toBeNull();
    const codeToggle = contents[3]!.parentElement!.querySelector<HTMLButtonElement>(
      ".chat-message-disclosure__toggle",
    )!;
    codeToggle.focus();
    const { userEvent } = await import("vitest/browser");
    await userEvent.keyboard("{Enter}");
    expect(codeToggle.getAttribute("aria-expanded")).toBe("true");
    expect(contents[3]!.querySelector(".code-block-copy")).not.toBeNull();
    expect(contents[3]!.textContent).toContain("const fourth = 4;");
    codeToggle.click();
    expect(codeToggle.getAttribute("aria-expanded")).toBe("false");
    expect(contents[3]!.textContent).not.toContain("fourth");
  },
);

it("keeps blank code rows and positioned media behind Show more", async () => {
  const { group, draw } = fixture("assistant", 700);
  group.messages = [
    {
      key: "blank-code",
      hasVisibleContent: true,
      message: { role: "assistant", content: "~~~\n" + "\n".repeat(100) + "final row\n~~~" },
    },
    {
      key: "media",
      hasVisibleContent: true,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Chart context." },
          {
            type: "image",
            url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='600'%3E%3Crect width='64' height='600' fill='teal'/%3E%3C/svg%3E",
          },
        ],
      },
    },
  ];
  draw();
  const contents = host.querySelectorAll<HTMLElement>(".chat-message-disclosure__content");
  expect(contents).toHaveLength(2);
  expect(contents[0]!.clientHeight).toBeLessThan(120);
  expect(contents[1]!.textContent).toContain("Chart context.");
  expect(contents[1]!.textContent).not.toContain("OPENCLAWMEDIASLOT");
  expect(contents[1]!.querySelector("img")).toBeNull();
  const toggle = contents[1]!.parentElement!.querySelector<HTMLButtonElement>(
    ".chat-message-disclosure__toggle",
  )!;
  toggle.click();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(contents[1]!.querySelector("img")).not.toBeNull();
});
