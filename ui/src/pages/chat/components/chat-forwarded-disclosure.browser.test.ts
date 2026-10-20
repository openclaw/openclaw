import { afterEach, beforeEach, expect, it } from "vitest";
import { resolveTypefaces, syncTypefaceStylesheets } from "../../../app/typography.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { createMessageGroupHarness } from "./chat-message-native.test-support.tsx";
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
let root: ReturnType<typeof createMessageGroupHarness>;
let avatarUrl: string | undefined;
const query = <T extends HTMLElement = HTMLElement>(selector: string, parent: ParentNode = host) =>
  parent.querySelector<T>(selector)!;
const contentOf = (parent: ParentNode = host) => query(".chat-message-disclosure__content", parent);
const toggleOf = (parent: ParentNode = host) =>
  query<HTMLButtonElement>(".chat-message-disclosure__toggle", parent);
const message = (content: string, key: string, role = "assistant") => ({
  key,
  hasVisibleContent: true,
  message: { role, content },
});
afterEach(async () => {
  if (host) {
    root.unmount();
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
  root = createMessageGroupHarness(host);
  const group: MessageGroup = {
    kind: "group",
    role,
    isStreaming: false,
    visibleContent: "text",
    key: "forwarded",
    timestamp: 0,
    senderSession: { sessionKey: "agent:research:main" },
    messages: [longText, longText, "First line.\nSecond line.", "One.\nTwo.\nThree."].map(
      (content, i) => message(content, `message-${i}`, role),
    ),
  };
  const expanded = new Set<string>();
  const draw = () =>
    root.render(group, {
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
    });
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
    const content = contentOf(bubbles[0]!);
    const toggle = toggleOf(bubbles[0]!);
    await expect.poll(() => toggle.hidden).toBe(false);
    const lineHeight = Number.parseFloat(getComputedStyle(query(".chat-text", content)).lineHeight);
    expect(Math.abs(content.getBoundingClientRect().height - lineHeight * 2.5)).toBeLessThanOrEqual(
      1,
    );
    expect(getComputedStyle(content).maskImage).not.toBe("none");
    expect(content.textContent?.trim()).toBe(longText);
    const box = bubbles[0]!.getBoundingClientRect();
    const button = toggle.getBoundingClientRect();
    const above = button.top - content.getBoundingClientRect().bottom;
    const below =
      box.bottom -
      Number.parseFloat(getComputedStyle(bubbles[0]!).borderBottomWidth) -
      button.bottom;
    expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
    for (const bubble of [bubbles[2]!, bubbles[3]!]) {
      const shortToggle = toggleOf(bubble);
      await expect.poll(() => !shortToggle || shortToggle.hidden).toBe(true);
      const short = contentOf(bubble);
      expect(getComputedStyle(short).maskImage).toBe("none");
      expect(short.scrollHeight - short.clientHeight).toBeLessThanOrEqual(1);
    }
    const link = query<HTMLAnchorElement>(".chat-reply-attribution a");
    expect(getComputedStyle(link)).toMatchObject({
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderTopWidth: "0px",
    });
    const label = query(".session-label", link);
    expect(label.textContent).toBe("research");
    expect(getComputedStyle(label, "::first-letter").textTransform).toBe("uppercase");
    toggle.click();
    await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
    expect(getComputedStyle(content).maskImage).toBe("none");
    expect(content.scrollHeight - content.clientHeight).toBeLessThanOrEqual(1);
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

it("rechecks retained content when the transcript width or message text changes", async () => {
  const { group, draw } = fixture("assistant", 1000);
  group.messages = [
    message(
      "A scheduled update preserves the full instruction text while keeping the conversation readable. ".repeat(
        3,
      ),
      "wrapped",
    ),
  ];
  draw();
  const toggle = toggleOf();
  const content = contentOf();
  await expect.poll(() => toggle.hidden).toBe(true);
  expect(getComputedStyle(content).maskImage).toBe("none");
  host.style.width = "240px";
  await expect.poll(() => toggle.hidden).toBe(false);
  expect(getComputedStyle(content).maskImage).not.toBe("none");
  host.style.width = "1000px";
  await expect.poll(() => toggle.hidden).toBe(true);
  expect(content.scrollHeight - content.clientHeight).toBeLessThanOrEqual(1);
  group.messages[0]!.message = { role: "assistant", content: longText };
  draw();
  expect(contentOf()).toBe(content);
  await expect.poll(() => toggle.hidden).toBe(false);
});

it.each([
  { loaded: true, width: 1440 },
  { loaded: false, width: 390 },
])(
  "shows one inline agent avatar with image loaded=$loaded at $width",
  async ({ loaded, width }) => {
    const { page } = await import("vitest/browser");
    await page.viewport(width, 800);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"/>';
    avatarUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    if (!loaded) {
      URL.revokeObjectURL(avatarUrl);
    }
    fixture("assistant", width, new Map([["research", avatarUrl]]));
    const slot = query(".chat-reply-attribution__agent-avatar .chat-avatar-slot");
    await expect.poll(() => slot.dataset.avatarState).toBe(loaded ? "loaded" : "failed");
    const image = query<HTMLImageElement>("img", slot);
    const fallback = query(":scope > .identity-avatar--agent", slot);
    await expect.poll(() => fallback.querySelector("svg") !== null).toBe(true);
    expect(image.getBoundingClientRect().height).toBe(loaded ? 18 : 0);
    expect(fallback.getBoundingClientRect().height).toBe(loaded ? 0 : 18);
    expect(slot.scrollHeight).toBe(18);
  },
);
