import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { en } from "../../../i18n/locales/en.ts";
import { prepareChatMessageRender } from "../../../lib/chat/message-display.ts";
import { managedSource } from "./chat-message-media.test-helpers.ts";
import { createGroupedMessageHarness } from "./chat-message-native.test-support.tsx";
import baseCss from "../../../styles/base.css?inline";
import layoutCss from "../../../styles/chat/layout.css?inline";
import messageCss from "../../../styles/chat/message-layout.css?inline";
import textCss from "../../../styles/chat/text.css?inline";

const views = new Map<HTMLElement, ReturnType<typeof createGroupedMessageHarness>>();
const originalThemeMode = document.documentElement.getAttribute("data-theme-mode");
const originalTextSize = document.documentElement.style.getPropertyValue("--chat-text-size");
const originalCopy = en.chat.pairingQrExpired;
const imageUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR4nGP4z8DwnxLMMGrAsDCAQv2jBgwPAwAxtf4Q24P5oAAAAABJRU5ErkJggg==";
const image = { type: "image", url: imageUrl, width: 320, height: 180 };
const text = (value: string) => ({ type: "text", text: value });
const fileAttachment = (name: string) => ({
  type: "attachment",
  attachment: {
    kind: "document",
    label: `${name}.txt`,
    url: `https://example.com/${name}.txt`,
    mimeType: "text/plain",
  },
});
const file = fileAttachment("report");
const video = {
  type: "video",
  url: new URL("../../../e2e/fixtures/video-poster.mp4", import.meta.url).href,
  fileName: "review.mp4",
  mimeType: "video/mp4",
  width: 320,
  height: 180,
};
const viewports = [
  { theme: "light", width: 1440 },
  { theme: "dark", width: 390 },
];
const all = <T extends Element = HTMLElement>(root: ParentNode, selector: string) =>
  Array.from(root.querySelectorAll<T>(selector));

afterEach(() => {
  for (const [container, view] of views) {
    view.unmount();
    container.remove();
  }
  views.clear();
  vi.unstubAllGlobals();
  document.documentElement.style.setProperty("--chat-text-size", originalTextSize);
  en.chat.pairingQrExpired = originalCopy;
  if (originalThemeMode === null) {
    document.documentElement.removeAttribute("data-theme-mode");
  } else {
    document.documentElement.setAttribute("data-theme-mode", originalThemeMode);
  }
});

function mount(width: number, theme: string) {
  const container = document.body.appendChild(document.createElement("section"));
  container.style.width = `${width}px`;
  const stylesheet = document.createElement("style");
  stylesheet.textContent = baseCss + layoutCss + messageCss + textCss;
  const group = document.createElement("div");
  container.append(stylesheet, group);
  const view = createGroupedMessageHarness(group);
  views.set(container, view);
  document.documentElement.dataset.themeMode = theme;
  return {
    container,
    draw: (content: unknown, isStreaming = false, role = "assistant") => {
      group.className = `chat-group ${role}`;
      view.render(prepareChatMessageRender({ role, content }), "media-spacing", {
        isStreaming,
        showReasoning: false,
      });
    },
  };
}

function blocks(container: HTMLElement) {
  return all(container, ".chat-text > p, .chat-image-frame, .chat-assistant-attachment-card");
}
const rect = (element: Element) => element.getBoundingClientRect();
const expectMargins = (element: Element, marginTop: string) =>
  expect(getComputedStyle(element)).toMatchObject({ marginTop, marginBottom: "0px" });
const geometry = (container: HTMLElement) =>
  blocks(container).map((element) => rect(element).toJSON());
function expectRhythm(container: HTMLElement, count: number) {
  const rendered = blocks(container);
  expect(rendered).toHaveLength(count);
  const paragraph = container.querySelector(".chat-text > p");
  const expected = Number.parseFloat(getComputedStyle(paragraph ?? rendered[0]!).fontSize);
  const rects = rendered.map(rect);
  for (let index = 1; index < rects.length; index += 1) {
    expect(rects[index]!.top - rects[index - 1]!.bottom).toBeCloseTo(expected, 1);
  }
  const bubble = container.querySelector(".chat-bubble")!;
  const bubbleRect = rect(bubble);
  const style = getComputedStyle(bubble);
  const topInset = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.borderTopWidth);
  const bottomInset =
    Number.parseFloat(style.paddingBottom) + Number.parseFloat(style.borderBottomWidth);
  expect(rects[0]!.top - bubbleRect.top).toBeCloseTo(topInset, 1);
  expect(bubbleRect.bottom - rects.at(-1)!.bottom).toBeCloseTo(bottomInset, 1);
}

async function expectReadyRhythm(container: HTMLElement, count: number) {
  await vi.dynamicImportSettled();
  await vi.waitFor(() => expectRhythm(container, count));
}

it.each(viewports)(
  "matches paragraph rhythm through streaming in $theme at $width px",
  async ({ theme, width }) => {
    const { container, draw } = mount(width, theme);
    const content = [
      image,
      text("First paragraph.\n\nReference paragraph."),
      image,
      image,
      text("Image caption."),
      video,
      text("Video caption."),
      file,
      text("File caption."),
      image,
    ];
    draw(content, true);
    await expectReadyRhythm(container, 11);
    const images = all<HTMLImageElement>(container, "img.chat-message-image");
    // The last lazy image can be below Chromium's loading margin.
    for (const element of images) {
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      await element.decode();
    }
    expectRhythm(container, 11);
    for (const isStreaming of [true, false]) {
      draw([...content, text("\n\nStreaming continues.")], isStreaming);
      expectRhythm(container, 12);
      const updated = all(container, "img.chat-message-image");
      expect(updated).toHaveLength(images.length);
      images.forEach((retainedImage, index) => expect(updated[index]).toBe(retainedImage));
    }
  },
);

it("keeps attachment-only edges flush", async () => {
  const { container, draw } = mount(390, "light");
  for (const role of ["assistant", "user"]) {
    draw([file, fileAttachment("second")], false, role);
    await expectReadyRhythm(container, 2);
  }
  draw([image, { ...image, url: `${imageUrl}#second` }]);
  await expectReadyRhythm(container, 2);
});

it("reserves the image and both gaps while a streamed image loads", async () => {
  const imageBlob = await (await fetch(imageUrl)).blob();
  const response = createDeferred<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => response.promise),
  );
  const { container, draw } = mount(390, "dark");
  draw(
    [text("Before the image."), { ...image, url: managedSource() }, text("After the image.")],
    true,
  );
  await expectReadyRhythm(container, 3);
  const before = geometry(container);
  response.resolve(new Response(imageBlob));
  await vi.waitFor(() => expect(container.querySelector("img")).not.toBeNull());
  await container.querySelector("img")!.decode();
  expectRhythm(container, 3);
  expect(geometry(container)).toEqual(before);
});

it.each(["assistant", "user"])("separates all heading levels in %s messages", (role) => {
  const { container, draw } = mount(390, "light");
  for (const textSize of [14, 20]) {
    document.documentElement.style.setProperty("--chat-text-size", `${textSize}px`);
    for (const level of [1, 2, 3, 4]) {
      const heading = "#".repeat(level);
      const markdown = `${heading} First\n\nFirst paragraph.\n\nSecond paragraph.\n\n${heading} Section\n\nFollowing paragraph.\n\n- Item\n\n> Quote\n\n\`\`\`text\nCode\n\`\`\``;
      draw(markdown, false, role);
      const root = container.querySelector(".chat-text")!;
      const headings = root.querySelectorAll(`h${level}`);
      expect(headings).toHaveLength(2);
      expectMargins(headings[0]!, "0px");
      expectMargins(headings[1]!, `${textSize * 1.5}px`);
      const previous = headings[1]!.previousElementSibling!;
      expect(
        Math.abs(rect(headings[1]!).top - rect(previous).bottom - textSize * 1.5),
      ).toBeLessThanOrEqual(0.5);
      for (const block of root.querySelectorAll(
        ":scope > p, :scope > ul, :scope > blockquote, :scope > .code-block-wrapper",
      )) {
        expectMargins(block, `${textSize}px`);
      }
    }
  }
});

it.each([
  { width: 768, direction: "ltr", scale: 1, long: false },
  { width: 280, direction: "ltr", scale: 1.5, long: true },
  { width: 280, direction: "rtl", scale: 1.5, long: true },
])(
  "keeps readable insets at $width px, $direction, scale $scale",
  ({ width, direction, scale, long }) => {
    if (long) {
      en.chat.pairingQrExpired = {
        title: "A deliberately long pairing invitation title that wraps across several lines",
        badge: "Expired setup invitation",
        reason:
          "Generate a fresh setup code for VeryLongUnbrokenDeviceIdentifierThatMustNotClipAtTheCardEdge.",
      };
    }
    const { container, draw } = mount(width, "light");
    container.dir = direction;
    container.style.setProperty("--control-ui-text-scale", String(scale));
    draw(Array.from({ length: 2 }, () => ({ type: "openclaw_pairing_qr", expiresAtMs: 1 })));
    const cards = all(container, ".chat-pairing-qr-expired");
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      const box = rect(card);
      const reason = card.querySelector<HTMLElement>(".chat-assistant-attachment-card__reason")!;
      const title = card.querySelector<HTMLElement>(".chat-pairing-qr-expired__title")!;
      const badge = card.querySelector(".chat-pairing-qr-expired__badge")!;
      const icon = rect(card.querySelector("svg")!);
      expect(box.bottom - rect(reason).bottom).toBeGreaterThanOrEqual(14);
      const edge = direction === "rtl" ? "right" : "left";
      expect(rect(title)[edge]).toBeCloseTo(rect(reason)[edge], 1);
      expect(icon.width).toBeGreaterThanOrEqual(16);
      expect(icon.height).toBeGreaterThanOrEqual(16);
      expect(getComputedStyle(badge)).toMatchObject({
        borderWidth: "0px",
        backgroundColor: "rgba(0, 0, 0, 0)",
        padding: "0px",
      });
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
      expect(reason.scrollWidth).toBeLessThanOrEqual(reason.clientWidth);
      expect(Number.parseFloat(getComputedStyle(title).fontSize)).toBeCloseTo(13 * scale);
    }
    expect(rect(cards[1]!).top - rect(cards[0]!).bottom).toBeGreaterThanOrEqual(8);
  },
);
