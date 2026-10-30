import { expect, it } from "vitest";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("corner-shape-", { ignoreCloseErrors: true });

function corners(circular: string, superelliptical: string, selectors: string) {
  return selectors.split(", ").map((selector) => ({ selector, circular, superelliptical }));
}

const CORNER_CASES = [
  ...corners("10px", "12.5px", ".btn, .nav-item, .slash-menu, .chat-reply-context-menu"),
  ...corners(
    "14px",
    "17.5px",
    ".card, .option-card__choice, .exec-approval-card, .settings-group, .agent-chat__search-bar",
  ),
  ...corners("20px", "25px", ".option-card, .agent-chat__input, .agent-chat__input .slash-menu"),
  // Item radius is panel radius minus 4px, at both scales.
  ...corners("6px", "8.5px", ".slash-menu-item, .chat-reply-context-menu button"),
];

// Neither siblings nor non-opted descendants may inherit scaled radius tokens.
const ALL_CASES = [
  ...CORNER_CASES,
  ...corners("9999px", "9999px", ".chip, .statusDot"),
  ...corners("10px", "10px", ".run-inspector__panel, .settings-segmented"),
];

// Nested fixtures match the real DOM; keep non-opted descendants and menu items nested.
const markup = `<main>
  <button class="btn" type="button">Send</button><div class="card">Surface</div>
  <section class="option-card" role="group"><div class="option-card__choices"><button type="button" class="option-card__choice">Choice</button></div></section>
  <div class="exec-approval-card">Surface</div><div class="agent-chat__input">Surface</div>
  <div class="sidebar-recent-session">Surface</div><a class="nav-item" href="#/chat">Chat</a>
  <div class="settings-group">Surface</div>
  <div class="slash-menu" role="listbox"><div class="slash-menu__scroll"><div class="slash-menu-group"><div class="slash-menu-item" role="option">Item</div></div></div></div>
  <div class="agent-chat__input"><div class="slash-menu">Menu</div></div>
  <div class="chat-reply-context-menu" role="menu"><button type="button" role="menuitem">Reply</button></div>
  <div class="agent-chat__search-bar"><input type="text" /></div>
  <span class="chip">Chip</span><span class="statusDot"></span><div class="run-inspector__panel">Surface</div>
  <div class="settings-group"><div class="settings-segmented">Segmented</div></div>
</main>`;

// CSSOM can serialize the same circular shape as round or superellipse(1).
// https://drafts.csswg.org/css-borders-4/#valdef-corner-shape-value-round
const CIRCULAR_SHAPE = expect.stringMatching(/^(?:round|superellipse\(1\))$/);

// Embedded MCP apps consume these unscaled root tokens on a separate origin.
const ROOT_RADIUS_TOKENS = {
  "--radius": "10px",
  "--radius-lg": "14px",
  "--radius-sm": "6px",
  "--radius-xl": "20px",
} as const;

const css = readStyles(
  "styles/base",
  "styles/components",
  "styles/layout",
  "styles/option-card",
  "styles/chat/startup-layout",
  "styles/chat/layout",
  "styles/chat/message-layout",
  "styles/chat/composer-surface",
  "styles/chat/composer",
  "styles/settings-controls",
  "styles/settings",
  "pages/activity/run-inspector",
);

async function probeCorners(supported: boolean) {
  return fixture.withPage(String(supported), cornerDocument(supported), (page) =>
    page.evaluate(
      (probes: readonly string[]) =>
        probes.map((selector) => {
          const element = document.querySelector(selector);
          if (!element) {
            throw new Error(`Missing corner fixture element for ${selector}`);
          }
          const style = getComputedStyle(element);
          return [style.borderTopLeftRadius, style.getPropertyValue("corner-shape")];
        }),
      ALL_CASES.map((item) => item.selector),
    ),
  );
}

function cornerDocument(supported: boolean) {
  return styleDocument(
    // Rewrite declarations too: unsupported engines ignore ungated corner-shape.
    supported ? css : css.replaceAll("corner-shape:", "openclaw-unsupported-corner-shape:"),
    markup,
    'data-theme-mode="light"',
  );
}

fixture.describe("Control UI corner curvature", () => {
  it.each([true, false])(
    "preserves opted-in, round and excluded corners (supported=%s)",
    async (supported) => {
      expect(await probeCorners(supported)).toEqual(
        ALL_CASES.map((item) => [
          supported ? item.superelliptical : item.circular,
          supported && CORNER_CASES.includes(item) ? "superellipse(1.5)" : CIRCULAR_SHAPE,
        ]),
      );
    },
  );

  it("keeps the :root radius tokens MCP apps read canonical under the scale", async () => {
    const tokens = await fixture.withPage("root-tokens", cornerDocument(true), (page) =>
      page.evaluate((names: string[]) => {
        const style = getComputedStyle(document.documentElement);
        return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
      }, Object.keys(ROOT_RADIUS_TOKENS)),
    );
    expect(tokens).toEqual(ROOT_RADIUS_TOKENS);
  });
});
