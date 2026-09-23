import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";
import baseCss from "../../../styles/base.css?inline";
import layoutCss from "../../../styles/chat/layout.css?inline";
import messageCss from "../../../styles/chat/message-layout.css?inline";
import textCss from "../../../styles/chat/text.css?inline";

const containers: HTMLElement[] = [];
const originalThemeMode = document.documentElement.getAttribute("data-theme-mode");
const imageUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR4nGP4z8DwnxLMMGrAsDCAQv2jBgwPAwAxtf4Q24P5oAAAAABJRU5ErkJggg==";
const image = { type: "image", url: imageUrl, width: 320, height: 180 };
const text = (value: string) => ({ type: "text", text: value });
const file = {
  type: "attachment",
  attachment: {
    kind: "document",
    label: "report.txt",
    url: "https://example.com/report.txt",
    mimeType: "text/plain",
  },
};
const video = {
  type: "video",
  url: new URL("../../../e2e/fixtures/video-poster.mp4", import.meta.url).href,
  fileName: "review.mp4",
  mimeType: "video/mp4",
  width: 320,
  height: 180,
};

afterEach(() => {
  for (const container of containers.splice(0)) {
    render(nothing, container);
    container.remove();
  }
  vi.unstubAllGlobals();
  if (originalThemeMode === null) {
    document.documentElement.removeAttribute("data-theme-mode");
  } else {
    document.documentElement.setAttribute("data-theme-mode", originalThemeMode);
  }
});

function mount(width: number, theme: string) {
  const container = document.body.appendChild(document.createElement("section"));
  container.style.width = `${width}px`;
  containers.push(container);
  document.documentElement.dataset.themeMode = theme;
  return {
    container,
    draw: (content: unknown[], isStreaming = false, role = "assistant") => {
      render(
        html`<style>
            ${baseCss}${layoutCss}${messageCss}${textCss}
          </style>
          <div class="chat-group ${role}">
            ${renderGroupedMessage(prepareChatMessageRender({ role, content }), "media-spacing", {
              isStreaming,
              showReasoning: false,
            })}
          </div>`,
        container,
      );
    },
  };
}

function blocks(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      ".chat-text > p, .chat-image-frame, .chat-assistant-attachment-card",
    ),
  );
}

function expectRhythm(container: HTMLElement, count: number) {
  const rendered = blocks(container);
  expect(rendered).toHaveLength(count);
  const paragraph = container.querySelector(".chat-text > p");
  // --chat-block-gap tracks the transcript font size.
  const expected = Number.parseFloat(getComputedStyle(paragraph ?? rendered[0]!).fontSize);
  const rects = rendered.map((element) => element.getBoundingClientRect());
  for (let index = 1; index < rects.length; index += 1) {
    expect(rects[index]!.top - rects[index - 1]!.bottom).toBeCloseTo(expected, 1);
  }
  const bubble = container.querySelector(".chat-bubble")!;
  const bubbleRect = bubble.getBoundingClientRect();
  const style = getComputedStyle(bubble);
  const topInset = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.borderTopWidth);
  const bottomInset =
    Number.parseFloat(style.paddingBottom) + Number.parseFloat(style.borderBottomWidth);
  expect(rects[0]!.top - bubbleRect.top).toBeCloseTo(topInset, 1);
  expect(bubbleRect.bottom - rects.at(-1)!.bottom).toBeCloseTo(bottomInset, 1);
}

describe("transcript media block spacing", () => {
  it.each(
    ["light", "dark"].flatMap((theme) =>
      [1440, 390].flatMap((width) =>
        [false, true].map((streaming) => ({ theme, width, streaming })),
      ),
    ),
  )(
    "matches paragraph rhythm in $theme at $width px (streaming: $streaming)",
    async ({ theme, width, streaming }) => {
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
      draw(content, streaming);
      await vi.waitFor(() => expectRhythm(container, 11));
      const images = Array.from(
        container.querySelectorAll<HTMLImageElement>("img.chat-message-image"),
      );
      await Promise.all(images.map((element) => element.decode()));
      expectRhythm(container, 11);
      if (streaming) {
        for (const isStreaming of [true, false]) {
          draw([...content, text("\n\nStreaming continues.")], isStreaming);
          expectRhythm(container, 12);
          const updatedImages = Array.from(container.querySelectorAll("img.chat-message-image"));
          expect(updatedImages).toHaveLength(images.length);
          for (const [index, retainedImage] of images.entries()) {
            expect(updatedImages[index]).toBe(retainedImage);
          }
        }
      }
    },
  );

  it.each(["light", "dark"])("keeps attachment-only edges flush in %s", async (theme) => {
    const { container, draw } = mount(390, theme);
    for (const role of ["assistant", "user"]) {
      draw(
        [
          file,
          {
            ...file,
            attachment: {
              ...file.attachment,
              url: "https://example.com/second.txt",
              label: "second.txt",
            },
          },
        ],
        false,
        role,
      );
      await vi.waitFor(() => expectRhythm(container, 2));
    }
    draw([image, { ...image, url: `${imageUrl}#second` }]);
    expectRhythm(container, 2);
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
      [
        text("Before the image."),
        {
          ...image,
          url: `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`,
        },
        text("After the image."),
      ],
      true,
    );
    expectRhythm(container, 3);
    const before = blocks(container).map((element) => element.getBoundingClientRect().toJSON());
    response.resolve(new Response(imageBlob));
    await vi.waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    await container.querySelector("img")!.decode();
    expectRhythm(container, 3);
    expect(blocks(container).map((element) => element.getBoundingClientRect().toJSON())).toEqual(
      before,
    );
  });
});
