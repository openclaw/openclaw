// Control UI tests cover sidebar session picker layering and interaction.
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";

const describeBrowserLayout = existsSync(chromium.executablePath()) ? describe : describe.skip;

let browser: Browser;

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

function sidebarSessionPickerHtml(opts: { sidebarOpen?: boolean; workspaceRail?: boolean } = {}) {
  const optionButtons = Array.from({ length: 18 }, (_, index) => {
    const sessionKey = `dashboard-session-${index + 1}`;
    const selected = index === 0;
    return `
      <button
        class="chat-session-picker__option${selected ? " chat-session-picker__option--selected" : ""}"
        data-chat-session-picker-option="true"
        data-session-key="${sessionKey}"
        role="option"
        aria-selected="${selected ? "true" : "false"}"
        title="Session ${index + 1}"
        type="button"
      >
        <span class="chat-session-picker__option-main">
          <span class="chat-session-picker__option-label">Session ${index + 1}</span>
          <span class="chat-session-picker__option-meta">workspace · gpt-5.5 · 2026-06-13 20:${String(
            index,
          ).padStart(2, "0")}</span>
        </span>
        ${selected ? `<span class="chat-session-picker__option-check" aria-hidden="true">${iconSvg()}</span>` : ""}
      </button>
    `;
  }).join("");
  const workspaceRail = opts.workspaceRail
    ? `
        <aside class="chat-workspace-rail" aria-label="Session workspace">
          <div class="chat-workspace-rail__header">
            <div class="chat-workspace-rail__title">
              <span class="chat-workspace-rail__eyebrow">Workspace</span>
              <strong>Files</strong>
            </div>
            <button class="btn btn--ghost btn--sm chat-workspace-rail__refresh" type="button" aria-label="Refresh files">
              ${iconSvg()}
            </button>
          </div>
          <div class="chat-workspace-rail__path">/workspace/openclaw</div>
          <div class="chat-workspace-rail__list" role="list">
            <div class="chat-workspace-rail__file chat-workspace-rail__file--active" role="listitem">
              <button class="chat-workspace-rail__file-open" type="button">
                <span class="chat-workspace-rail__file-icon">${iconSvg()}</span>
                <span class="chat-workspace-rail__file-main">
                  <span class="chat-workspace-rail__file-name">ui/src/ui/chat/session-controls.ts</span>
                  <span class="chat-workspace-rail__file-meta">24 KB</span>
                </span>
              </button>
            </div>
            <div class="chat-workspace-rail__file" role="listitem">
              <button class="chat-workspace-rail__file-open" type="button">
                <span class="chat-workspace-rail__file-icon">${iconSvg()}</span>
                <span class="chat-workspace-rail__file-main">
                  <span class="chat-workspace-rail__file-name">ui/src/styles/layout.css</span>
                  <span class="chat-workspace-rail__file-meta">31 KB</span>
                </span>
              </button>
            </div>
          </div>
        </aside>
      `
    : "";
  return `
    <div class="shell shell--chat shell--nav-collapsed" data-chat-sidebar-picker-fixture>
      <header class="topbar">
        <div class="topnav-shell">
          <div class="topnav-shell__actions">
            <button class="topbar-search" type="button">
              <span class="topbar-search__label">Search</span>
              <kbd class="topbar-search__kbd">K</kbd>
            </button>
          </div>
        </div>
      </header>
      <div class="shell-nav">
        <aside class="sidebar sidebar--collapsed">
          <div class="sidebar-shell">
            <div class="sidebar-shell__header">
              <button class="nav-collapse-toggle" type="button" aria-label="Expand navigation">
                <span class="nav-collapse-toggle__icon" aria-hidden="true">${iconSvg()}</span>
              </button>
            </div>
            <div class="sidebar-shell__body">
              <section class="sidebar-sessions">
                <button class="sidebar-new-session" type="button" aria-label="New session">
                  <span class="sidebar-new-session__icon" aria-hidden="true">${iconSvg()}</span>
                </button>
                <div class="sidebar-session-select sidebar-session-select--collapsed">
                  <div class="chat-controls__session-row chat-controls__session-row--session-switcher chat-controls__session-row--single-agent chat-controls__session-row--compact">
                    <div class="chat-controls__session chat-controls__session-picker">
                      <button
                        class="chat-controls__session-trigger"
                        data-chat-session-select="true"
                        type="button"
                        title="main"
                        aria-label="Chat session"
                        aria-haspopup="dialog"
                        aria-expanded="true"
                        aria-controls="chat-session-picker-sidebar"
                      >
                        <span class="chat-controls__session-trigger-compact-icon" aria-hidden="true">${iconSvg()}</span>
                        <span class="chat-controls__session-trigger-label">main</span>
                        <span class="chat-controls__session-trigger-icon" aria-hidden="true">${iconSvg()}</span>
                      </button>
                      <div id="chat-session-picker-sidebar" class="chat-session-picker" role="dialog" aria-label="Chat session">
                        <div class="chat-session-picker__search-row">
                          <label class="field chat-session-picker__search">
                            <input
                              data-chat-session-picker-search="true"
                              type="search"
                              placeholder="Search sessions"
                              aria-label="Search sessions"
                            />
                          </label>
                          <button class="btn btn--ghost btn--icon chat-session-picker__icon-button" type="button" aria-label="Search">
                            ${iconSvg()}
                          </button>
                        </div>
                        <div class="chat-session-picker__list" role="listbox">
                          ${optionButtons}
                        </div>
                        <div class="chat-session-picker__footer">
                          <span class="chat-session-picker__count">18 / 18</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </aside>
      </div>
      <main class="content content--chat">
        <section class="card chat">
          <div class="chat-workbench">
            ${workspaceRail}
            <div class="chat-workbench__main">
              <div class="chat-split-container${opts.sidebarOpen ? " chat-split-container--open" : ""}">
                <div class="chat-main" style="flex: ${opts.sidebarOpen ? "0 1 72%" : "1 1 100%"}">
                  <div class="chat-thread" role="log">
                    <div class="chat-thread-inner">
                      <div class="chat-group assistant">
                        <div class="chat-group-messages">
                          <div class="chat-bubble">
                            <div class="chat-text">
                              <p>Keep the sidebar session picker interactive even when the desktop chat workbench is visible.</p>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div
                        style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:28px 0 0;padding:0 8px;"
                      >
                        <button class="btn" type="button">What can you do?</button>
                        <button class="btn" type="button">Summarize recent sessions</button>
                        <button class="btn" type="button">Help me configure a channel</button>
                        <button class="btn" type="button">Check system health</button>
                      </div>
                    </div>
                  </div>
                  <div class="agent-chat__input">
                    <div class="agent-chat__composer-combobox">
                      <textarea placeholder="Message OpenClaw"></textarea>
                    </div>
                    <div class="agent-chat__toolbar">
                      <div class="agent-chat__toolbar-left">
                        <button class="agent-chat__input-btn" type="button" aria-label="Attach file">
                          ${iconSvg()}
                        </button>
                      </div>
                      <button class="btn btn--ghost" type="button">Send</button>
                    </div>
                  </div>
                </div>
                ${
                  opts.sidebarOpen
                    ? `
                      <resizable-divider style="width:14px;flex:0 0 14px;"></resizable-divider>
                      <div class="chat-sidebar">
                        <div class="sidebar-panel">
                          <div class="sidebar-header">
                            <div class="sidebar-title">AGENTS.md</div>
                            <button class="btn" type="button">Close</button>
                          </div>
                          <div class="sidebar-content">
                            <article class="sidebar-markdown">File preview content</article>
                          </div>
                        </div>
                      </div>
                    `
                    : ""
                }
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
    <script>
      const searchInput = document.querySelector('[data-chat-session-picker-search="true"]');
      if (searchInput instanceof HTMLInputElement) {
        searchInput.addEventListener('input', () => {
          document.body.dataset.searchValue = searchInput.value;
        });
      }
      for (const option of document.querySelectorAll('[data-chat-session-picker-option="true"]')) {
        option.addEventListener('click', () => {
          document.body.dataset.clickedSession = option.getAttribute('data-session-key') ?? '';
        });
      }
    </script>
  `;
}

async function openSidebarSessionPickerFixture(
  width: number,
  height: number,
  opts: { sidebarOpen?: boolean; workspaceRail?: boolean } = {},
): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(
    `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${sidebarSessionPickerHtml(opts)}</body></html>`,
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

describeBrowserLayout("sidebar session picker browser layout", () => {
  it("keeps the collapsed sidebar session picker interactive above the desktop workbench when the workspace rail is visible", async () => {
    const page = await openSidebarSessionPickerFixture(1366, 900, { workspaceRail: true });
    try {
      await expectNoHorizontalOverflow(page);
      const input = page.locator('[data-chat-session-picker-search="true"]');
      const list = page.locator(".chat-session-picker__list");
      const targetOption = page.locator(
        '[data-chat-session-picker-option="true"][data-session-key="dashboard-session-12"]',
      );

      const inputHit = await input.evaluate((node) => {
        const rect = (node as HTMLElement).getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return hit === node || node.contains(hit);
      });
      expect(inputHit).toBe(true);

      await input.click();
      await input.fill("telegram");
      await expect
        .poll(() => page.evaluate(() => document.body.dataset.searchValue ?? ""))
        .toBe("telegram");

      const listBox = await list.boundingBox();
      if (!listBox) {
        throw new Error("Expected session picker list bounding box");
      }
      const listScrollBefore = await list.evaluate((node) => (node as HTMLElement).scrollTop);
      await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2);
      await page.mouse.wheel(0, 420);
      await expect
        .poll(() => list.evaluate((node) => (node as HTMLElement).scrollTop))
        .toBeGreaterThan(listScrollBefore);

      const optionHit = await targetOption.evaluate((node) => {
        const rect = (node as HTMLElement).getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + Math.min(rect.height / 2, rect.height - 4),
        );
        return hit === node || node.contains(hit);
      });
      expect(optionHit).toBe(true);

      await targetOption.click();
      await expect
        .poll(() => page.evaluate(() => document.body.dataset.clickedSession ?? ""))
        .toBe("dashboard-session-12");
    } finally {
      await page.close();
    }
  });

  it("keeps the file preview sidebar inside the main workbench column when the workspace rail is visible", async () => {
    const page = await openSidebarSessionPickerFixture(1366, 900, {
      sidebarOpen: true,
      workspaceRail: true,
    });
    try {
      await expectNoHorizontalOverflow(page);
      const boxes = await page.evaluate(() => {
        const rectFor = (selector: string) => {
          const element = document.querySelector(selector);
          if (!element) {
            throw new Error(`Missing ${selector}`);
          }
          const rect = element.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            width: rect.width,
          };
        };
        return {
          main: rectFor(".chat-workbench__main"),
          input: rectFor(".agent-chat__input"),
          rail: rectFor(".chat-workspace-rail"),
          sidebar: rectFor(".chat-sidebar"),
          split: rectFor(".chat-split-container"),
        };
      });

      expect(boxes.split.right).toBeLessThanOrEqual(boxes.rail.left + 1);
      expect(boxes.sidebar.right).toBeLessThanOrEqual(boxes.rail.left + 1);
      expect(boxes.input.right).toBeLessThanOrEqual(boxes.sidebar.left + 1);
      expect(boxes.sidebar.left).toBeGreaterThanOrEqual(boxes.main.left - 1);
      expect(boxes.sidebar.width).toBeGreaterThanOrEqual(300);
    } finally {
      await page.close();
    }
  });
});
