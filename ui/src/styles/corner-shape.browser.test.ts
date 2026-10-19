import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeCornerShape = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

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
  return [
    "ui/src/styles/base.css",
    "ui/src/styles/components.css",
    "ui/src/styles/layout.css",
    "ui/src/styles/option-card.css",
    "ui/src/styles/chat/startup-layout.css",
    "ui/src/styles/chat/layout.css",
    "ui/src/styles/chat/message-layout.css",
    "ui/src/styles/chat/composer-surface.css",
    "ui/src/styles/chat/composer.css",
    "ui/src/styles/settings-controls.css",
    "ui/src/styles/settings.css",
    "ui/src/pages/activity/run-inspector.css",
  ]
    .map((file) => readStyleSheet(file))
    .join("\n");
}

function fixtureDocument(css: string): string {
  return `<!doctype html><html data-theme-mode="light"><head><style>${css}</style></head><body>
    <main>${ALL_CASES.map((item) => item.markup).join("")}</main>
  </body></html>`;
}

type CornerProbe = Record<string, { radius: string; shape: string }>;

async function probeCorners(browser: Browser, fixtureFile: string): Promise<CornerProbe> {
  const page = await browser.newPage();
  try {
    await page.goto(`file://${fixtureFile}`);
    return await page.evaluate(
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
    );
  } finally {
    await page.close().catch(() => {});
  }
}

async function probeRootRadiusTokens(
  browser: Browser,
  fixtureFile: string,
): Promise<Record<string, string>> {
  const page = await browser.newPage();
  try {
    await page.goto(`file://${fixtureFile}`);
    return await page.evaluate((tokens: readonly string[]) => {
      const style = getComputedStyle(document.documentElement);
      return Object.fromEntries(
        tokens.map((token) => [token, style.getPropertyValue(token).trim()]),
      );
    }, Object.keys(ROOT_RADIUS_TOKENS));
  } finally {
    await page.close().catch(() => {});
  }
}

let fixtureDirectory: string;
let superellipticalFixture: string;
let circularFixture: string;
let browser: Browser;

beforeAll(async () => {
  if (!canRunPlaywrightChromium(chromiumExecutablePath)) {
    return;
  }
  const css = readUiCss();
  expect(css).toContain(SUPPORTS_CONDITION);
  fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "corner-shape-"));
  superellipticalFixture = path.join(fixtureDirectory, "superelliptical.html");
  circularFixture = path.join(fixtureDirectory, "circular.html");
  fs.writeFileSync(superellipticalFixture, fixtureDocument(css), "utf8");
  fs.writeFileSync(
    circularFixture,
    fixtureDocument(css.replaceAll("corner-shape:", "openclaw-unsupported-corner-shape:")),
    "utf8",
  );
  browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
});

afterAll(async () => {
  await browser?.close().catch(() => {});
  if (fixtureDirectory) {
    fs.rmSync(fixtureDirectory, { force: true, recursive: true });
  }
});

describeCornerShape("Control UI corner curvature", () => {
  it("scales and reshapes the surfaces that carry the app silhouette", async () => {
    const probe = await probeCorners(browser, superellipticalFixture);

    expect(probe).toEqual(
      Object.fromEntries([
        ...CORNER_CASES.map((item) => [
          item.selector,
          { radius: item.superelliptical, shape: "superellipse(1.5)" },
        ]),
        ...ROUND_CASES.map((item) => [
          item.selector,
          { radius: item.superelliptical, shape: CIRCULAR_SHAPE },
        ]),
        ...EXCLUDED_CASES.map((item) => [
          item.selector,
          { radius: item.superelliptical, shape: CIRCULAR_SHAPE },
        ]),
      ]),
    );
  });

  it("keeps today's corners on engines without corner-shape", async () => {
    const probe = await probeCorners(browser, circularFixture);

    expect(probe).toEqual(
      Object.fromEntries(
        ALL_CASES.map((item) => [item.selector, { radius: item.circular, shape: CIRCULAR_SHAPE }]),
      ),
    );
  });

  it("keeps the :root radius tokens MCP apps read canonical under the scale", async () => {
    const probe = await probeRootRadiusTokens(browser, superellipticalFixture);

    expect(probe).toEqual(ROOT_RADIUS_TOKENS);
  });
});
