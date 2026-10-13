import { nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { renderComposerQuestionDock } from "./chat-composer-question.tsx";
import { questionPanelIn } from "./chat-question-card.test-support.ts";
import type { QuestionPanelProps } from "./chat-question-card.ts";
import baseStyles from "../../../styles/base.css?inline";
import questionStyles from "../../../styles/chat/question-card.css?inline";
import componentStyles from "../../../styles/components.css?inline";

let container: HTMLDivElement;
let styles: HTMLStyleElement;

beforeEach(() => {
  styles = document.createElement("style");
  styles.textContent = baseStyles + componentStyles + questionStyles;
  document.head.append(styles);
  container = document.body.appendChild(document.createElement("div"));
});

afterEach(() => {
  render(nothing, container);
  container.remove();
  styles.remove();
});

it.each([320, 400, 440, 480])(
  "keeps rich-form thumbnails beside readable option copy at %d px",
  async (width) => {
    await page.viewport(width, 800);
    const thumbnail = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="8" y="8" width="48" height="48" rx="12" fill="steelblue"/><circle cx="32" cy="32" r="12" fill="white"/></svg>')}`;
    const props: QuestionPanelProps = {
      model: {
        requestKey: "rich-form-layout",
        title: "Configure a demo order",
        questions: [
          {
            questionId: "part",
            header: "Part",
            question: "Choose a part",
            presentation: "form",
            options: [
              {
                label: "Mounting bracket",
                description: "Anodized aluminum for a compact printer assembly.",
                thumbnail,
              },
              {
                label: "Precision spacer with a long descriptive label",
                description: "Stainless steel; available in several lengths.",
                thumbnail,
              },
              { label: "Washer", description: "No preview is available for this part." },
            ],
          },
        ],
        collapsed: false,
        autoFocus: false,
        disabled: false,
        drafts: new Map(),
      },
      onSubmit: vi.fn(),
    };
    render(renderComposerQuestionDock(props), container);
    await questionPanelIn(container);
    await document.fonts.ready;
    for (const option of container.querySelectorAll<HTMLElement>('[role="radio"]')) {
      const tile = option
        .querySelector<HTMLElement>(".chat-question-panel__thumbnail")!
        .getBoundingClientRect();
      const copy = option.querySelector<HTMLElement>(".chat-question-panel__option-copy")!;
      const copyBounds = copy.getBoundingClientRect();
      expect(tile.width).toBe(64);
      expect(copyBounds.left).toBeGreaterThanOrEqual(tile.right);
      expect(copyBounds.top).toBeLessThan(tile.bottom);
      expect(copyBounds.width).toBeGreaterThan(100);
      const shortcut = option.querySelector<HTMLElement>("kbd")!.getBoundingClientRect();
      expect(shortcut.left).toBeGreaterThanOrEqual(copyBounds.right);
      expect(shortcut.top).toBeLessThan(tile.bottom);
      expect(copy.scrollWidth).toBeLessThanOrEqual(copy.clientWidth);
      expect(option.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    }
  },
);
