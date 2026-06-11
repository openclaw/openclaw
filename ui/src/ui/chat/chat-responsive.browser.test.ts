import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";

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
const FULL_TOUCH_TARGET_MIN_PX = 44;
const LAYOUT_ROUNDING_TOLERANCE_PX = 0.01;
const describeBrowserLayout = existsSync(chromium.executablePath()) ? describe : describe.skip;

let browser: Browser;

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

function expectAtLeastFullTouchTargetPx(value: number) {
  expect(value).toBeGreaterThanOrEqual(FULL_TOUCH_TARGET_MIN_PX - LAYOUT_ROUNDING_TOLERANCE_PX);
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
  return `${files.map((file) => readStyleSheet(file)).join("\n")}
*, *::before, *::after {
  animation: none !important;
  transition: none !important;
}`;
}

function iconSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;
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
            <label class="field chat-controls__session chat-controls__model">
              <select data-chat-model-select="true" aria-label="Chat model"><option>Default (gpt-5)</option></select>
            </label>
            <label class="field chat-controls__session chat-controls__thinking-select">
              <select class="chat-controls__thinking-select-full" data-chat-thinking-select="true" aria-label="Chat thinking level"><option>Default (high)</option></select>
            </label>
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
            <label class="field chat-controls__session chat-controls__model">
              <select data-chat-model-select="true" aria-label="Chat model"><option>gpt-5.5</option></select>
            </label>
            <label class="field chat-controls__session chat-controls__thinking-select">
              <select class="chat-controls__thinking-select-full" data-chat-thinking-select="true" aria-label="Chat thinking level"><option>Default (high)</option></select>
            </label>
          </div>
        </div>
        <div class="page-meta">
          <div class="chat-controls">
            <button class="btn btn--sm btn--icon" aria-label="Refresh chat data">${iconSvg()}</button>
            <span class="chat-controls__separator">|</span>
            <button class="btn btn--sm btn--icon active" aria-label="Toggle assistant thinking">${iconSvg()}</button>
            <button class="btn btn--sm btn--icon active" aria-label="Toggle tool calls">${iconSvg()}</button>
            <button class="btn btn--sm btn--icon" aria-label="Toggle focus mode">${iconSvg()}</button>
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
                <span class="agent-chat__token-count">8</span>
              </div>
              <div class="agent-chat__toolbar-right">
                <button class="btn btn--ghost agent-chat__desktop-run-control">${iconSvg()}</button>
                <button class="btn btn--ghost agent-chat__desktop-run-control">${iconSvg()}</button>
                <details class="agent-chat__mobile-actions">
                  <summary class="agent-chat__input-btn agent-chat__mobile-actions-toggle">${iconSvg()}</summary>
                  <div class="agent-chat__mobile-actions-sheet" role="menu">
                    <button type="button" role="menuitem">${iconSvg()}<span>New session</span></button>
                    <button type="button" role="menuitem">${iconSvg()}<span>Export chat</span></button>
                  </div>
                </details>
                <button class="chat-send-btn">${iconSvg()}</button>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  `;
}

function nonChatComposerHtml() {
  return `
    <div class="shell" data-chat-responsive-fixture>
      <main class="content">
        <section class="card chat">
          <div class="agent-chat__input">
            <div class="agent-chat__composer-combobox">
              <textarea rows="1">This composer fixture is outside the Chat tab.</textarea>
            </div>
            <div class="agent-chat__toolbar">
              <div class="agent-chat__toolbar-left">
                <button class="agent-chat__input-btn">${iconSvg()}</button>
              </div>
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

function mobileShellNavHtml() {
  return `
    <div class="shell shell--nav-collapsed" data-mobile-safe-area-fixture>
      <aside class="shell-nav">
        <nav class="sidebar sidebar--collapsed">
          <div class="sidebar-shell">
            <div class="sidebar-shell__header">
              <a class="sidebar-brand" href="#">
                <span class="sidebar-brand__logo">${iconSvg()}</span>
                <span class="sidebar-brand__copy">
                  <span class="sidebar-brand__eyebrow">Control</span>
                  <strong class="sidebar-brand__title">OpenClaw</strong>
                </span>
              </a>
            </div>
          </div>
        </nav>
      </aside>
      <header class="topbar">
        <div class="topnav-shell">
          <div class="topnav-shell__actions">
            <button class="topbar-nav-toggle">${iconSvg()}</button>
            <button class="topbar-search"><span class="topbar-search__label">Search</span></button>
          </div>
        </div>
      </header>
      <main class="content content--chat"></main>
    </div>
  `;
}

async function openFixture(
  width: number,
  height: number,
  opts: { sideResult?: boolean; singleAgent?: boolean } = {},
) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(
    `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${chatHtml(opts)}</body></html>`,
  );
  return page;
}

async function openMobileShellNavFixture(width: number, height: number) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(
    `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${mobileShellNavHtml()}</body></html>`,
  );
  return page;
}

async function openNonChatComposerFixture(width: number, height: number) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(
    `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${nonChatComposerHtml()}</body></html>`,
  );
  return page;
}

async function openHeaderFixture(width: number, height: number, opts: { hidden?: boolean } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(
    `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${chatHeaderControlsHtml(Boolean(opts.hidden))}</body></html>`,
  );
  return page;
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

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

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
          thinking: rectFor('[data-chat-thinking-select="true"]'),
          action: rectFor(".page-meta .btn--icon"),
        };
      });
      const rowY = [
        controls.session?.y,
        controls.agent?.y,
        controls.model?.y,
        controls.thinking?.y,
        controls.action?.y,
      ].filter((value): value is number => typeof value === "number");
      expect(rowY.length).toBe(5);
      expect(Math.max(...rowY) - Math.min(...rowY)).toBeLessThanOrEqual(4);
      const agent = expectControlRect(controls.agent, "agent");
      const session = expectControlRect(controls.session, "session");
      expect(agent.x).toBeLessThan(session.x);
      expect(session.width / agent.width).toBeGreaterThan(1.25);
      expect(session.width / agent.width).toBeLessThan(1.55);
    } finally {
      await page.close();
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
      await page.close();
    }
  });

  it.each(VIEWPORTS)("keeps the chat shell inside the viewport at %sx%s", async (width, height) => {
    const page = await openFixture(width, height);
    try {
      await expectNoHorizontalOverflow(page);
      const code = await getBoundingBox(page, ".chat-text pre");
      expect(code.x + code.width).toBeLessThanOrEqual(width + 1);
    } finally {
      await page.close();
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
            const node = document.querySelector(selector) as HTMLSelectElement | null;
            if (!node) {
              return null;
            }
            const rect = node.getBoundingClientRect();
            return {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              text: node.options[node.selectedIndex]?.textContent?.trim() ?? "",
              display: getComputedStyle(node).display,
            };
          };
          return {
            agent: rectFor('[data-chat-agent-filter="true"]'),
            session: rectFor('[data-chat-session-select="true"]'),
            thinkingFull: rectFor('[data-chat-thinking-select="true"]'),
            compactCount: document.querySelectorAll('[data-chat-thinking-select-compact="true"]')
              .length,
          };
        });
        const agent = expectControlRect(mobileControls.agent, "agent");
        const session = expectControlRect(mobileControls.session, "session");
        expect(session.y).toBe(agent.y);
        expect(agent.x).toBeLessThan(session.x);
        expect(session.width / agent.width).toBeGreaterThan(1.25);
        expect(session.width / agent.width).toBeLessThan(1.55);
        expect(mobileControls.thinkingFull?.display).not.toBe("none");
        expect(mobileControls.thinkingFull?.text).toBe("Default (high)");
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
        await page.close();
      }
    },
  );

  it("keeps composer actions touch-sized on phones", async () => {
    const page = await openFixture(320, 568);
    try {
      const sizes = await page
        .locator(".agent-chat__input-btn, .agent-chat__toolbar .btn--ghost, .chat-send-btn")
        .evaluateAll((nodes) =>
          nodes
            .filter((node) => getComputedStyle(node as HTMLElement).display !== "none")
            .map((node) => {
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
      await page.close();
    }
  });

  it("keeps the composer above the iOS safe area on phones", async () => {
    const page = await openFixture(320, 568);
    try {
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--safe-area-bottom", "34px"),
      );
      const composer = await getBoundingBox(page, ".agent-chat__input");
      const send = await getBoundingBox(page, ".chat-send-btn");
      expect(composer.x).toBeGreaterThanOrEqual(8);
      expect(composer.x + composer.width).toBeLessThanOrEqual(312);
      expect(composer.y + composer.height).toBeGreaterThanOrEqual(568 - 34 - 1);
      expect(composer.y + composer.height).toBeLessThanOrEqual(568 - 34 + 1);
      expect(send.y + send.height).toBeLessThanOrEqual(568 - 34 + 1);
      expectAtLeastFullTouchTargetPx(send.width);
      expectAtLeastFullTouchTargetPx(send.height);
      const textareaFontSize = await page
        .locator(".agent-chat__composer-combobox > textarea")
        .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
      expect(textareaFontSize).toBeGreaterThanOrEqual(16);
      await expectNoHorizontalOverflow(page);
    } finally {
      await page.close();
    }
  });

  it("does not pin a composer outside the Chat tab", async () => {
    const page = await openNonChatComposerFixture(320, 568);
    try {
      const position = await page
        .locator(".agent-chat__input")
        .evaluate((node) => getComputedStyle(node).position);
      const composer = await getBoundingBox(page, ".agent-chat__input");
      expect(position).not.toBe("fixed");
      expect(composer.y + composer.height).toBeLessThan(220);
      await expectNoHorizontalOverflow(page);
    } finally {
      await page.close();
    }
  });

  it("hides the mobile composer while the left navigation drawer is open", async () => {
    const page = await openFixture(320, 568);
    try {
      await page.locator(".shell").evaluate((node) => {
        node.classList.add("shell--nav-drawer-open");
      });
      const composerState = await page.locator(".agent-chat__input").evaluate((node) => {
        const style = getComputedStyle(node as HTMLElement);
        return {
          opacity: style.opacity,
          pointerEvents: style.pointerEvents,
          visibility: style.visibility,
          zIndex: Number.parseInt(style.zIndex, 10),
        };
      });

      expect(composerState.visibility).toBe("hidden");
      expect(composerState.opacity).toBe("0");
      expect(composerState.pointerEvents).toBe("none");
      expect(composerState.zIndex).toBeLessThan(70);
      await expectNoHorizontalOverflow(page);
    } finally {
      await page.close();
    }
  });

  it("keeps the composer docked near the bottom when the mobile keyboard inset is reported", async () => {
    const page = await openFixture(320, 568);
    try {
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--mobile-keyboard-inset", "260px"),
      );
      await page.locator(".agent-chat__composer-combobox > textarea").focus();
      const composer = await getBoundingBox(page, ".agent-chat__input");
      const send = await getBoundingBox(page, ".chat-send-btn");
      const keyboardTop = 568 - 260;
      expect(composer.y).toBeGreaterThan(96);
      expect(composer.y + composer.height).toBeLessThanOrEqual(keyboardTop + 1);
      expect(send.y + send.height).toBeLessThanOrEqual(keyboardTop + 1);
      await expectNoHorizontalOverflow(page);
    } finally {
      await page.close();
    }
  });

  it("keeps the full composer controls visible while focused on mobile", async () => {
    const page = await openFixture(320, 568);
    try {
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--mobile-keyboard-inset", "260px"),
      );
      await page.locator(".agent-chat__composer-combobox > textarea").focus();
      const composer = await getBoundingBox(page, ".agent-chat__input");
      const controls = await getBoundingBox(page, ".agent-chat__toolbar-right");
      const send = await getBoundingBox(page, ".chat-send-btn");
      const primaryTool = await getBoundingBox(
        page,
        ".agent-chat__toolbar-left .agent-chat__input-btn:first-of-type",
      );
      const mobileActions = await getBoundingBox(page, ".agent-chat__mobile-actions-toggle");
      const composerPosition = await page
        .locator(".agent-chat__input")
        .evaluate((node) => getComputedStyle(node).position);
      const controlsPosition = await page
        .locator(".agent-chat__toolbar-right")
        .evaluate((node) => getComputedStyle(node).position);
      const desktopControlDisplay = await page
        .locator(".agent-chat__desktop-run-control")
        .first()
        .evaluate((node) => getComputedStyle(node).display);
      const keyboardTop = 568 - 260;

      expect(composerPosition).toBe("fixed");
      expect(controlsPosition).not.toBe("fixed");
      expect(desktopControlDisplay).toBe("none");
      expect(composer.y).toBeGreaterThan(96);
      expect(composer.y + composer.height).toBeLessThanOrEqual(keyboardTop + 1);
      expect(controls.y + controls.height).toBeLessThanOrEqual(composer.y + composer.height + 1);
      expect(send.y + send.height).toBeLessThanOrEqual(composer.y + composer.height + 1);
      expectAtLeastFullTouchTargetPx(send.width);
      expect(send.width).toBeLessThan(52);
      expectAtLeastFullTouchTargetPx(send.height);
      expectAtLeastFullTouchTargetPx(primaryTool.width);
      expectAtLeastFullTouchTargetPx(primaryTool.height);
      expectAtLeastFullTouchTargetPx(mobileActions.width);
      expectAtLeastFullTouchTargetPx(mobileActions.height);
      const rowCenters = [
        primaryTool.y + primaryTool.height / 2,
        mobileActions.y + mobileActions.height / 2,
        send.y + send.height / 2,
      ];
      expect(Math.max(...rowCenters) - Math.min(...rowCenters)).toBeLessThanOrEqual(8);
      expect(controls.x + controls.width).toBeLessThanOrEqual(composer.x + composer.width + 1);
      await expectNoHorizontalOverflow(page);
    } finally {
      await page.close();
    }
  });

  it("opens the mobile chat action sheet inside the visible viewport", async () => {
    const page = await openFixture(320, 568);
    try {
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--mobile-keyboard-inset", "260px"),
      );
      await page.locator(".agent-chat__composer-combobox > textarea").focus();
      await page.locator(".agent-chat__mobile-actions-toggle").click();
      const sheet = await getBoundingBox(page, ".agent-chat__mobile-actions-sheet");
      const keyboardTop = 568 - 260;
      expect(sheet.x).toBeGreaterThanOrEqual(8);
      expect(sheet.x + sheet.width).toBeLessThanOrEqual(312);
      expect(sheet.y).toBeGreaterThan(56);
      expect(sheet.y + sheet.height).toBeLessThanOrEqual(keyboardTop + 1);
      await expectNoHorizontalOverflow(page);
    } finally {
      await page.close();
    }
  });

  it("lifts the complete composer above taller iPhone keyboards", async () => {
    const page = await openFixture(393, 852);
    try {
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--mobile-keyboard-inset", "420px"),
      );
      await page.locator(".agent-chat__composer-combobox > textarea").focus();
      const composer = await getBoundingBox(page, ".agent-chat__input");
      const primaryTool = await getBoundingBox(
        page,
        ".agent-chat__toolbar-left .agent-chat__input-btn:first-of-type",
      );
      const moreActions = await getBoundingBox(page, ".agent-chat__mobile-actions-toggle");
      const send = await getBoundingBox(page, ".chat-send-btn");
      const keyboardTop = 852 - 420;

      expect(composer.y).toBeGreaterThan(96);
      expect(composer.y + composer.height).toBeLessThanOrEqual(keyboardTop + 1);
      expect(primaryTool.y + primaryTool.height).toBeLessThanOrEqual(
        composer.y + composer.height + 1,
      );
      expect(moreActions.y + moreActions.height).toBeLessThanOrEqual(
        composer.y + composer.height + 1,
      );
      expect(send.y + send.height).toBeLessThanOrEqual(keyboardTop + 1);
      expectAtLeastFullTouchTargetPx(send.width);
      expectAtLeastFullTouchTargetPx(send.height);
      await expectNoHorizontalOverflow(page);
    } finally {
      await page.close();
    }
  });

  it("expands multiline mobile text upward without hiding composer actions", async () => {
    const page = await openFixture(393, 852);
    try {
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--mobile-keyboard-inset", "360px"),
      );
      const textarea = page.locator(".agent-chat__composer-combobox > textarea");
      await textarea.focus();
      const before = await getBoundingBox(page, ".agent-chat__input");
      await textarea.fill(["Line one", "Line two", "Line three", "Line four"].join("\n"));
      await textarea.evaluate((node) => {
        const textareaNode = node as HTMLTextAreaElement;
        textareaNode.style.height = "auto";
        textareaNode.style.height = `${textareaNode.scrollHeight}px`;
      });
      await page.waitForTimeout(50);
      const after = await getBoundingBox(page, ".agent-chat__input");
      const primaryTool = await getBoundingBox(
        page,
        ".agent-chat__toolbar-left .agent-chat__input-btn:first-of-type",
      );
      const moreActions = await getBoundingBox(page, ".agent-chat__mobile-actions-toggle");
      const send = await getBoundingBox(page, ".chat-send-btn");
      const keyboardTop = 852 - 360;

      expect(after.height).toBeGreaterThan(before.height);
      expect(after.y).toBeLessThan(before.y);
      expect(after.y + after.height).toBeLessThanOrEqual(keyboardTop + 1);
      expect(primaryTool.y + primaryTool.height).toBeLessThanOrEqual(after.y + after.height + 1);
      expect(moreActions.y + moreActions.height).toBeLessThanOrEqual(after.y + after.height + 1);
      expect(send.y + send.height).toBeLessThanOrEqual(after.y + after.height + 1);
      await expectNoHorizontalOverflow(page);
    } finally {
      await page.close();
    }
  });

  it("keeps the collapsed mobile OpenClaw logo below the iOS status area", async () => {
    const page = await openMobileShellNavFixture(375, 812);
    try {
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--safe-area-top", "47px"),
      );
      const nav = await getBoundingBox(page, ".shell-nav");
      const logo = await getBoundingBox(page, ".sidebar-brand__logo");
      expect(nav.y).toBeGreaterThanOrEqual(47);
      expect(logo.y).toBeGreaterThanOrEqual(47);
      await expectNoHorizontalOverflow(page);
    } finally {
      await page.close();
    }
  });

  it("uses the compact mobile grid when the agent filter is not rendered", async () => {
    const page = await openFixture(320, 568, { singleAgent: true });
    try {
      await expectNoHorizontalOverflow(page);
      expect(await page.locator('[data-chat-agent-filter="true"]').count()).toBe(0);
      const session = await getBoundingBox(page, '[data-chat-session-select="true"]');
      const model = await getBoundingBox(page, '[data-chat-model-select="true"]');
      const thinking = await getBoundingBox(page, '[data-chat-thinking-select="true"]');
      expect(thinking.x).toBeGreaterThan(session.x);
      expect(model.y).toBeGreaterThan(session.y);
      expect(model.width).toBeGreaterThan(session.width);
    } finally {
      await page.close();
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
      await page.close();
    }
  });
});
