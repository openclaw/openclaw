// @vitest-environment node
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, describe, expect, it as baseIt } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";
import { finishElementAnimations } from "../../test-helpers/animations.ts";
import { closeBrowserPage } from "../../test-helpers/browser-page.ts";
import {
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";
import {
  canRunChatLayoutBrowser,
  chromiumExecutablePath,
  createChatLayoutBrowser,
  expectFiniteRect,
  getBoundingBox,
  getRect,
  readUiCss,
  mountMcpAppSurfaceFixture,
  rectsOverlap,
  waitForLayoutSettled,
} from "./chat-layout.browser.test-support.ts";

const TOUCH_TARGET_MIN_PX = 43.5;
const LONG_SESSION_RAIL_BODY = Array.from(
  { length: 80 },
  (_, index) => `<p>Line ${index + 1}: keep the complete side result readable.</p>`,
).join("");
const describeBrowserLayout = canRunChatLayoutBrowser ? describe : describe.skip;

const layoutBrowser = createChatLayoutBrowser();
const { openBrowserPage } = layoutBrowser;
let realChatServer: ControlUiE2eServer | null = null;

type UsePage = (pagePromise: Promise<Page>) => Promise<Page>;
const it = baseIt.extend<{ usePage: UsePage }>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest reads fixture dependencies from this pattern.
  usePage: async ({}, use) => {
    const pages: Page[] = [];
    try {
      await use(async (pagePromise) => {
        const page = await pagePromise;
        pages.push(page);
        return page;
      });
    } finally {
      for (const page of pages) {
        await closeBrowserPage(page);
      }
    }
  },
});

type ChatFixtureOptions = {
  composerAttachment?: boolean;
  crowdedComposerFooter?: boolean;
  direct?: boolean;
  goalMode?: boolean;
  slashMenu?: boolean;
};

// CSS scales corners by engine support for continuous curvature.
async function readCornerScale(page: Page): Promise<number> {
  return await page.evaluate(() =>
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--openclaw-corner-radius-scale"),
    ),
  );
}

// Measure each group in one browser turn, before layout or animations can advance.
async function readControlRects<Key extends string>(
  page: Page,
  selectorMap: Record<Key, string>,
  scrollSelector?: string,
) {
  return page.evaluate(
    ({ selectors, scroll }) => {
      if (scroll) {
        const node = document.querySelector<HTMLElement>(scroll);
        if (node) {
          node.scrollTop = node.scrollHeight;
        }
      }
      const measure = (node: HTMLElement) => {
        const { x, y, width, height, top, bottom } = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        if (![x, y, width, height].every(Number.isFinite)) {
          throw new Error("Expected finite control geometry");
        }
        return {
          x,
          y,
          width,
          height,
          top,
          bottom,
          left: x,
          right: x + width,
          center: x + width / 2,
          centerY: y + height / 2,
          clientWidth: node.clientWidth,
          scrollWidth: node.scrollWidth,
          clientHeight: node.clientHeight,
          scrollHeight: node.scrollHeight,
          scrollTop: node.scrollTop,
          paddingTop: Number.parseFloat(style.paddingTop),
          paddingBottom: Number.parseFloat(style.paddingBottom),
          paddingLeft: Number.parseFloat(style.paddingLeft),
          paddingRight: Number.parseFloat(style.paddingRight),
          borderRadius: Number.parseFloat(style.borderTopLeftRadius),
          cornerShape: style.getPropertyValue("corner-shape"),
          fontSize: Number.parseFloat(style.fontSize),
          placeholderFontSize: Number.parseFloat(getComputedStyle(node, "::placeholder").fontSize),
          css: Object.fromEntries<string>(
            "display padding-top padding-bottom position background-color color border-color box-shadow border-top-color border-top-style border-top-width outline-style min-height overflow-y margin-top letter-spacing border-bottom-style border-left-style border-radius margin-bottom border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius user-select box-sizing object-fit padding font-size scrollbar-gutter"
              .split(" ")
              .map((property) => [property, style.getPropertyValue(property)] as const),
          ),
        };
      };
      const entries = Object.entries(selectors).map(([key, selector]) => {
        const nodes = document.querySelectorAll<HTMLElement>(selector);
        const node = nodes[0];
        if (!node || nodes.length !== 1) {
          throw new Error(`Expected one layout element: ${selector}`);
        }
        return [key, measure(node)];
      });
      // SAFETY: every input key produces one measured entry; invalid nodes throw.
      return Object.fromEntries(entries) as Record<Key, ReturnType<typeof measure>>;
    },
    { selectors: selectorMap, scroll: scrollSelector },
  );
}

async function expectAligned(
  page: Page,
  coordinate: "left" | "centerX" | "centerY",
  selectorList: string,
) {
  const values = await page.evaluate(
    ({ axis, selectors }) =>
      selectors.split(",").flatMap((selector) => {
        const nodes = [...document.querySelectorAll(selector)];
        if (!nodes.length) {
          throw new Error(`Expected layout elements: ${selector}`);
        }
        return nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return axis === "left"
            ? box.left
            : axis === "centerX"
              ? box.left + box.width / 2
              : box.top + box.height / 2;
        });
      }),
    { axis: coordinate, selectors: selectorList },
  );
  expect(Math.max(...values) - Math.min(...values)).toBeLessThan(0.5);
}

const composerSelectors = {
  chat: ".chat",
  shell: ".agent-chat__composer-shell",
  input: ".agent-chat__composer-shell > .agent-chat__input",
  thread: ".chat-thread",
  footer: ".agent-chat__composer-footer",
  textarea: ".agent-chat__composer-combobox > textarea",
  meta: ".agent-chat__composer-meta",
  model: ".chat-composer-model-control",
  modelSettings: ".chat-controls__model-trigger",
  modelTrigger: ".chat-controls__model-trigger",
  modelLabel: ".chat-controls__model-trigger .chat-controls__inline-select-label",
  effortTrigger: ".chat-controls__effort-trigger",
  effortLabel: ".chat-controls__effort-trigger .chat-controls__inline-select-label",
  context: ".context-ring",
  attach: '.agent-chat__input-btn[aria-label="Add attachment"]',
  attachIcon: '.agent-chat__input-btn[aria-label="Add attachment"] svg',
  send: ".chat-send-btn",
};

function readComposer(page: Page, scroll = false) {
  return readControlRects(page, composerSelectors, scroll ? composerSelectors.input : undefined);
}

type MeasuredRect = { left: number; right: number; top: number; bottom: number };
function expectInside(rect: MeasuredRect, parent: MeasuredRect, axis: "x" | "y") {
  const [start, end] = axis === "x" ? (["left", "right"] as const) : (["top", "bottom"] as const);
  expect(rect[start]).toBeGreaterThanOrEqual(parent[start] - 1);
  expect(rect[end]).toBeLessThanOrEqual(parent[end] + 1);
}

function iconSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;
}

function setMarkup(page: Page, body: string) {
  return page.setContent(
    `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${body}</body></html>`,
  );
}

function textBubble(content: string) {
  return `<div class="chat-bubble"><div class="chat-text">${content}</div></div>`;
}

function messageHtml(classes: string, content: string, avatar = "", footer = "", attributes = "") {
  return `<div class="chat-group ${classes}" ${attributes}>${avatar}
    <div class="chat-group-messages">${content}</div>${footer}</div>`;
}

function threadHtml(
  content: string,
  classes = "",
  attributes = 'role="log"',
  innerAttributes = "",
) {
  return `<div class="chat-thread ${classes}" ${attributes}>
    <div class="chat-thread-inner" ${innerAttributes}>${content}</div></div>`;
}

function footerHtml(name = "Assistant", actions = chatFooterActionsHtml(), time = "9:41 PM") {
  return `<div class="chat-group-footer"><div class="chat-group-footer__meta">
    <span class="chat-sender-name">${name}</span><span class="chat-group-timestamp">${time}</span>
    </div>${actions}</div>`;
}

function div(classes: string, content: string, attributes = "") {
  return `<div class="${classes}" ${attributes}>${content}</div>`;
}

function span(classes: string, content: string) {
  return `<span class="${classes}">${content}</span>`;
}

function activityAlignmentHtml() {
  const disclosure = (classes: string, iconClass: string, content: string, attrs: string) => `
    <button class="chat-inline-disclosure ${classes}" type="button" ${attrs}>
      <span class="${iconClass}">${iconSvg()}</span>
      <span class="chat-tool-disclosure__content">${content}</span>
      <span class="chat-tool-row__chevron">${iconSvg()}</span>
    </button>`;
  const tool = (failed: boolean) => {
    const row = div(
      "chat-tool-msg-collapse",
      disclosure(
        "chat-tool-msg-summary chat-tool-row",
        "chat-tool-msg-summary__icon",
        `<span class="chat-tool-msg-summary__label">Bash</span>
      <span class="chat-tool-msg-summary__names">${failed ? "Bash" : "search a deliberately long workspace path without extra card chrome"}</span>`,
        `aria-expanded="false" ${failed ? "data-failed-call-row" : ""}`,
      ),
    );
    return div(
      "chat-bubble chat-bubble--tool-shell",
      failed ? row : div("chat-tools-inline", row),
      failed ? "" : "data-activity-call-row",
    );
  };
  return threadHtml(
    div(
      "chat-group tool",
      div("chat-group-messages", "Inspecting the available tools.", "data-tool-column-reference"),
    ) +
      messageHtml(
        "tool chat-group--activity chat-group--with-footer",
        div(
          "chat-activity-group is-open",
          disclosure(
            "chat-activity-group__summary",
            "chat-activity-group__icon",
            '<span class="chat-activity-group__label">Activity: 2 tools</span>',
            'aria-expanded="true"',
          ) + div("chat-activity-group__body", tool(false) + tool(true)),
        ),
      ),
  );
}

type AvatarPlacement = "gutter" | "footer" | "none";

function uniformTurnSpacingHtml(placement: AvatarPlacement) {
  const copy = `<div class="chat-group-footer-actions"><button class="chat-copy-btn" type="button" aria-label="Copy">${iconSvg()}</button></div>`;
  const row = (group: string) => `<div class="chat-virtual-row">${group}</div>`;
  const gutterAvatar = (role: string) =>
    placement === "gutter" ? `<div class="chat-avatar ${role}">A</div>` : "";
  const meta = (name: string, role: string) =>
    `<div class="chat-group-footer__meta">${
      placement === "footer" && role === "user" ? '<span class="chat-author-avatar"></span>' : ""
    }<span class="chat-sender-name">${name}</span></div>`;
  const message = (role: string, text: string, modifier = "", streaming = false) => {
    const identity = meta(
      role === "assistant" ? "Assistant" : modifier === "peer" ? "Peer" : "You",
      role,
    );
    const footer = streaming
      ? '<div class="chat-group-footer" aria-hidden="true"></div>'
      : div(
          `chat-group-footer${role === "user" ? " chat-group-footer--persistent-identity" : ""}`,
          role === "user" && modifier !== "peer" ? copy + identity : identity + copy,
        );
    return messageHtml(
      `${role} chat-group--with-footer ${modifier ? `chat-group--${modifier}` : ""}`,
      textBubble(text),
      gutterAvatar(role),
      footer,
    );
  };
  const tool = (kind: "work" | "activity", summary: string) =>
    messageHtml(
      `tool chat-group--turn-block chat-group--${kind}${kind === "activity" ? " chat-group--with-footer" : ""}`,
      div(
        "chat-activity-group chat-work-group",
        `
      <button class="chat-inline-disclosure chat-activity-group__summary" type="button">${summary}</button>
      <div class="chat-work-group__separator"></div>`,
      ),
    );
  const narration = (text: string) =>
    messageHtml("assistant chat-group--turn-block chat-group--with-footer", textBubble(text));
  const turns = [
    message("user", "Own prompt"),
    tool("work", "Worked for 10s"),
    message("assistant", "Reply after work"),
    message("user", "Peer prompt", "peer"),
    tool("activity", "Activity: 2 tools"),
    message("assistant", "Revealed reply", "meta-revealed"),
    message("user", "Revealed own prompt", "meta-revealed"),
    narration("Checking the footer layout first."),
    tool("activity", "Activity: 1 tool"),
    narration("Comparing the two layouts."),
    message("assistant", "Streaming reply", "", true),
  ]
    .map(row)
    .join("");
  return div(
    `chat-thread${placement === "footer" ? " chat-thread--direct" : ""}`,
    div(
      "chat-thread-inner chat-thread-inner--virtual",
      div("chat-virtual-sizer", div("chat-virtual-block", turns), 'style="height: 1600px;"'),
    ),
    'role="log"',
  );
}

function runBlockSpacingHtml() {
  const bubble = (text: string, attributes: string, classes = "", wrapText = true) =>
    `<div class="chat-bubble ${classes}" ${attributes}>${wrapText ? `<div class="chat-text">${text}</div>` : text}</div>`;
  const copy = `<div class="chat-group-footer-actions"><button class="chat-copy-btn" type="button" aria-label="Copy">${iconSvg()}</button></div>`;
  const turn = (
    attributes: string,
    text: string,
    persistent = false,
    revealed = false,
    role = "user",
  ) =>
    messageHtml(
      `${role} chat-group--with-footer ${revealed ? "chat-group--meta-revealed" : ""}`,
      bubble(text, ""),
      "",
      div(
        `chat-group-footer ${persistent ? "chat-group-footer--persistent-identity" : ""}`,
        `<span class="chat-sender-name">${role === "user" ? "You" : "Assistant"}</span>${persistent ? copy : ""}`,
      ),
      attributes,
    );
  return threadHtml(
    messageHtml(
      "assistant chat-group--with-footer",
      `
          ${bubble("Opening text", 'data-run-block="text"')}
          ${bubble("Detail text", 'data-run-block="detail"')}
          ${bubble("Tool row", 'data-run-block="tool"', "chat-bubble--tool-shell", false)}
          <div class="chat-activity-group" data-run-block="list">
            <div class="chat-activity-group__body"><div class="chat-group-messages">
              ${bubble("Expanded detail", 'data-expanded-row="text"', "", false)}
              ${bubble("Expanded tool row", 'data-expanded-row="tool"', "chat-bubble--tool-shell", false)}
            </div></div>
          </div>
          ${bubble("Activity result", 'data-run-block="activity-reply"')}
          <div class="chat-activity-group chat-work-group" data-run-block="work">
            <button class="chat-inline-disclosure chat-activity-group__summary" type="button">Worked for 10s</button>
            <div class="chat-work-group__separator"></div>
          </div>
          ${bubble("Final reply", 'data-run-block="reply"')}
  `,
      "",
      `<div class="chat-group-footer"><span class="chat-sender-name">Assistant</span>${copy}</div>`,
      "data-run-turn",
    ) +
      turn("data-next-turn", "Next turn") +
      turn("data-persistent-turn", "Persistent identity turn", true) +
      turn("data-after-persistent-turn", "After persistent identity", false, false, "assistant") +
      turn("data-revealed-persistent-turn", "Revealed persistent identity", true, true) +
      turn("data-after-revealed-turn", "After revealed identity", false, false, "assistant"),
    "chat-thread--direct",
  );
}

function chatFooterActionsHtml() {
  return div(
    "chat-group-footer-actions",
    `
      <button class="chat-copy-btn" type="button" aria-label="Copy as markdown">
        <span class="chat-copy-btn__icon" aria-hidden="true">${iconSvg()}</span>
      </button>`,
  );
}

function composerControlsHtml() {
  // These fixtures measure closed controls; menu rows never participate in layout.
  const picker = (kind: string, label: string, attributes: string) => `
    <details class="chat-controls__inline-select chat-controls__${kind}-picker">
      <summary class="chat-controls__inline-select-trigger chat-controls__${kind}-trigger" ${attributes}>${label}</summary>
      <div class="chat-controls__inline-select-menu chat-controls__${kind}-menu"></div>
    </details>`;
  const label = (text: string) => `<span class="chat-controls__inline-select-label">${text}</span>`;
  return `<div class="agent-chat__composer-controls"><div class="chat-composer-model-control">
    <div class="chat-controls__session chat-controls__model chat-controls__model-settings">
      ${picker("model", label("GPT-5.6 Luna"), 'data-chat-composer-model="true" aria-label="Chat model: GPT-5.6 Luna"')}
      ${picker("permission", `<span class="chat-controls__permission-icon" aria-hidden="true">${iconSvg()}</span>`, 'aria-label="Permissions: Guarded"')}
      ${picker("effort", label("Medium"), 'data-chat-composer-effort="true" aria-label="Effort"')}
    </div></div></div>`;
}

function nestedDivs(classPath: string, content: string) {
  return classPath.split(" > ").reduceRight((inner, className) => div(className, inner), content);
}

function composerActionsHtml(voice = false) {
  return `<div class="agent-chat__composer-actions">
    <button class="chat-send-btn${voice ? " chat-send-btn--voice" : ""}" ${voice ? 'aria-label="Start voice input"' : ""}>${iconSvg()}</button>
  </div>`;
}

function chatHtml(opts: ChatFixtureOptions = {}, mobileNavLayout = false) {
  const thread = threadHtml(
    messageHtml("user", textBubble("Keep this visible."), div("chat-avatar user", "V")) +
      messageHtml(
        "assistant chat-group--with-footer",
        textBubble("It stays readable.") +
          textBubble(`
          <p>The chat shell should stay compact and readable.</p>
          <div class="code-block-wrapper"><pre><code>const importantLongIdentifier = "control-ui-chat-responsive-regression-fixture-keeps-code-scrollable"; console.log(importantLongIdentifier);</code></pre></div>`),
        div("chat-avatar assistant", "A"),
        footerHtml(),
      ),
    opts.direct ? "chat-thread--direct" : "",
  );
  const typing = opts.crowdedComposerFooter
    ? `
    <div class="agent-chat__typing-indicator agent-chat__typing-indicator--outside" role="status">
      <span class="agent-chat__typing-avatars" aria-hidden="true">
        ${["A", "B", "C"].map((name) => `<span class="chat-author-avatar">${name}</span>`).join("\n")}
      </span>
      <span class="agent-chat__typing-text">Alexandria, Bartholomew, and Cassandra are typing</span>
    </div>`
    : "";
  const slashItems = [
    ["/plan", "Create a plan"],
    ["/review", "Review changes"],
    ["/fix", "Fix current issue"],
  ]
    .map(
      ([command, description], index) => `
    <div class="slash-menu-item${index === 0 ? " slash-menu-item--active" : ""}" role="option" ${index === 0 ? 'aria-selected="true"' : ""}>
      <span class="slash-menu-icon">${iconSvg()}</span>
      <span class="slash-menu-name">${command}</span><span class="slash-menu-desc">${description}</span>
    </div>`,
    )
    .join("");
  const slashMenu = opts.slashMenu
    ? `
    <div class="slash-menu" role="listbox" aria-label="Command suggestions">
      <div class="slash-menu-group"><div class="slash-menu-group__label">Commands</div>${slashItems}</div>
    </div>`
    : "";
  const goal = opts.goalMode
    ? `
    <div class="agent-chat__goal-mode composer-context-strip">
      <span class="agent-chat__goal-mode-label composer-context-strip__label"><span class="composer-context-strip__icon">${iconSvg()}</span><span class="composer-context-strip__label-text">Goal</span></span>
      <span class="agent-chat__goal-mode-hint composer-context-strip__text">Enter your objective.</span>
    </div>`
    : "";
  const attachment = opts.composerAttachment
    ? `
    <div class="chat-attachments-preview">
      <div class="chat-attachment-thumb chat-attachment-thumb--file">
        <div class="chat-attachment-file">
        <span class="chat-attachment-file__icon">${iconSvg()}</span>
        <span class="chat-attachment-file__name">landscape-proof-attachment.txt</span>
        </div>
        <button class="chat-attachment-remove" type="button" aria-label="Remove attachment">&times;</button>
      </div>
    </div>`
    : "";
  const lede = div(
    "agent-chat__composer-lede",
    goal + attachment + div("agent-chat__composer-status-stack", " "),
  );
  const context = nestedDivs(
    "agent-chat__composer-meta agent-chat__composer-context > context-usage",
    `
    <details><summary class="context-ring" role="status" aria-label="Session context usage: 46k/200k (23%)">
      <svg class="context-ring__dial" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        ${["track", "fill"].map((part) => `<circle class="context-ring__${part}" cx="8" cy="8" r="6.5"></circle>`).join("")}
      </svg>
    </summary></details>`,
  );
  const attachMenu = div(
    "agent-chat__composer-lead",
    `
      <details class="agent-chat__attach-menu">
        <summary class="agent-chat__input-btn agent-chat__input-btn--attach" aria-label="Add attachment">${iconSvg()}</summary>
        <div class="agent-chat__attach-menu-popover" role="menu"></div>
      </details>`,
  );
  const trail = div(
    "agent-chat__composer-trail",
    context + composerControlsHtml() + composerActionsHtml(true),
  );
  const footer = div("agent-chat__composer-footer", attachMenu + trail);
  const input = nestedDivs(
    "agent-chat__composer-input-row > agent-chat__composer-combobox",
    '<textarea rows="1">Queued follow-up for the active operator session</textarea>',
  );
  const composer = `<div class="agent-chat__composer-shell">
    <div class="agent-chat__input" data-composer-layout="multiline">${slashMenu}${lede}${input}${footer}</div>
  </div>`;
  return div(
    `shell shell--chat${mobileNavLayout ? " shell--mobile-nav" : ""}`,
    `
    <header class="topbar">${nestedDivs("topnav-shell > topnav-shell__actions", `<button class="topbar-search">${iconSvg()}</button>`)}</header>
    <main class="content content--chat"><section class="chat">${div(
      "chat-split-container",
      div("chat-main", thread + typing + composer, 'style="flex: 1 1 100%"'),
    )}</section></main>`,
    "data-chat-responsive-fixture",
  );
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
    await setMarkup(page, chatHtml(opts, width <= 1100));
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
    const message = (role: string, kind: string, text: string) =>
      `<div class="chat-group ${role} chat-session-rail__message"><div class="chat-bubble chat-session-rail__${kind}">${text}</div></div>`;
    const thread = `<div class="chat-session-rail__thread">
      <article class="chat-session-rail__exchange">
        ${message("user", "question", "What should I check next?")}
        ${message("assistant", "answer", LONG_SESSION_RAIL_BODY)}
        <span class="chat-session-rail__pr-checks">2 passed</span>
        <time class="chat-session-rail__timestamp">as of 4:12 PM</time>
        <div class="chat-session-rail__hint">Side chat is already answering a question.</div>
      </article></div>`;
    const composer = `<form class="agent-chat__input chat-session-rail__composer">
      <div class="agent-chat__composer-input-row">
        <label class="agent-chat__composer-combobox chat-session-rail__prompt">
          <textarea class="chat-session-rail__input" rows="1" placeholder="What should I know?"></textarea>
        </label>
      </div>
      ${nestedDivs("agent-chat__composer-footer > agent-chat__composer-trail", composerActionsHtml())}
    </form>`;
    const rail = `<openclaw-chat-session-rail>
      <section class="chat-session-rail chat-session-rail--expanded chat-session-rail--embedded" role="region" aria-label="Side chat">${thread}${composer}</section>
    </openclaw-chat-session-rail>`;
    const panel = nestedDivs(
      "sidebar-region__right-runtime > side-panel",
      `
      <header class="rail-header side-panel__header" data-region-header="side">Side chat</header>
      ${div("side-panel__body", div("side-panel__panel", rail, 'data-region="side"'))}`,
    );
    const region = div(
      `sidebar-region sidebar-region--right sidebar-region--open${width <= 768 ? " sidebar-region--narrow" : ""}`,
      div("sidebar-region__header", "Current session") +
        div("sidebar-region__primary", "Conversation", 'data-region="main"') +
        panel,
      'style="--side-panel-width:400px;--side-panel-height:360px"',
    );
    await setMarkup(page, `<div style="display:flex;height:100dvh">${region}</div>`);
    return page;
  } catch (error) {
    await closeBrowserPage(page);
    throw error;
  }
}

async function getTextBottom(page: Page, selector: string) {
  const rect = await page.locator(selector).evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const { x, y, width, height, bottom } = range.getBoundingClientRect();
    range.detach();
    return { x, y, width, height, bottom };
  });
  expectFiniteRect(rect);
  return rect.bottom;
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
    realChatServer = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await realChatServer?.close();
    realChatServer = null;
    await layoutBrowser.close();
  });

  it("waits through delayed layout updates", async ({ usePage }) => {
    const page = await usePage(openBrowserPage(320, 568));
    await page.setContent('<div id="delayed-layout" style="position:absolute;top:0">Layout</div>');
    await page.locator("#delayed-layout").evaluate((node) => {
      const element = node as HTMLElement;
      const nativeGetBoundingClientRect = element.getBoundingClientRect.bind(element);
      let scheduled = false;
      element.getBoundingClientRect = () => {
        const rect = nativeGetBoundingClientRect();
        element.dataset.lastObservedTop = String(rect.top);
        if (!scheduled) {
          scheduled = true;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              element.style.top = "12px";
            });
          });
        }
        return rect;
      };
    });
    await waitForLayoutSettled(page, "#delayed-layout");

    expect(
      await page
        .locator("#delayed-layout")
        .evaluate((node) => Number((node as HTMLElement).dataset.lastObservedTop)),
    ).toBe(12);
  });

  it("keeps a constrained no-face header to one flex gap", async ({ usePage }) => {
    const page = await usePage(openBrowserPage(360, 180));
    const splitViewCss = readStyleSheet("ui/src/styles/chat/split-view.css");
    await page.setContent(
      `<!doctype html><html><head><style>${readUiCss()}\n${splitViewCss}</style></head><body>
          <div class="chat-pane__header" style="width: 320px;">
            <div class="chat-pane__header-leading">
              <div class="chat-pane__crumbs">
                <span class="chat-pane__session-title">
                  <span class="chat-pane__session-title-text">A deliberately long session title for the no-face header</span>
                </span>
              </div>
            </div>
            <div class="chat-pane__header-trailing">
              <div class="chat-pane__actions">
                <button class="btn btn--ghost btn--icon chat-icon-btn" type="button">A</button>
                <button class="btn btn--ghost btn--icon chat-icon-btn" type="button">B</button>
                <button class="btn btn--ghost btn--icon chat-icon-btn" type="button">C</button>
              </div>
            </div>
          </div>
        </body></html>`,
    );
    const { leading, trailing, title } = await readControlRects(page, {
      leading: ".chat-pane__header-leading",
      trailing: ".chat-pane__header-trailing",
      title: ".chat-pane__session-title-text",
    });
    expect(
      await page
        .locator(".chat-pane__header > *")
        .evaluateAll((nodes) => nodes.map((node) => node.className)),
    ).toEqual(["chat-pane__header-leading", "chat-pane__header-trailing"]);
    expect(trailing.left - leading.right).toBeCloseTo(8, 0);
    expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
  });

  it("caps a nested session trail at half the header while ellipsizing both titles", async ({
    usePage,
  }) => {
    const page = await usePage(openBrowserPage(720, 180));
    const splitViewCss = readStyleSheet("ui/src/styles/chat/split-view.css");
    await page.setContent(
      `<!doctype html><html><head><style>${readUiCss()}\n${splitViewCss}</style></head><body>
          <div class="chat-split-view__cell" style="width: 640px;">
            <div class="chat-pane__header chat-pane__header--closable">
              <div class="chat-pane__crumbs">
                <div class="chat-pane__project-row">
                  <div class="chat-pane__workspace-menu">
                    <button class="oc-menu-trigger chat-pane__workspace-chip" type="button">
                      <span class="oc-menu-item__label">${iconSvg()}<span>openclaw</span></span>
                    </button>
                    <div class="oc-overlay oc-menu" popover="manual" role="menu"></div>
                  </div>
                </div>
                <div class="chat-pane__session-trail">
                  <span class="chat-pane__crumb-sep" aria-hidden="true">/</span>
                  <button class="chat-pane__parent-session" type="button">
                    <span class="chat-pane__parent-session-text">Release preparation with a long parent name</span>
                  </button>
                  <span class="chat-pane__crumb-sep" aria-hidden="true">/</span>
                  <button class="chat-pane__session-title chat-pane__session-title-button" type="button">
                    <span class="chat-pane__session-title-text">Implementation details with a long child name</span>
                  </button>
                </div>
              </div>
              <div class="chat-pane__actions">
                <button class="btn btn--ghost chat-pane__layout-trigger" type="button" aria-label="Layout">Layout</button>
              </div>
            </div>
          </div>
        </body></html>`,
    );

    for (const [width, firstSeparator] of [
      [640, "block"],
      [320, "none"],
    ] as const) {
      await page.locator(".chat-split-view__cell").evaluate((cell, nextWidth) => {
        (cell as HTMLElement).style.width = `${nextWidth}px`;
      }, width);
      const { header, parent, child, parentText, childText, first, second } =
        await readControlRects(page, {
          header: ".chat-pane__header",
          parent: ".chat-pane__parent-session",
          child: ".chat-pane__session-title",
          parentText: ".chat-pane__parent-session-text",
          childText: ".chat-pane__session-title-text",
          first: ".chat-pane__crumb-sep:first-child",
          second: ".chat-pane__crumb-sep:last-of-type",
        });
      expect({
        firstSeparator: first.css.display,
        secondSeparator: second.css.display,
        parentEllipses: parentText.scrollWidth > parentText.clientWidth,
        childEllipses: childText.scrollWidth > childText.clientWidth,
        overflow: header.scrollWidth - header.clientWidth,
      }).toEqual({
        firstSeparator,
        secondSeparator: "block",
        parentEllipses: true,
        childEllipses: true,
        overflow: 0,
      });
      expect(child.right - parent.left).toBeLessThanOrEqual(header.width / 2 + 1);
    }
  });

  it.for([
    { label: "desktop", width: 1366, height: 900, hasTouch: false },
    { label: "mobile touch", width: 430, height: 720, hasTouch: true },
  ])(
    "keeps activity disclosures compact on $label",
    async ({ width, height, hasTouch }, { usePage }) => {
      const page = await usePage(openBrowserPage(width, height, { hasTouch, isolated: true }));
      await setMarkup(page, activityAlignmentHtml());

      await expectNoHorizontalOverflow(page);
      const { group, summary, failed, reference, label, chevron, tool } = await readControlRects(
        page,
        {
          group: ".chat-activity-group",
          summary: ".chat-activity-group__summary",
          failed: "[data-failed-call-row]",
          reference: "[data-tool-column-reference]",
          label: ".chat-activity-group__label",
          chevron: ".chat-activity-group__summary .chat-tool-row__chevron",
          tool: "[data-activity-call-row] .chat-tool-msg-summary",
        },
      );
      expect(summary.width).toBeLessThan(group.width);
      expect(failed.width).toBeLessThan(group.width);
      expect(group.left).toBeCloseTo(reference.left, 0);
      const padding = hasTouch ? "8px" : "5px";
      expect(summary.css).toMatchObject({
        "user-select": "none",
        "background-color": "rgba(0, 0, 0, 0)",
        "padding-top": padding,
        "padding-bottom": padding,
      });
      expect(tool.css).toMatchObject({
        "user-select": "none",
        "padding-top": "3px",
        "padding-bottom": "3px",
      });
      // Summary gap (8px) less the chevron's own -3px inset.
      expect(chevron.left - label.right).toBe(5);
      const toolRowGap = failed.top - tool.bottom;
      expect(toolRowGap).toBeGreaterThanOrEqual(0);
      expect(toolRowGap).toBeLessThanOrEqual(2);
    },
  );

  it.for([
    { label: "desktop gutter", placement: "gutter", width: 1366, hasTouch: false, turnGap: 16 },
    { label: "narrow touch footer", placement: "footer", width: 390, hasTouch: true, turnGap: 12 },
    { label: "wide touch none", placement: "none", width: 1366, hasTouch: true, turnGap: 12 },
  ] as const)(
    "separates every consecutive turn by the same space on $label",
    async ({ placement, width, hasTouch, turnGap }, { usePage }) => {
      const page = await usePage(openBrowserPage(width, 1800, { hasTouch, isolated: true }));

      // Isolate the final-layout contract from the 200ms settle-in transform.
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style><style>.chat-group--work { animation: none; }</style></head><body>${uniformTurnSpacingHtml(placement)}</body></html>`,
      );
      await waitForLayoutSettled(page, ".chat-virtual-row .chat-group");
      const layout = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".chat-virtual-row > .chat-group")].map(
          (group) => {
            const box = group.getBoundingClientRect();
            const content = group
              .querySelector<HTMLElement>(":scope > .chat-group-messages")!
              .getBoundingClientRect();
            const footer = group
              .querySelector<HTMLElement>(":scope > .chat-group-footer")
              ?.getBoundingClientRect();
            return {
              inTurnBlock: group.classList.contains("chat-group--turn-block"),
              top: box.top,
              bottom: box.bottom,
              contentTop: content.top,
              contentBottom: content.bottom,
              footer: footer
                ? {
                    offset: footer.top - content.bottom,
                    height: footer.height,
                    toEdge: box.bottom - footer.bottom,
                  }
                : null,
              gapAfter: Number.parseFloat(getComputedStyle(group).marginBlockEnd),
            };
          },
        ),
      );

      expect(layout).toHaveLength(11);
      for (const [index, group] of layout.entries()) {
        const next = layout[index + 1];
        if (group.inTurnBlock) {
          // In-turn work/activity/narration uses only the run-frame gap, not a footer.
          expect(group.footer).toBeNull();
          expect(group.gapAfter).toBe(8);
          expect(next!.contentTop - group.contentBottom).toBeCloseTo(8, 1);
          continue;
        }
        expect(group.gapAfter).toBe(turnGap);
        expect(group.footer).toEqual({
          offset: expect.closeTo(2, 1),
          height: 24,
          toEdge: expect.closeTo(0, 1),
        });
        if (next) {
          expect(next.top - group.bottom).toBeCloseTo(turnGap, 1);
          expect(next.contentTop - group.contentBottom).toBeCloseTo(2 + 24 + turnGap, 1);
        }
      }
    },
  );

  it.for([
    { label: "desktop", width: 1366, hasTouch: false },
    { label: "mobile", width: 430, hasTouch: true },
    { label: "wide touch", width: 1366, hasTouch: true },
  ])(
    "keeps transcript turn and run block spacing on $label",
    async ({ width, hasTouch }, { usePage }) => {
      const page = await usePage(openBrowserPage(width, 900, { hasTouch, isolated: true }));
      await setMarkup(page, runBlockSpacingHtml());
      const gaps = await page.evaluate(() => {
        const rect = (selector: string) =>
          document.querySelector(selector)!.getBoundingClientRect();
        const gap = (before: string, after: string) => rect(after).top - rect(before).bottom;
        const run = (name: string) => `[data-run-block="${name}"]`;
        const turn = (name: string) => `[data-${name}-turn] .chat-bubble`;
        const blocks = ["text", "detail", "tool", "list", "activity-reply", "work", "reply"];
        return [
          ...blocks.slice(1).map((name, index) => gap(run(blocks[index]!), run(name))),
          gap('[data-expanded-row="text"]', '[data-expanded-row="tool"]'),
          gap(`${run("work")} > button`, ".chat-work-group__separator"),
          gap(run("reply"), turn("next")),
          gap(turn("persistent"), turn("after-persistent")),
          gap(turn("revealed-persistent"), turn("after-revealed")),
          gap(turn("next"), turn("persistent")),
        ];
      });
      // Footer offset + 24px footer + turn gap (16px, or 12px on touch).
      const turnGap = hasTouch ? 38 : 42;
      expect(gaps).toEqual([2, 8, 8, 8, 8, 8, 6, 0, turnGap, turnGap, turnGap, turnGap]);
    },
  );

  it("keeps custom avatar sizing and the user edge neutral", async ({ usePage }) => {
    const page = await usePage(openBrowserPage(430, 720));
    await setMarkup(
      page,
      `<img class="chat-avatar assistant" src="/avatar/main" alt="Custom" />
        <img class="chat-avatar user" src="/avatar/user" alt="User" />`,
    );
    const avatars = await readControlRects(page, {
      assistant: ".chat-avatar.assistant",
      user: ".chat-avatar.user",
    });
    const avatarSize = {
      width: 36,
      height: 36,
      css: {
        "box-sizing": "border-box",
        "object-fit": "cover",
        padding: "0px",
        "border-top-width": "1px",
      },
    };
    expect(Object.values(avatars)).toMatchObject([avatarSize, avatarSize]);

    for (const theme of ["dark", "light"]) {
      const edge = await page.evaluate((mode) => {
        document.documentElement.dataset.themeMode = mode;
        const probe = document.createElement("span");
        probe.style.border = "1px solid var(--border)";
        document.body.append(probe);
        const neutralColor = getComputedStyle(probe).borderTopColor;
        probe.style.borderColor = "color-mix(in srgb, var(--accent) 20%, transparent)";
        const accentColor = getComputedStyle(probe).borderTopColor;
        const avatar = document.querySelector("img.chat-avatar.user");
        if (!avatar) {
          throw new Error("Expected user avatar fixture");
        }
        const avatarStyle = getComputedStyle(avatar);
        const result = {
          accentColor,
          borderColor: avatarStyle.borderTopColor,
          borderStyle: avatarStyle.borderTopStyle,
          borderWidth: avatarStyle.borderTopWidth,
          neutralColor,
          outlineStyle: avatarStyle.outlineStyle,
        };
        probe.remove();
        return result;
      }, theme);
      expect(edge.borderColor).toBe(edge.neutralColor);
      expect(edge.borderColor).not.toBe(edge.accentColor);
      expect(edge).toMatchObject({
        borderStyle: "solid",
        borderWidth: "1px",
        outlineStyle: "none",
      });
    }
  });

  it("hides image avatars when the mobile transcript drops their grid column", async ({
    usePage,
  }) => {
    const page = await usePage(openBrowserPage(430, 720));
    await setMarkup(
      page,
      threadHtml(
        messageHtml(
          "assistant chat-group--with-footer",
          textBubble("Completed work remains readable."),
          "<img class=\"chat-avatar assistant\" alt=\"Assistant\" src=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36'/%3E\" />",
          '<div class="chat-group-footer"><span class="chat-sender-name">Assistant</span></div>',
        ),
        "",
        "",
      ),
    );
    const avatar = page.locator(".chat-avatar");
    for (const width of [430, 400, 390, 320, 401, 768, 769, 1366]) {
      await page.setViewportSize({ width, height: 720 });
      if (width <= 768) {
        await expectBrowser(avatar).toBeHidden();
      } else {
        await expectBrowser(avatar).toBeVisible();
        const image = await avatar.boundingBox();
        const text = await page.locator(".chat-text").boundingBox();
        expect(image!.x + image!.width).toBeLessThanOrEqual(text!.x);
      }
    }
  });

  it("paints a visible outline when a chat image action receives keyboard focus", async ({
    usePage,
  }) => {
    const page = await usePage(openBrowserPage(390, 844));
    await page.setContent(`<style>${readUiCss()}</style>
        <button class="chat-tool-card__preview-image-button">Open image</button>`);
    await page.keyboard.press("Tab");
    const button = page.locator("button");
    await expectBrowser(button).toBeFocused();
    await expectBrowser(button).toHaveCSS("outline-style", "solid");
    await expectBrowser(button).toHaveCSS("outline-width", "2px");
  });

  it("applies configured chat width to tool rows and composer without changing defaults", async ({
    usePage,
  }) => {
    const page = await usePage(openBrowserPage(1600, 900));
    const renderFixture = async (configured: boolean) => {
      const style = configured
        ? 'style="--chat-thread-max-width: 82%; --chat-message-max-width: 100%"'
        : "";
      await setMarkup(
        page,
        `<section class="chat" ${style}>
          <div class="chat-thread chat-thread--direct" role="log">
            <div class="chat-thread-inner">
              <div class="chat-group tool">
                <div class="chat-group-messages" data-tool-lane>
                  <div class="chat-bubble chat-bubble--tool-shell" data-tool-shell>
                    <div class="chat-tool-msg-collapse">Tool output</div>
                  </div>
                </div>
              </div>
              <div class="chat-group tool chat-group--activity">
                <div class="chat-group-messages" data-activity-lane>
                  <div class="chat-activity-group">Activity</div>
                </div>
              </div>
              <div class="chat-group assistant chat-group--with-footer">
                <div class="chat-group-messages" data-frame-lane>
                  <div class="chat-activity-group">Framed activity</div>
                </div>
              </div>
            </div>
          </div>
          <div class="chat-footer">
            <div class="agent-chat__composer-shell" data-composer>
              <div class="chat-footer__context">
                <div class="chat-prs" data-chat-prs>Pull requests</div>
              </div>
              <div class="agent-chat__input">Composer</div>
            </div>
          </div>
        </section>`,
      );
      return readControlRects(page, {
        activity: "[data-activity-lane] .chat-activity-group",
        composer: "[data-composer]",
        prs: "[data-chat-prs]",
        shell: "[data-tool-shell]",
        framedActivity: "[data-frame-lane] .chat-activity-group",
        thread: ".chat-thread-inner",
        tool: "[data-tool-lane]",
      });
    };
    const defaults = await renderFixture(false);
    expect(defaults.thread.width).toBeCloseTo(768, 0);
    expect(defaults.composer.width).toBeCloseTo(defaults.thread.width, 0);
    expect(defaults.prs.width).toBeCloseTo(defaults.thread.width, 0);
    expect(defaults.tool.width).toBeCloseTo(defaults.thread.width, 0);
    expect(defaults.shell.width).toBeCloseTo(760, 0);
    expect(defaults.activity.width).toBeCloseTo(760, 0);
    expect(defaults.framedActivity.width).toBeCloseTo(defaults.activity.width, 0);
    const configured = await renderFixture(true);
    for (const key of ["activity", "framedActivity", "shell", "tool"] as const) {
      expect(configured[key].width).toBeCloseTo(configured.thread.width, 0);
    }
    expect(configured.composer.width).toBeCloseTo(configured.prs.width, 0);
    for (const rect of Object.values(configured)) {
      expect(rect.center).toBeCloseTo(configured.thread.center, 0);
    }
    expect(configured.thread.width).toBeGreaterThan(defaults.thread.width);
    expect(configured.composer.width).toBeGreaterThan(defaults.composer.width);
  });

  it("keeps the desktop model picker label-to-chevron gap at 4px", async ({ usePage }) => {
    const page = await usePage(openBrowserPage(800, 800));
    await setMarkup(
      page,
      `<div class="agent-chat__composer-shell">
          <div class="agent-chat__input">
            <div class="chat-controls__model-settings">
              <div class="chat-controls__inline-select">
                <div class="chat-controls__inline-select-trigger chat-controls__model-trigger">
                  <span class="chat-controls__inline-select-label">Model</span>
                  <span class="chat-controls__inline-select-chevron">${iconSvg()}</span>
                </div>
              </div>
            </div>
          </div>
        </div>`,
    );
    const { label, chevron } = await readControlRects(page, {
      label: ".chat-controls__inline-select-label",
      chevron: ".chat-controls__inline-select-chevron",
    });
    expect(chevron.left - label.right).toBeCloseTo(4, 0);
  });

  it("keeps inline MCP App reloads transparent without changing dashboard surfaces", async ({
    usePage,
  }) => {
    const page = await usePage(openBrowserPage(1366, 900));

    if (!realChatServer) {
      throw new Error("Expected the Control UI server to be ready");
    }
    const provider = await mountMcpAppSurfaceFixture(page, realChatServer.baseUrl);
    const backgrounds = await provider.evaluate(async (owner: HTMLElement) => {
      await customElements.whenDefined("mcp-app-view");
      const readFrameBackground = async (boardSurface?: string) => {
        if (boardSurface) {
          owner.style.setProperty("--board-surface", boardSurface);
        } else {
          owner.style.removeProperty("--board-surface");
        }
        const view = document.createElement("mcp-app-view") as HTMLElement & {
          updateComplete: Promise<boolean>;
        };
        owner.replaceChildren(view);
        await view.updateComplete;
        const mount = view.querySelector(".mount");
        if (!mount) {
          throw new Error("MCP App mount is missing");
        }
        const frame = document.createElement("iframe");
        mount.append(frame);
        return getComputedStyle(frame).backgroundColor;
      };
      return {
        dashboard: await readFrameBackground("rgb(12, 34, 56)"),
        inline: await readFrameBackground(),
      };
    });

    expect(backgrounds.dashboard).toBe("rgb(12, 34, 56)");
    expect(backgrounds.inline).toBe("rgba(0, 0, 0, 0)");
  });

  it("keeps wrapped message footers inside measured virtual rows", async ({ usePage }) => {
    const page = await usePage(openBrowserPage(1366, 900));
    await setMarkup(
      page,
      `<div class="chat-thread" style="width: 220px; height: 400px;">
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
                        ${textBubble("A narrow assistant message.")}
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
          </div>`,
    );
    await waitForLayoutSettled(page, "[data-first-row], .chat-group-footer");
    const { first, second, avatar, bubble, footer } = await readControlRects(page, {
      first: "[data-first-row]",
      second: "[data-second-row]",
      avatar: "[data-first-row] .chat-avatar",
      bubble: "[data-first-row] .chat-bubble",
      footer: "[data-first-row] .chat-group-footer",
    });

    expect(footer.height).toBeGreaterThan(24);
    expect(avatar.top - bubble.top).toBeCloseTo(0, 0);
    expect(footer.bottom).toBeLessThanOrEqual(first.bottom + 1);
    expect(Math.abs(second.top - first.bottom)).toBeLessThanOrEqual(1);
  });

  it("keeps attributed user avatar fallbacks beside the message after identity resolution", async ({
    usePage,
  }) => {
    const page = await usePage(openBrowserPage(860, 900));
    await setMarkup(
      page,
      `<div class="chat-thread" style="width: 768px;">
            <div class="chat-thread-inner" style="width: 768px;">
              ${messageHtml(
                "user chat-group--with-footer",
                textBubble("A newly sent message."),
                `
                <span class="chat-avatar-slot"><img class="chat-avatar user" alt="Collin Johnson"
                  src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36'%3E%3Crect width='36' height='36' fill='purple'/%3E%3C/svg%3E" />
                  <div class="chat-avatar user chat-avatar--sender-initials">C</div>
                </span>`,
                footerHtml("collinjohnsonw", "", "now"),
              )}
            </div>
          </div>`,
    );
    const messageAvatarSlot = page.locator(".chat-group .chat-avatar-slot");
    await messageAvatarSlot.locator("img").waitFor();

    expect(await messageAvatarSlot.evaluate((slot) => getComputedStyle(slot).display)).toBe("grid");
    for (const selector of ["img.chat-avatar", ".chat-avatar--sender-initials"]) {
      if (selector === ".chat-avatar--sender-initials") {
        await messageAvatarSlot.evaluate((slot) => slot.classList.add("is-fallback"));
      }
      const { group, bubble, avatar } = await readControlRects(page, {
        group: ".chat-group.user",
        bubble: ".chat-bubble",
        avatar: selector,
      });
      expect(avatar.css.display).not.toBe("none");
      expect(avatar.left).toBeGreaterThanOrEqual(bubble.right + 9);
      expect(avatar.right).toBeLessThanOrEqual(group.right + 1);
    }
    await page
      .locator(".chat-thread")
      .evaluate((thread) => thread.classList.add("chat-thread--direct"));
    expect(await messageAvatarSlot.evaluate((slot) => getComputedStyle(slot).display)).toBe("none");
    await page
      .locator(".chat-thread")
      .evaluate((thread) => thread.classList.remove("chat-thread--direct"));
    await page.setViewportSize({ width: 390, height: 900 });
    expect(await messageAvatarSlot.evaluate((slot) => getComputedStyle(slot).display)).toBe("none");
  });

  it.for([
    ["dark", false],
    ["light", true],
  ])(
    "keeps a sent gallery above its text bubble without hover changes in %s mode (sender tint: %s)",
    async ([theme, tinted], { usePage }) => {
      const page = await usePage(openBrowserPage(1280, 900));
      const tile = (index: number) => `
        <span class="chat-image-frame" data-tile="${index}">
          <button class="chat-message-image-button" type="button">
            <img class="chat-message-image" width="640" height="640" alt="Image ${index}"
              src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='640'%3E%3Crect width='640' height='640' fill='%23865cff'/%3E%3C/svg%3E" />
          </button>
        </span>`;
      await page.setContent(`<!doctype html><html data-theme-mode="${theme}"><head><style>${readUiCss()}</style></head><body>
          <div class="chat-group user ${tinted ? "chat-group--sender-tint" : ""}"
            style="--chat-sender-hue: 208">
            <div class="chat-bubble chat-bubble--with-images">
              <div
                class="chat-message-images chat-message-images--gallery chat-message-images--five"
              >
                ${Array.from({ length: 5 }, (_, index) => tile(index + 1)).join("")}
              </div>
              <div class="chat-text">oi</div>
            </div>
          </div>
        </body></html>`);
      await page.locator(".chat-message-image").first().waitFor();
      const geometry = await page.locator(".chat-bubble").evaluate((bubble) => {
        const gallery = bubble.querySelector<HTMLElement>(".chat-message-images")!;
        const text = bubble.querySelector<HTMLElement>(".chat-text")!;
        const frames = [...gallery.querySelectorAll<HTMLElement>(".chat-image-frame")];
        const boxes = frames.map((frame) => frame.getBoundingClientRect());
        const galleryBox = gallery.getBoundingClientRect();
        const textBox = text.getBoundingClientRect();
        return {
          background: getComputedStyle(bubble).backgroundColor,
          firstRow: boxes.filter((box) => Math.round(box.top) === Math.round(boxes[0]!.top)).length,
          fourthAlignedWithSecond: Math.abs(boxes[3]!.left - boxes[1]!.left) <= 1,
          lastRowRightAligned: Math.abs(boxes[4]!.right - galleryBox.right) <= 1,
          textGap: textBox.top - galleryBox.bottom,
          textRightAligned: Math.abs(textBox.right - galleryBox.right) <= 1,
          tileSize: boxes[0]!.width,
        };
      });
      expect(geometry).toMatchObject({
        background: "rgba(0, 0, 0, 0)",
        firstRow: 3,
        fourthAlignedWithSecond: true,
        lastRowRightAligned: true,
        textGap: 8,
        textRightAligned: true,
      });
      expect(geometry.tileSize).toBeCloseTo(128, 0);
      for (const hovered of [true, false]) {
        if (hovered) {
          await page.locator(".chat-message-image").first().hover();
        } else {
          await page.mouse.move(0, 0);
        }
        expect(
          await page.locator(".chat-bubble").evaluate((bubble) => ({
            background: getComputedStyle(bubble).backgroundColor,
            shadow: getComputedStyle(bubble).boxShadow,
          })),
        ).toEqual({ background: "rgba(0, 0, 0, 0)", shadow: "none" });
      }
    },
  );

  it.for([false, true])(
    "keeps every sent-image text shape on the user bubble surface (sender tint: %s)",
    async (tinted, { usePage }) => {
      const page = await usePage(openBrowserPage(1280, 900));
      const shapes = [
        '<div class="chat-text" data-shape="text">Short text</div>',
        `<div class="chat-message-disclosure" data-shape="disclosure">
          <div class="chat-message-disclosure__content"><div class="chat-text">Collapsed text</div></div>
        </div>`,
        '<div class="chat-text" data-shape="json"><pre><code class="language-json">{"ready":true}</code></pre></div>',
      ]
        .map((content) => div("chat-bubble chat-bubble--with-images", content))
        .join("");
      await setMarkup(
        page,
        `<div class="chat-group user ${tinted ? "chat-group--sender-tint" : ""}"
            style="--chat-sender-hue: 208">
            <div class="chat-bubble" data-reference>Text-only message</div>
            ${shapes}
          </div>`,
      );
      for (const theme of ["dark", "light"] as const) {
        await page.evaluate(
          (mode) => document.documentElement.setAttribute("data-theme-mode", mode),
          theme,
        );
        const { surfaces, reference, transparent } = await page.evaluate(() => {
          const surface = (element: Element) => {
            const style = getComputedStyle(element);
            return {
              backgroundColor: style.backgroundColor,
              color: style.color,
              padding: style.padding,
            };
          };
          const { backgroundColor, color } = surface(document.querySelector("[data-reference]")!);
          return {
            surfaces: [...document.querySelectorAll("[data-shape]")].map(surface),
            reference: { backgroundColor, color, padding: "10px 14px" },
            transparent: [...document.querySelectorAll(".chat-bubble--with-images")].every(
              (bubble) => getComputedStyle(bubble).backgroundColor === "rgba(0, 0, 0, 0)",
            ),
          };
        });
        expect(surfaces).toEqual([reference, reference, reference]);
        expect(transparent).toBe(true);
      }
    },
  );

  it("wraps long question and approval metadata inside narrow cards", async ({ usePage }) => {
    const page = await usePage(openBrowserPage(320, 568));
    const longToken = `workspace${"x".repeat(240)}session`;
    await setMarkup(
      page,
      `<div data-narrow-card style="width: 220px;">
            <div class="chat-question-panel__heading">
              <span class="chat-question-panel__progress">1/1</span>
              <span class="chat-question-panel__prompt">${longToken}</span>
            </div>
            <div class="exec-approval-meta">
              <div class="exec-approval-meta-row"><span>Session</span><span>${longToken}</span></div>
            </div>
          </div>`,
    );
    const { card, heading, prompt, row, value } = await readControlRects(page, {
      card: "[data-narrow-card]",
      heading: ".chat-question-panel__heading",
      prompt: ".chat-question-panel__prompt",
      row: ".exec-approval-meta-row",
      value: ".exec-approval-meta-row > :last-child",
    });

    expect(prompt.right).toBeLessThanOrEqual(heading.right + 1);
    expect(value.right).toBeLessThanOrEqual(row.right + 1);
    expect(heading.right).toBeLessThanOrEqual(card.right + 1);
    expect(row.right).toBeLessThanOrEqual(card.right + 1);
  });

  it("reserves command text space for flush tool-card actions", async ({ usePage }) => {
    const page = await usePage(openBrowserPage(320, 568));
    await setMarkup(
      page,
      `<div class="chat-tool-card chat-tool-card--flush" style="width: 220px;">
            <div class="chat-tool-card__actions">
              <button class="chat-tool-card__action-btn" type="button">${iconSvg()}</button>
            </div>
            <div class="chat-tool-term">
              <div class="chat-tool-term__cmd"><span class="chat-tool-term__prompt">$</span><code>command with a long first line</code></div>
            </div>
          </div>`,
    );
    const { command, actions } = await readControlRects(page, {
      command: ".chat-tool-term__cmd",
      actions: ".chat-tool-card__actions",
    });

    expect(command.right - command.paddingRight).toBeLessThanOrEqual(actions.left + 1);
  });

  it("keeps tool-card header actions visible without hover", async ({ usePage }) => {
    const page = await usePage(openBrowserPage(430, 720));
    await setMarkup(
      page,
      `<div class="chat-tool-card">
            <div class="chat-tool-card__header">
              <span>ui/src/styles/chat/tool-cards.css</span>
              <div class="chat-tool-card__actions">
                <button class="chat-tool-card__action-btn" type="button">${iconSvg()}</button>
              </div>
            </div>
          </div>`,
    );

    expect(
      await page
        .locator(".chat-tool-card__header > .chat-tool-card__actions")
        .evaluate((node) => getComputedStyle(node).opacity),
    ).toBe("1");
  });

  it.for([
    [320, 568],
    [900, 500],
    [1366, 900],
    [1440, 1400],
  ] as const)(
    "keeps transcript roles, insets, and composer surfaces aligned at %sx%s",
    async ([width, height], { usePage }) => {
      const page = await usePage(openFixture(width, height));
      const { thread, first } = await readControlRects(page, {
        thread: ".chat-thread",
        first: ".chat-thread-inner > .chat-group:first-child",
      });
      expect(thread.paddingTop).toBeGreaterThanOrEqual(20);
      expect(first.top - thread.top).toBeCloseTo(thread.paddingTop, 0);
      if (height > 500) {
        const roles = await readControlRects(page, {
          assistantLane: ".chat-group.assistant .chat-group-messages",
          assistantBubble: ".chat-group.assistant .chat-bubble:first-child",
          transcript: ".chat-thread-inner",
          transcriptViewport: ".chat-thread",
          composer: ".agent-chat__composer-shell",
          userLane: ".chat-group.user .chat-group-messages",
          userBubble: ".chat-group.user .chat-bubble:first-child",
        });
        const {
          assistantLane,
          assistantBubble,
          transcript,
          transcriptViewport,
          userLane,
          userBubble,
        } = roles;

        expect(Math.abs(transcript.center - transcriptViewport.center)).toBeLessThanOrEqual(1);
        if (width <= 768) {
          const composer = roles.composer;
          expect(transcript.x).toBeCloseTo(composer.x, 0);
          expect(transcript.width).toBeCloseTo(composer.width, 0);
        } else {
          expect(transcript.width).toBeCloseTo(768, 0);
        }
        expect(Math.abs(assistantBubble.x - assistantLane.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(userBubble.right - userLane.right)).toBeLessThanOrEqual(1);
        expect(userLane.x).toBeGreaterThan(assistantLane.x);
        expect(userBubble.width).toBeLessThan(userLane.width);
        expect(assistantBubble.width).toBeLessThan(assistantLane.width);
      }
      const geometry = await readControlRects(page, {
        assistantBubble: ".chat-group.assistant .chat-bubble:first-child",
        bubble: ".chat-group.user .chat-bubble:first-child",
        codeBlock: ".code-block-wrapper",
        composer: ".agent-chat__composer-shell > .agent-chat__input",
        footer: ".agent-chat__composer-footer",
        textarea: ".agent-chat__composer-combobox > textarea",
      });

      expect(geometry.codeBlock?.borderRadius).toBeGreaterThan(0);
      expect(geometry.bubble).toMatchObject({
        borderRadius: geometry.codeBlock?.borderRadius,
        cornerShape: geometry.codeBlock?.cornerShape,
        paddingTop: 16,
        paddingRight: 16,
        paddingBottom: 16,
        paddingLeft: 16,
      });
      expect(geometry.assistantBubble).toMatchObject({ paddingLeft: 0, paddingRight: 0 });
      expect(geometry.composer?.borderRadius).toBe(20 * (await readCornerScale(page)));
      const textareaBlockInset = width <= 768 || (width <= 932 && height <= 500) ? 10 : 6;
      expect(geometry.textarea).toMatchObject({
        paddingTop: textareaBlockInset,
        paddingBottom: textareaBlockInset,
        paddingLeft: 0,
        paddingRight: 0,
      });
      const shortLandscape = width <= 932 && height <= 500;
      const footerInset = width <= 768 || shortLandscape ? 4 : 8;
      expect(geometry.footer).toMatchObject({
        paddingLeft: footerInset,
        paddingRight: footerInset,
        paddingTop: width <= 768 ? 4 : shortLandscape ? 2 : 6,
        paddingBottom: width <= 768 ? 4 : shortLandscape ? 0 : 6,
      });
      const { composer: surface, textarea: editor, footer: actionRow } = geometry;
      expect(surface.height).toBeGreaterThanOrEqual(98);
      expect(actionRow.top).toBeGreaterThanOrEqual(editor.bottom - 1);
      expect(surface.bottom - actionRow.bottom).toBeGreaterThanOrEqual(0);
    },
  );

  it.for([[1366, 900]] as const)(
    "centers overflowing direct messages on the composer axis at %sx%s",
    async ([width, height], { usePage }) => {
      const page = await usePage(openFixture(width, height, { direct: true }));
      await page.evaluate(() => {
        const thread = document.querySelector<HTMLElement>(".chat-thread");
        const inner = document.querySelector<HTMLElement>(".chat-thread-inner");
        if (!thread || !inner) {
          throw new Error("Missing chat overflow fixture");
        }
        inner.style.minHeight = `${thread.clientHeight + 1}px`;
      });
      await expectNoHorizontalOverflow(page);
      const { assistantLane, composer, thread, userLane, overflow } = await readControlRects(page, {
        assistantLane: ".chat-group.assistant .chat-group-messages",
        composer: ".agent-chat__composer-shell",
        thread: ".chat-thread-inner",
        userLane: ".chat-group.user .chat-group-messages",
        overflow: ".chat-thread",
      });
      expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);
      expect(overflow.css["scrollbar-gutter"]).toBe("stable both-edges");
      expect(Math.abs(thread.center - composer.center)).toBeLessThanOrEqual(1);
      expect(Math.abs(thread.width - composer.width)).toBeLessThanOrEqual(1);
      expect(thread.width).toBeCloseTo(768, 0);
      expect(Math.abs(assistantLane.left - thread.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(userLane.right - thread.right)).toBeLessThanOrEqual(1);
    },
  );

  it.for([
    [320, 568],
    [1366, 900],
  ] as const)(
    "keeps short assistant names and actions compact below the bubble at %sx%s",
    async ([width, height], { usePage }) => {
      const page = await usePage(openBrowserPage(width, height));
      await setMarkup(
        page,
        threadHtml(
          messageHtml(
            "assistant chat-group--with-footer",
            textBubble("<p>Done.</p>"),
            '<div class="chat-avatar assistant">A</div>',
            footerHtml(),
          ),
        ),
      );
      await page.locator(".chat-bubble").hover();
      const textBottom = await getTextBottom(page, ".chat-text p");
      const actions = await getRect(page, ".chat-group-footer-actions");
      expect(textBottom).toBeLessThanOrEqual(actions.top - 1);
      const bubble = await getRect(page, ".chat-bubble");
      const name = await getRect(page, ".chat-sender-name");
      const icon = await getRect(page, ".chat-group-footer-actions button svg");
      // Turn spacing belongs after this whole set, not above its metadata.
      expect(name.top - bubble.bottom).toBeLessThanOrEqual(10);
      expect(icon.top - bubble.bottom).toBeLessThanOrEqual(10);
    },
  );

  it.for([
    [320, 568, "dark"],
    [1366, 900, "light"],
  ] as const)(
    "wraps inline code without clipping or detached punctuation at %sx%s in %s",
    async ([width, height, themeMode], { usePage }) => {
      const page = await usePage(openBrowserPage(width, height));
      await page.setContent(`<!doctype html><html data-theme-mode="${themeMode}"><head><style>${readUiCss()}</style></head><body>
${threadHtml(
  messageHtml(
    "assistant",
    textBubble(
      "<p><code data-long-code>openclaw_message_send_channel_webchat_target_example_com_thread_very_long_identifier_without_spaces_1234567890abcdefghijklmnopqrstuvwxyz</code></p>",
    ),
    '<div class="chat-avatar assistant">A</div>',
  ),
)}
          <div class="chat-text" data-inline-punctuation><p>Use <code>status</code>; then <code>restart</code>.</p></div>
        </body></html>`);

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
        // The chip's inset plus border must fit within a quarter of the 14px prose size.
        expect(horizontalGap).toBeLessThanOrEqual(3.75);
        // Use the CSS line box: monospace text bounds vary between macOS and Linux.
        expect(lineHeight).toBeGreaterThan(0);
        expect(chipHeight).toBeLessThanOrEqual(lineHeight + 1);
      }
    },
  );

  it.for(["dark", "light"] as const)(
    "fits short table cards to their columns in %s mode",
    async (themeMode, { usePage }) => {
      const page = await usePage(openBrowserPage(800, 400));
      await page.setContent(`<!doctype html><html data-theme-mode="${themeMode}"><head><style>${readUiCss()}</style></head><body>
            <div class="chat-text">
              <div data-table-lane style="width: 680px">
                <table data-short-table><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody><tr><td>Gateway</td><td>Ready</td></tr></tbody></table>
              </div>
              <div data-narrow-table-lane style="width: 160px">
                <table data-narrow-table><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody><tr><td>Gateway</td><td>Ready</td></tr></tbody></table>
              </div>
            </div>
          </body></html>`);
      const { lane, narrowLane, narrowTable, table, cell } = await readControlRects(page, {
        lane: "[data-table-lane]",
        narrowLane: "[data-narrow-table-lane]",
        narrowTable: "[data-narrow-table]",
        table: "[data-short-table]",
        cell: "[data-short-table] tbody td:last-child",
      });

      expect(table.width).toBeLessThan(lane.width);
      expect(table.right - cell.right).toBeLessThanOrEqual(1);
      expect(narrowTable.width).toBeCloseTo(narrowLane.width, 0);
    },
  );

  it("shows the current effort beside its heading in the accent color", async ({ usePage }) => {
    const page = await usePage(openBrowserPage(393, 852));
    await setMarkup(
      page,
      `<div class="chat-controls__reasoning-panel">
              <div class="chat-controls__reasoning-head">
                <span class="chat-controls__effort-heading">Effort</span>
                <span class="chat-controls__effort-value">Extra high</span>
              </div>
            </div>
            <span data-accent-probe style="color: var(--accent)"></span>`,
    );
    const { heading, value, accent } = await readControlRects(page, {
      heading: ".chat-controls__effort-heading",
      value: ".chat-controls__effort-value",
      accent: "[data-accent-probe]",
    });

    expect(value.x).toBeGreaterThanOrEqual(heading.right);
    expect(Math.abs(value.centerY - heading.centerY)).toBeLessThanOrEqual(1);
    expect(value.css.color).toBe(accent.css.color);
  });

  it("keeps the expanded mobile composer inset, scrollable, and flush with the thread", async ({
    usePage,
  }) => {
    const page = await usePage(openFixture(393, 852));
    const textarea = page.locator(".agent-chat__composer-combobox > textarea");
    // Exceed the viewport cap so this proves scrolling, not merely draft height.
    await textarea.fill(
      Array.from({ length: 16 }, (_value, index) => `Mobile composer line ${index + 1}`).join("\n"),
    );
    await textarea.evaluate((node) => {
      const textareaNode = node as HTMLTextAreaElement;
      textareaNode.style.height = `${textareaNode.scrollHeight}px`;
    });
    await page.locator(".context-ring").evaluate(finishElementAnimations);
    const layout = {
      ...(await readComposer(page)),
      ...(await page.evaluate(() => ({
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
      }))),
    };
    const {
      shell,
      input,
      thread,
      meta,
      model,
      context,
      send,
      attach,
      attachIcon,
      textarea: textareaRect,
    } = layout;

    expect(textareaRect.height).toBeLessThanOrEqual(layout.viewportHeight * 0.25 + 1);
    expect(textareaRect.scrollHeight).toBeGreaterThan(textareaRect.clientHeight);
    expect(input.y - thread.bottom).toBeCloseTo(0, 0);
    expect(shell.x).toBeCloseTo(20, 0);
    expect(layout.viewportWidth - shell.right).toBeCloseTo(shell.x, 0);
    expect(attach.x - input.x).toBeLessThanOrEqual(10);
    expect(model.x).toBeGreaterThanOrEqual(context.right - 1);
    expect(input.right - send.right).toBeLessThanOrEqual(8);
    expect(Math.abs(context.centerY - model.centerY)).toBeLessThanOrEqual(2);
    expect(meta.y).toBeGreaterThanOrEqual(model.y - 1);
    expect(attachIcon.width).toBeGreaterThanOrEqual(16);
    expect(attachIcon.height).toBeGreaterThanOrEqual(16);
  });

  it("keeps transient footer controls from crushing mobile model settings", async ({ usePage }) => {
    const page = await usePage(openFixture(320, 568, { crowdedComposerFooter: true }));

    await expectNoHorizontalOverflow(page);
    const layout = {
      ...(await readControlRects(page, {
        controls: ".agent-chat__composer-controls",
        footer: ".agent-chat__composer-footer",
        input: ".agent-chat__input",
        meta: ".agent-chat__composer-meta",
        settings: ".chat-controls__model-trigger",
        typing: ".agent-chat__typing-indicator--outside",
      })),
      viewport: await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      })),
    };

    expect(layout.viewport).toEqual({ width: 320, height: 568 });
    expect(layout.controls.scrollWidth).toBeLessThanOrEqual(layout.controls.clientWidth + 1);
    expectInside(layout.settings, layout.footer, "x");
    expect(layout.typing.x).toBeGreaterThanOrEqual(0);
    expect(layout.typing.x + layout.typing.width).toBeLessThanOrEqual(layout.viewport.width);
    expect(layout.settings.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
    expect(layout.settings.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
    expect(rectsOverlap(layout.settings, layout.meta)).toBe(false);
    expect(rectsOverlap(layout.typing, layout.footer)).toBe(false);
  });

  it.for([
    [320, 568],
    [430, 932],
    [768, 1024],
    [1024, 768],
    [568, 320],
    [1920, 1080],
  ] as const)(
    "keeps the composer bottom controls, attachment, and primary action aligned at %sx%s",
    async ([width, height], { usePage }) => {
      const page = await usePage(openFixture(width, height));

      await expectNoHorizontalOverflow(page);
      const code = await getBoundingBox(page, ".chat-text pre");
      expect(code.x + code.width).toBeLessThanOrEqual(width + 1);
      // Settle the finite entrance effect without a wall-clock sleep.
      await page.locator(".context-ring").evaluate(finishElementAnimations);
      const controls = await readComposer(page);
      const { chat, shell, input, thread, footer, textarea, meta, model, context, attach, send } =
        controls;

      for (const control of [footer, textarea, meta, model, context, attach, send]) {
        expectInside(control, input, "x");
      }
      for (const control of [input, send]) {
        expectInside(control, shell, "x");
      }
      for (const control of [model, attach, send]) {
        expectInside(control, footer, "y");
      }
      expect(model.y).toBeGreaterThanOrEqual(textarea.y);
      expect(context.y).toBeGreaterThanOrEqual(textarea.y);
      expect(attach.y).toBeGreaterThanOrEqual(textarea.bottom - 1);
      expect(send.y).toBeGreaterThanOrEqual(textarea.bottom - 1);
      expect(attach.x).toBeLessThan(send.x);
      expect(send.right).toBeLessThanOrEqual(input.right + 1);
      expect(rectsOverlap(model, send)).toBe(false);
      const contextModelGap = model.x - context.right;
      expect(contextModelGap).toBeGreaterThanOrEqual(-1);
      expect(Math.abs(context.centerY - model.centerY)).toBeLessThanOrEqual(2);
      expect([controls.modelLabel.fontSize, controls.effortLabel.fontSize]).toEqual([14, 14]);
      expect(textarea).toMatchObject({ fontSize: 16, placeholderFontSize: 16 });
      if (width === 320) {
        expect(attach.width).toBeGreaterThanOrEqual(36);
        expect(attach.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
      }
      if (width <= 480) {
        const modelSettings = controls.modelSettings;
        expect(model.width).toBeGreaterThanOrEqual(40);
        expect(model.width).toBeLessThanOrEqual(footer.width);
        expect(modelSettings.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
        expect(modelSettings.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
        expect(modelSettings.x).toBeGreaterThanOrEqual(context.right - 1);
      } else {
        const { modelTrigger, modelLabel, effortTrigger, effortLabel } = controls;
        for (const label of [modelLabel, effortLabel]) {
          expect(label.scrollWidth ?? 0).toBeLessThanOrEqual((label.clientWidth ?? 0) + 1);
        }
        expect(modelTrigger.x).toBeGreaterThanOrEqual(model.x - 1);
        expect(effortTrigger.x).toBeGreaterThanOrEqual(modelTrigger.right - 1);
      }
      expect(send).toMatchObject({ width: expect.closeTo(32, 2), height: expect.closeTo(32, 2) });
      if (width <= 768) {
        expect(footer.height).toBeLessThanOrEqual(53);
      }

      if (width >= 1600) {
        expect(shell.width).toBeGreaterThanOrEqual(767);
        expect(shell.width).toBeLessThanOrEqual(769);
        expect(Math.abs(shell.center - chat.center)).toBeLessThanOrEqual(1);
        expect(input.height).toBeLessThanOrEqual(119);
      }

      if (width > height && height <= 500) {
        expect(input.height).toBeLessThanOrEqual(height * 0.38);
        expect(thread.height).toBeGreaterThanOrEqual(height * 0.4 - 1);
        expect(textarea.height).toBeLessThanOrEqual(56.1);
      }
    },
  );

  it.for([
    [320, 568],
    [844, 390],
    [1440, 1000],
  ] as const)(
    "aligns attachment previews with draft text without clipping remove targets at %sx%s",
    async ([width, height], { usePage }) => {
      const page = await usePage(openFixture(width, height, { composerAttachment: true }));

      await expectNoHorizontalOverflow(page);
      await page.locator(".chat-attachment-remove").focus();
      await page.locator(".chat-attachment-remove").evaluate(finishElementAnimations);
      await page.locator(".agent-chat__input").evaluate((node) => {
        node.scrollTop = 0;
      });
      const { input, preview, attachment, remove, textarea } = await readControlRects(page, {
        input: composerSelectors.input,
        preview: ".chat-attachments-preview",
        attachment: ".chat-attachment-thumb",
        remove: ".chat-attachment-remove",
        textarea: composerSelectors.textarea,
      });
      expect(attachment.x - input.x).toBeGreaterThanOrEqual(9.5);
      expect(Math.abs(attachment.x - textarea.x - textarea.paddingLeft)).toBeLessThanOrEqual(0.5);
      expect(preview.x).toBeGreaterThanOrEqual(input.x);
      expect(remove.y).toBeGreaterThanOrEqual(preview.y);
      expect(remove.x + remove.width).toBeLessThanOrEqual(preview.x + preview.width);
      expect(remove.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
      expect(remove.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
      const hitEdge = (node: HTMLElement | SVGElement, edge: "top" | "right") => {
        const rect = node.getBoundingClientRect();
        return [1, 3].map(
          (offset) =>
            document.elementFromPoint(
              edge === "top" ? rect.x + rect.width / 2 : rect.right - offset,
              edge === "top" ? rect.y + offset : rect.y + rect.height / 2,
            ) === node,
        );
      };
      expect(await page.locator(".chat-attachment-remove").evaluate(hitEdge, "top")).toEqual([
        true,
        true,
      ]);
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
      expect(await lastRemove.evaluate(hitEdge, "right")).toEqual([true, true]);
    },
  );

  it.for([
    { dock: "narrow", width: 620, height: 600 },
    { dock: "bottom", width: 900, height: 300 },
    { dock: "bottom", width: 900, height: 1000 },
  ])(
    "keeps both stacked panels usable at $width×$height ($dock)",
    async ({ dock, width, height }, { usePage }) => {
      const page = await usePage(openBrowserPage(1000, 1100));
      await setMarkup(
        page,
        `<div style="width: ${width}px; height: ${height}px; display: flex;">
            <div class="sidebar-region sidebar-region--${dock} sidebar-region--open" style="--side-panel-height: 360px">
              <main class="sidebar-region__primary" data-region="main">Primary chat</main>
              <section class="side-panel">
                <div class="rail-header side-panel__header" data-region-header="side">Details</div>
                <div class="side-panel__body">
                  <div class="side-panel__panel" data-region="side">Active detail panel</div>
                </div>
              </section>
            </div>
          </div>`,
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
    },
  );

  it("keeps short-landscape composer adjunct rows scroll-reachable", async ({ usePage }) => {
    const page = await usePage(openFixture(568, 320, { composerAttachment: true, goalMode: true }));
    await page
      .locator(".agent-chat__composer-combobox > textarea")
      .fill(
        Array.from(
          { length: 10 },
          (_value, index) =>
            `Landscape proof line ${index + 1}: keep transcript visible while this long draft scrolls inside the bounded composer.`,
        ).join("\n"),
      );
    const initial = await readComposer(page);
    const { input, thread, textarea } = initial;
    expect(input.height).toBeLessThanOrEqual(320 * 0.38);
    expect(thread.height).toBeGreaterThanOrEqual(320 * 0.4 - 1);
    expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
    expect(input.css["overflow-y"]).toBe("auto");
    const { goal } = await readControlRects(page, { goal: ".agent-chat__goal-mode" });
    expect(goal.css).toMatchObject({
      "border-bottom-style": "solid",
      "border-left-style": "none",
      "border-radius": "0px",
      "margin-bottom": "0px",
    });
    expect(textarea.scrollHeight).toBeGreaterThan(textarea.clientHeight);
    const scrolled = await readComposer(page, true);
    const { shell: scrolledShell, input: scrolledInput } = scrolled;
    expect(scrolled.input.scrollTop).toBeGreaterThan(0);
    for (const rect of [scrolled.meta, scrolled.model]) {
      expectInside(rect, scrolledInput, "y");
    }
    const send = scrolled.send;
    expectInside(send, scrolledShell, "y");
  });

  it("keeps short-landscape slash menu visible inside the bounded composer", async ({
    usePage,
  }) => {
    const page = await usePage(
      openFixture(568, 320, {
        composerAttachment: true,
        slashMenu: true,
      }),
    );
    await page.locator(".agent-chat__composer-combobox > textarea").fill("/review");
    const { input, textarea } = await readComposer(page);
    const { menu } = await readControlRects(page, { menu: ".slash-menu" });
    expect(input.height).toBeLessThanOrEqual(320 * 0.38);
    expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
    expectInside(menu, input, "y");
    expect(menu.height).toBeGreaterThanOrEqual(48);
    expect(menu.height).toBeLessThanOrEqual(89);
    expect(textarea.y).toBeGreaterThan(menu.y);
    const scrolled = await readComposer(page, true);
    const { input: scrolledInput, footer } = scrolled;
    expectInside(footer, scrolledInput, "y");
  });

  it("keeps mobile slash command copy in separate grid tracks", async ({ usePage }) => {
    const page = await usePage(openBrowserPage(390, 844));
    await setMarkup(
      page,
      `<div class="slash-menu" style="position: relative">
          <div class="slash-menu-item" role="option">
            <span class="slash-menu-icon">${iconSvg()}</span>
            <span class="slash-menu-copy">
              <span class="slash-menu-name">/session <span class="slash-menu-args">idle max-age &lt;duration|off&gt;</span></span>
              <span class="slash-menu-desc">Manage session-level settings (for example /session idle).</span>
            </span>
          </div>
        </div>`,
    );
    const { copy, name, description } = await readControlRects(page, {
      copy: ".slash-menu-copy",
      name: ".slash-menu-name",
      description: ".slash-menu-desc",
    });
    expect(copy.scrollWidth - copy.clientWidth).toBeLessThanOrEqual(1);
    expect(description.left - name.right).toBeGreaterThanOrEqual(8);
  });

  it("keeps a long task panel full-width with a fixed header and an internal body scroll", async ({
    usePage,
  }) => {
    const page = await usePage(openBrowserPage(980, 844));
    const stepCount = 14;
    const steps = Array.from(
      { length: stepCount },
      (
        _,
        index,
      ) => `<li class="session-progress-card__step session-progress-card__step--${index < 5 ? "completed" : index === 5 ? "in_progress" : "pending"}">
        <span class="session-progress-card__step-marker">${iconSvg()}</span>
        <span class="session-progress-card__step-text">Plan step ${index + 1}</span>
      </li>`,
    ).join("");
    await page.setContent(`<!doctype html><html><head><style>${readUiCss()}
        body { margin: 0; padding: 32px; background: var(--bg); }
        .agent-chat__composer-shell { width: 760px; margin: 0 auto; }
        .session-progress-card__summary :is(
          .session-progress-card__summary-title,
          .session-progress-card__heading-actions,
          .session-progress-card__current,
          .session-progress-card__summary-count,
          .session-progress-card__summary-chevron
        ) { transition: none; }
      </style></head><body>
        <div class="agent-chat__composer-shell">
          <div class="chat-footer__context">
          <div class="agent-chat__progress-float">
            <details class="session-progress-card session-progress-card--composer" open>
              <summary class="session-progress-card__summary">
                ${span("session-progress-card__summary-indicator", span("session-run-spinner", ""))}
                ${span("session-progress-card__summary-collapsed", span("session-progress-card__current", "Abrir a interface"))}
                ${span("session-progress-card__summary-count session-progress-card__summary-count--collapsed", `1/${stepCount}`)}
                ${span("session-progress-card__summary-expanded", span("session-progress-card__summary-title", "Task progress") + span("session-progress-card__heading-actions", `6 of ${stepCount}`))}
                ${span("session-progress-card__summary-chevron", iconSvg())}
              </summary>
              <div class="session-progress-card__body"><ol class="session-progress-card__steps">${steps}</ol></div>
            </details>
          </div>
          <div class="chat-queue">
            <div class="chat-queue__scroll">
              <div class="chat-queue__item chat-queue__item--no-avatar">
                <span class="chat-queue__leading">${iconSvg()}</span>
                <span class="chat-queue__copy"><span class="chat-queue__text">Queued after the plan</span></span>
                <span class="chat-queue__actions"><button class="chat-queue__remove">${iconSvg()}</button></span>
              </div>
            </div>
          </div>
          <div class="agent-chat__goal-float">
            <div class="agent-chat__goal agent-chat__goal--active" data-expanded="false">
              <div class="agent-chat__goal-row">
                <span class="agent-chat__goal-icon">${iconSvg()}</span>
                <span class="agent-chat__goal-copy">
                  <span class="agent-chat__goal-label">Pursuing goal</span>
                  <span class="agent-chat__goal-objective">Ship the aligned stack</span>
                </span>
                <span class="agent-chat__goal-elapsed">14m</span>
                <span class="agent-chat__goal-actions">
                  <button class="agent-chat__goal-action agent-chat__goal-expand">${iconSvg()}</button>
                </span>
              </div>
            </div>
          </div>
          </div>
          <div class="agent-chat__input">Composer</div>
        </div>
        <span id="failed-outcome-probe" class="session-progress-card__summary-count" data-outcome="failed">Failed</span>
        <span id="danger-color-probe" style="color: var(--danger)">Danger</span>
      </body></html>`);
    await page.evaluate(() => {
      document.documentElement.dataset.themeMode = "light";
    });
    const summary = page.locator(".session-progress-card__summary");
    const card = page.locator(".session-progress-card--composer");
    const body = page.locator(".session-progress-card__body");
    const list = page.locator(".session-progress-card__steps");
    const widthBefore = (await card.boundingBox())?.width;
    const readSummaryState = () =>
      readControlRects(page, {
        card: ".session-progress-card--composer",
        summary: ".session-progress-card__summary",
        title: ".session-progress-card__summary-title",
        actions: ".session-progress-card__heading-actions",
        current: ".session-progress-card__current",
        count: ".session-progress-card__summary-count--collapsed",
        chevron: ".session-progress-card__summary-chevron",
        spinner: ".session-progress-card__summary-indicator .session-run-spinner",
        marker: ".session-progress-card__step:first-child .session-progress-card__step-marker",
      });
    const expectHoverColors = (
      before: Awaited<ReturnType<typeof readSummaryState>>,
      after: Awaited<ReturnType<typeof readSummaryState>>,
      changed: readonly ("title" | "actions" | "current" | "count" | "chevron")[],
    ) => {
      for (const key of ["card", "summary"] as const) {
        expect(after[key].css["background-color"]).toBe(before[key].css["background-color"]);
      }
      for (const key of changed) {
        expect(after[key].css.color).not.toBe(before[key].css.color);
      }
    };
    const setSummaryHover = async (hovered: boolean) => {
      if (hovered) {
        await summary.hover();
      } else {
        await page.mouse.move(0, 0);
      }
      const state = await page.waitForFunction(
        (expected) =>
          document
            .querySelector<HTMLElement>(".session-progress-card__summary")!
            .matches(":hover") === expected,
        hovered,
      );
      await state.dispose();
    };
    const expandedBefore = await readSummaryState();
    const stack = await readControlRects(page, {
      shell: ".agent-chat__composer-shell",
      progress: ".session-progress-card--composer",
      queue: ".chat-queue",
      goal: ".agent-chat__goal",
      input: ".agent-chat__input",
    });
    const stackSurfaces = [stack.progress, stack.queue, stack.goal, stack.input];
    const warnGoalSurfaces = await page.locator(".agent-chat__goal").evaluate((goal) => {
      const surfaces = ["blocked", "budget_limited", "usage_limited"].map((state) => {
        goal.className = `agent-chat__goal agent-chat__goal--${state}`;
        const style = getComputedStyle(goal);
        return { state, background: style.backgroundColor, border: style.borderColor };
      });
      goal.className = "agent-chat__goal agent-chat__goal--active";
      return surfaces;
    });
    await setSummaryHover(true);
    const widthAfter = (await card.boundingBox())?.width;
    const expandedAfter = await readSummaryState();
    expect(widthBefore).toBeCloseTo(760, 1);
    expect(widthAfter).toBeCloseTo(widthBefore ?? 0, 1);
    for (const surface of stackSurfaces) {
      expect(surface.left).toBeCloseTo(stack.shell.left, 1);
      expect(surface.right).toBeCloseTo(stack.shell.right, 1);
    }
    expect(
      new Set(stackSurfaces.slice(0, 3).map(({ css }) => css["background-color"])),
    ).toHaveProperty("size", 1);
    for (const [index, surface] of stackSurfaces.entries()) {
      expect(Number.parseFloat(surface.css["border-top-left-radius"]!)).toBeGreaterThan(0);
      for (const corner of ["top-right", "bottom-left", "bottom-right"]) {
        expect(surface.css[`border-${corner}-radius`]).toBe(surface.css["border-top-left-radius"]);
      }
      if (index > 0) {
        expect(surface.top).toBeGreaterThan(stackSurfaces[index - 1]!.bottom);
      }
    }
    expect(stackSurfaces[2]?.css["border-color"]).toBe(stackSurfaces[1]?.css["border-color"]);
    expect(stackSurfaces[2]?.css["box-shadow"]).toBe(
      stackSurfaces[1]?.css["box-shadow"]?.split(", rgba")[0],
    );
    for (const { state, background, border } of warnGoalSurfaces) {
      expect(background, state).not.toBe(stack.goal.css["background-color"]);
      expect(border, state).not.toBe(stack.goal.css["border-color"]);
    }
    expect(new Set(warnGoalSurfaces.map(({ border }) => border))).toHaveProperty("size", 1);
    expect(expandedBefore.title.left).toBeCloseTo(expandedBefore.marker.left, 1);
    expectHoverColors(expandedBefore, expandedAfter, ["title", "actions", "chevron"]);
    const bodyLayout = await body.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const visibleItems = [...node.querySelectorAll(".session-progress-card__step")].filter(
        (child) => {
          const row = child.getBoundingClientRect();
          return row.bottom <= bounds.bottom + 1 && row.top >= bounds.top - 1;
        },
      ).length;
      return {
        clientHeight: node.clientHeight,
        overflowY: getComputedStyle(node).overflowY,
        scrollHeight: node.scrollHeight,
        visibleItems,
      };
    });
    expect(bodyLayout.overflowY).toBe("auto");
    expect(bodyLayout.scrollHeight).toBeGreaterThan(bodyLayout.clientHeight);
    expect(bodyLayout.visibleItems).toBeGreaterThan(0);
    expect(bodyLayout.visibleItems).toBeLessThan(stepCount);
    expect(await list.evaluate((node) => getComputedStyle(node).overflowY)).toBe("visible");
    await expectAligned(
      page,
      "centerX",
      ".session-progress-card__step-marker > *, .chat-queue__leading svg, .agent-chat__goal-icon svg",
    );
    await expectAligned(
      page,
      "left",
      ".session-progress-card__step:first-child .session-progress-card__step-text, .chat-queue__copy, .agent-chat__goal-label",
    );
    await expectAligned(
      page,
      "centerX",
      ".session-progress-card__summary-chevron svg, .agent-chat__goal-expand svg",
    );
    await body.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    expect((await summary.boundingBox())?.y).toBeCloseTo(expandedBefore.summary.y, 1);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
      await body.evaluate((node) => {
        node.scrollTop = 0;
      });
      await page.locator(".agent-chat__composer-shell").screenshot({
        animations: "disabled",
        path: path.join(artifactDir, "task-progress-expanded-with-queue.png"),
      });
    }
    await setSummaryHover(false);
    await card.evaluate((node) => node.removeAttribute("open"));
    const collapsedState = await page.waitForFunction(
      () =>
        !document.querySelector(".session-progress-card--composer")!.hasAttribute("open") &&
        getComputedStyle(
          document.querySelector<HTMLElement>(".session-progress-card__summary-collapsed")!,
        ).display !== "none",
    );
    await collapsedState.dispose();
    const collapsedBefore = await readSummaryState();
    await setSummaryHover(true);
    const collapsedAfter = await readSummaryState();
    expectHoverColors(collapsedBefore, collapsedAfter, ["current", "count", "chevron"]);
    for (const property of ["border-color", "border-top-color"]) {
      expect(collapsedAfter.spinner.css[property]).toBe(collapsedBefore.spinner.css[property]);
    }
    const { current, count, chevron } = collapsedAfter;
    expect(count.left).toBeGreaterThan(current.right);
    expect(count.right).toBeLessThanOrEqual(chevron.left);
    await expectAligned(
      page,
      "centerX",
      ".session-progress-card__summary-indicator > *, .chat-queue__leading svg, .agent-chat__goal-icon svg",
    );
    await expectAligned(
      page,
      "centerX",
      ".session-progress-card__summary-chevron svg, .agent-chat__goal-expand svg",
    );
    await expectAligned(
      page,
      "centerY",
      ".session-progress-card__summary-indicator > *, .session-progress-card__current, .session-progress-card__summary-count--collapsed, .session-progress-card__summary-chevron > svg",
    );
    await page.locator("#failed-outcome-probe").evaluate(finishElementAnimations);
    const outcomeColors = await page.evaluate(() => ({
      danger: getComputedStyle(document.querySelector("#danger-color-probe")!).color,
      failed: getComputedStyle(document.querySelector("#failed-outcome-probe")!).color,
    }));
    expect(outcomeColors.failed).toBe(outcomeColors.danger);
    if (artifactDir) {
      await page.locator(".agent-chat__composer-shell").screenshot({
        animations: "disabled",
        path: path.join(artifactDir, "task-progress-collapsed-with-queue.png"),
      });
    }
  });

  it("allows pointer selection in the embedded side-chat transcript", async ({ usePage }) => {
    const page = await usePage(openBrowserPage(1024, 768));
    await setMarkup(
      page,
      `<section class="chat-session-rail chat-session-rail--expanded chat-session-rail--embedded">
          <div class="chat-session-rail__thread">
            <article class="chat-session-rail__exchange">
              <div class="chat-session-rail__answer">
                <span data-selection-target>Copy this side chat answer.</span>
              </div>
            </article>
          </div>
        </section>`,
    );
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

  it.for([
    [320, 568],
    [1024, 768],
  ] as const)(
    "keeps embedded side-chat scrolling, composer, and metadata within its panel at %sx%s",
    async ([width, height], { usePage }) => {
      const page = await usePage(openSessionRailFixture(width, height));

      await expectNoHorizontalOverflow(page);
      const { rail, host, thread } = await readControlRects(page, {
        rail: ".chat-session-rail",
        host: ".side-panel__panel",
        thread: ".chat-session-rail__thread",
      });
      expect(rail.css.position).toBe("relative");
      expect(rail.clientHeight).toBeLessThanOrEqual(host.clientHeight);
      expect(host.clientHeight).toBeLessThanOrEqual(height);
      expect(thread.css["overflow-y"]).toBe("auto");
      expect(thread.clientHeight).toBeLessThan(thread.scrollHeight);
      const layout = await readControlRects(
        page,
        {
          rail: ".chat-session-rail",
          thread: ".chat-session-rail__thread",
          composer: ".chat-session-rail__composer",
          footer: ".chat-session-rail__composer .agent-chat__composer-footer",
          input: ".chat-session-rail__input",
          send: ".chat-session-rail__composer .chat-send-btn",
          prChecks: ".chat-session-rail__pr-checks",
          timestamp: ".chat-session-rail__timestamp",
          hint: ".chat-session-rail__hint",
        },
        ".chat-session-rail__thread",
      );
      expect(layout.thread.scrollTop).toBeGreaterThan(0);
      expect(layout.composer.bottom).toBeLessThanOrEqual(layout.rail.bottom + 1);
      expect(layout.input.width).toBeGreaterThan(layout.composer.width * 0.8);
      expect(layout.footer.width).toBeGreaterThan(layout.composer.width * 0.8);
      expect(Math.abs(layout.composer.right - layout.send.right)).toBeLessThanOrEqual(10);
      expect(layout.thread.css).toMatchObject({
        "border-top-width": "0px",
        "margin-top": "0px",
        "min-height": "96px",
        "overflow-y": "auto",
      });
      // Metadata must not inherit the thread's 96px scrolling bordered box.
      for (const metadata of [layout.prChecks, layout.timestamp, layout.hint]) {
        expect(metadata.css["min-height"]).not.toBe(layout.thread.css["min-height"]);
        expect(metadata.css).toMatchObject({
          "overflow-y": "visible",
          "border-top-width": "0px",
        });
      }
    },
  );

  it("matches the reading prototype's transcript letter spacing without changing shared text", async ({
    usePage,
  }) => {
    const page = await usePage(openBrowserPage(1366, 900));
    await page.setContent(`<!doctype html><html data-theme-mode="dark"><head><style>${readUiCss()}</style></head><body>
${threadHtml(
  messageHtml(
    "assistant",
    textBubble(
      "<p>Aa Bb Cc — Smooth reading depends on the shape, spacing, and contrast of every glyph in a transcript.</p><p>Keep this fixture about text rendering; width and block rhythm are intentionally not asserted here.</p>",
    ),
  ),
  "chat-thread--direct",
)}
        <section class="custodian-surface">
          ${textBubble("Custodian output")}
        </section>
        <div class="chat-notice"><div class="chat-text chat-notice__body">Compact notice</div></div>
        <div class="cron-run-entry__body chat-text">Cron output</div>
      </body></html>`);
    const { transcript, custodian, notice, cron, body } = await readControlRects(page, {
      transcript: ".chat-thread .chat-bubble .chat-text",
      custodian: ".custodian-surface .chat-bubble .chat-text",
      notice: ".chat-notice .chat-text",
      cron: ".cron-run-entry__body.chat-text",
      body: "body",
    });
    expect(transcript.css["letter-spacing"]).toBe("normal");
    for (const surface of [custodian, notice, cron]) {
      expect(surface.css["letter-spacing"]).toBe(body.css["letter-spacing"]);
    }
  });
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
      it.for([
        [1440, 1600, 1200],
        [1440, 1800, 420],
        [375, 1800, 420],
      ])(
        "keeps %ipx-wide chat image frames on their visible edges (%i×%i)",
        async ([viewportWidth, width, height], { usePage }) => {
          const page = await usePage(
            browser.newPage({ viewport: { width: viewportWidth, height: 900 } }),
          );
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
                group.classList.contains("user") && !group.classList.contains("chat-group--peer");
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
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
