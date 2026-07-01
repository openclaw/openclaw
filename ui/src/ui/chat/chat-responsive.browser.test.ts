// Control UI tests cover chat responsive behavior.
import { chromium, type Browser, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../../test-helpers/control-ui-e2e.ts";

const VIEWPORTS = [
  [320, 568],
  [375, 812],
  [430, 932],
  [768, 1024],
  [1024, 768],
  [1366, 900],
  [1440, 900],
] as const;
const TOUCH_TARGET_MIN_PX = 43.5;
const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeBrowserLayout = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

const pageBrowsers = new WeakMap<Page, Browser>();

type ControlRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  display?: string;
};

function expectFiniteRect(rect: Pick<ControlRect, "x" | "y" | "width" | "height">) {
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Number.isFinite(rect[key])).toBe(true);
  }
}

async function getBoundingBox(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (box === null) {
    throw new Error(`Expected bounding box for ${selector}`);
  }
  expectFiniteRect(box);
  return box;
}

function expectControlRect(rect: ControlRect | null, label: string): ControlRect {
  if (rect === null) {
    throw new Error(`Expected ${label} control rect`);
  }
  expectFiniteRect(rect);
  return rect;
}

function readUiCss(): string {
  const files = [
    "ui/src/styles/base.css",
    "ui/src/styles/layout.css",
    "ui/src/styles/layout.mobile.css",
    "ui/src/styles/components.css",
    "ui/src/styles/chat/layout.css",
    "ui/src/styles/chat/text.css",
    "ui/src/styles/chat/grouped.css",
    "ui/src/styles/chat/tool-cards.css",
    "ui/src/styles/chat/sidebar.css",
  ];
  return files.map((file) => readStyleSheet(file)).join("\n");
}

function iconSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;
}

function chatBubbleActionsHtml() {
  return `
    <div class="chat-bubble-actions">
      <button class="btn btn--xs chat-expand-btn" type="button" aria-label="Open in canvas">
        <span class="chat-expand-btn__icon" aria-hidden="true">${iconSvg()}</span>
      </button>
      <button class="btn btn--xs chat-copy-btn" type="button" aria-label="Copy as markdown">
        <span class="chat-copy-btn__icon" aria-hidden="true">${iconSvg()}</span>
      </button>
    </div>
  `;
}

function chatControlsHtml(opts: { agent?: boolean } = {}) {
  const showAgent = opts.agent !== false;
  return `
    <div class="chat-mobile-controls-wrapper">
      <button class="btn btn--sm btn--icon chat-controls-mobile-toggle" aria-expanded="true" aria-controls="chat-mobile-controls-dropdown">${iconSvg()}</button>
      <div id="chat-mobile-controls-dropdown" class="chat-controls-dropdown open">
        <div class="chat-controls">
          <div class="chat-controls__session-row${showAgent ? "" : " chat-controls__session-row--single-agent"}">
            ${
              showAgent
                ? `<label class="field chat-controls__session chat-controls__agent">
                    <select data-chat-agent-filter="true" aria-label="Filter sessions by agent"><option>Alpha</option><option>Beta</option></select>
                  </label>`
                : ""
            }
            <label class="field chat-controls__session chat-controls__session-picker">
              <select data-chat-session-select="true" aria-label="Chat session"><option>Daily planning</option></select>
            </label>
            <details class="chat-controls__session chat-controls__inline-select chat-controls__model">
              <summary class="chat-controls__inline-select-trigger" data-chat-model-select="true" data-chat-thinking-select="true" data-chat-select-value="" data-chat-thinking-value="" aria-label="Chat model">gpt-5 · High</summary>
            </details>
          </div>
          <div class="chat-controls__thinking">
            <button class="btn btn--sm btn--icon active">${iconSvg()}</button>
            <button class="btn btn--sm btn--icon active">${iconSvg()}</button>
            <button class="btn btn--sm btn--icon">${iconSvg()}</button>
            <button class="btn btn--sm btn--icon active">${iconSvg()}</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function composerControlsHtml() {
  return `
    <div class="agent-chat__composer-controls">
      <div class="chat-composer-model-control">
        <details class="chat-controls__session chat-controls__inline-select chat-controls__model">
          <summary class="chat-controls__inline-select-trigger" data-chat-composer-model="true" aria-label="Chat model">
            <span class="chat-controls__inline-select-label">Default model · Off</span>
            <span class="chat-controls__inline-select-icon">${iconSvg()}</span>
          </summary>
          <div class="chat-controls__inline-select-menu chat-controls__inline-select-menu--combined">
            <div class="chat-controls__combined-model-list">
              <button class="chat-controls__inline-select-option chat-controls__combined-model-option chat-controls__inline-select-option--selected">Default model</button>
              <button class="chat-controls__inline-select-option chat-controls__combined-model-option">gpt-5.5</button>
              <button class="chat-controls__inline-select-option chat-controls__combined-model-option">claude-sonnet-4-6</button>
            </div>
          </div>
        </details>
      </div>
      <div class="chat-settings-popover-wrapper">
        <button class="chat-settings-chip" type="button" aria-label="Chat settings">
          <span class="chat-settings-chip__icon">${iconSvg()}</span>
          <span class="chat-settings-chip__text">Chat settings</span>
          <span class="chat-settings-chip__chevron">${iconSvg()}</span>
        </button>
      </div>
    </div>
  `;
}

function chatHeaderControlsHtml(hidden = false) {
  return `
    <main class="content content--chat" data-chat-header-responsive-fixture>
      <section class="content-header${hidden ? " content-header--chat-hidden" : ""}"${hidden ? ' inert aria-hidden="true"' : ""}>
        <div>
          <div class="chat-controls__session-row">
            <label class="field chat-controls__session chat-controls__agent">
              <select data-chat-agent-filter="true" aria-label="Filter sessions by agent"><option>Valentina</option></select>
            </label>
            <label class="field chat-controls__session chat-controls__session-picker">
              <select data-chat-session-select="true" aria-label="Chat session"><option>main</option></select>
            </label>
            <details class="chat-controls__session chat-controls__inline-select chat-controls__model">
              <summary class="chat-controls__inline-select-trigger" data-chat-model-select="true" data-chat-thinking-select="true" data-chat-select-value="gpt-5.5" data-chat-thinking-value="" aria-label="Chat model">gpt-5.5 · High</summary>
            </details>
          </div>
        </div>
        <div class="page-meta">
          <div class="chat-controls">
            <button class="btn btn--sm btn--icon" aria-label="Refresh chat data">${iconSvg()}</button>
            <span class="chat-controls__separator">|</span>
            <button class="btn btn--sm btn--icon active" aria-label="Toggle assistant thinking">${iconSvg()}</button>
            <button class="btn btn--sm btn--icon active" aria-label="Toggle tool calls">${iconSvg()}</button>
            <button class="btn btn--sm btn--icon active" aria-label="Show cron sessions">${iconSvg()}</button>
          </div>
        </div>
      </section>
      <section class="card chat"></section>
    </main>
  `;
}

function chatHtml(opts: { sideResult?: boolean; singleAgent?: boolean } = {}) {
  return `
    <div class="shell shell--chat" data-chat-responsive-fixture>
      <header class="topbar">
        <div class="topnav-shell">
          <div class="topnav-shell__actions">
            <button class="topbar-search"><span class="topbar-search__label">Search</span><kbd class="topbar-search__kbd">K</kbd></button>
            <div class="topbar-status">${chatControlsHtml({ agent: !opts.singleAgent })}</div>
          </div>
        </div>
      </header>
      <main class="content content--chat">
        <section class="card chat">
          <div class="chat-split-container">
            <div class="chat-main">
              <div class="chat-thread" role="log">
                <div class="chat-thread-inner">
                  <div class="chat-group user">
                    <div class="chat-avatar user">V</div>
                    <div class="chat-group-messages">
                      <div class="chat-bubble"><div class="chat-text">Please keep every control visible at the smallest viewport.</div></div>
                    </div>
                  </div>
                  <div class="chat-group assistant">
                    <div class="chat-avatar assistant">A</div>
                    <div class="chat-group-messages">
                      <div class="chat-bubble has-copy">
                        ${chatBubbleActionsHtml()}
                        <div class="chat-text">
                          <p>The chat shell should stay compact and readable.</p>
                          <pre><code>const importantLongIdentifier = "control-ui-chat-responsive-regression-fixture-keeps-code-scrollable"; console.log(importantLongIdentifier);</code></pre>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          ${
            opts.sideResult
              ? `<section class="chat-side-result" role="status" aria-live="polite">
                  <div class="chat-side-result__header">
                    <div class="chat-side-result__label-row"><span class="chat-side-result__label">BTW</span><span class="chat-side-result__meta">Not saved to chat history</span></div>
                    <button class="btn chat-side-result__dismiss">${iconSvg()}</button>
                  </div>
                  <div class="chat-side-result__question">What should I check next?</div>
                  <div class="chat-side-result__body"><p>Inspect the responsive controls and keep the transcript usable.</p></div>
                </section>`
              : ""
          }
          <div class="agent-chat__input">
            <div class="agent-chat__composer-combobox">
              <textarea rows="1">Queued follow-up for the active operator session</textarea>
            </div>
            <div class="agent-chat__toolbar">
              <div class="agent-chat__toolbar-left">
                <button class="agent-chat__input-btn">${iconSvg()}</button>
                <button class="agent-chat__input-btn">${iconSvg()}</button>
                <button class="agent-chat__input-btn">${iconSvg()}</button>
                <span class="agent-chat__token-count">8</span>
              </div>
              ${composerControlsHtml()}
              <div class="agent-chat__toolbar-right">
                <button class="chat-send-btn">${iconSvg()}</button>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  `;
}

async function openFixture(
  width: number,
  height: number,
  opts: { sideResult?: boolean; singleAgent?: boolean } = {},
) {
  const page = await openBrowserPage(width, height);
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${chatHtml(opts)}</body></html>`,
    );
    return page;
  } catch (error) {
    await closeBrowserPage(page);
    throw error;
  }
}

async function openBrowserPage(width: number, height: number): Promise<Page> {
  const browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
  let page: Page | undefined;
  try {
    page = await browser.newPage({ viewport: { width, height } });
    pageBrowsers.set(page, browser);
    return page;
  } catch (error) {
    await page?.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

async function closeBrowserPage(page: Page): Promise<void> {
  const browser = pageBrowsers.get(page);
  pageBrowsers.delete(page);
  await page.close().catch(() => {});
  await browser?.close().catch(() => {});
}

async function getRect(page: Page, selector: string) {
  const rect = await page.locator(selector).evaluate((node) => {
    const bounds = (node as HTMLElement).getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      bottom: bounds.bottom,
      width: bounds.width,
      height: bounds.height,
    };
  });
  expectFiniteRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  return rect;
}

async function getTextContentRect(page: Page, selector: string) {
  const rect = await page.locator(selector).evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const bounds = range.getBoundingClientRect();
    range.detach();
    return {
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      bottom: bounds.bottom,
      width: bounds.width,
      height: bounds.height,
    };
  });
  expectFiniteRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  return rect;
}

function rectsOverlap(
  first: Pick<ControlRect, "x" | "y" | "width" | "height">,
  second: Pick<ControlRect, "x" | "y" | "width" | "height">,
) {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

async function openHeaderFixture(width: number, height: number, opts: { hidden?: boolean } = {}) {
  const page = await openBrowserPage(width, height);
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${chatHeaderControlsHtml(Boolean(opts.hidden))}</body></html>`,
    );
    return page;
  } catch (error) {
    await closeBrowserPage(page);
    throw error;
  }
}

async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    html: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(metrics.html).toBeLessThanOrEqual(metrics.viewport + 1);
  expect(metrics.body).toBeLessThanOrEqual(metrics.viewport + 1);
}

describeBrowserLayout("chat responsive browser layout", () => {
  it.each([
    [1120, 740],
    [1366, 900],
    [1440, 900],
  ] as const)("keeps desktop chat controls in one row at %sx%s", async (width, height) => {
    const page = await openHeaderFixture(width, height);
    try {
      await expectNoHorizontalOverflow(page);
      const controls = await page.evaluate(() => {
        const rectFor = (selector: string) => {
          const node = document.querySelector(selector);
          const rect = node?.getBoundingClientRect();
          return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
        };
        return {
          session: rectFor('[data-chat-session-select="true"]'),
          agent: rectFor('[data-chat-agent-filter="true"]'),
          model: rectFor('[data-chat-model-select="true"]'),
          action: rectFor(".page-meta .btn--icon"),
        };
      });
      const rowY = [
        controls.session?.y,
        controls.agent?.y,
        controls.model?.y,
        controls.action?.y,
      ].filter((value): value is number => typeof value === "number");
      expect(rowY.length).toBe(4);
      expect(Math.max(...rowY) - Math.min(...rowY)).toBeLessThanOrEqual(4);
      const agent = expectControlRect(controls.agent, "agent");
      const session = expectControlRect(controls.session, "session");
      expect(agent.x).toBeLessThan(session.x);
      expect(session.width / agent.width).toBeGreaterThan(1.25);
      expect(session.width / agent.width).toBeLessThan(1.55);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("collapses the desktop chat controls row when scroll state hides it", async () => {
    const page = await openHeaderFixture(1366, 900, { hidden: true });
    try {
      const hiddenState = await page.evaluate(() => {
        const header = document.querySelector(".content-header") as HTMLElement | null;
        const rect = header?.getBoundingClientRect();
        const style = header ? getComputedStyle(header) : null;
        return {
          height: rect?.height ?? -1,
          opacity: style?.opacity ?? "",
          pointerEvents: style?.pointerEvents ?? "",
        };
      });
      expect(hiddenState.height).toBeLessThanOrEqual(1);
      expect(hiddenState.opacity).toBe("0");
      expect(hiddenState.pointerEvents).toBe("none");
    } finally {
      await closeBrowserPage(page);
    }
  });

  it.each(VIEWPORTS)("keeps the chat shell inside the viewport at %sx%s", async (width, height) => {
    const page = await openFixture(width, height);
    try {
      await expectNoHorizontalOverflow(page);
      const code = await getBoundingBox(page, ".chat-text pre");
      expect(code.x + code.width).toBeLessThanOrEqual(width + 1);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it.each([
    [320, 568],
    [1366, 900],
  ] as const)(
    "keeps short assistant text clear of bubble actions at %sx%s",
    async (width, height) => {
      const page = await openBrowserPage(width, height);
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
            <div class="chat-thread" role="log">
              <div class="chat-thread-inner">
                <div class="chat-group assistant">
                  <div class="chat-avatar assistant">A</div>
                  <div class="chat-group-messages">
                    <div class="chat-bubble has-copy">
                      ${chatBubbleActionsHtml()}
                      <div class="chat-text"><p>Done.</p></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </body></html>`,
        );
        await page.locator(".chat-bubble").hover();

        const text = await getTextContentRect(page, ".chat-text p");
        const actions = await getRect(page, ".chat-bubble-actions");
        expect(text.right).toBeLessThanOrEqual(actions.left - 1);
      } finally {
        await closeBrowserPage(page);
      }
    },
  );

  it.each([
    [320, 568],
    [1366, 900],
  ] as const)("wraps long inline code without clipping at %sx%s", async (width, height) => {
    const page = await openBrowserPage(width, height);
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-thread" role="log">
            <div class="chat-thread-inner">
              <div class="chat-group assistant">
                <div class="chat-avatar assistant">A</div>
                <div class="chat-group-messages">
                  <div class="chat-bubble">
                    <div class="chat-text">
                      <p><code>openclaw_message_send_channel_webchat_target_example_com_thread_very_long_identifier_without_spaces_1234567890abcdefghijklmnopqrstuvwxyz</code></p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </body></html>`,
      );

      await expectNoHorizontalOverflow(page);
      const bubble = await getRect(page, ".chat-bubble");
      const inlineCode = await getRect(page, ".chat-text p code");
      expect(inlineCode.right).toBeLessThanOrEqual(bubble.right + 1);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it.each(["dark", "light"] as const)(
    "keeps mobile controls inside the viewport with touch targets in %s mode",
    async (themeMode) => {
      const page = await openFixture(320, 568);
      try {
        await page.evaluate(
          (mode) => document.documentElement.setAttribute("data-theme-mode", mode),
          themeMode,
        );
        const dropdown = await getBoundingBox(page, ".chat-controls-dropdown.open");
        expect(dropdown.x).toBeGreaterThanOrEqual(8);
        expect(dropdown.x + dropdown.width).toBeLessThanOrEqual(312);
        await expectNoHorizontalOverflow(page);
        const mobileControls = await page.evaluate(() => {
          const rectFor = (selector: string) => {
            const node = document.querySelector(selector) as HTMLElement | null;
            if (!node) {
              return null;
            }
            const rect = node.getBoundingClientRect();
            return {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              text: node.textContent?.trim() ?? "",
              display: getComputedStyle(node).display,
            };
          };
          return {
            agent: rectFor('[data-chat-agent-filter="true"]'),
            session: rectFor('[data-chat-session-select="true"]'),
            model: rectFor('[data-chat-model-select="true"]'),
            compactCount: document.querySelectorAll('[data-chat-thinking-select-compact="true"]')
              .length,
          };
        });
        const agent = expectControlRect(mobileControls.agent, "agent");
        const session = expectControlRect(mobileControls.session, "session");
        const model = expectControlRect(mobileControls.model, "model");
        expect(session.y).toBe(agent.y);
        expect(agent.x).toBeLessThan(session.x);
        expect(session.width / agent.width).toBeGreaterThan(1.25);
        expect(session.width / agent.width).toBeLessThan(1.55);
        expect(model.display).not.toBe("none");
        expect(model.text).toBe("gpt-5 · High");
        expect(mobileControls.compactCount).toBe(0);

        const sizes = await page
          .locator(".chat-controls-mobile-toggle, .chat-controls-dropdown .btn--icon")
          .evaluateAll((nodes) =>
            nodes.map((node) => {
              const rect = (node as HTMLElement).getBoundingClientRect();
              return { width: rect.width, height: rect.height };
            }),
          );
        expect(sizes.length).toBeGreaterThan(0);
        for (const size of sizes) {
          expect(size.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
          expect(size.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
        }
      } finally {
        await closeBrowserPage(page);
      }
    },
  );

  it("keeps composer actions touch-sized on phones", async () => {
    const page = await openFixture(320, 568);
    try {
      const sizes = await page
        .locator(".agent-chat__input-btn, .agent-chat__toolbar .btn--ghost, .chat-send-btn")
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const rect = (node as HTMLElement).getBoundingClientRect();
            return { width: rect.width, height: rect.height };
          }),
        );
      expect(sizes.length).toBeGreaterThan(0);
      for (const size of sizes) {
        expect(size.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
        expect(size.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
      }
    } finally {
      await closeBrowserPage(page);
    }
  });

  it.each([
    [320, 568],
    [393, 852],
    [568, 320],
  ] as const)(
    "keeps current composer model, settings, and send controls from overlapping at %sx%s",
    async (width, height) => {
      const page = await openFixture(width, height);
      try {
        await expectNoHorizontalOverflow(page);
        const controls = await page.evaluate(() => {
          const rectFor = (selector: string) => {
            const node = document.querySelector(selector) as HTMLElement | null;
            if (!node) {
              return null;
            }
            const rect = node.getBoundingClientRect();
            return {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              display: getComputedStyle(node).display,
            };
          };
          return {
            input: rectFor(".agent-chat__input"),
            left: rectFor(".agent-chat__toolbar-left"),
            model: rectFor(".chat-composer-model-control"),
            settings: rectFor(".chat-settings-chip"),
            settingsLabel: rectFor(".chat-settings-chip__text"),
            send: rectFor(".chat-send-btn"),
          };
        });

        const input = expectControlRect(controls.input, "composer");
        const left = expectControlRect(controls.left, "composer left controls");
        const model = expectControlRect(controls.model, "composer model control");
        const settings = expectControlRect(controls.settings, "composer settings control");
        const send = expectControlRect(controls.send, "composer send control");
        const settingsLabel = expectControlRect(controls.settingsLabel, "settings label");

        for (const control of [left, model, settings, send]) {
          expect(control.x).toBeGreaterThanOrEqual(input.x - 1);
          expect(control.x + control.width).toBeLessThanOrEqual(input.x + input.width + 1);
        }
        expect(rectsOverlap(model, settings)).toBe(false);
        expect(rectsOverlap(model, send)).toBe(false);
        expect(rectsOverlap(settings, send)).toBe(false);
        expect(settings.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
        expect(settings.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
        expect(settingsLabel.display).toBe("none");
      } finally {
        await closeBrowserPage(page);
      }
    },
  );

  it("uses the compact mobile grid when the agent filter is not rendered", async () => {
    const page = await openFixture(320, 568, { singleAgent: true });
    try {
      await expectNoHorizontalOverflow(page);
      expect(await page.locator('[data-chat-agent-filter="true"]').count()).toBe(0);
      const session = await getBoundingBox(page, '[data-chat-session-select="true"]');
      const model = await getBoundingBox(page, '[data-chat-model-select="true"]');
      expect(model.y).toBeGreaterThan(session.y);
      expect(model.width).toBe(session.width);
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("renders BTW side results as a mobile overlay without horizontal overflow", async () => {
    const page = await openFixture(320, 568, { sideResult: true });
    try {
      await expectNoHorizontalOverflow(page);
      const position = await page
        .locator(".chat-side-result")
        .evaluate((node) => getComputedStyle(node).position);
      expect(position).toBe("fixed");
    } finally {
      await closeBrowserPage(page);
    }
  });
});
