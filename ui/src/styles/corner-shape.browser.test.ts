import { expect, it } from "vitest";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("corner-shape-", { ignoreCloseErrors: true });

function corners(circular: string, superelliptical: string, selectors: string) {
  return selectors.split(", ").map((selector) => ({ selector, circular, superelliptical }));
}

const CORNER_CASES = [
  ...corners("3px", "3px", ".field .oc-checkbox"),
  ...corners("10px", "12.5px", ".btn, .nav-item"),
  ...corners("16px", "20px", ".slash-menu, .chat-reply-context-menu"),
  ...corners(
    "14px",
    "17.5px",
    ".card, .option-card__choice, .exec-approval-card, .agent-chat__search-bar",
  ),
  ...corners("20px", "25px", ".option-card, .settings-group, .agent-chat__input .slash-menu"),
  // Menu rows share --menu-item-radius at both scales.
  ...corners("10px", "12.5px", ".slash-menu-item, .chat-reply-context-menu button"),
];

// Neither siblings nor non-opted descendants may inherit scaled radius tokens.
const ALL_CASES = [
  ...CORNER_CASES,
  ...corners(
    "20px",
    "25px",
    ".agent-chat__input, .agent-chat__input--dictating::after, .agent-chat__disabled-banner, .agent-chat__composer-notices .chat-composer-neighbor-card, .agent-chat__composer-alert, .agent-chat__talk-status",
  ),
  ...corners("9999px", "9999px", ".chip, .statusDot"),
  ...corners("10px", "10px", ".run-inspector__panel, .settings-segmented"),
  ...corners("14px", "17.5px", ".chat"),
  ...corners("3px", "3px", ".round-checkbox"),
  ...corners("2px", "2px", ".square-checkbox"),
];

// Nested fixtures match the real DOM; keep non-opted descendants and menu items nested.
const markup = `<main>
  <div class="chat">Chat</div>
  <label class="field"><input class="oc-checkbox" type="checkbox" checked />Choice</label>
  <label style="--radius-sm: 2px"><input class="oc-checkbox square-checkbox" type="checkbox" /></label>
  <label style="--radius-sm: 12px"><input class="oc-checkbox round-checkbox" type="checkbox" /></label>
  <button class="btn" type="button">Send</button><div class="card">Surface</div>
  <section class="option-card" role="group"><div class="option-card__choices"><button type="button" class="option-card__choice">Choice</button></div></section>
  <div class="exec-approval-card">Surface</div><div class="agent-chat__input agent-chat__input--dictating">Surface</div>
  <div class="agent-chat__composer-shell">
    <div class="agent-chat__disabled-banner callout">Archived session</div>
    <div class="agent-chat__composer-notices">
      <div class="chat-composer-neighbor-card">Recovery</div>
      <div class="agent-chat__composer-alert">Error</div>
      <div class="agent-chat__talk-status callout">Connecting</div>
    </div>
  </div>
  <div class="sidebar-recent-session">Surface</div><a class="nav-item" href="#/chat">Chat</a>
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
  "styles/checkbox",
  "styles/layout",
  "styles/option-card",
  "styles/chat/startup-layout",
  "styles/chat/layout",
  "styles/chat/message-layout",
  "styles/chat/composer-surface",
  "styles/chat/composer",
  "styles/settings-controls",
  "styles/settings",
  "components/solid/overlay",
  "pages/activity/run-inspector",
);

fixture.describe("Control UI corner curvature", () => {
  it.each([true, false])(
    "preserves corners and canonical root tokens (supported=%s)",
    async (supported) => {
      const actual = await fixture.withPage(
        String(supported),
        styleDocument(
          // Rewrite declarations too: unsupported engines ignore ungated corner-shape.
          supported ? css : css.replaceAll("corner-shape:", "openclaw-unsupported-corner-shape:"),
          markup,
          'data-theme-mode="light"',
        ),
        (page) =>
          page.evaluate(
            ({ selectors, tokens }) => {
              const root = getComputedStyle(document.documentElement);
              return [
                ...selectors.map((selector) => {
                  const [element, pseudo] = selector.split("::");
                  const style = getComputedStyle(
                    document.querySelector(element!)!,
                    pseudo ? `::${pseudo}` : null,
                  );
                  return [style.borderTopLeftRadius, style.getPropertyValue("corner-shape")];
                }),
                tokens.map((name) => root.getPropertyValue(name).trim()),
              ];
            },
            {
              selectors: ALL_CASES.map((item) => item.selector),
              tokens: Object.keys(ROOT_RADIUS_TOKENS),
            },
          ),
      );
      expect(actual).toEqual([
        ...ALL_CASES.map((item) => [
          supported ? item.superelliptical : item.circular,
          supported && CORNER_CASES.includes(item) ? "superellipse(1.5)" : CIRCULAR_SHAPE,
        ]),
        Object.values(ROOT_RADIUS_TOKENS),
      ]);
    },
  );
});
