import { expect, it } from "vitest";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("composer-layering-", { ignoreCloseErrors: true });

const css = readStyles("styles/chat/split-view", "styles/chat/composer-surface");
const markup = `<openclaw-chat-pane class="chat-pane-cache__pane chat-pane-cache__pane--visible">
  <div class="chat-footer">
    <div class="agent-chat__composer-shell">
      <div class="agent-chat__input"><textarea aria-label="Message"></textarea></div>
    </div>
  </div>
</openclaw-chat-pane>`;

fixture.describe("Control UI composer layering", () => {
  it.each(["light", "dark"])(
    "keeps the composer above the visible chat pane in %s mode",
    async (mode) => {
      const actual = await fixture.withPage(
        mode,
        styleDocument(css, markup, `data-theme-mode="${mode}"`),
        (page) =>
          page.evaluate(() => ({
            pane: Number(getComputedStyle(document.querySelector("openclaw-chat-pane")!).zIndex),
            composer: Number(
              getComputedStyle(document.querySelector(".agent-chat__input")!).zIndex,
            ),
          })),
      );
      expect(actual.composer).toBeGreaterThan(actual.pane);
    },
  );
});
