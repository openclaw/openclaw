import type { Page } from "playwright";
import { expect, it } from "vitest";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("corner-shape-", { ignoreCloseErrors: true });

// Rewrite the property in both feature queries and declarations: unsupported
// engines also ignore corner-shape outside an @supports block.
const SUPPORTS_CONDITION = "@supports (corner-shape: superellipse(1.5))";

type CornerCase = {
  readonly circular: string;
  readonly markup: string;
  readonly selector: string;
  readonly superelliptical: string;
};

function corner(
  selector: string,
  circular: string,
  superelliptical: string,
  markup = `<div class="${selector.slice(1)}">Surface</div>`,
): CornerCase {
  return { selector, circular, superelliptical, markup };
}

// Nested fixtures match the real DOM: descendant selectors must still apply.
const CORNER_CASES: readonly CornerCase[] = [
  corner(".btn", "10px", "12.5px", '<button class="btn" type="button">Send</button>'),
  corner(".card", "14px", "17.5px"),
  corner(
    ".option-card",
    "20px",
    "25px",
    '<section class="option-card" role="group"><div class="option-card__choices">' +
      '<button type="button" class="option-card__choice">Choice</button></div></section>',
  ),
  corner(".option-card__choice", "14px", "17.5px", ""),
  corner(".exec-approval-card", "14px", "17.5px"),
  corner(".agent-chat__input", "20px", "25px"),
  corner(".sidebar-recent-session", "10px", "12.5px"),
  corner(".nav-item", "10px", "12.5px", '<a class="nav-item" href="#/chat">Chat</a>'),
  corner(".settings-group", "14px", "17.5px"),
  // Item radius is panel radius minus 4px, at both scales.
  corner(
    ".slash-menu",
    "10px",
    "12.5px",
    '<div class="slash-menu" role="listbox"><div class="slash-menu__scroll">' +
      '<div class="slash-menu-group"><div class="slash-menu-item" role="option">Item</div>' +
      "</div></div></div>",
  ),
  corner(
    ".agent-chat__input .slash-menu",
    "20px",
    "25px",
    '<div class="agent-chat__input"><div class="slash-menu">Menu</div></div>',
  ),
  corner(".slash-menu-item", "6px", "8.5px", ""),
  corner(
    ".chat-reply-context-menu",
    "10px",
    "12.5px",
    '<div class="chat-reply-context-menu" role="menu">' +
      '<button type="button" role="menuitem">Reply</button></div>',
  ),
  corner(".chat-reply-context-menu button", "6px", "8.5px", ""),
  corner(
    ".agent-chat__search-bar",
    "14px",
    "17.5px",
    '<div class="agent-chat__search-bar"><input type="text" /></div>',
  ),
];

const ROUND_CASES: readonly CornerCase[] = [
  corner(".chip", "9999px", "9999px", '<span class="chip">Chip</span>'),
  corner(".statusDot", "9999px", "9999px", '<span class="statusDot"></span>'),
];

// Neither siblings nor non-opted descendants may inherit scaled radius tokens.
const EXCLUDED_CASES: readonly CornerCase[] = [
  corner(".run-inspector__panel", "10px", "10px"),
  corner(
    ".settings-segmented",
    "10px",
    "10px",
    '<div class="settings-group"><div class="settings-segmented">Segmented</div></div>',
  ),
];

const ALL_CASES = [...CORNER_CASES, ...ROUND_CASES, ...EXCLUDED_CASES];

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

function readUiCss(): string {
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
  expect(css).toContain(SUPPORTS_CONDITION);
  return css;
}

type CornerProbe = Record<string, { radius: string; shape: string }>;

async function probeCorners(supported: boolean): Promise<CornerProbe> {
  return withFixture(supported, (page) =>
    page.evaluate(
      (probes: readonly string[]) => {
        return Object.fromEntries(
          probes.map((selector) => {
            const element = document.querySelector(selector);
            if (!element) {
              throw new Error(`Missing corner fixture element for ${selector}`);
            }
            const style = getComputedStyle(element);
            const radius = style.borderTopLeftRadius;
            return [selector, { radius, shape: style.getPropertyValue("corner-shape") }];
          }),
        );
      },
      ALL_CASES.map((item) => item.selector),
    ),
  );
}

function withFixture<T>(supported: boolean, run: (page: Page) => Promise<T>) {
  const css = readUiCss();
  return fixture.withPage(
    String(supported),
    styleDocument(
      supported ? css : css.replaceAll("corner-shape:", "openclaw-unsupported-corner-shape:"),
      `<main>${ALL_CASES.map((item) => item.markup).join("")}</main>`,
      'data-theme-mode="light"',
    ),
    run,
  );
}

fixture.describe("Control UI corner curvature", () => {
  it.each([true, false])(
    "preserves opted-in, round and excluded corners (supported=%s)",
    async (supported) => {
      expect(await probeCorners(supported)).toEqual(
        Object.fromEntries(
          ALL_CASES.map((item) => [
            item.selector,
            {
              radius: supported ? item.superelliptical : item.circular,
              shape:
                supported && CORNER_CASES.includes(item) ? "superellipse(1.5)" : CIRCULAR_SHAPE,
            },
          ]),
        ),
      );
    },
  );

  it("keeps the :root radius tokens MCP apps read canonical under the scale", async () => {
    const tokens = await withFixture(true, (page) =>
      page.evaluate((names: string[]) => {
        const style = getComputedStyle(document.documentElement);
        return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
      }, Object.keys(ROOT_RADIUS_TOKENS)),
    );
    expect(tokens).toEqual(ROOT_RADIUS_TOKENS);
  });
});
