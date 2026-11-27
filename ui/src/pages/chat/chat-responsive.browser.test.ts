// @vitest-environment node

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";
import { finishElementAnimations } from "../../test-helpers/animations.ts";
import { closeBrowserPage, withBrowserPage } from "../../test-helpers/browser-page.ts";
import {
  canRunChatLayoutBrowser,
  chromiumExecutablePath,
  createChatLayoutBrowser,
  expectFiniteRect,
  getBoundingBox,
  getRect,
  readUiCss,
  rectsOverlap,
  waitForLayoutSettled,
  type ControlRect,
} from "./chat-layout.browser.test-support.ts";

const TOUCH_TARGET_MIN_PX = 43.5;
const LONG_SESSION_RAIL_BODY = Array.from(
  { length: 80 },
  (_, index) => `<p>Line ${index + 1}: keep the complete side result readable.</p>`,
).join("");
const describeBrowserLayout = canRunChatLayoutBrowser ? describe : describe.skip;

const layoutBrowser = createChatLayoutBrowser();
const { openBrowserPage } = layoutBrowser;

type ChatFixtureOptions = {
  composerAttachment?: boolean;
  crowdedComposerFooter?: boolean;
  goalMode?: boolean;
  slashMenu?: boolean;
};

function expectControlRect(rect: ControlRect | null, label: string): ControlRect {
  const defined = expectDefined(rect, `${label} control rect`);
  expectFiniteRect(defined);
  return defined;
}

function iconSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;
}

function chatFooterActionsHtml() {
  return `
    <div class="chat-group-footer-actions">
      <button class="chat-copy-btn" type="button" aria-label="Copy as markdown">
        <span class="chat-copy-btn__icon" aria-hidden="true">${iconSvg()}</span>
      </button>
    </div>
  `;
}

function composerControlsHtml() {
  return `
    <div class="agent-chat__composer-controls">
      <div class="chat-composer-model-control">
        <div class="chat-controls__session chat-controls__model chat-controls__model-settings">
          <details class="chat-controls__inline-select chat-controls__model-picker">
          <summary class="chat-controls__inline-select-trigger chat-controls__model-trigger" data-chat-composer-model="true" aria-label="Chat model: GPT-5.6 Luna">
            <span class="chat-controls__inline-select-label">GPT-5.6 Luna</span>
          </summary>
          <div class="oc-overlay chat-picker-overlay" popover="manual"></div>
          </details>
          <details class="chat-controls__inline-select chat-controls__permission-picker">
          <summary class="chat-controls__inline-select-trigger chat-controls__permission-trigger" aria-label="Permissions: Guarded">
            <span class="chat-controls__permission-icon" aria-hidden="true">${iconSvg()}</span>
          </summary>
          <div class="chat-controls__inline-select-menu chat-controls__permission-menu">
            <button class="chat-controls__permission-option">Guarded</button>
          </div>
          </details>
          <details class="chat-controls__inline-select chat-controls__effort-picker">
          <summary class="chat-controls__inline-select-trigger chat-controls__effort-trigger" data-chat-composer-effort="true" aria-label="Effort">
            <span class="chat-controls__inline-select-label">Medium</span>
          </summary>
          <div class="oc-overlay chat-picker-overlay" popover="manual"></div>
          </details>
        </div>
      </div>
    </div>
  `;
}

function chatHtml(opts: ChatFixtureOptions = {}, mobileNavLayout = false) {
  return `
    <div class="shell shell--chat${mobileNavLayout ? " shell--mobile-nav" : ""}" data-chat-responsive-fixture>
      <header class="topbar">
        <div class="topnav-shell">
          <div class="topnav-shell__actions">
            <button class="topbar-search">${iconSvg()}</button>
          </div>
        </div>
      </header>
      <main class="content content--chat">
        <section class="chat">
          <div class="chat-split-container">
            <div class="chat-main" style="flex: 1 1 100%">
              <div class="chat-thread" role="log">
                <div class="chat-thread-inner">
                  <div class="chat-group user">
                    <div class="chat-avatar user">V</div>
                    <div class="chat-group-messages">
                      <div class="chat-bubble"><div class="chat-text">Keep this visible.</div></div>
                    </div>
                  </div>
                  <div class="chat-group assistant chat-group--with-footer">
                    <div class="chat-avatar assistant">A</div>
                    <div class="chat-group-messages">
                      <div class="chat-bubble"><div class="chat-text">It stays readable.</div></div>
                      <div class="chat-bubble">
                        <div class="chat-text">
                          <p>The chat shell should stay compact and readable.</p>
                          <div class="code-block-wrapper"><pre><code>const importantLongIdentifier = "control-ui-chat-responsive-regression-fixture-keeps-code-scrollable"; console.log(importantLongIdentifier);</code></pre></div>
                        </div>
                      </div>
                    </div>
                    <div class="chat-group-footer">
                      <div class="chat-group-footer__meta">
                        <span class="chat-sender-name">Assistant</span>
                        <span class="chat-group-timestamp">9:41 PM</span>
                      </div>
                      ${chatFooterActionsHtml()}
                    </div>
                  </div>
                </div>
              </div>
              ${
                opts.crowdedComposerFooter
                  ? `<div class="agent-chat__typing-indicator agent-chat__typing-indicator--outside" role="status">
                    <span class="agent-chat__typing-avatars" aria-hidden="true">
                      <span class="chat-author-avatar">A</span>
                      <span class="chat-author-avatar">B</span>
                      <span class="chat-author-avatar">C</span>
                    </span>
                    <span class="agent-chat__typing-text">Alexandria, Bartholomew, and Cassandra are typing</span>
                  </div>`
                  : ""
              }
              <div class="agent-chat__composer-shell">
                <div class="agent-chat__input agent-chat__input--chat agent-chat__input--mobile-toolbar" data-composer-layout="multiline">
                  ${
                    opts.slashMenu
                      ? `<div class="slash-menu" role="listbox" aria-label="Command suggestions">
                      <div class="slash-menu-group">
                        <div class="slash-menu-group__label">Commands</div>
                        <div class="slash-menu-item slash-menu-item--active" role="option" aria-selected="true">
                          <span class="slash-menu-icon">${iconSvg()}</span>
                          <span class="slash-menu-name">/plan</span>
                          <span class="slash-menu-desc">Create a plan</span>
                        </div>
                        <div class="slash-menu-item" role="option">
                          <span class="slash-menu-icon">${iconSvg()}</span>
                          <span class="slash-menu-name">/review</span>
                          <span class="slash-menu-desc">Review changes</span>
                        </div>
                        <div class="slash-menu-item" role="option">
                          <span class="slash-menu-icon">${iconSvg()}</span>
                          <span class="slash-menu-name">/fix</span>
                          <span class="slash-menu-desc">Fix current issue</span>
                        </div>
                      </div>
                    </div>`
                      : ""
                  }
                  <div class="agent-chat__composer-lede">
                  ${
                    opts.goalMode
                      ? `<div class="agent-chat__goal-mode composer-context-strip">
                        <span class="agent-chat__goal-mode-label composer-context-strip__label"><span class="composer-context-strip__icon">${iconSvg()}</span><span class="composer-context-strip__label-text">Goal</span></span>
                        <span class="agent-chat__goal-mode-hint composer-context-strip__text">Describe what “done” looks like.</span>
                      </div>`
                      : ""
                  }
                  ${
                    opts.composerAttachment
                      ? `<div class="chat-attachments-preview">
                      <div class="chat-attachment-thumb chat-attachment-thumb--file">
                        <div class="chat-attachment-file">
                          <span class="chat-attachment-file__icon">${iconSvg()}</span>
                          <span class="chat-attachment-file__name">landscape-proof-attachment.txt</span>
                        </div>
                        <button class="chat-attachment-remove" type="button" aria-label="Remove attachment">&times;</button>
                      </div>
                    </div>`
                      : ""
                  }
                  </div>
                  <div class="agent-chat__composer-input-row">
                    <div class="agent-chat__composer-combobox">
                      <textarea rows="1">Queued follow-up for the active operator session</textarea>
                    </div>
                  </div>
                  <div class="agent-chat__composer-footer">
                    <div class="agent-chat__composer-lead">
                      <details class="agent-chat__attach-menu">
                        <summary class="agent-chat__input-btn agent-chat__input-btn--attach" aria-label="Add attachment">${iconSvg()}</summary>
                        <div class="agent-chat__attach-menu-popover" role="menu">
                          <button class="agent-chat__attach-menu-option" role="menuitem">${iconSvg()}<span>Camera</span></button>
                          <button class="agent-chat__attach-menu-option" role="menuitem">${iconSvg()}<span>Photo</span></button>
                          <button class="agent-chat__attach-menu-option" role="menuitem">${iconSvg()}<span>File</span></button>
                        </div>
                      </details>
                    </div>
                    <div class="agent-chat__composer-trail">
                    <div class="agent-chat__composer-meta agent-chat__composer-context">
                      <div class="context-usage">
                        <details>
                          <summary class="context-ring" role="status" aria-label="Session context usage: 46k/200k (23%)">
                            <svg class="context-ring__dial" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                              <circle class="context-ring__track" cx="8" cy="8" r="6.5"></circle>
                              <circle class="context-ring__fill" cx="8" cy="8" r="6.5"></circle>
                            </svg>
                          </summary>
                        </details>
                      </div>
                    </div>
                    ${composerControlsHtml()}
                      <div class="agent-chat__composer-actions">
                        <button class="chat-send-btn chat-send-btn--voice" aria-label="Start voice input">${iconSvg()}</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  `;
}

async function syncFixtureComposerPopoverAnchor(page: Page) {
  // The session companion runs the same composer surface, so the pane's own
  // composer is named by its shell rather than by the shared surface class.
  await page.locator(".agent-chat__composer-shell > .agent-chat__input").evaluate((node) => {
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const composerTop = node.getBoundingClientRect().top;
    node.style.setProperty(
      "--chat-composer-popover-max-height",
      `${Math.max(0, composerTop - viewportTop - 28)}px`,
    );
  });
}

async function openFixture(width: number, height: number, opts: ChatFixtureOptions = {}) {
  const page = await openBrowserPage(width, height);
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${readUiCss()}${readStyleSheet("ui/src/components/solid/overlay.css")}</style></head><body>${chatHtml(opts, width <= 1100)}</body></html>`,
    );
    await syncFixtureComposerPopoverAnchor(page);
    return page;
  } catch (error) {
    await closeBrowserPage(page);
    throw error;
  }
}

async function openSessionRailFixture(width: number, height: number) {
  const page = await openBrowserPage(width, height);
  try {
    await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
      <div style="display:flex;height:100dvh">
        <div class="sidebar-region sidebar-region--right sidebar-region--open${width <= 768 ? " sidebar-region--narrow" : ""}" style="--side-panel-width:400px;--side-panel-height:360px">
          <div class="sidebar-region__header">Current session</div>
          <div class="sidebar-region__primary" data-region="main">Conversation</div>
          <div class="sidebar-region__right-runtime">
            <div class="side-panel">
              <header class="rail-header side-panel__header" data-region-header="side">Side chat</header>
              <div class="side-panel__body">
                <div class="side-panel__panel" data-region="side">
                  <openclaw-chat-session-rail>
                    <section class="chat-session-rail chat-session-rail--expanded chat-session-rail--embedded" role="region" aria-label="Side chat">
                      <div class="chat-session-rail__thread">
                        <article class="chat-session-rail__exchange">
                          <div class="chat-group user chat-group--with-footer"><div class="chat-group-messages"><div class="chat-bubble">What should I check next?</div></div></div>
                          <div class="chat-group assistant chat-group--with-footer"><div class="chat-group-messages"><div class="chat-bubble">${LONG_SESSION_RAIL_BODY}</div></div></div>
                          <span class="chat-session-rail__pr-checks">2 passed</span>
                          <div class="chat-session-rail__hint">Side chat is already answering a question.</div>
                        </article>
                      </div>
                      <form class="agent-chat__input chat-session-rail__composer">
                        <div class="agent-chat__composer-input-row">
                          <label class="agent-chat__composer-combobox chat-session-rail__prompt">
                            <textarea class="chat-session-rail__input" rows="1" placeholder="What should I know?"></textarea>
                          </label>
                        </div>
                        <div class="agent-chat__composer-footer">
                          <div class="agent-chat__composer-trail">
                            <div class="agent-chat__composer-actions"><button class="chat-send-btn">${iconSvg()}</button></div>
                          </div>
                        </div>
                      </form>
                    </section>
                  </openclaw-chat-session-rail>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </body></html>`);
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

describeBrowserLayout.concurrent("chat responsive browser layout", () => {
  beforeAll(async () => {
    await layoutBrowser.start();
  });

  afterAll(async () => {
    await layoutBrowser.close();
  });

  it("paints a visible outline when a chat image action receives keyboard focus", async () => {
    await withBrowserPage(openBrowserPage(390, 844), async (page) => {
      await page.setContent(`<style>${readUiCss()}</style>
        <button class="chat-tool-card__preview-image-button">Open image</button>`);
      await page.keyboard.press("Tab");
      const button = page.locator("button");
      await expectBrowser(button).toBeFocused();
      await expectBrowser(button).toHaveCSS("outline-style", "solid");
      await expectBrowser(button).toHaveCSS("outline-width", "2px");
    });
  });

  it("keeps wrapped message footers inside measured virtual rows", async () => {
    await withBrowserPage(openBrowserPage(1366, 900), async (page) => {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-thread" style="width: 220px; height: 400px;">
            <div class="chat-thread-inner chat-thread-inner--virtual" style="width: 220px;">
              <div class="chat-virtual-sizer" style="height: 400px;">
                <div class="chat-virtual-block">
                  <div class="chat-virtual-row" data-first-row >
                    <div
                      class="chat-group assistant chat-group--with-footer"
                      style="--chat-message-max-width: 120px;"
                    >
                      <div class="chat-avatar assistant">A</div>
                      <div class="chat-group-messages">
                        <div class="chat-bubble"><div class="chat-text">A narrow assistant message.</div></div>
                      </div>
                      <div class="chat-group-footer">
                        <div class="chat-group-footer__meta">
                          <span class="chat-sender-name">Assistant</span>
                          <span class="chat-group-timestamp">9:41 PM</span>
                        </div>
                        <div class="chat-group-footer-actions">
                          <button type="button">${iconSvg()}</button>
                          <button type="button">${iconSvg()}</button>
                          <button type="button">${iconSvg()}</button>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="chat-virtual-row" data-second-row>
                    <div class="chat-group user"><div class="chat-group-messages">Next row</div></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </body></html>`,
      );
      await waitForLayoutSettled(page, "[data-first-row], .chat-group-footer");

      const layout = await page.evaluate(() => {
        const first = document.querySelector<HTMLElement>("[data-first-row]")!;
        const second = document.querySelector<HTMLElement>("[data-second-row]")!;
        const avatar = first.querySelector<HTMLElement>(".chat-avatar")!;
        const bubble = first.querySelector<HTMLElement>(".chat-bubble")!;
        const footer = first.querySelector<HTMLElement>(".chat-group-footer")!;
        const firstRect = first.getBoundingClientRect();
        const secondRect = second.getBoundingClientRect();
        const avatarRect = avatar.getBoundingClientRect();
        const bubbleRect = bubble.getBoundingClientRect();
        const footerRect = footer.getBoundingClientRect();
        return {
          avatarTop: avatarRect.top,
          bubbleTop: bubbleRect.top,
          firstBottom: firstRect.bottom,
          footerBottom: footerRect.bottom,
          footerHeight: footerRect.height,
          secondTop: secondRect.top,
        };
      });

      expect(layout.footerHeight).toBeGreaterThan(24);
      expect(layout.avatarTop - layout.bubbleTop).toBeCloseTo(0, 0);
      expect(layout.footerBottom).toBeLessThanOrEqual(layout.firstBottom + 1);
      expect(Math.abs(layout.secondTop - layout.firstBottom)).toBeLessThanOrEqual(1);
    });
  });

  it("wraps long question and approval metadata inside narrow cards", async () => {
    await withBrowserPage(openBrowserPage(320, 568), async (page) => {
      const longToken = `workspace${"x".repeat(240)}session`;
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div data-narrow-card style="width: 220px;">
            <div class="chat-question-panel__heading">
              <span class="chat-question-panel__progress">1/1</span>
              <span class="chat-question-panel__prompt">${longToken}</span>
            </div>
            <div class="exec-approval-meta">
              <div class="exec-approval-meta-row"><span>Session</span><span>${longToken}</span></div>
            </div>
          </div>
        </body></html>`,
      );

      const metrics = await page.evaluate(() => {
        const card = document.querySelector<HTMLElement>("[data-narrow-card]")!;
        const heading = document.querySelector<HTMLElement>(".chat-question-panel__heading")!;
        const row = document.querySelector<HTMLElement>(".exec-approval-meta-row")!;
        return {
          cardRight: card.getBoundingClientRect().right,
          headingRight: heading.getBoundingClientRect().right,
          promptRight: document
            .querySelector<HTMLElement>(".chat-question-panel__prompt")!
            .getBoundingClientRect().right,
          rowRight: row.getBoundingClientRect().right,
          valueRight: row.lastElementChild!.getBoundingClientRect().right,
        };
      });

      expect(metrics.promptRight).toBeLessThanOrEqual(metrics.headingRight + 1);
      expect(metrics.valueRight).toBeLessThanOrEqual(metrics.rowRight + 1);
      expect(metrics.headingRight).toBeLessThanOrEqual(metrics.cardRight + 1);
      expect(metrics.rowRight).toBeLessThanOrEqual(metrics.cardRight + 1);
    });
  });

  it("reserves command text space for flush tool-card actions", async () => {
    await withBrowserPage(openBrowserPage(320, 568), async (page) => {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-tool-card chat-tool-card--flush" style="width: 220px;">
            <div class="chat-tool-card__actions">
              <button class="chat-tool-card__action-btn" type="button">${iconSvg()}</button>
            </div>
            <div class="chat-tool-term">
              <div class="chat-tool-term__cmd"><span class="chat-tool-term__prompt">$</span><code>command with a long first line</code></div>
            </div>
          </div>
        </body></html>`,
      );

      const layout = await page.evaluate(() => {
        const command = document.querySelector<HTMLElement>(".chat-tool-term__cmd")!;
        const actions = document.querySelector<HTMLElement>(".chat-tool-card__actions")!;
        const commandRect = command.getBoundingClientRect();
        return {
          actionLeft: actions.getBoundingClientRect().left,
          commandContentRight:
            commandRect.right - Number.parseFloat(getComputedStyle(command).paddingRight),
        };
      });

      expect(layout.commandContentRight).toBeLessThanOrEqual(layout.actionLeft + 1);
    });
  });

  it("keeps tool-card header actions visible without hover", async () => {
    await withBrowserPage(openBrowserPage(430, 720), async (page) => {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-tool-card">
            <div class="chat-tool-card__header">
              <span>ui/src/styles/chat/tool-cards.css</span>
              <div class="chat-tool-card__actions">
                <button class="chat-tool-card__action-btn" type="button">${iconSvg()}</button>
              </div>
            </div>
          </div>
        </body></html>`,
      );

      expect(
        await page
          .locator(".chat-tool-card__header > .chat-tool-card__actions")
          .evaluate((node) => getComputedStyle(node).opacity),
      ).toBe("1");
    });
  });

  it.each([
    [320, 568, "dark"],
    [1366, 900, "light"],
  ] as const)(
    "wraps inline code without clipping or detached punctuation at %sx%s in %s",
    async (width, height, themeMode) => {
      await withBrowserPage(openBrowserPage(width, height), async (page) => {
        await page.setContent(
          `<!doctype html><html data-theme-mode="${themeMode}"><head><style>${readUiCss()}</style></head><body>
          <div class="chat-thread" role="log">
            <div class="chat-thread-inner">
              <div class="chat-group assistant">
                <div class="chat-avatar assistant">A</div>
                <div class="chat-group-messages">
                  <div class="chat-bubble">
                    <div class="chat-text">
                      <p><code data-long-code>openclaw_message_send_channel_webchat_target_example_com_thread_very_long_identifier_without_spaces_1234567890abcdefghijklmnopqrstuvwxyz</code></p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="chat-text" data-inline-punctuation><p>Use <code>status</code>; then <code>restart</code>.</p></div>
        </body></html>`,
        );

        await expectNoHorizontalOverflow(page);
        const bubble = await getRect(page, ".chat-bubble");
        const inlineCode = await getRect(page, "[data-long-code]");
        expect(inlineCode.right).toBeLessThanOrEqual(bubble.right + 1);
        const spacing = await page.locator("[data-inline-punctuation] code").evaluateAll((nodes) =>
          nodes.map((node) => {
            const punctuation = node.nextSibling;
            if (!(punctuation instanceof Text)) {
              throw new Error("Expected punctuation text after inline code");
            }
            const range = document.createRange();
            range.selectNodeContents(node);
            const textRect = range.getBoundingClientRect();
            range.setStart(punctuation, 0);
            range.setEnd(punctuation, 1);
            const punctuationRect = range.getBoundingClientRect();
            range.detach();
            const chipRect = (node as HTMLElement).getBoundingClientRect();
            const paragraph = (node as HTMLElement).parentElement;
            if (!paragraph) {
              throw new Error("Expected inline code inside a paragraph");
            }
            return {
              horizontalGap: punctuationRect.left - textRect.right,
              chipHeight: chipRect.height,
              lineHeight: Number.parseFloat(getComputedStyle(paragraph).lineHeight),
            };
          }),
        );

        expect(spacing).toHaveLength(2);
        for (const { horizontalGap, chipHeight, lineHeight } of spacing) {
          // The gap is the chip's em-derived inset plus its border, so a quarter of
          // the 14px prose size holds on every platform.
          expect(horizontalGap).toBeLessThanOrEqual(3.75);
          // Measure the chip against the paragraph's CSS line box rather than a text
          // rect: the chip's content height follows the monospace font's default line
          // spacing, which differs by several px between macOS and Linux.
          expect(lineHeight).toBeGreaterThan(0);
          expect(chipHeight).toBeLessThanOrEqual(lineHeight + 1);
        }
      });
    },
  );

  it("keeps the expanded mobile composer inset, scrollable, and flush with the thread", async () => {
    await withBrowserPage(openFixture(393, 852), async (page) => {
      const textarea = page.locator(".agent-chat__composer-combobox > textarea");
      // Comfortably past a quarter of the tallest viewport this case runs at,
      // so the assertion below proves the cap and the scroll, not the draft.
      await textarea.fill(
        Array.from({ length: 16 }, (_value, index) => `Mobile composer line ${index + 1}`).join(
          "\n",
        ),
      );
      await textarea.evaluate((node) => {
        const textareaNode = node as HTMLTextAreaElement;
        textareaNode.style.height = `${textareaNode.scrollHeight}px`;
      });
      await page.locator(".context-ring").evaluate(finishElementAnimations);

      const layout = await page.evaluate(() => {
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
          };
        };
        const textareaNode = document.querySelector<HTMLTextAreaElement>(
          ".agent-chat__composer-combobox > textarea",
        );
        const textareaStyle = textareaNode ? getComputedStyle(textareaNode) : null;
        const textareaRect = rectFor(".agent-chat__composer-combobox > textarea");
        return {
          attach: rectFor('.agent-chat__input-btn[aria-label="Add attachment"]'),
          attachIcon: rectFor('.agent-chat__input-btn[aria-label="Add attachment"] svg'),
          input: rectFor(".agent-chat__composer-shell > .agent-chat__input"),
          meta: rectFor(".agent-chat__composer-meta"),
          model: rectFor(".chat-composer-model-control"),
          context: rectFor(".context-ring"),
          send: rectFor(".chat-send-btn"),
          shell: rectFor(".agent-chat__composer-shell"),
          textarea:
            textareaNode && textareaRect
              ? {
                  ...textareaRect,
                  clientHeight: textareaNode.clientHeight,
                  lineHeight: Number.parseFloat(textareaStyle?.lineHeight ?? "0"),
                  paddingBottom: Number.parseFloat(textareaStyle?.paddingBottom ?? "0"),
                  paddingTop: Number.parseFloat(textareaStyle?.paddingTop ?? "0"),
                  scrollHeight: textareaNode.scrollHeight,
                }
              : null,
          thread: rectFor(".chat-thread"),
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
        };
      });

      const shell = expectControlRect(layout.shell, "composer shell");
      const input = expectControlRect(layout.input, "composer input");
      const thread = expectControlRect(layout.thread, "chat thread");
      const meta = expectControlRect(layout.meta, "composer metadata");
      const model = expectControlRect(layout.model, "model selector");
      const context = expectControlRect(layout.context, "context control");
      const send = expectControlRect(layout.send, "primary action");
      const attach = expectControlRect(layout.attach, "attachment control");
      const attachIcon = expectControlRect(layout.attachIcon, "attachment icon");
      const textareaRect = expectControlRect(layout.textarea, "composer textarea");
      const textareaMetrics = layout.textarea;
      if (
        textareaMetrics?.clientHeight === undefined ||
        textareaMetrics.scrollHeight === undefined ||
        textareaMetrics.lineHeight === undefined ||
        textareaMetrics.paddingTop === undefined ||
        textareaMetrics.paddingBottom === undefined
      ) {
        throw new Error("Expected textarea sizing metrics");
      }

      // The editor grows against the viewport, not against a line count: past a
      // quarter of the screen the surface stops moving and the draft scrolls
      // inside it, so a long draft can never push the thread off the page.
      expect(textareaRect.height).toBeLessThanOrEqual(layout.viewportHeight * 0.25 + 1);
      expect(textareaMetrics.scrollHeight).toBeGreaterThan(textareaMetrics.clientHeight);
      expect(input.y - (thread.y + thread.height)).toBeCloseTo(0, 0);
      expect(shell.x).toBeCloseTo(16, 0); // Composer inset; the full-bleed shell adds none.
      expect(layout.viewportWidth - (shell.x + shell.width)).toBeCloseTo(shell.x, 0);
      expect(attach.x - input.x).toBeLessThanOrEqual(10);
      expect(model.x).toBeGreaterThanOrEqual(context.x + context.width - 1);
      expect(input.x + input.width - (send.x + send.width)).toBeCloseTo(attach.x - input.x, 0);
      for (const control of [model, context]) {
        expect(
          Math.abs(control.y + control.height / 2 - (model.y + model.height / 2)),
        ).toBeLessThanOrEqual(2);
      }
      expect(meta.y).toBeGreaterThanOrEqual(model.y - 1);
      expect(attachIcon.width).toBeGreaterThanOrEqual(16);
      expect(attachIcon.height).toBeGreaterThanOrEqual(16);
    });
  });

  it("keeps transient footer controls from crushing mobile model settings", async () => {
    await withBrowserPage(openFixture(320, 568, { crowdedComposerFooter: true }), async (page) => {
      await expectNoHorizontalOverflow(page);
      const layout = await page.evaluate(() => {
        const rectFor = (selector: string) => {
          const node = document.querySelector<HTMLElement>(selector)!;
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
            overflow: style.overflow,
            textOverflow: style.textOverflow,
          };
        };
        return {
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
          },
          controls: rectFor(".agent-chat__composer-controls"),
          footer: rectFor(".agent-chat__composer-footer"),
          input: rectFor(".agent-chat__input"),
          meta: rectFor(".agent-chat__composer-meta"),
          settings: rectFor(".chat-controls__model-trigger"),
          typing: rectFor(".agent-chat__typing-indicator--outside"),
        };
      });

      expect(layout.viewport).toEqual({ width: 320, height: 568 });
      expect(layout.controls.scrollWidth).toBeLessThanOrEqual(layout.controls.clientWidth + 1);
      expect(layout.settings.x).toBeGreaterThanOrEqual(layout.footer.x - 1);
      expect(layout.settings.x + layout.settings.width).toBeLessThanOrEqual(
        layout.footer.x + layout.footer.width + 1,
      );
      expect(layout.typing.x).toBeGreaterThanOrEqual(0);
      expect(layout.typing.x + layout.typing.width).toBeLessThanOrEqual(layout.viewport.width);
      expect(layout.settings.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
      expect(layout.settings.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
      expect(rectsOverlap(layout.settings, layout.meta)).toBe(false);
      expect(rectsOverlap(layout.typing, layout.footer)).toBe(false);
    });
  });

  it.each([
    [320, 568],
    [430, 932],
    [768, 1024],
    [1024, 768],
    [568, 320],
    [1920, 1080],
  ] as const)(
    "keeps the composer bottom controls, attachment, and primary action aligned at %sx%s",
    async (width, height) => {
      await withBrowserPage(openFixture(width, height), async (page) => {
        await expectNoHorizontalOverflow(page);
        const code = await getBoundingBox(page, ".chat-text pre");
        expect(code.x + code.width).toBeLessThanOrEqual(width + 1);
        // Wall-clock sleeps can expire before Chromium advances compositor animations
        // on a contended CI runner. Measure the footer after its finite entrance effect.
        await page.locator(".context-ring").evaluate(finishElementAnimations);
        const controls = await page.evaluate(() => {
          const rectFor = (selector: string) => {
            const node = document.querySelector(selector) as HTMLElement | null;
            if (!node) {
              return null;
            }
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              clientWidth: node.clientWidth,
              scrollWidth: node.scrollWidth,
              display: style.display,
              overflow: style.overflow,
              textOverflow: style.textOverflow,
            };
          };
          const paddingFor = (selector: string) => {
            const node = document.querySelector(selector) as HTMLElement | null;
            if (!node) {
              return null;
            }
            const style = getComputedStyle(node);
            return {
              end: Number.parseFloat(style.paddingInlineEnd),
              start: Number.parseFloat(style.paddingInlineStart),
            };
          };
          return {
            chat: rectFor(".chat"),
            shell: rectFor(".agent-chat__composer-shell"),
            input: rectFor(".agent-chat__composer-shell > .agent-chat__input"),
            thread: rectFor(".chat-thread"),
            footer: rectFor(".agent-chat__composer-footer"),
            textarea: rectFor(".agent-chat__composer-combobox > textarea"),
            meta: rectFor(".agent-chat__composer-meta"),
            model: rectFor(".chat-composer-model-control"),
            modelSettings: rectFor(".chat-controls__model-trigger"),
            modelTrigger: rectFor(".chat-controls__model-trigger"),
            modelTriggerPadding: paddingFor(".chat-controls__model-trigger"),
            modelLabel: rectFor(
              ".chat-controls__model-trigger .chat-controls__inline-select-label",
            ),
            effortTrigger: rectFor(".chat-controls__effort-trigger"),
            effortTriggerPadding: paddingFor(".chat-controls__effort-trigger"),
            effortLabel: rectFor(
              ".chat-controls__effort-trigger .chat-controls__inline-select-label",
            ),
            context: rectFor(".context-ring"),
            attach: rectFor('.agent-chat__input-btn[aria-label="Add attachment"]'),
            send: rectFor(".chat-send-btn"),
          };
        });

        const chat = expectControlRect(controls.chat, "chat surface");
        const shell = expectControlRect(controls.shell, "composer shell");
        const input = expectControlRect(controls.input, "composer");
        const thread = expectControlRect(controls.thread, "chat thread");
        const footer = expectControlRect(controls.footer, "composer footer");
        const textarea = expectControlRect(controls.textarea, "composer textarea");
        const meta = expectControlRect(controls.meta, "composer metadata");
        const model = expectControlRect(controls.model, "composer model control");
        const context = expectControlRect(controls.context, "composer context control");
        const attach = expectControlRect(controls.attach, "composer attach control");
        const send = expectControlRect(controls.send, "composer send control");

        for (const control of [footer, textarea, meta, model, context, attach, send]) {
          expect(control.x).toBeGreaterThanOrEqual(input.x - 1);
          expect(control.x + control.width).toBeLessThanOrEqual(input.x + input.width + 1);
        }
        for (const control of [input, send]) {
          expect(control.x).toBeGreaterThanOrEqual(shell.x - 1);
          expect(control.x + control.width).toBeLessThanOrEqual(shell.x + shell.width + 1);
        }
        expect(model.y).toBeGreaterThanOrEqual(footer.y - 1);
        expect(model.y + model.height).toBeLessThanOrEqual(footer.y + footer.height + 1);
        expect(model.y).toBeGreaterThanOrEqual(textarea.y);
        expect(context.y).toBeGreaterThanOrEqual(textarea.y);
        // The multiline footer is one row: the leading attachment control and
        // trailing action group share its vertical bounds without overlapping.
        expect(attach.y).toBeGreaterThanOrEqual(footer.y - 1);
        expect(attach.y + attach.height).toBeLessThanOrEqual(footer.y + footer.height + 1);
        expect(send.y).toBeGreaterThanOrEqual(footer.y - 1);
        expect(send.y + send.height).toBeLessThanOrEqual(footer.y + footer.height + 1);
        // Footer controls stay below the editor, pinned to opposite edges of the
        // surface, and neither may drift back up into the text.
        expect(attach.y).toBeGreaterThanOrEqual(textarea.y + textarea.height - 1);
        expect(send.y).toBeGreaterThanOrEqual(textarea.y + textarea.height - 1);
        expect(attach.x).toBeLessThan(send.x);
        expect(send.x + send.width).toBeLessThanOrEqual(input.x + input.width + 1);
        expect(rectsOverlap(model, send)).toBe(false);
        const contextModelGap = model.x - (context.x + context.width);
        expect(contextModelGap).toBeGreaterThanOrEqual(-1);
        expect(
          Math.abs(context.y + context.height / 2 - (model.y + model.height / 2)),
        ).toBeLessThanOrEqual(2);
        const composerFontSizes = await page.evaluate(() => {
          const textareaNode = document.querySelector<HTMLTextAreaElement>(
            ".agent-chat__composer-combobox > textarea",
          );
          const selectors = [
            ".chat-controls__model-trigger .chat-controls__inline-select-label",
            ".chat-controls__effort-trigger .chat-controls__inline-select-label",
          ];
          if (!textareaNode) {
            throw new Error("Missing composer textarea");
          }
          const fontSize = (node: Element, pseudo?: string) =>
            Number.parseFloat(getComputedStyle(node, pseudo).fontSize);
          return {
            labels: selectors.map((selector) => {
              const label = document.querySelector(selector);
              if (!label) {
                throw new Error(`Missing composer label: ${selector}`);
              }
              return fontSize(label);
            }),
            placeholder: fontSize(textareaNode, "::placeholder"),
            textarea: fontSize(textareaNode),
          };
        });
        expect(composerFontSizes).toEqual({
          labels: [13, 13],
          placeholder: 14,
          textarea: 14,
        });
        if (width === 320) {
          expect(attach.width).toBeGreaterThanOrEqual(32);
          expect(attach.height).toBeGreaterThanOrEqual(32);
          await page
            .locator('.agent-chat__input-btn[aria-label="Add attachment"]')
            .click({ trial: true });
        }
        if (width <= 480) {
          const modelSettings = expectControlRect(
            controls.modelSettings,
            "composer model settings",
          );
          expect(model.width).toBeGreaterThanOrEqual(40);
          expect(model.width).toBeLessThanOrEqual(footer.width);
          expect(modelSettings.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
          expect(modelSettings.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
          expect(modelSettings.x).toBeGreaterThanOrEqual(context.x + context.width - 1);
        } else {
          const modelTrigger = expectControlRect(controls.modelTrigger, "composer model trigger");
          const modelLabel = expectControlRect(controls.modelLabel, "composer model label");
          const effortTrigger = expectControlRect(
            controls.effortTrigger,
            "composer thinking trigger",
          );
          const effortLabel = expectControlRect(controls.effortLabel, "composer thinking label");
          expect(controls.modelTriggerPadding).not.toBeNull();
          expect(controls.effortTriggerPadding).not.toBeNull();
          for (const label of [modelLabel, effortLabel]) {
            expect(label.scrollWidth ?? 0).toBeLessThanOrEqual((label.clientWidth ?? 0) + 1);
          }
          expect(modelTrigger.x).toBeGreaterThanOrEqual(model.x - 1);
          expect(effortTrigger.x).toBeGreaterThanOrEqual(modelTrigger.x + modelTrigger.width - 1);
        }
        expect(send.width).toBeGreaterThanOrEqual(32);
        expect(send.height).toBeGreaterThanOrEqual(32);
        expect(
          Math.abs(attach.y + attach.height / 2 - send.y - send.height / 2),
        ).toBeLessThanOrEqual(1);

        if (width >= 1600) {
          expect(shell.width).toBeGreaterThanOrEqual(767);
          expect(shell.width).toBeLessThanOrEqual(769);
          expect(
            Math.abs(shell.x + shell.width / 2 - (chat.x + chat.width / 2)),
          ).toBeLessThanOrEqual(1);
          expect(input.height).toBeLessThanOrEqual(119);
        }

        if (width > height && height <= 500) {
          expect(input.height).toBeLessThanOrEqual(height * 0.38);
          expect(thread.height).toBeGreaterThanOrEqual(height * 0.4 - 1);
          expect(textarea.height).toBeLessThanOrEqual(56.1);
        }
      });
    },
  );

  it.each([
    [320, 568],
    [844, 390],
    [1440, 1000],
  ] as const)(
    "aligns attachment previews with draft text without clipping remove targets at %sx%s",
    async (width, height) => {
      await withBrowserPage(
        openFixture(width, height, { composerAttachment: true }),
        async (page) => {
          await expectNoHorizontalOverflow(page);
          await page.locator(".chat-attachment-remove").focus();
          await page.locator(".chat-attachment-remove").evaluate(finishElementAnimations);
          await page.locator(".agent-chat__input").evaluate((node) => {
            node.scrollTop = 0;
          });
          const { input, preview, attachment, remove, topHits, textStart } = await page.evaluate(
            () => {
              const elementFor = (selector: string) => {
                const [element, ...others] = document.querySelectorAll(selector);
                if (!element || others.length > 0) {
                  throw new Error(`Expected one layout element: ${selector}`);
                }
                return element;
              };
              const rectFor = (selector: string) => {
                const {
                  x,
                  y,
                  width: rectWidth,
                  height: rectHeight,
                } = elementFor(selector).getBoundingClientRect();
                return { x, y, width: rectWidth, height: rectHeight };
              };
              const removeNode = elementFor(".chat-attachment-remove");
              const removeRect = rectFor(".chat-attachment-remove");
              const textarea = elementFor(".agent-chat__composer-combobox > textarea");
              return {
                input: rectFor(".agent-chat__composer-shell > .agent-chat__input"),
                preview: rectFor(".chat-attachments-preview"),
                attachment: rectFor(".chat-attachment-thumb"),
                remove: removeRect,
                topHits: [1, 3].map(
                  (offset) =>
                    document.elementFromPoint(
                      removeRect.x + removeRect.width / 2,
                      removeRect.y + offset,
                    ) === removeNode,
                ),
                textStart:
                  textarea.getBoundingClientRect().x +
                  Number.parseFloat(getComputedStyle(textarea).paddingLeft),
              };
            },
          );
          for (const rect of [input, preview, attachment, remove]) {
            expectFiniteRect(rect);
          }

          expect(attachment.x - input.x).toBeGreaterThanOrEqual(9.5);
          expect(Math.abs(attachment.x - textStart)).toBeLessThanOrEqual(0.5);
          expect(preview.x).toBeGreaterThanOrEqual(input.x);
          expect(remove.y).toBeGreaterThanOrEqual(preview.y);
          expect(remove.x + remove.width).toBeLessThanOrEqual(preview.x + preview.width);
          expect(topHits).toEqual([true, true]);

          await page.locator(".chat-attachments-preview").evaluate((node) => {
            const firstAttachment = node.querySelector(".chat-attachment-thumb")!;
            for (let index = 0; index < 7; index++) {
              node.append(firstAttachment.cloneNode(true));
            }
            node.scrollLeft = node.scrollWidth;
          });
          const lastRemove = page.locator(".chat-attachment-remove").last();
          await lastRemove.focus();
          await lastRemove.evaluate(finishElementAnimations);
          const rightHits = await lastRemove.evaluate((node) => {
            const bounds = node.getBoundingClientRect();
            return [1, 3].map(
              (offset) =>
                document.elementFromPoint(bounds.right - offset, bounds.y + bounds.height / 2) ===
                node,
            );
          });
          expect(rightHits).toEqual([true, true]);
        },
      );
    },
  );

  it.each([
    { dock: "narrow", width: 620, height: 600 },
    { dock: "bottom", width: 900, height: 300 },
    { dock: "bottom", width: 900, height: 1000 },
  ])(
    "keeps both stacked panels usable at $width×$height ($dock)",
    async ({ dock, width, height }) => {
      await withBrowserPage(openBrowserPage(1000, 1100), async (page) => {
        await page.setContent(
          `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div style="width: ${width}px; height: ${height}px; display: flex;">
            <div class="sidebar-region sidebar-region--${dock} sidebar-region--open" style="--side-panel-height: 360px">
              <main class="sidebar-region__primary" data-region="main">Primary chat</main>
              <section class="side-panel">
                <div class="rail-header side-panel__header" data-region-header="side">Details</div>
                <div class="side-panel__body">
                  <div class="side-panel__panel" data-region="side">Active detail panel</div>
                </div>
              </section>
            </div>
          </div>
        </body></html>`,
        );

        await expectNoHorizontalOverflow(page);
        const primary = await getRect(page, ".sidebar-region__primary");
        const sidebar = await getRect(page, '[data-region="side"]');
        expect(sidebar.top).toBeGreaterThanOrEqual(primary.bottom - 1);
        expect(Math.abs(sidebar.width - primary.width)).toBeLessThanOrEqual(1);
        expect(sidebar.width).toBeGreaterThanOrEqual(width - 2);
        expect(primary.height).toBeGreaterThan(80);
        expect(sidebar.height).toBeGreaterThan(80);
        expect(sidebar.bottom - primary.top).toBe(height);
        if (dock === "bottom" && height === 1000) {
          expect(sidebar.height).toBe(360);
        }
        expect(await page.locator(".side-panel").count()).toBe(1);
      });
    },
  );

  it("keeps short-landscape composer adjunct rows scroll-reachable", async () => {
    await withBrowserPage(
      openFixture(568, 320, { composerAttachment: true, goalMode: true }),
      async (page) => {
        await page
          .locator(".agent-chat__composer-combobox > textarea")
          .fill(
            Array.from(
              { length: 10 },
              (_value, index) =>
                `Landscape proof line ${index + 1}: keep transcript visible while this long draft scrolls inside the bounded composer.`,
            ).join("\n"),
          );

        const initial = await page.evaluate(() => {
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
              clientHeight: node.clientHeight,
              scrollHeight: node.scrollHeight,
              scrollTop: node.scrollTop,
            };
          };
          return {
            input: rectFor(".agent-chat__composer-shell > .agent-chat__input"),
            thread: rectFor(".chat-thread"),
            textarea: rectFor(".agent-chat__composer-combobox > textarea"),
          };
        });

        const input = expectControlRect(initial.input, "composer");
        const thread = expectControlRect(initial.thread, "chat thread");
        const textarea = expectControlRect(initial.textarea, "composer textarea");
        expect(input.height).toBeLessThanOrEqual(320 * 0.38);
        expect(thread.height).toBeGreaterThanOrEqual(320 * 0.4 - 1);
        if (
          input.scrollHeight === undefined ||
          input.clientHeight === undefined ||
          textarea.scrollHeight === undefined ||
          textarea.clientHeight === undefined
        ) {
          throw new Error("Expected scroll metrics for short-landscape composer");
        }
        expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
        expect(
          await page
            .locator(".agent-chat__input")
            .evaluate((node) => getComputedStyle(node).overflowY),
        ).toBe("auto");
        expect(
          await page.locator(".agent-chat__goal-mode").evaluate((node) => {
            const style = getComputedStyle(node);
            return {
              borderBottomStyle: style.borderBottomStyle,
              borderLeftStyle: style.borderLeftStyle,
              borderRadius: style.borderRadius,
              marginBottom: style.marginBottom,
            };
          }),
        ).toEqual({
          borderBottomStyle: "solid",
          borderLeftStyle: "none",
          borderRadius: "0px",
          marginBottom: "0px",
        });
        expect(textarea.scrollHeight).toBeGreaterThan(textarea.clientHeight);

        const scrolled = await page.evaluate(() => {
          const composer = document.querySelector(
            ".agent-chat__composer-shell > .agent-chat__input",
          ) as HTMLElement | null;
          if (composer) {
            composer.scrollTop = composer.scrollHeight;
          }
          const rectFor = (selector: string) => {
            const node = document.querySelector(selector) as HTMLElement | null;
            if (!node) {
              return null;
            }
            const rect = node.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          };
          return {
            shell: rectFor(".agent-chat__composer-shell"),
            input: rectFor(".agent-chat__composer-shell > .agent-chat__input"),
            meta: rectFor(".agent-chat__composer-meta"),
            model: rectFor(".chat-composer-model-control"),
            scrollTop: composer?.scrollTop ?? 0,
            send: rectFor(".chat-send-btn"),
          };
        });

        const scrolledShell = expectControlRect(scrolled.shell, "scrolled composer shell");
        const scrolledInput = expectControlRect(scrolled.input, "scrolled composer");
        expect(scrolled.scrollTop).toBeGreaterThan(0);
        for (const [label, control] of [
          ["composer metadata", scrolled.meta],
          ["composer model control", scrolled.model],
        ] as const) {
          const rect = expectControlRect(control, label);
          expect(rect.y).toBeGreaterThanOrEqual(scrolledInput.y - 1);
          expect(rect.y + rect.height).toBeLessThanOrEqual(
            scrolledInput.y + scrolledInput.height + 1,
          );
        }
        const send = expectControlRect(scrolled.send, "composer send control");
        expect(send.y).toBeGreaterThanOrEqual(scrolledShell.y - 1);
        expect(send.y + send.height).toBeLessThanOrEqual(
          scrolledShell.y + scrolledShell.height + 1,
        );
      },
    );
  });

  it("keeps short-landscape slash menu visible inside the bounded composer", async () => {
    await withBrowserPage(
      openFixture(568, 320, {
        composerAttachment: true,
        slashMenu: true,
      }),
      async (page) => {
        await page.locator(".agent-chat__composer-combobox > textarea").fill("/review");

        const initial = await page.evaluate(() => {
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
              clientHeight: node.clientHeight,
              scrollHeight: node.scrollHeight,
              scrollTop: node.scrollTop,
            };
          };
          return {
            input: rectFor(".agent-chat__composer-shell > .agent-chat__input"),
            menu: rectFor(".slash-menu"),
            textarea: rectFor(".agent-chat__composer-combobox > textarea"),
            footer: rectFor(".agent-chat__composer-footer"),
          };
        });

        const input = expectControlRect(initial.input, "composer");
        const menu = expectControlRect(initial.menu, "slash menu");
        const textarea = expectControlRect(initial.textarea, "composer textarea");
        expect(input.height).toBeLessThanOrEqual(320 * 0.38);
        if (input.scrollHeight === undefined || input.clientHeight === undefined) {
          throw new Error("Expected scroll metrics for slash-menu composer");
        }
        expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
        expect(menu.y).toBeGreaterThanOrEqual(input.y - 1);
        expect(menu.y + menu.height).toBeLessThanOrEqual(input.y + input.height + 1);
        expect(menu.height).toBeGreaterThanOrEqual(48);
        expect(menu.height).toBeLessThanOrEqual(89);
        expect(textarea.y).toBeGreaterThan(menu.y);

        const scrolled = await page.evaluate(() => {
          const composer = document.querySelector(
            ".agent-chat__composer-shell > .agent-chat__input",
          ) as HTMLElement | null;
          if (composer) {
            composer.scrollTop = composer.scrollHeight;
          }
          const rectFor = (selector: string) => {
            const node = document.querySelector(selector) as HTMLElement | null;
            if (!node) {
              return null;
            }
            const rect = node.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          };
          return {
            input: rectFor(".agent-chat__composer-shell > .agent-chat__input"),
            footer: rectFor(".agent-chat__composer-footer"),
          };
        });

        const scrolledInput = expectControlRect(scrolled.input, "scrolled composer");
        const footer = expectControlRect(scrolled.footer, "composer footer");
        expect(footer.y).toBeGreaterThanOrEqual(scrolledInput.y - 1);
        expect(footer.y + footer.height).toBeLessThanOrEqual(
          scrolledInput.y + scrolledInput.height + 1,
        );
      },
    );
  });

  it("keeps mobile slash command copy in separate grid tracks", async () => {
    await withBrowserPage(openBrowserPage(390, 844), async (page) => {
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <div class="slash-menu" style="position: relative">
          <div class="slash-menu-item" role="option">
            <span class="slash-menu-icon">${iconSvg()}</span>
            <span class="slash-menu-copy">
              <span class="slash-menu-name">/session <span class="slash-menu-args">idle max-age &lt;duration|off&gt;</span></span>
              <span class="slash-menu-desc">Manage session-level settings (for example /session idle).</span>
            </span>
          </div>
        </div>
      </body></html>`);

      const geometry = await page.locator(".slash-menu-copy").evaluate((copy) => {
        const name = copy.querySelector<HTMLElement>(".slash-menu-name")!;
        const description = copy.querySelector<HTMLElement>(".slash-menu-desc")!;
        const nameRect = name.getBoundingClientRect();
        const descriptionRect = description.getBoundingClientRect();
        return {
          copyOverflow: copy.scrollWidth - copy.clientWidth,
          gap: descriptionRect.left - nameRect.right,
        };
      });

      expect(geometry.copyOverflow).toBeLessThanOrEqual(1);
      expect(geometry.gap).toBeGreaterThanOrEqual(8);
    });
  });

  it("allows pointer selection in the embedded side-chat transcript", async () => {
    await withBrowserPage(openBrowserPage(1024, 768), async (page) => {
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <section class="chat-session-rail chat-session-rail--expanded chat-session-rail--embedded">
          <div class="chat-session-rail__thread">
            <article class="chat-session-rail__exchange">
              <div class="chat-bubble">
                <span data-selection-target>Copy this side chat answer.</span>
              </div>
            </article>
          </div>
        </section>
      </body></html>`);

      const target = page.locator("[data-selection-target]");
      const box = await target.boundingBox();
      if (!box) {
        throw new Error("Expected side-chat selection target");
      }
      await page.mouse.move(box.x + 1, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();

      const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactDir) {
        await mkdir(artifactDir, { recursive: true });
        await page.screenshot({
          animations: "disabled",
          path: path.join(artifactDir, "side-chat-selection.png"),
        });
      }

      expect(await page.evaluate(() => window.getSelection()?.toString().trim())).toBe(
        "Copy this side chat answer.",
      );
    });
  });

  it.each([
    [320, 568],
    [1024, 768],
  ] as const)(
    "keeps embedded side-chat scrolling, composer, and metadata within its panel at %sx%s",
    async (width, height) => {
      await withBrowserPage(openSessionRailFixture(width, height), async (page) => {
        await expectNoHorizontalOverflow(page);
        const panel = await page.evaluate(() => {
          const element = document.querySelector<HTMLElement>(".chat-session-rail")!;
          const host = document.querySelector<HTMLElement>(".side-panel__panel")!;
          return {
            clientHeight: element.clientHeight,
            hostHeight: host.clientHeight,
            position: getComputedStyle(element).position,
          };
        });
        expect(panel.position).toBe("relative");
        expect(panel.clientHeight).toBeLessThanOrEqual(panel.hostHeight);
        expect(panel.hostHeight).toBeLessThanOrEqual(height);

        const body = await page.locator(".chat-session-rail__thread").evaluate((node) => ({
          overflowY: getComputedStyle(node).overflowY,
          clientHeight: node.clientHeight,
          scrollHeight: node.scrollHeight,
        }));
        expect(body.overflowY).toBe("auto");
        expect(body.clientHeight).toBeLessThan(body.scrollHeight);
        const scrollTop = await page.locator(".chat-session-rail__thread").evaluate((node) => {
          node.scrollTop = node.scrollHeight;
          return node.scrollTop;
        });
        expect(scrollTop).toBeGreaterThan(0);
        const rail = await getRect(page, ".chat-session-rail");
        const composer = await getRect(page, ".chat-session-rail__composer");
        expect(composer.bottom).toBeLessThanOrEqual(rail.bottom + 1);
        const geometry = await page.evaluate(() => {
          const rect = (selector: string) => {
            const element = document.querySelector<HTMLElement>(selector)!;
            const box = element.getBoundingClientRect();
            return { left: box.left, right: box.right, width: box.width };
          };
          const thread = document.querySelector<HTMLElement>(".chat-session-rail__thread")!;
          const threadStyle = getComputedStyle(thread);
          return {
            composer: rect(".chat-session-rail__composer"),
            footer: rect(".chat-session-rail__composer .agent-chat__composer-footer"),
            input: rect(".chat-session-rail__input"),
            send: rect(".chat-session-rail__composer .chat-send-btn"),
            threadBorderTopWidth: threadStyle.borderTopWidth,
            threadMarginTop: threadStyle.marginTop,
          };
        });

        expect(geometry.input.width).toBeGreaterThan(geometry.composer.width * 0.8);
        expect(geometry.footer.width).toBeGreaterThan(geometry.composer.width * 0.8);
        expect(Math.abs(geometry.composer.right - geometry.send.right)).toBeLessThanOrEqual(10);
        expect(geometry.threadBorderTopWidth).toBe("0px");
        expect(geometry.threadMarginTop).toBe("0px");
        const styles = await page.evaluate(() => {
          const read = (selector: string) => {
            const style = getComputedStyle(document.querySelector(selector) as HTMLElement);
            return {
              minHeight: style.minHeight,
              overflowY: style.overflowY,
              borderTopWidth: style.borderTopWidth,
            };
          };
          return {
            thread: read(".chat-session-rail__thread"),
            prChecks: read(".chat-session-rail__pr-checks"),
            hint: read(".chat-session-rail__hint"),
          };
        });

        // PR checks and hints are metadata inside an exchange. Sharing the
        // thread's rule would give each one a 96px scrolling bordered box; the
        // selector list has silently merged before.
        expect(styles.thread.minHeight).toBe("96px");
        expect(styles.thread.overflowY).toBe("auto");
        for (const metadata of [styles.prChecks, styles.hint]) {
          // Relational, not a literal: the point is that these nodes do not share
          // the thread's rule, whatever the thread's own numbers become.
          expect(metadata.minHeight).not.toBe(styles.thread.minHeight);
          expect(metadata.overflowY).toBe("visible");
          expect(metadata.borderTopWidth).toBe("0px");
        }
      });
    },
  );
});
for (const engine of [chromium, webkit]) {
  const executablePath = engine === chromium ? chromiumExecutablePath : engine.executablePath();
  // The normal UI lane provisions Chromium; run the same regression in WebKit
  // when installed so Safari's different intrinsic grid sizing stays covered.
  describe.skipIf(!existsSync(executablePath))(
    `${engine.name()} image alignment`,
    { concurrent: false },
    () => {
      let browser: Browser;
      beforeAll(async () => {
        browser = await engine.launch({ executablePath });
      });
      afterAll(async () => {
        await browser?.close();
      });
      it.each([
        [1440, 1600, 1200],
        [1440, 1800, 420],
        [375, 1800, 420],
      ])(
        "keeps %ipx-wide chat image frames on their visible edges (%i×%i)",
        async (viewportWidth, width, height) => {
          await withBrowserPage(
            browser.newPage({ viewport: { width: viewportWidth, height: 900 } }),
            async (page) => {
              const source = `data:image/svg+xml,${encodeURIComponent(
                `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="teal"/></svg>`,
              )}`;
              const prompt = `<div class="chat-text"><p>Review this image.</p><p>Keep paragraph spacing.</p></div>`;
              await page.setContent(`<!doctype html><html style="--chat-text-size: 20px"><head><style>${readUiCss()}</style></head><body>
                <main style="width: 740px; max-width: 100%; margin: auto">
                  ${["user", "user chat-group--peer", "assistant"]
                    .map(
                      (role) => `<div class="chat-group ${role}">
                        <div class="chat-group-messages">
                          <div class="chat-bubble chat-bubble--with-images">
                            <div class="chat-message-images chat-message-images--single">
                              <span class="chat-image-frame"><button class="chat-message-image-button" type="button">
                                <img class="chat-message-image" src="${source}" width="${width}" height="${height}" alt="Large attachment" />
                              </button></span>
                            </div>
                            ${role === "assistant" ? prompt : `<div class="chat-message-avatar-anchor">${prompt}</div>`}
                          </div>
                        </div>
                      </div>`,
                    )
                    .join("")}
                </main></body></html>`);
              await page
                .locator("img")
                .evaluateAll((images: HTMLImageElement[]) =>
                  Promise.all(images.map((image) => image.decode())),
                );
              const rows = await page.locator(".chat-group").evaluateAll((groups) =>
                groups.map((group) => {
                  const box = (selector: string) =>
                    group.querySelector(selector)!.getBoundingClientRect();
                  const image = box("img");
                  const frame = box(".chat-image-frame");
                  const text = box(".chat-text");
                  const own =
                    group.classList.contains("user") &&
                    !group.classList.contains("chat-group--peer");
                  return {
                    frameGap: frame.right - image.right,
                    textGap: own ? text.right - image.right : image.left - text.left,
                    mediaGap: text.top - image.bottom,
                    user: group.classList.contains("user"),
                    paragraphGap: box(".chat-text > p + p").top - box(".chat-text > p").bottom,
                    width: image.width,
                    height: image.height,
                    laneWidth: box(".chat-group-messages").width,
                  };
                }),
              );
              for (const row of rows) {
                expect(Math.abs(row.frameGap)).toBeLessThanOrEqual(1);
                expect(Math.abs(row.textGap)).toBeLessThanOrEqual(1);
                expect(row.mediaGap).toBe(row.user ? 8 : 20);
                expect(row.paragraphGap).toBe(20);
                expect(row.width).toBeLessThanOrEqual(Math.min(400, row.laneWidth) + 1);
                expect(row.width / row.height).toBeCloseTo(width / height, 1);
              }
            },
          );
        },
      );
    },
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
