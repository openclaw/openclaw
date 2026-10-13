import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";
import baseCss from "../../../styles/base.css?inline";
import layoutCss from "../../../styles/chat/layout.css?inline";
import messageCss from "../../../styles/chat/message-layout.css?inline";
import textCss from "../../../styles/chat/text.css?inline";

const container = document.createElement("section");
const originalTheme = document.documentElement.getAttribute("data-theme-mode");
const originalTextSize = document.documentElement.style.getPropertyValue("--chat-text-size");

afterEach(() => {
  render(nothing, container);
  container.remove();
  document.documentElement.style.setProperty("--chat-text-size", originalTextSize);
  if (originalTheme === null) {
    document.documentElement.removeAttribute("data-theme-mode");
  } else {
    document.documentElement.setAttribute("data-theme-mode", originalTheme);
  }
});

describe("chat Markdown heading spacing", () => {
  it.each(
    ["light", "dark"].flatMap((theme) =>
      [1440, 390].flatMap((width) => ["assistant", "user"].map((role) => ({ theme, width, role }))),
    ),
  )(
    "separates all heading levels in $role messages ($theme, $width px)",
    ({ theme, width, role }) => {
      document.body.append(container);
      container.style.width = `${width}px`;
      document.documentElement.dataset.themeMode = theme;
      for (const textSize of [14, 20]) {
        document.documentElement.style.setProperty("--chat-text-size", `${textSize}px`);
        for (const level of [1, 2, 3, 4]) {
          const heading = "#".repeat(level);
          const markdown = [
            `${heading} First heading`,
            "First paragraph.",
            "Second paragraph.",
            `${heading} Section heading`,
            "Following paragraph.",
            "- First item\n- Second item",
            "> Quoted paragraph.",
            "```text\nSample code\n```",
          ].join("\n\n");
          render(
            html`<style>
                ${baseCss}${layoutCss}${messageCss}${textCss}
              </style>
              <div class="chat-group ${role}">
                ${renderGroupedMessage(
                  prepareChatMessageRender({ role, content: markdown }),
                  `heading-${level}`,
                  { isStreaming: false, showReasoning: false },
                )}
              </div>`,
            container,
          );
          const root = container.querySelector(".chat-text")!;
          const headings = root.querySelectorAll(`h${level}`);
          expect(headings).toHaveLength(2);
          const first = getComputedStyle(headings[0]!);
          const section = getComputedStyle(headings[1]!);
          const paragraph = root.querySelector("p + p")!;
          const paragraphGap = Number.parseFloat(getComputedStyle(paragraph).marginTop);
          expect(paragraphGap).toBe(textSize);
          expect(first.marginTop).toBe("0px");
          expect(first.marginBottom).toBe("0px");
          expect(section.marginBottom).toBe("0px");
          expect(
            Math.abs(Number.parseFloat(section.marginTop) - paragraphGap * 1.5),
          ).toBeLessThanOrEqual(0.5);
          const previous = headings[1]!.previousElementSibling!;
          expect(
            Math.abs(
              headings[1]!.getBoundingClientRect().top -
                previous.getBoundingClientRect().bottom -
                paragraphGap * 1.5,
            ),
          ).toBeLessThanOrEqual(0.5);
          for (const block of root.querySelectorAll(
            ":scope > p, :scope > ul, :scope > blockquote, :scope > .code-block-wrapper",
          )) {
            expect(getComputedStyle(block).marginTop).toBe(`${textSize}px`);
            expect(getComputedStyle(block).marginBottom).toBe("0px");
          }
        }
      }
    },
  );
});
