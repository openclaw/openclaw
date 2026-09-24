// @vitest-environment node
// Control UI tests cover chat responsive behavior.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.ts";
import {
  createPlaybackMediaFixture,
  type PlaybackMediaFixtureFormat,
} from "../../../../test/fixtures/media-playback.js";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";
import { finishElementAnimations } from "../../test-helpers/animations.ts";
import { closeBrowserPage, withBrowserPage } from "../../test-helpers/browser-page.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  installMockGateway,
  startControlUiE2eServer,
  type ControlUiMockGatewayScenario,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";
import {
  canRunChatLayoutBrowser,
  chromiumExecutablePath,
  createChatLayoutBrowser,
  expectFiniteRect,
  getBoundingBox,
  getRect,
  messageCircleOffSvg,
  readUiCss,
  rectsOverlap,
  waitForLayoutSettled,
  type ControlRect,
} from "./chat-layout.browser.test-support.ts";

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
// The shared real-app page still cold-boots Vite's full Control UI graph once;
// under CI contention that first render can starve well past 10s.
const APP_FIRST_RENDER_TIMEOUT_MS = 30_000;
const FULL_APP_TEST_OPTIONS = {
  // Shared-page interactions mutate viewport, pointer, and composer state. Keep
  // each as a sequential barrier so they cannot overlap one another.
  concurrent: false,
  timeout: 60_000,
} as const;
const LONG_SESSION_RAIL_BODY = Array.from(
  { length: 80 },
  (_, index) => `<p>Line ${index + 1}: keep the complete side result readable.</p>`,
).join("");
const describeBrowserLayout = canRunChatLayoutBrowser ? describe : describe.skip;

const layoutBrowser = createChatLayoutBrowser();
const { openBrowserPage } = layoutBrowser;
let sharedAppPage: Page | null = null;
let sharedAppPagePromise: Promise<Page> | null = null;
const sharedAppPageErrors: string[] = [];
let realChatServer: ControlUiE2eServer | null = null;

const SHARED_APP_CONTEXT_TEXT = "Context hover regression fixture.";
const SHARED_APP_SLASH_TEXT = "Short landscape slash command keyboard regression fixture.";
const SHARED_APP_IMAGE_URL = "https://cdn.example/render%2Epng?download=1";
const SHARED_APP_ATTACHMENT_OUTCOME_TEXT = "Mixed attachment outcome fixture.";
const SHARED_APP_TTS_TEXT = "Audio generated and delivered via native TTS.";
const SHARED_APP_PLAYBACK_MEDIA = [
  ["voice---a75c70c7-0112-4d07-8fb5-40c82c979ee8.mp3", "audio", "audio/mpeg", "native"],
  ["reply.ogg", "audio", "audio/ogg", "transcode"],
  ["reply.m4a", "audio", "audio/x-m4a", "native"],
  ["reply.flac", "audio", "audio/flac", "transcode"],
  ["reply.mp4", "video", "video/mp4", "native"],
  ["reply.webm", "video", "video/webm", "transcode"],
] as const;
const sharedAppPlaybackRequests: string[] = [];

function installResponsiveChatGateway(page: Page, scenario: ControlUiMockGatewayScenario = {}) {
  return installMockGateway(page, {
    agentModel: "openai/gpt-5.5",
    ...scenario,
  });
}

async function getSharedAppPage(): Promise<Page> {
  sharedAppPagePromise ??= createSharedAppPage();
  return await sharedAppPagePromise;
}

async function createSharedAppPage(): Promise<Page> {
  if (!realChatServer) {
    throw new Error("Expected the Control UI server to be ready");
  }
  // The five app assertions use disjoint fixture messages and reset mutable
  // page state, so one lazy boot preserves coverage without five graph loads.
  const page = await openBrowserPage(1366, 900, { isolated: true });
  try {
    page.on("pageerror", (error) => sharedAppPageErrors.push(error.message));
    await page.route("https://cdn.example/**", async (route) => {
      const request = route.request();
      if (request.url() === SHARED_APP_IMAGE_URL) {
        await route.fulfill({
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR4nGP4z8DwnxLMMGrAsDCAQv2jBgwPAwAxtf4Q24P5oAAAAABJRU5ErkJggg==",
            "base64",
          ),
        });
        return;
      }
      const fileName = decodeURIComponent(new URL(request.url()).pathname.split("/").at(-1) ?? "");
      const media = SHARED_APP_PLAYBACK_MEDIA.find(([candidate]) => candidate === fileName);
      if (!media) {
        await route.abort();
        return;
      }
      const format = fileName.split(".").at(-1) as PlaybackMediaFixtureFormat;
      const body = createPlaybackMediaFixture(format);
      sharedAppPlaybackRequests.push(request.url());
      await route.fulfill({
        status: 200,
        contentType: media[2],
        body: request.method() === "HEAD" ? Buffer.alloc(0) : body,
      });
    });
    await installResponsiveChatGateway(page, {
      assistantName: "Claw",
      historyMessages: [
        {
          // Keep context geometry independent of the lazily loaded media fixtures.
          __openclaw: { runId: "context-fixture-run" },
          content: [{ text: SHARED_APP_CONTEXT_TEXT, type: "text" }],
          model: "openai/gpt-5.5",
          role: "assistant",
          timestamp: Date.UTC(2026, 6, 5, 9, 51),
          usage: { cacheRead: 2_400, input: 19_600, output: 126 },
        },
        {
          content: `MEDIA:${SHARED_APP_IMAGE_URL}`,
          role: "assistant",
          timestamp: Date.UTC(2026, 6, 9, 10, 0),
        },
        {
          content: [
            { text: SHARED_APP_TTS_TEXT, type: "text" },
            ...SHARED_APP_PLAYBACK_MEDIA.map(([fileName, type, mimeType, playback]) => ({
              fileName,
              mimeType,
              playback,
              type,
              url: `https://cdn.example/${fileName}`,
            })),
          ],
          role: "assistant",
          timestamp: Date.UTC(2026, 6, 9, 10, 1),
        },
        {
          content: [{ text: SHARED_APP_SLASH_TEXT, type: "text" }],
          role: "assistant",
          timestamp: Date.UTC(2026, 6, 9, 10, 2),
        },
        {
          content: [
            { text: SHARED_APP_ATTACHMENT_OUTCOME_TEXT, type: "text" },
            {
              type: "attachment",
              attachment: {
                url: "https://files.example/deploy.yaml",
                kind: "document",
                label: "deploy.yaml",
                mimeType: "application/yaml",
              },
            },
            ...["settings.toml", "schema.sql", "events.ndjson", "font.ttf", "font.woff2"].map(
              (label) => ({
                type: "attachment_error",
                attachment: {
                  code: "unsupported-format",
                  kind: "document",
                  label,
                },
              }),
            ),
            {
              type: "attachment_error",
              attachment: {
                code: "delivery-failed",
                kind: "document",
                label: "bundle.7z",
                mimeType: "application/x-7z-compressed",
              },
            },
          ],
          role: "assistant",
          timestamp: Date.UTC(2026, 6, 9, 10, 3),
        },
      ],
    });
    await page.goto(`${realChatServer.baseUrl}chat/main`, {
      waitUntil: "domcontentloaded",
      timeout: APP_FIRST_RENDER_TIMEOUT_MS,
    });
    await page.getByText(SHARED_APP_SLASH_TEXT).waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
    sharedAppPage = page;
    return page;
  } catch (error) {
    // Closing the page discards its diagnostic ring and browser state.
    await captureControlUiE2eFailureDiagnostics(page, {
      error: error instanceof Error ? error : new Error(String(error)),
      label: "chat-responsive.shared-app-startup",
      pageErrors: sharedAppPageErrors,
    });
    await closeBrowserPage(page);
    throw error;
  }
}

type ChatFixtureOptions = {
  composerAttachment?: boolean;
  crowdedComposerFooter?: boolean;
  direct?: boolean;
  goalMode?: boolean;
  sessionRailBody?: string;
  slashMenu?: boolean;
};

/**
 * Corner radii are expressed as their base step times the live corner scale,
 * so these expectations stay true on engines that draw continuous curvature
 * (`--openclaw-corner-radius-scale: 1.25`) and on engines that do not.
 */
async function readCornerScale(page: Page): Promise<number> {
  return await page.evaluate(() =>
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--openclaw-corner-radius-scale"),
    ),
  );
}

function expectControlRect(rect: ControlRect | null, label: string): ControlRect {
  if (rect === null) {
    throw new Error(`Expected ${label} control rect`);
  }
  expectFiniteRect(rect);
  return rect;
}

function iconSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;
}

const QUEUE_MATRIX_MODES = [
  "steer",
  "followup",
  "collect",
  "interrupt",
] as const satisfies readonly QueueMode[];
const QUEUE_MATRIX_RUNTIMES = ["connected-running", "connected-idle", "disconnected"] as const;
const QUEUE_MATRIX_VARIANTS = ["never-steered", "steered", "editing"] as const;

type QueueMatrixRuntime = (typeof QUEUE_MATRIX_RUNTIMES)[number];
type QueueMatrixVariant = (typeof QUEUE_MATRIX_VARIANTS)[number];

function queueMatrixCellReachable(mode: QueueMode, variant: QueueMatrixVariant): boolean {
  // Steering replaces the delivery mode with `steer`; the prior mode is no
  // longer observable, so a "steered collect/followup/interrupt" row cannot
  // exist in the current queue item contract.
  return variant !== "steered" || mode === "steer";
}

function queueMatrixCellHtml(
  mode: QueueMode,
  runtime: QueueMatrixRuntime,
  variant: QueueMatrixVariant,
) {
  const disconnected = runtime === "disconnected";
  const editing = variant === "editing";
  const steerMode = mode === "steer";
  const badge =
    steerMode && runtime === "connected-idle" && !editing
      ? `<span class="chat-queue__badge chat-queue__badge--steered">Steer</span>`
      : "";
  const state = disconnected ? '<span class="chat-queue__state">Waiting for reconnect</span>' : "";
  const copy = editing
    ? `<textarea class="chat-queue__edit-input">Edit ${mode} message</textarea>`
    : `<span class="chat-queue__copy"><span class="chat-queue__text">${mode} message</span>${badge}${state}</span>`;
  const actions = editing
    ? `<span class="chat-queue__actions"><button class="chat-queue__edit-submit">${iconSvg()}</button><button class="chat-queue__edit-cancel">${iconSvg()}</button></span>`
    : `<span class="chat-queue__actions">${runtime === "connected-running" ? `<button class="chat-queue__action chat-queue__steer">${iconSvg()}<span>Steer</span></button>` : ""}<button class="chat-queue__remove">${iconSvg()}</button><button class="chat-queue__more">${iconSvg()}</button></span>`;
  return `<article class="queue-matrix-cell" data-queue-cell="${mode}-${runtime}-${variant}">
    <header>${mode} · ${runtime} · ${variant}</header>
    <div class="agent-chat__composer-shell">
      <div class="chat-footer__context">
      <div class="chat-queue">
        <div class="chat-queue__scroll">
          <div class="chat-queue__item chat-queue__item--no-avatar${steerMode ? " chat-queue__item--steered" : ""}${disconnected ? " chat-queue__item--reconnect" : ""}${editing ? " chat-queue__item--editing" : ""}">
            <span class="chat-queue__leading">${iconSvg()}</span>${copy}${actions}
          </div>
        </div>
      </div>
      </div>
      <div class="agent-chat__input">Composer</div>
    </div>
  </article>`;
}

function queueExceptionCellHtml(
  key: string,
  globalState: string,
  itemClass: string,
  rowState: string,
  error = "",
  actions = `<button class="chat-queue__remove">${iconSvg()}</button>`,
) {
  return `<article class="queue-matrix-cell" data-queue-exception="${key}">
    <header>${key}</header>
    <div class="agent-chat__composer-shell">
      <div class="chat-footer__context">
      <div class="chat-queue">
        ${globalState}
        <div class="chat-queue__scroll">
          <div class="chat-queue__item chat-queue__item--no-avatar ${itemClass}">
            <span class="chat-queue__leading">${iconSvg()}</span>
            <span class="chat-queue__copy"><span class="chat-queue__text">Queued message</span>${rowState}</span>
            <span class="chat-queue__actions">${actions}</span>
            ${error}
          </div>
        </div>
      </div>
      </div>
      <div class="agent-chat__input">Composer</div>
    </div>
  </article>`;
}

function activityAlignmentHtml() {
  return `
    <div class="chat-thread" role="log">
      <div class="chat-thread-inner">
        <div class="chat-group tool">
          <div class="chat-group-messages" data-tool-column-reference>Inspecting the available tools.</div>
        </div>
        <div class="chat-group tool chat-group--activity chat-group--with-footer">
          <div class="chat-group-messages">
            <div class="chat-activity-group is-open">
              <button class="chat-inline-disclosure chat-activity-group__summary" type="button" aria-expanded="true">
                <span class="chat-activity-group__icon">${iconSvg()}</span>
                <span class="chat-tool-disclosure__content">
                  <span class="chat-activity-group__label">Activity: 2 tools</span>
                </span>
                <span class="chat-tool-row__chevron">${iconSvg()}</span>
              </button>
              <div class="chat-activity-group__body">
                <div class="chat-bubble chat-bubble--tool-shell" data-activity-call-row>
                  <div class="chat-tools-inline">
                    <div class="chat-tool-msg-collapse">
                      <button class="chat-inline-disclosure chat-tool-msg-summary chat-tool-row" type="button" aria-expanded="false">
                        <span class="chat-tool-msg-summary__icon">${iconSvg()}</span>
                        <span class="chat-tool-disclosure__content">
                          <span class="chat-tool-msg-summary__label">Bash</span>
                          <span class="chat-tool-msg-summary__names">search a deliberately long workspace path without extra card chrome</span>
                        </span>
                        <span class="chat-tool-row__chevron">${iconSvg()}</span>
                      </button>
                    </div>
                  </div>
                </div>
                <div class="chat-bubble chat-bubble--tool-shell">
                  <div class="chat-tool-msg-collapse">
                    <button class="chat-inline-disclosure chat-tool-msg-summary chat-tool-row" data-failed-call-row type="button" aria-expanded="false">
                      <span class="chat-tool-msg-summary__icon">${iconSvg()}</span>
                      <span class="chat-tool-disclosure__content">
                        <span class="chat-tool-msg-summary__label">Bash</span>
                        <span class="chat-tool-msg-summary__names">Bash</span>
                      </span>
                      <span class="chat-tool-row__chevron">${iconSvg()}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

type AvatarPlacement = "gutter" | "footer" | "none";

// Mirrors every group shape the transcript renders: turn-ending own/peer user and
// assistant groups (hidden, revealed, persistent footers, and a streaming reply
// whose footer row is still empty), plus work, activity and live narration blocks
// that belong to the turn of the answer after them and therefore have no footer
// row. Each avatar
// placement renders the same turns: gutter avatars, footer avatars in direct
// threads, or none for subagent sessions.
function uniformTurnSpacingHtml(placement: AvatarPlacement) {
  const copy = `<div class="chat-group-footer-actions"><button class="chat-copy-btn" type="button" aria-label="Copy">${iconSvg()}</button></div>`;
  const row = (group: string) => `<div class="chat-virtual-row">${group}</div>`;
  const gutterAvatar = (role: string) =>
    placement === "gutter" ? `<div class="chat-avatar ${role}">A</div>` : "";
  const meta = (name: string, role: string) =>
    `<div class="chat-group-footer__meta">${
      placement === "footer" && role === "user" ? '<span class="chat-author-avatar"></span>' : ""
    }<span class="chat-sender-name">${name}</span></div>`;
  const message = (role: string, modifiers: string, text: string, footer: string) => `
    <div class="chat-group ${role} ${modifiers} chat-group--with-footer">
      ${gutterAvatar(role)}
      <div class="chat-group-messages"><div class="chat-bubble"><div class="chat-text">${text}</div></div></div>
      ${footer}
    </div>`;
  const persistent = (inner: string) =>
    `<div class="chat-group-footer chat-group-footer--persistent-identity">${inner}</div>`;
  const tool = (classes: string, summary: string) => `
    <div class="chat-group tool chat-group--turn-block ${classes}">
      <div class="chat-group-messages">
        <div class="chat-activity-group chat-work-group">
          <button class="chat-inline-disclosure chat-activity-group__summary" type="button">${summary}</button>
          <div class="chat-work-group__separator"></div>
        </div>
      </div>
    </div>`;
  // Live narration renders as an assistant group marked as a turn block.
  const narration = (text: string) => `
    <div class="chat-group assistant chat-group--turn-block chat-group--with-footer">
      <div class="chat-group-messages"><div class="chat-bubble"><div class="chat-text">${text}</div></div></div>
    </div>`;
  return `
    <div class="chat-thread${placement === "footer" ? " chat-thread--direct" : ""}" role="log">
      <div class="chat-thread-inner chat-thread-inner--virtual">
        <div class="chat-virtual-sizer" style="height: 1600px;">
          <div class="chat-virtual-block">
            ${[
              message("user", "", "Own prompt", persistent(`${copy}${meta("You", "user")}`)),
              tool("chat-group--work", "Worked for 10s"),
              message(
                "assistant",
                "",
                "Reply after work",
                `<div class="chat-group-footer">${meta("Assistant", "assistant")}${copy}</div>`,
              ),
              message(
                "user",
                "chat-group--peer",
                "Peer prompt",
                persistent(`${meta("Peer", "user")}${copy}`),
              ),
              tool("chat-group--activity chat-group--with-footer", "Activity: 2 tools"),
              message(
                "assistant",
                "chat-group--meta-revealed",
                "Revealed reply",
                `<div class="chat-group-footer">${meta("Assistant", "assistant")}${copy}</div>`,
              ),
              message(
                "user",
                "chat-group--meta-revealed",
                "Revealed own prompt",
                persistent(`${copy}${meta("You", "user")}`),
              ),
              narration("Checking the footer layout first."),
              tool("chat-group--activity chat-group--with-footer", "Activity: 1 tool"),
              narration("Comparing the two layouts."),
              message(
                "assistant",
                "",
                "Streaming reply",
                '<div class="chat-group-footer" aria-hidden="true"></div>',
              ),
            ]
              .map(row)
              .join("")}
          </div>
        </div>
      </div>
    </div>
  `;
}

function runBlockSpacingHtml() {
  return `
    <div class="chat-thread chat-thread--direct" role="log">
      <div class="chat-thread-inner">
        <div class="chat-group assistant chat-group--with-footer" data-run-turn>
          <div class="chat-group-messages">
            <div class="chat-bubble" data-run-block="text"><div class="chat-text">Opening text</div></div>
            <div class="chat-bubble" data-run-block="detail"><div class="chat-text">Detail text</div></div>
            <div class="chat-bubble chat-bubble--tool-shell" data-run-block="tool">Tool row</div>
            <div class="chat-activity-group" data-run-block="list">
              <div class="chat-activity-group__body">
                <div class="chat-group-messages">
                  <div class="chat-bubble" data-expanded-row="text">Expanded detail</div>
                  <div class="chat-bubble chat-bubble--tool-shell" data-expanded-row="tool">Expanded tool row</div>
                </div>
              </div>
            </div>
            <div class="chat-bubble" data-run-block="activity-reply"><div class="chat-text">Activity result</div></div>
            <div class="chat-activity-group chat-work-group" data-run-block="work">
              <button class="chat-inline-disclosure chat-activity-group__summary" type="button">Worked for 10s</button>
              <div class="chat-work-group__separator"></div>
            </div>
            <div class="chat-bubble" data-run-block="reply"><div class="chat-text">Final reply</div></div>
          </div>
          <div class="chat-group-footer">
            <span class="chat-sender-name">Assistant</span>
            <div class="chat-group-footer-actions">
              <button class="chat-copy-btn" type="button" aria-label="Copy">${iconSvg()}</button>
            </div>
          </div>
        </div>
        <div class="chat-group user chat-group--with-footer" data-next-turn>
          <div class="chat-group-messages">
            <div class="chat-bubble"><div class="chat-text">Next turn</div></div>
          </div>
          <div class="chat-group-footer"><span class="chat-sender-name">You</span></div>
        </div>
        <div class="chat-group user chat-group--with-footer" data-persistent-turn>
          <div class="chat-group-messages">
            <div class="chat-bubble"><div class="chat-text">Persistent identity turn</div></div>
          </div>
          <div class="chat-group-footer chat-group-footer--persistent-identity">
            <span class="chat-sender-name">You</span>
            <div class="chat-group-footer-actions">
              <button class="chat-copy-btn" type="button" aria-label="Copy">${iconSvg()}</button>
            </div>
          </div>
        </div>
        <div class="chat-group assistant chat-group--with-footer" data-after-persistent-turn>
          <div class="chat-group-messages">
            <div class="chat-bubble"><div class="chat-text">After persistent identity</div></div>
          </div>
          <div class="chat-group-footer"><span class="chat-sender-name">Assistant</span></div>
        </div>
        <div class="chat-group user chat-group--with-footer chat-group--meta-revealed" data-revealed-persistent-turn>
          <div class="chat-group-messages">
            <div class="chat-bubble"><div class="chat-text">Revealed persistent identity</div></div>
          </div>
          <div class="chat-group-footer chat-group-footer--persistent-identity">
            <span class="chat-sender-name">You</span>
            <div class="chat-group-footer-actions">
              <button class="chat-copy-btn" type="button" aria-label="Copy">${iconSvg()}</button>
            </div>
          </div>
        </div>
        <div class="chat-group assistant chat-group--with-footer" data-after-revealed-turn>
          <div class="chat-group-messages">
            <div class="chat-bubble"><div class="chat-text">After revealed identity</div></div>
          </div>
          <div class="chat-group-footer"><span class="chat-sender-name">Assistant</span></div>
        </div>
      </div>
    </div>
  `;
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
          <div class="chat-controls__inline-select-menu chat-controls__model-menu">
            <div class="chat-controls__model-search-wrap"><input class="chat-controls__model-search" placeholder="Search models" /></div>
            <div class="chat-controls__model-options">
              <button class="chat-controls__inline-select-option chat-controls__model-option chat-controls__inline-select-option--selected">Default model</button>
              <button class="chat-controls__inline-select-option chat-controls__model-option">gpt-5.5</button>
              <button class="chat-controls__inline-select-option chat-controls__model-option">claude-sonnet-4-6</button>
              <button class="chat-controls__inline-select-option chat-controls__model-option">gpt-5.6-luna</button>
              <button class="chat-controls__inline-select-option chat-controls__model-option">gpt-5.6-sol</button>
              <button class="chat-controls__inline-select-option chat-controls__model-option">openrouter/auto</button>
            </div>
          </div>
          </details>
          <details class="chat-controls__inline-select chat-controls__permission-picker">
          <summary class="chat-controls__inline-select-trigger chat-controls__permission-trigger" aria-label="Permissions: Guarded">
            <span class="chat-controls__inline-select-label">Guarded</span>
          </summary>
          <div class="chat-controls__inline-select-menu chat-controls__permission-menu">
            <button class="chat-controls__permission-option">Guarded</button>
          </div>
          </details>
          <details class="chat-controls__inline-select chat-controls__effort-picker">
          <summary class="chat-controls__inline-select-trigger chat-controls__effort-trigger" data-chat-composer-effort="true" aria-label="Effort">
            <span class="chat-controls__inline-select-label">Medium</span>
          </summary>
          <div class="chat-controls__inline-select-menu chat-controls__effort-menu">
            <div class="chat-controls__reasoning-panel">Effort</div>
          </div>
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
              <div class="chat-thread${opts.direct ? " chat-thread--direct" : ""}" role="log">
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
                opts.sessionRailBody !== undefined
                  ? `<openclaw-chat-session-rail>
                    <section class="chat-session-rail chat-session-rail--expanded" role="region" aria-label="Side chat">
                      <header class="chat-session-rail__header">
                        <div class="chat-session-rail__header-copy">
                          <strong class="chat-session-rail__headline">Reviewing the session</strong>
                        </div>
                      </header>
                      <div class="chat-session-rail__thread">
                        <article class="chat-session-rail__exchange">
                          <div class="chat-session-rail__question">What should I check next?</div>
                          <div class="chat-session-rail__answer">${opts.sessionRailBody}</div>
                          <span class="chat-session-rail__pr-checks">2 passed</span>
                          <time class="chat-session-rail__timestamp">as of 4:12 PM</time>
                          <div class="chat-session-rail__hint">Side chat is already answering a question.</div>
                        </article>
                      </div>
                      <footer class="agent-chat__input chat-session-rail__composer" data-composer-layout="multiline">
                        <div class="agent-chat__composer-input-row">
                          <label class="agent-chat__composer-combobox chat-session-rail__prompt">
                            <textarea class="chat-session-rail__input" rows="1" placeholder="What should I know?"></textarea>
                          </label>
                        </div>
                        <div class="agent-chat__composer-footer">
                          <div class="agent-chat__composer-trail">
                            <div class="agent-chat__composer-actions">
                              <button class="chat-send-btn">${iconSvg()}</button>
                            </div>
                          </div>
                        </div>
                      </footer>
                    </section>
                  </openclaw-chat-session-rail>`
                  : ""
              }
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
                ${
                  opts.crowdedComposerFooter
                    ? `<div class="agent-chat__composer-run-status">
                    <span class="agent-chat__run-status agent-chat__run-status--interrupted">
                      ${messageCircleOffSvg()}<span class="agent-chat__run-status-label">Interrupted</span>
                    </span>
                  </div>`
                    : ""
                }
                <div class="agent-chat__input" data-composer-layout="multiline">
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
                        <span class="agent-chat__goal-mode-hint composer-context-strip__text">Enter your objective.</span>
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
                  <div class="agent-chat__composer-status-stack"> </div>
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
      `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${chatHtml(opts, width <= 1100)}</body></html>`,
    );
    await syncFixtureComposerPopoverAnchor(page);
    return page;
  } catch (error) {
    await closeBrowserPage(page);
    throw error;
  }
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
    await sharedAppPage?.close();
    sharedAppPage = null;
    sharedAppPagePromise = null;
    await realChatServer?.close();
    realChatServer = null;
    await layoutBrowser.close();
  });

  it("waits through delayed layout updates", async () => {
    await withBrowserPage(openBrowserPage(320, 568), async (page) => {
      await page.setContent(
        '<div id="delayed-layout" style="position:absolute;top:0">Layout</div>',
      );
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
  });

  it.each([
    [320, 568],
    [1366, 900],
    [1440, 1400],
  ] as const)("keeps the first message clear of the topbar at %sx%s", async (width, height) => {
    await withBrowserPage(openFixture(width, height), async (page) => {
      const spacing = await page.evaluate(() => {
        const thread = document.querySelector<HTMLElement>(".chat-thread");
        const firstMessage = document.querySelector<HTMLElement>(
          ".chat-thread-inner > .chat-group",
        );
        if (!thread || !firstMessage) {
          return null;
        }
        return {
          inset: firstMessage.getBoundingClientRect().top - thread.getBoundingClientRect().top,
          paddingTop: Number.parseFloat(getComputedStyle(thread).paddingTop),
        };
      });

      expect(spacing).not.toBeNull();
      expect(spacing?.paddingTop).toBeGreaterThanOrEqual(20);
      expect(spacing?.inset).toBeCloseTo(spacing?.paddingTop ?? 0, 0);
    });
  });

  it("insets the collapsed session rail from the pane header edge", async () => {
    await withBrowserPage(openBrowserPage(922, 282), async (page) => {
      const splitViewCss = readStyleSheet("ui/src/styles/chat/split-view.css");
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}\n${splitViewCss}</style></head><body>
          <div class="chat-split-view__cell" style="width: 922px; height: 282px;">
            <div class="chat-pane__header">Current session</div>
            <div class="chat-split-view__pane">
              <div class="chat-main" style="height: 100%;">
                <div class="chat-session-rail chat-session-rail--pill">
                  <span class="chat-session-rail__status" data-health="on-track">On track</span>
                  <span class="chat-session-rail__headline">Investigating repository guidance</span>
                </div>
              </div>
            </div>
          </div>
        </body></html>`,
      );

      const header = await getBoundingBox(page, ".chat-pane__header");
      const observer = await getBoundingBox(page, ".chat-session-rail");

      expect(observer.y).toBeCloseTo(header.y + header.height + 12, 0);
    });
  });

  it("keeps a constrained no-face header to one flex gap", async () => {
    await withBrowserPage(openBrowserPage(360, 180), async (page) => {
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

      const geometry = await page.locator(".chat-pane__header").evaluate((header) => {
        const leading = header.querySelector<HTMLElement>(".chat-pane__header-leading")!;
        const trailing = header.querySelector<HTMLElement>(".chat-pane__header-trailing")!;
        const title = header.querySelector<HTMLElement>(".chat-pane__session-title-text")!;
        const leadingRect = leading.getBoundingClientRect();
        const trailingRect = trailing.getBoundingClientRect();
        return {
          gap: trailingRect.left - leadingRect.right,
          regionClasses: [...header.children].map((child) => child.className),
          titleClientWidth: title.clientWidth,
          titleScrollWidth: title.scrollWidth,
        };
      });

      expect(geometry.regionClasses).toEqual([
        "chat-pane__header-leading",
        "chat-pane__header-trailing",
      ]);
      expect(geometry.gap).toBeCloseTo(8, 0);
      expect(geometry.titleScrollWidth).toBeGreaterThan(geometry.titleClientWidth);
    });
  });

  it("keeps the split-pane close button reachable as the pane narrows", async () => {
    await withBrowserPage(openBrowserPage(1100, 240), async (page) => {
      const splitViewCss = readStyleSheet("ui/src/styles/chat/split-view.css");
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}\n${splitViewCss}</style></head><body>
          <div class="chat-split-view__cell" style="width: 320px;">
            <div class="chat-pane__header">
              <button class="btn btn--ghost btn--icon chat-icon-btn chat-pane__nav-toggle" type="button">N</button>
              <span class="chat-pane__session-title"
                ><span class="chat-pane__session-title-text"
                  >A deliberately long split-pane session title</span
                ></span
              >
              <openclaw-session-owner-chip>
                <span class="session-owner-chip session-owner-chip--header">O</span>
              </openclaw-session-owner-chip>
              <button class="chat-pane__workspace-chip" type="button">
                ${iconSvg()}<span>openclaw-workspace</span>
              </button>
              <wa-dropdown class="chat-pane__sharing-menu">
                <button class="btn btn--ghost btn--icon chat-icon-btn chat-pane__sharing-trigger" type="button">S</button>
              </wa-dropdown>
              <wa-dropdown class="chat-pane__branches-menu">
                <button class="btn btn--ghost btn--icon chat-icon-btn chat-pane__branches-trigger" type="button">R</button>
              </wa-dropdown>
              <div class="chat-pane__actions">
                <button class="btn btn--ghost btn--icon chat-icon-btn chat-side-panel-toggle" type="button">L</button>
                <button class="btn btn--ghost btn--icon chat-icon-btn chat-pane__split-down" type="button">V</button>
                <button class="btn btn--ghost btn--icon chat-icon-btn chat-pane__split-right" type="button">H</button>
                <button class="btn btn--ghost btn--icon chat-icon-btn chat-pane__close-pane" type="button">X</button>
                <button class="btn btn--ghost btn--icon chat-icon-btn chat-pane__palette-open" type="button">P</button>
              </div>
            </div>
          </div>
        </body></html>`,
      );

      const selectors = [
        "openclaw-session-owner-chip",
        ".chat-side-panel-toggle",
        ".chat-pane__sharing-menu",
        ".chat-pane__nav-toggle",
        ".chat-pane__palette-open",
        ".chat-pane__split-down",
        ".chat-pane__split-right",
      ];
      const displayValues = async () =>
        await page
          .locator(selectors.join(","))
          .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).display));
      const setHeaderContentWidth = async (contentWidth: number) => {
        await page.locator(".chat-split-view__cell").evaluate((cell, width) => {
          const header = cell.querySelector<HTMLElement>(".chat-pane__header")!;
          const style = getComputedStyle(header);
          const horizontalInsets =
            Number.parseFloat(style.paddingLeft) +
            Number.parseFloat(style.paddingRight) +
            Number.parseFloat(style.borderLeftWidth) +
            Number.parseFloat(style.borderRightWidth);
          (cell as HTMLElement).style.width = `${width + horizontalInsets}px`;
        }, contentWidth);
      };

      const header = await getBoundingBox(page, ".chat-pane__header");
      const close = await getBoundingBox(page, ".chat-pane__close-pane");
      expect(close.x + close.width).toBeLessThanOrEqual(header.x + header.width);
      expect(await displayValues()).toEqual(selectors.map(() => "none"));

      await page.locator(".chat-split-view__cell").evaluate((cell) => {
        (cell as HTMLElement).style.width = "580px";
      });
      await waitForLayoutSettled(page, ".chat-pane__header, .chat-pane__close-pane");
      const intermediateHeader = await getBoundingBox(page, ".chat-pane__header");
      const intermediateClose = await getBoundingBox(page, ".chat-pane__close-pane");
      expect(intermediateClose.x + intermediateClose.width).toBeLessThanOrEqual(
        intermediateHeader.x + intermediateHeader.width,
      );
      expect(await displayValues()).toEqual(selectors.map(() => "none"));
      const intermediateOverflow = await page.locator(".chat-pane__header").evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      expect(intermediateOverflow.scrollWidth).toBeLessThanOrEqual(
        intermediateOverflow.clientWidth,
      );

      await page.locator(".chat-split-view__cell").evaluate((cell) => {
        (cell as HTMLElement).style.width = "1000px";
      });
      await waitForLayoutSettled(page, ".chat-pane__header, .chat-pane__close-pane");
      const fullCompositionWidth = await page.locator(".chat-pane__header").evaluate((element) => {
        const headerElement = element as HTMLElement;
        headerElement.style.containerType = "normal";
        headerElement.style.width = "0px";
        const width = headerElement.scrollWidth;
        headerElement.style.removeProperty("width");
        headerElement.style.removeProperty("container-type");
        return width;
      });
      await setHeaderContentWidth(801);
      await waitForLayoutSettled(page, ".chat-pane__header, .chat-pane__close-pane");
      const transitionOverflow = await page.locator(".chat-pane__header").evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      const transitionHeader = await getBoundingBox(page, ".chat-pane__header");
      const transitionClose = await getBoundingBox(page, ".chat-pane__close-pane");
      expect(transitionClose.x + transitionClose.width).toBeLessThanOrEqual(
        transitionHeader.x + transitionHeader.width,
      );
      expect(await displayValues()).not.toContain("none");
      expect(transitionOverflow.scrollWidth).toBeLessThanOrEqual(transitionOverflow.clientWidth);
      expect(transitionOverflow.clientWidth - fullCompositionWidth).toBeGreaterThanOrEqual(8);

      await page.locator(".chat-split-view__cell").evaluate((cell) => {
        (cell as HTMLElement).style.width = "1000px";
      });
      expect(await displayValues()).not.toContain("none");
    });
  });

  it("caps a nested session trail at half the header while ellipsizing both titles", async () => {
    await withBrowserPage(openBrowserPage(720, 180), async (page) => {
      const splitViewCss = readStyleSheet("ui/src/styles/chat/split-view.css");
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}\n${splitViewCss}</style></head><body>
          <div class="chat-split-view__cell" style="width: 640px;">
            <div class="chat-pane__header">
              <div class="chat-pane__crumbs">
                <div class="chat-pane__project-row">
                  <wa-dropdown class="chat-pane__workspace-menu">
                    <button class="chat-pane__workspace-chip" type="button">
                      ${iconSvg()}<span>openclaw</span>
                    </button>
                  </wa-dropdown>
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
                <button class="btn btn--ghost btn--icon chat-icon-btn chat-pane__close-pane" type="button">X</button>
              </div>
            </div>
          </div>
        </body></html>`,
      );

      const readState = () =>
        page.locator(".chat-pane__header").evaluate((header) => {
          const separators = [...header.querySelectorAll<HTMLElement>(".chat-pane__crumb-sep")];
          const parentText = header.querySelector<HTMLElement>(".chat-pane__parent-session-text")!;
          const childText = header.querySelector<HTMLElement>(".chat-pane__session-title-text")!;
          const parent = header.querySelector<HTMLElement>(".chat-pane__parent-session")!;
          const child = header.querySelector<HTMLElement>(".chat-pane__session-title")!;
          const headerRect = header.getBoundingClientRect();
          const parentRect = parent.getBoundingClientRect();
          const childRect = child.getBoundingClientRect();
          return {
            firstSeparator: getComputedStyle(separators[0]!).display,
            secondSeparator: getComputedStyle(separators[1]!).display,
            parentEllipses: parentText.scrollWidth > parentText.clientWidth,
            childEllipses: childText.scrollWidth > childText.clientWidth,
            headerWidth: headerRect.width,
            nestedTrailWidth: childRect.right - parentRect.left,
            overflow: (header as HTMLElement).scrollWidth - (header as HTMLElement).clientWidth,
          };
        });

      const normal = await readState();
      expect(normal).toMatchObject({
        firstSeparator: "block",
        secondSeparator: "block",
        parentEllipses: true,
        childEllipses: true,
        overflow: 0,
      });
      expect(normal.nestedTrailWidth).toBeLessThanOrEqual(normal.headerWidth / 2 + 1);

      await page.locator(".chat-split-view__cell").evaluate((cell) => {
        (cell as HTMLElement).style.width = "320px";
      });
      const narrow = await readState();
      expect(narrow).toMatchObject({
        firstSeparator: "none",
        secondSeparator: "block",
        parentEllipses: true,
        childEllipses: true,
        overflow: 0,
      });
      expect(narrow.nestedTrailWidth).toBeLessThanOrEqual(narrow.headerWidth / 2 + 1);
    });
  });

  it("keeps a Done status disjoint from a long compact session headline", async () => {
    await withBrowserPage(openBrowserPage(320, 240), async (page) => {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-session-rail chat-session-rail--pill" style="width: 190px">
            <span class="chat-session-rail__status" data-health="done">Done</span>
            <button class="chat-session-rail__expand" type="button">
              <span class="chat-session-rail__headline">A deliberately long completed-session headline</span>
            </button>
            <button class="chat-session-rail__hide" type="button">Hide</button>
          </div>
        </body></html>`,
      );

      const status = await getBoundingBox(page, ".chat-session-rail__status");
      const headline = await getBoundingBox(page, ".chat-session-rail__headline");
      const expand = await getBoundingBox(page, ".chat-session-rail__expand");

      expect(status.x + status.width).toBeLessThanOrEqual(headline.x);
      expect(headline.x + headline.width).toBeLessThanOrEqual(expand.x + expand.width);
    });
  });

  it("keeps the composer task-state panel full width when hovered", async () => {
    await withBrowserPage(openBrowserPage(1024, 480), async (page) => {
      const progressCss = [
        readStyleSheet("ui/src/styles/chat/progress-card.css"),
        readStyleSheet("ui/src/styles/chat/composer-progress.css"),
      ].join("\n");
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}\n${progressCss}</style></head><body>
          <div class="agent-chat__progress-float" style="width: 800px">
            <details class="session-progress-card session-progress-card--composer" open>
              <summary class="session-progress-card__summary">
                <span class="session-progress-card__summary-indicator"></span>
                <span class="session-progress-card__summary-expanded">Task progress</span>
                <span class="session-progress-card__summary-chevron">${iconSvg()}</span>
              </summary>
              <div class="session-progress-card__body">Current task state</div>
            </details>
          </div>
        </body></html>`,
      );

      const card = page.locator(".session-progress-card--composer");
      const resting = await getBoundingBox(page, ".session-progress-card--composer");
      await card.hover();
      const hovered = await getBoundingBox(page, ".session-progress-card--composer");

      expect(resting.width).toBeCloseTo(800, 0);
      expect(hovered.width).toBeCloseTo(resting.width, 0);
    });
  });

  it.each([
    { label: "narrow desktop", width: 430, height: 720, hasTouch: false },
    { label: "desktop", width: 1366, height: 900, hasTouch: false },
    { label: "mobile touch", width: 430, height: 720, hasTouch: true },
  ])("keeps activity disclosures compact on $label", async ({ width, height, hasTouch }) => {
    await withBrowserPage(
      openBrowserPage(width, height, { hasTouch, isolated: true }),
      async (page) => {
        await page.setContent(
          `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${activityAlignmentHtml()}</body></html>`,
        );

        await expectNoHorizontalOverflow(page);
        const activityGroup = await getRect(page, ".chat-activity-group");
        const activitySummary = await getRect(page, ".chat-activity-group__summary");
        const failedSummary = await getRect(page, "[data-failed-call-row]");
        const toolColumn = await getRect(page, "[data-tool-column-reference]");
        expect(activitySummary.width).toBeLessThan(activityGroup.width);
        expect(failedSummary.width).toBeLessThan(activityGroup.width);
        expect(activityGroup.left).toBeCloseTo(toolColumn.left, 0);
        const styles = await page.evaluate(() => {
          const activity = document.querySelector<HTMLElement>(".chat-activity-group__summary")!;
          const label = activity.querySelector<HTMLElement>(".chat-activity-group__label")!;
          const chevron = activity.querySelector<HTMLElement>(".chat-tool-row__chevron")!;
          const toolRows = [
            ...document.querySelectorAll<HTMLElement>(
              ".chat-activity-group__body .chat-tool-msg-summary",
            ),
          ];
          const firstToolStyle = getComputedStyle(toolRows[0]!);
          const firstToolRect = toolRows[0]!.getBoundingClientRect();
          const secondToolRect = toolRows[1]!.getBoundingClientRect();
          return {
            activity: getComputedStyle(activity).userSelect,
            activityBackground: getComputedStyle(activity).backgroundColor,
            activityPaddingBlock: [
              getComputedStyle(activity).paddingTop,
              getComputedStyle(activity).paddingBottom,
            ],
            chevronGap: chevron.getBoundingClientRect().left - label.getBoundingClientRect().right,
            tool: firstToolStyle.userSelect,
            toolPaddingBlock: [firstToolStyle.paddingTop, firstToolStyle.paddingBottom],
            toolRowGap: secondToolRect.top - firstToolRect.bottom,
          };
        });
        const { toolRowGap, ...disclosureStyles } = styles;
        expect(disclosureStyles).toEqual({
          activity: "text",
          activityBackground: "rgba(0, 0, 0, 0)",
          activityPaddingBlock: hasTouch ? ["8px", "8px"] : ["5px", "5px"],
          // Summary gap (8px) less the chevron's own -3px inset.
          chevronGap: 5,
          tool: "text",
          toolPaddingBlock: ["3px", "3px"],
        });
        expect(toolRowGap).toBeGreaterThanOrEqual(0);
        expect(toolRowGap).toBeLessThanOrEqual(2);
      },
    );
  });

  it.each(
    (["gutter", "footer", "none"] as const).flatMap((placement) => [
      { label: `desktop ${placement}`, placement, width: 1366, hasTouch: false, footerRow: 24 },
      { label: `narrow touch ${placement}`, placement, width: 390, hasTouch: true, footerRow: 44 },
      { label: `wide touch ${placement}`, placement, width: 1366, hasTouch: true, footerRow: 44 },
    ]),
  )(
    "separates every consecutive turn by the same space on $label",
    async ({ placement, width, hasTouch, footerRow }) => {
      await withBrowserPage(
        openBrowserPage(width, 1800, { hasTouch, isolated: true }),
        async (page) => {
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
              // Work, activity and live narration blocks belong to the answer's
              // turn: no footer row, only the inline run-frame gap to what follows.
              expect(group.footer).toBeNull();
              expect(group.gapAfter).toBe(8);
              expect(next!.contentTop - group.contentBottom).toBeCloseTo(8, 1);
              continue;
            }
            // Every turn ends in one footer row of the context's size; the turn
            // gap is the only space before whatever comes next.
            expect(group.gapAfter).toBe(16);
            expect(group.footer).toEqual({
              offset: expect.closeTo(2, 1),
              height: footerRow,
              toEdge: expect.closeTo(0, 1),
            });
            if (next) {
              expect(next.top - group.bottom).toBeCloseTo(16, 1);
              expect(next.contentTop - group.contentBottom).toBeCloseTo(2 + footerRow + 16, 1);
            }
          }
        },
      );
    },
  );

  it.each([
    { label: "desktop", width: 1366, hasTouch: false },
    { label: "mobile", width: 430, hasTouch: true },
    { label: "wide touch", width: 1366, hasTouch: true },
  ])("keeps transcript turn and run block spacing on $label", async ({ width, hasTouch }) => {
    await withBrowserPage(
      openBrowserPage(width, 900, { hasTouch, isolated: true }),
      async (page) => {
        await page.setContent(
          `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${runBlockSpacingHtml()}</body></html>`,
        );

        const gaps = await page.evaluate(() => {
          const rect = (selector: string) =>
            document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
          const gap = (before: string, after: string) => rect(after).top - rect(before).bottom;
          return {
            intraTurn: gap('[data-run-block="text"]', '[data-run-block="detail"]'),
            textToTool: gap('[data-run-block="detail"]', '[data-run-block="tool"]'),
            toolToList: gap('[data-run-block="tool"]', '[data-run-block="list"]'),
            listToReply: gap('[data-run-block="list"]', '[data-run-block="activity-reply"]'),
            replyToWork: gap('[data-run-block="activity-reply"]', '[data-run-block="work"]'),
            workToReply: gap('[data-run-block="work"]', '[data-run-block="reply"]'),
            expandedTextToTool: gap('[data-expanded-row="text"]', '[data-expanded-row="tool"]'),
            workedForSeparator: gap(
              '[data-run-block="work"] > button',
              ".chat-work-group__separator",
            ),
            turn: gap('[data-run-block="reply"]', "[data-next-turn] .chat-bubble"),
            persistentTurn: gap(
              "[data-persistent-turn] .chat-bubble",
              "[data-after-persistent-turn] .chat-bubble",
            ),
            revealedPersistentTurn: gap(
              "[data-revealed-persistent-turn] .chat-bubble",
              "[data-after-revealed-turn] .chat-bubble",
            ),
            simpleToPersistentTurn: gap(
              "[data-next-turn] .chat-bubble",
              "[data-persistent-turn] .chat-bubble",
            ),
          };
        });

        expect(gaps).toEqual({
          intraTurn: 2,
          textToTool: 8,
          toolToList: 8,
          listToReply: 8,
          replyToWork: 8,
          workToReply: 8,
          expandedTextToTool: 6,
          workedForSeparator: 0,
          // Footer offset + footer row (24px, or the 44px touch target) + turn gap.
          turn: hasTouch ? 62 : 42,
          persistentTurn: hasTouch ? 62 : 42,
          revealedPersistentTurn: hasTouch ? 62 : 42,
          simpleToPersistentTurn: hasTouch ? 62 : 42,
        });
      },
    );
  });

  it("keeps custom avatar sizing and the user edge neutral", async () => {
    await withBrowserPage(openBrowserPage(430, 720), async (page) => {
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <img class="chat-avatar assistant" src="/avatar/main" alt="Custom" />
        <img class="chat-avatar user" src="/avatar/user" alt="User" />
      </body></html>`);

      const avatars = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".chat-avatar")].map((avatar) => {
          const style = getComputedStyle(avatar);
          const bounds = avatar.getBoundingClientRect();
          return {
            width: bounds.width,
            height: bounds.height,
            boxSizing: style.boxSizing,
            objectFit: style.objectFit,
            padding: style.padding,
            borderWidth: style.borderTopWidth,
          };
        }),
      );

      expect(avatars).toEqual([
        {
          width: 36,
          height: 36,
          boxSizing: "border-box",
          objectFit: "cover",
          padding: "0px",
          borderWidth: "1px",
        },
        {
          width: 36,
          height: 36,
          boxSizing: "border-box",
          objectFit: "cover",
          padding: "0px",
          borderWidth: "1px",
        },
      ]);

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
        expect(edge.borderStyle).toBe("solid");
        expect(edge.borderWidth).toBe("1px");
        expect(edge.outlineStyle).toBe("none");
      }
    });
  });

  it("hides image avatars when the mobile transcript drops their grid column", async () => {
    await withBrowserPage(openBrowserPage(430, 720), async (page) => {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-thread">
            <div class="chat-group assistant chat-group--with-footer">
              <img class="chat-avatar assistant" alt="Assistant" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36'/%3E" />
              <div class="chat-group-messages">
                <div class="chat-bubble"><div class="chat-text">Completed work remains readable.</div></div>
              </div>
              <div class="chat-group-footer"><span class="chat-sender-name">Assistant</span></div>
            </div>
          </div>
        </body></html>`,
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

  it("applies configured chat width to tool rows and composer without changing defaults", async () => {
    const page = await openBrowserPage(1600, 900);
    const renderFixture = async (configured: boolean) => {
      const style = configured
        ? 'style="--chat-thread-max-width: 82%; --chat-message-max-width: 100%"'
        : "";
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <section class="chat" ${style}>
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
        </section>
      </body></html>`);
      return await page.evaluate(() => {
        const rect = (selector: string) => {
          const bounds = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
          return { center: bounds.x + bounds.width / 2, width: bounds.width };
        };
        return {
          activity: rect("[data-activity-lane] .chat-activity-group"),
          composer: rect("[data-composer]"),
          prs: rect("[data-chat-prs]"),
          shell: rect("[data-tool-shell]"),
          framedActivity: rect("[data-frame-lane] .chat-activity-group"),
          thread: rect(".chat-thread-inner"),
          tool: rect("[data-tool-lane]"),
        };
      });
    };

    try {
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
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("optically matches the effort lightning to the microphone without shrinking fast mode", async () => {
    await withBrowserPage(openBrowserPage(800, 300), async (page) => {
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <div class="agent-chat__input">
          <span class="chat-controls__effort-zap">${iconSvg()}</span>
          <button class="chat-send-btn chat-send-btn--voice">${iconSvg()}</button>
          <span class="chat-controls__fast-mode-icon">${iconSvg()}</span>
        </div>
      </body></html>`);
      const sizes = await page.evaluate(() => {
        const size = (selector: string) => {
          const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
          return { height: rect.height, width: rect.width };
        };
        return {
          effort: size(".chat-controls__effort-zap"),
          fast: size(".chat-controls__fast-mode-icon"),
          microphone: size(".chat-send-btn--voice svg"),
        };
      });
      expect(sizes.effort).toEqual({ height: 14, width: 14 });
      expect(sizes.microphone).toEqual({ height: 16, width: 16 });
      expect(sizes.fast).toEqual({ height: 16, width: 16 });
    });
  });

  it("keeps the desktop model picker label-to-chevron gap at 4px", async () => {
    await withBrowserPage(openBrowserPage(800, 800), async (page) => {
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <div class="agent-chat__composer-shell">
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
        </div>
      </body></html>`);
      const measuredGap = await page.evaluate(() => {
        const label = document
          .querySelector<HTMLElement>(".chat-controls__inline-select-label")!
          .getBoundingClientRect();
        const chevron = document
          .querySelector<HTMLElement>(".chat-controls__inline-select-chevron")!
          .getBoundingClientRect();
        return chevron.left - label.right;
      });
      expect(measuredGap).toBeCloseTo(4, 0);
    });
  });

  it("gives inline MCP Apps the full assistant message column", async () => {
    await withBrowserPage(openBrowserPage(1366, 900), async (page) => {
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <div class="chat-thread chat-thread--direct" role="log">
          <div class="chat-thread-inner">
            <div class="chat-group assistant chat-group--with-footer">
              <div class="chat-group-messages">
                <div class="chat-bubble">
                  <div class="chat-tool-card__widget-host">
                    <div class="chat-tool-card__preview" data-content-kind="mcp-app">
                      <div class="chat-tool-card__preview-panel">
                        <mcp-app-view style="display:block;width:100%;height:320px"></mcp-app-view>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </body></html>`);

      await expectNoHorizontalOverflow(page);
      const widths = await page.evaluate(() => ({
        app: document.querySelector("mcp-app-view")!.getBoundingClientRect().width,
        bubble: document.querySelector<HTMLElement>(".chat-bubble")!.getBoundingClientRect().width,
        messages: document
          .querySelector<HTMLElement>(".chat-group-messages")!
          .getBoundingClientRect().width,
      }));
      expect(widths.bubble).toBeCloseTo(widths.messages, 0);
      expect(widths.app).toBeGreaterThan(600);
    });
  });

  it("keeps inline MCP App reloads transparent without changing dashboard surfaces", async () => {
    await withBrowserPage(openBrowserPage(1366, 900), async (page) => {
      if (!realChatServer) {
        throw new Error("Expected the Control UI server to be ready");
      }
      await page.goto(realChatServer.baseUrl, { waitUntil: "domcontentloaded" });
      await page.addScriptTag({
        type: "module",
        url: new URL("src/components/mcp-app-view-registration.ts", realChatServer.baseUrl).href,
      });
      const backgrounds = await page.evaluate(async () => {
        await customElements.whenDefined("mcp-app-view");
        const readFrameBackground = async (boardSurface?: string) => {
          const owner = document.createElement("div");
          if (boardSurface) {
            owner.style.setProperty("--board-surface", boardSurface);
          }
          const view = document.createElement("mcp-app-view") as HTMLElement & {
            updateComplete: Promise<boolean>;
          };
          owner.append(view);
          document.body.replaceChildren(owner);
          await view.updateComplete;
          const mount = view.shadowRoot?.querySelector(".mount");
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

  it("keeps attributed user avatar fallbacks beside the message after identity resolution", async () => {
    await withBrowserPage(openBrowserPage(860, 900), async (page) => {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-thread" style="width: 768px;">
            <div class="chat-thread-inner" style="width: 768px;">
              <div class="chat-group user chat-group--with-footer">
                <span class="chat-avatar-slot">
                  <img
                    class="chat-avatar user"
                    alt="Collin Johnson"
                    src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36'%3E%3Crect width='36' height='36' fill='purple'/%3E%3C/svg%3E"
                  />
                  <div class="chat-avatar user chat-avatar--sender-initials">C</div>
                </span>
                <div class="chat-group-messages">
                  <div class="chat-bubble"><div class="chat-text">A newly sent message.</div></div>
                </div>
                <div class="chat-group-footer">
                  <div class="chat-group-footer__meta">
                    <span class="chat-sender-name">collinjohnsonw</span>
                    <span class="chat-group-timestamp">now</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </body></html>`,
      );
      const messageAvatarSlot = page.locator(".chat-group .chat-avatar-slot");
      await messageAvatarSlot.locator("img").waitFor();

      const readLayout = async () =>
        await page.evaluate(() => {
          const group = document.querySelector<HTMLElement>(".chat-group.user")!;
          const bubble = group.querySelector<HTMLElement>(".chat-bubble")!;
          const visibleAvatar = [...group.querySelectorAll<HTMLElement>(".chat-avatar")].find(
            (avatar) => getComputedStyle(avatar).display !== "none",
          )!;
          const groupRect = group.getBoundingClientRect();
          const bubbleRect = bubble.getBoundingClientRect();
          const avatarRect = visibleAvatar.getBoundingClientRect();
          return {
            avatarLeft: avatarRect.left,
            avatarRight: avatarRect.right,
            bubbleRight: bubbleRect.right,
            groupRight: groupRect.right,
          };
        });

      const imageLayout = await readLayout();
      expect(await messageAvatarSlot.evaluate((slot) => getComputedStyle(slot).display)).toBe(
        "grid",
      );
      await messageAvatarSlot.evaluate((slot) => slot.classList.add("is-fallback"));
      const fallbackLayout = await readLayout();

      for (const layout of [imageLayout, fallbackLayout]) {
        expect(layout.avatarLeft).toBeGreaterThanOrEqual(layout.bubbleRight + 9);
        expect(layout.avatarRight).toBeLessThanOrEqual(layout.groupRight + 1);
      }

      await page
        .locator(".chat-thread")
        .evaluate((thread) => thread.classList.add("chat-thread--direct"));
      expect(await messageAvatarSlot.evaluate((slot) => getComputedStyle(slot).display)).toBe(
        "none",
      );
      await page
        .locator(".chat-thread")
        .evaluate((thread) => thread.classList.remove("chat-thread--direct"));
      await page.setViewportSize({ width: 390, height: 900 });
      expect(await messageAvatarSlot.evaluate((slot) => getComputedStyle(slot).display)).toBe(
        "none",
      );
    });
  });

  it("keeps attached images within narrow message lanes", async () => {
    await withBrowserPage(openBrowserPage(320, 568), async (page) => {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div data-image-lane style="width: 180px;">
            <div class="chat-message-images">
              <img
                class="chat-message-image"
                width="600"
                height="100"
                alt="Wide attachment"
                src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='100'%3E%3C/svg%3E"
              />
            </div>
          </div>
        </body></html>`,
      );
      await page.locator(".chat-message-image").waitFor();

      const lane = await getRect(page, "[data-image-lane]");
      const image = await getRect(page, ".chat-message-image");
      expect(image.width).toBeLessThanOrEqual(lane.width + 1);
      expect(image.width / image.height).toBeCloseTo(6, 1);
    });
  });

  it.each([
    ["dark", false],
    ["light", false],
    ["dark", true],
    ["light", true],
  ])(
    "keeps a sent gallery above its text bubble without hover changes in %s mode (sender tint: %s)",
    async (theme, tinted) => {
      await withBrowserPage(openBrowserPage(1280, 900), async (page) => {
        const tile = (index: number) => `
        <span class="chat-image-frame" data-tile="${index}">
          <button class="chat-message-image-button" type="button">
            <img class="chat-message-image" width="640" height="640" alt="Image ${index}"
              src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='640'%3E%3Crect width='640' height='640' fill='%23865cff'/%3E%3C/svg%3E" />
          </button>
        </span>`;
        await page.setContent(
          `<!doctype html><html data-theme-mode="${theme}"><head><style>${readUiCss()}</style></head><body>
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
        </body></html>`,
        );
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
            firstRow: boxes.filter((box) => Math.round(box.top) === Math.round(boxes[0]!.top))
              .length,
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
      });
    },
  );

  it.each([false, true])(
    "keeps every sent-image text shape on the user bubble surface (sender tint: %s)",
    async (tinted) => {
      await withBrowserPage(openBrowserPage(1280, 900), async (page) => {
        await page.setContent(
          `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-group user ${tinted ? "chat-group--sender-tint" : ""}"
            style="--chat-sender-hue: 208">
            <div class="chat-bubble" data-reference>Text-only message</div>
            <div class="chat-bubble chat-bubble--with-images">
              <div class="chat-text" data-shape="text">Short text</div>
            </div>
            <div class="chat-bubble chat-bubble--with-images">
              <div class="chat-message-disclosure" data-shape="disclosure">
                <div class="chat-message-disclosure__content">
                  <div class="chat-text">Collapsed text</div>
                </div>
              </div>
            </div>
            <div class="chat-bubble chat-bubble--with-images">
              <div class="chat-text" data-shape="json">
                <pre><code class="language-json">{"ready":true}</code></pre>
              </div>
            </div>
          </div>
        </body></html>`,
        );
        for (const theme of ["dark", "light"] as const) {
          await page.evaluate(
            (mode) => document.documentElement.setAttribute("data-theme-mode", mode),
            theme,
          );
          const surfaces = await page.locator("[data-shape]").evaluateAll((elements) =>
            elements.map((element) => {
              const style = getComputedStyle(element);
              return {
                backgroundColor: style.backgroundColor,
                color: style.color,
                padding: style.padding,
              };
            }),
          );
          const reference = await page.locator("[data-reference]").evaluate((bubble) => ({
            backgroundColor: getComputedStyle(bubble).backgroundColor,
            color: getComputedStyle(bubble).color,
          }));
          expect(surfaces[0]).toEqual({ ...reference, padding: "10px 14px" });
          expect(surfaces[1]).toEqual(surfaces[0]);
          expect(surfaces[2]).toEqual(surfaces[0]);
          expect(
            await page
              .locator(".chat-bubble--with-images")
              .evaluateAll((bubbles) =>
                bubbles.every(
                  (bubble) => getComputedStyle(bubble).backgroundColor === "rgba(0, 0, 0, 0)",
                ),
              ),
          ).toBe(true);
        }
      });
    },
  );

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

  it(
    "remeasures a populated composer when the viewport width changes",
    FULL_APP_TEST_OPTIONS,
    async () => {
      const page = await getSharedAppPage();
      const errorStart = sharedAppPageErrors.length;
      try {
        await page.setViewportSize({ width: 900, height: 800 });
        const textarea = page.locator(".agent-chat__composer-combobox > textarea");
        await textarea.waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
        await textarea.fill(
          "Resize this populated draft across a narrow pane so its wrapped lines change height without waiting for another input event. ".repeat(
            2,
          ),
        );
        await waitForLayoutSettled(page, ".agent-chat__composer-combobox > textarea");
        const wideHeight = (await textarea.boundingBox())?.height ?? 0;

        await page.setViewportSize({ width: 430, height: 800 });
        await page.waitForFunction((previousHeight) => {
          const element = document.querySelector<HTMLTextAreaElement>(
            ".agent-chat__composer-combobox > textarea",
          );
          return element !== null && element.getBoundingClientRect().height > previousHeight + 1;
        }, wideHeight);
        const narrowHeight = (await textarea.boundingBox())?.height ?? 0;
        expect(narrowHeight).toBeGreaterThan(wideHeight + 1);

        await page.setViewportSize({ width: 900, height: 800 });
        await page.waitForFunction((previousHeight) => {
          const element = document.querySelector<HTMLTextAreaElement>(
            ".agent-chat__composer-combobox > textarea",
          );
          return element !== null && element.getBoundingClientRect().height < previousHeight - 1;
        }, narrowHeight);
        expect(
          sharedAppPageErrors
            .slice(errorStart)
            .filter((message) => message.includes("ResizeObserver loop")),
        ).toEqual([]);
      } finally {
        await page.locator(".agent-chat__composer-combobox > textarea").fill("");
        await page.setViewportSize({ width: 1366, height: 900 });
      }
    },
  );

  it(
    "reveals, pins, and dismisses shared message context above virtual-row containment",
    FULL_APP_TEST_OPTIONS,
    async () => {
      const page = await getSharedAppPage();
      try {
        await page.setViewportSize({ width: 1366, height: 900 });
        const group = page.locator(".chat-group").filter({ hasText: SHARED_APP_CONTEXT_TEXT });
        const tooltip = group.locator("openclaw-tooltip.msg-meta");
        const context = tooltip.locator(".msg-meta__details");
        const summary = tooltip.locator(".msg-meta__summary");
        const messageText = group.locator(".chat-text").first();
        await messageText.waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
        expect(await context.isVisible()).toBe(false);

        await messageText.hover();
        await waitForLayoutSettled(page, ".chat-group");
        const initialLayout = await group.evaluate((node) => {
          const footer = node.querySelector<HTMLElement>(".chat-group-footer")!;
          return {
            footerHeight: footer.getBoundingClientRect().height,
            groupHeight: (node as HTMLElement).getBoundingClientRect().height,
          };
        });
        await summary.hover();
        await context.waitFor({ state: "visible", timeout: 10_000 });
        const hoverLayout = await group.evaluate((node) => {
          const footer = node.querySelector<HTMLElement>(".chat-group-footer")!;
          const summaryNode = node.querySelector<HTMLElement>(".msg-meta__summary")!;
          const detailsOverlay = node.querySelector<HTMLElement>(".msg-meta__details")!;
          return {
            contextBottom: detailsOverlay.getBoundingClientRect().bottom,
            footerHeight: footer.getBoundingClientRect().height,
            groupHeight: (node as HTMLElement).getBoundingClientRect().height,
            summaryTop: summaryNode.getBoundingClientRect().top,
          };
        });
        expect(hoverLayout.footerHeight).toBeCloseTo(initialLayout.footerHeight, 2);
        expect(hoverLayout.groupHeight).toBeCloseTo(initialLayout.groupHeight, 2);
        expect(hoverLayout.contextBottom).toBeLessThanOrEqual(hoverLayout.summaryTop + 4);

        // Real top-layer placement replaces the old per-row containment escape.
        // Hit-test rendered content, not just the popup's open flag.
        await expect
          .poll(() =>
            context.evaluate((node) => {
              const row = node.closest<HTMLElement>(".chat-virtual-row")!;
              const tooltipNode = node.closest("openclaw-tooltip")!;
              const popup = tooltipNode.shadowRoot
                ?.querySelector("wa-tooltip")
                ?.shadowRoot?.querySelector("wa-popup")
                ?.shadowRoot?.querySelector<HTMLElement>('[part="popup"]');
              const rect = node.getBoundingClientRect();
              const target = document.elementFromPoint(rect.left + 8, rect.top + rect.height / 2);
              return {
                rowContainment: getComputedStyle(row).contentVisibility,
                topLayer: popup?.matches(":popover-open") ?? false,
                painted: target !== null && node.contains(target),
              };
            }),
          )
          .toEqual({ rowContainment: "auto", topLayer: true, painted: true });

        await page.mouse.move(0, 0);
        await context.waitFor({ state: "hidden", timeout: 10_000 });

        // Keyboard discovery must reveal the timestamp itself, not just its tip.
        await page.keyboard.press("Tab");
        await summary.focus();
        await context.waitFor({ state: "visible", timeout: 10_000 });
        // Settle the footer reveal independently of the headless compositor clock.
        await group.locator(".chat-group-footer").evaluate(finishElementAnimations);
        await expect
          .poll(() =>
            summary.evaluate((node) => {
              const footer = node.closest<HTMLElement>(".chat-group-footer")!;
              return {
                footerOpacity: getComputedStyle(footer).opacity,
                summaryOpacity: getComputedStyle(node).opacity,
                pointerEvents: getComputedStyle(node).pointerEvents,
                focused: document.activeElement === node,
              };
            }),
          )
          .toEqual({
            footerOpacity: "1",
            summaryOpacity: "1",
            pointerEvents: "auto",
            focused: true,
          });
        await page.keyboard.press("Escape");
        await context.waitFor({ state: "hidden", timeout: 10_000 });
        expect(await tooltip.getAttribute("open")).toBeNull();

        await summary.press("Enter");
        await context.waitFor({ state: "visible", timeout: 10_000 });
        // Remove focus without focusing an outside control: only the pin should
        // retain this disclosure, even in browsers that do not focus on click.
        await summary.evaluate((node) => (node as HTMLElement).blur());
        await expect
          .poll(() =>
            group.evaluate((node) => ({
              hovered: node.matches(":hover"),
              focused: node.matches(":focus-within"),
              footerOpacity: getComputedStyle(
                node.querySelector<HTMLElement>(".chat-group-footer")!,
              ).opacity,
            })),
          )
          .toEqual({ hovered: false, focused: false, footerOpacity: "1" });
        expect(await tooltip.getAttribute("open")).toBe("");
        expect(await context.isVisible()).toBe(true);

        await page.mouse.click(0, 0);
        await context.waitFor({ state: "hidden", timeout: 10_000 });
        expect(await tooltip.getAttribute("open")).toBeNull();

        await messageText.hover();
        await summary.click();
        await context.waitFor({ state: "visible", timeout: 10_000 });
        await page.keyboard.press("Escape");
        await context.waitFor({ state: "hidden", timeout: 10_000 });
        expect(await tooltip.getAttribute("open")).toBeNull();
      } finally {
        await page.keyboard.press("Escape");
        await page.mouse.move(0, 0);
      }
    },
  );

  it("renders delivered playback media inline", FULL_APP_TEST_OPTIONS, async () => {
    const page = await getSharedAppPage();
    const image = page.locator(`img.chat-message-image[src="${SHARED_APP_IMAGE_URL}"]`);
    await image.waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
    expect(await image.getAttribute("src")).toBe(SHARED_APP_IMAGE_URL);
    expect(await page.getByText(SHARED_APP_TTS_TEXT, { exact: true }).count()).toBe(1);
    expect(await page.getByText(/MEDIA:/u).count()).toBe(0);
    for (const [fileName, type, , playback] of SHARED_APP_PLAYBACK_MEDIA) {
      const player = page
        .locator(type === "audio" ? "openclaw-chat-audio-player" : "openclaw-chat-video-player")
        .filter({ hasText: fileName });
      await player.waitFor({ state: "attached", timeout: 10_000 });
      expect(await player.evaluate((element) => (element as { playback?: unknown }).playback)).toBe(
        playback,
      );
      const card = player.locator(".chat-assistant-attachment-card");
      await card.waitFor({ state: "visible", timeout: 10_000 });
      await player.evaluate((element) => {
        element
          .querySelector(".chat-assistant-attachment-card")!
          .scrollIntoView({ block: "center" });
      });
      const requireMetadata = fileName !== "reply.m4a" && fileName !== "reply.mp4";
      // Read the stable player: an error replaces its media child and card.
      // Only AAC/H.264 fixtures may fall back; other codecs must actually load.
      await expect
        .poll(
          () =>
            player.evaluate(
              (element, { type: mediaType, requireMetadata: needsMetadata }) => {
                const media = element.querySelector<HTMLMediaElement>(mediaType);
                return (
                  (!needsMetadata &&
                    element.querySelector(".chat-assistant-attachment-card--compact") !== null) ||
                  (media !== null && media.readyState >= 1)
                );
              },
              { type, requireMetadata },
            ),
          { timeout: 10_000 },
        )
        .toBe(true);
      const compactFallback =
        (await player.locator(".chat-assistant-attachment-card--compact").count()) > 0;
      if (!compactFallback) {
        expect(
          sharedAppPlaybackRequests.some((url) => {
            if (!url.includes(fileName)) {
              return false;
            }
            return playback === "native" || new URL(url).searchParams.get("playback") === "1";
          }),
        ).toBe(true);
      }
    }
    expect(await page.getByText(/can't play this format/iu).count()).toBe(0);
  });

  it(
    "renders one named card for every success and failure in a mixed attachment batch",
    FULL_APP_TEST_OPTIONS,
    async () => {
      const page = await getSharedAppPage();
      const bubble = page
        .locator(".chat-bubble")
        .filter({ hasText: SHARED_APP_ATTACHMENT_OUTCOME_TEXT });
      const cards = bubble.locator(".chat-assistant-attachment-card");
      await expect.poll(() => cards.count()).toBe(7);
      expect(
        await cards.locator(".chat-assistant-attachment-card__title").allTextContents(),
      ).toEqual([
        "deploy.yaml",
        "settings.toml",
        "schema.sql",
        "events.ndjson",
        "font.ttf",
        "font.woff2",
        "bundle.7z",
      ]);
      expect(await bubble.locator(".chat-assistant-attachment-card--compact").count()).toBe(1);
      expect(await bubble.locator(".chat-assistant-attachment-card--definitive").count()).toBe(6);
      expect(
        await bubble
          .getByText(
            "Not sent · Rejected by the local attachment allowlist. Send a supported file type.",
          )
          .count(),
      ).toBe(5);
      expect(
        await bubble.getByText("Not sent · Delivery failed. Try sending this file again.").count(),
      ).toBe(1);
      expect(await bubble.getByText("Media failed").count()).toBe(0);

      try {
        await cards.filter({ hasText: "settings.toml" }).scrollIntoViewIfNeeded();
        const desktopStatusSpacing = await cards
          .filter({ hasText: "settings.toml" })
          .evaluate((card) => {
            const badge = card.querySelector<HTMLElement>(
              ".chat-assistant-attachment-card__status-badge",
            )!;
            const reason = card.querySelector<HTMLElement>(
              ".chat-assistant-attachment-card__status-reason",
            )!;
            const separator = card.querySelector<HTMLElement>(
              ".chat-assistant-attachment-card__status-separator",
            )!;
            const badgeRect = badge.getBoundingClientRect();
            const reasonRect = reason.getBoundingClientRect();
            const separatorRect = separator.getBoundingClientRect();
            return {
              leftGap: separatorRect.left - badgeRect.right,
              rightGap: reasonRect.left - separatorRect.right,
            };
          });
        expect(desktopStatusSpacing.leftGap).toBeGreaterThan(4);
        expect(desktopStatusSpacing.rightGap).toBeGreaterThan(4);
        expect(Math.abs(desktopStatusSpacing.leftGap - desktopStatusSpacing.rightGap)).toBeLessThan(
          0.25,
        );

        for (const width of [320, 560]) {
          await page.setViewportSize({ width, height: 852 });
          const failedCard = cards.filter({ hasText: "settings.toml" });
          // The viewport ACK does not settle the retained pane's responsive geometry.
          await failedCard.scrollIntoViewIfNeeded();
          await waitForLayoutSettled(
            page,
            ".chat-main__conversation, .chat-assistant-attachment-card, .chat-assistant-attachment-card__status-reason",
          );
          const mobileStatusLayout = await failedCard.evaluate((card) => {
            const badge = card.querySelector<HTMLElement>(
              ".chat-assistant-attachment-card__status-badge",
            )!;
            const reason = card.querySelector<HTMLElement>(
              ".chat-assistant-attachment-card__status-reason",
            )!;
            const separator = card.querySelector<HTMLElement>(
              ".chat-assistant-attachment-card__status-separator",
            )!;
            const cardRect = card.getBoundingClientRect();
            const reasonRect = reason.getBoundingClientRect();
            return {
              badgeBottom: badge.getBoundingClientRect().bottom,
              cardBottom: cardRect.bottom,
              cardClientWidth: card.clientWidth,
              cardScrollWidth: card.scrollWidth,
              reasonBottom: reasonRect.bottom,
              reasonRight: reasonRect.right,
              reasonTop: reasonRect.top,
              separatorDisplay: getComputedStyle(separator).display,
              reasonWhiteSpace: getComputedStyle(reason).whiteSpace,
            };
          });
          expect(mobileStatusLayout.separatorDisplay).toBe("none");
          expect(mobileStatusLayout.reasonWhiteSpace).toBe("normal");
          expect(mobileStatusLayout.reasonTop).toBeGreaterThanOrEqual(
            mobileStatusLayout.badgeBottom,
          );
          expect(mobileStatusLayout.reasonBottom).toBeLessThanOrEqual(
            mobileStatusLayout.cardBottom,
          );
          expect(mobileStatusLayout.reasonRight).toBeLessThanOrEqual(width);
          expect(mobileStatusLayout.cardScrollWidth).toBeLessThanOrEqual(
            mobileStatusLayout.cardClientWidth,
          );
          await expectNoHorizontalOverflow(page);
        }
      } finally {
        await page.setViewportSize({ width: 1366, height: 900 });
      }
    },
  );

  it.each([
    [393, 852],
    [1366, 900],
  ] as const)(
    "anchors message roles and balances transcript width at %sx%s",
    async (width, height) => {
      await withBrowserPage(openFixture(width, height), async (page) => {
        const roles = await page.evaluate(() => {
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
          return {
            assistantLane: rectFor(".chat-group.assistant .chat-group-messages"),
            assistantBubble: rectFor(".chat-group.assistant .chat-bubble:first-child"),
            transcript: rectFor(".chat-thread-inner"),
            transcriptViewport: rectFor(".chat-thread"),
            composer: rectFor(".agent-chat__composer-shell"),
            userLane: rectFor(".chat-group.user .chat-group-messages"),
            userBubble: rectFor(".chat-group.user .chat-bubble:first-child"),
          };
        });

        const assistantLane = expectControlRect(roles.assistantLane, "assistant message lane");
        const assistantBubble = expectControlRect(roles.assistantBubble, "assistant bubble");
        const transcript = expectControlRect(roles.transcript, "transcript");
        const transcriptViewport = expectControlRect(
          roles.transcriptViewport,
          "transcript viewport",
        );
        const userLane = expectControlRect(roles.userLane, "user message lane");
        const userBubble = expectControlRect(roles.userBubble, "user bubble");

        expect(
          Math.abs(
            transcript.x +
              transcript.width / 2 -
              (transcriptViewport.x + transcriptViewport.width / 2),
          ),
        ).toBeLessThanOrEqual(1);
        if (width <= 768) {
          const composer = expectControlRect(roles.composer, "composer");
          expect(transcript.x).toBeCloseTo(composer.x, 0);
          expect(transcript.width).toBeCloseTo(composer.width, 0);
        } else {
          expect(transcript.width).toBeCloseTo(768, 0);
        }
        expect(Math.abs(assistantBubble.x - assistantLane.x)).toBeLessThanOrEqual(1);
        expect(
          Math.abs(userBubble.x + userBubble.width - (userLane.x + userLane.width)),
        ).toBeLessThanOrEqual(1);
        expect(userLane.x).toBeGreaterThan(assistantLane.x);
        expect(userBubble.width).toBeLessThan(userLane.width);
        expect(assistantBubble.width).toBeLessThan(assistantLane.width);
      });
    },
  );

  it.each([
    [1366, 900],
    [1920, 1080],
  ] as const)(
    "centers overflowing direct messages on the composer axis at %sx%s",
    async (width, height) => {
      await withBrowserPage(openFixture(width, height, { direct: true }), async (page) => {
        await page.evaluate(() => {
          const thread = document.querySelector<HTMLElement>(".chat-thread");
          const inner = document.querySelector<HTMLElement>(".chat-thread-inner");
          if (!thread || !inner) {
            throw new Error("Missing chat overflow fixture");
          }
          inner.style.minHeight = `${thread.clientHeight + 1}px`;
        });
        await expectNoHorizontalOverflow(page);
        const [assistantLane, composer, thread, userLane, overflow] = await Promise.all([
          getRect(page, ".chat-group.assistant .chat-group-messages"),
          getRect(page, ".agent-chat__composer-shell"),
          getRect(page, ".chat-thread-inner"),
          getRect(page, ".chat-group.user .chat-group-messages"),
          page.evaluate(() => {
            const node = document.querySelector<HTMLElement>(".chat-thread");
            if (!node) {
              return null;
            }
            return {
              clientHeight: node.clientHeight,
              gutter: getComputedStyle(node).scrollbarGutter,
              scrollHeight: node.scrollHeight,
            };
          }),
        ]);

        expect(overflow).not.toBeNull();
        expect(overflow?.scrollHeight).toBeGreaterThan(overflow?.clientHeight ?? 0);
        expect(overflow?.gutter).toBe("stable both-edges");
        const threadCenter = thread.left + thread.width / 2;
        const composerCenter = composer.left + composer.width / 2;
        expect(Math.abs(threadCenter - composerCenter)).toBeLessThanOrEqual(1);
        expect(Math.abs(thread.width - composer.width)).toBeLessThanOrEqual(1);
        expect(thread.width).toBeCloseTo(768, 0);
        expect(Math.abs(assistantLane.left - thread.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(userLane.right - thread.right)).toBeLessThanOrEqual(1);
      });
    },
  );

  it.each([
    [393, 852],
    [900, 500],
    [1366, 900],
    [1920, 1080],
  ] as const)("matches corners and optical chat-box insets at %sx%s", async (width, height) => {
    await withBrowserPage(openFixture(width, height), async (page) => {
      const geometry = await page.evaluate(() => {
        const styleFor = (selector: string) => {
          const node = document.querySelector<HTMLElement>(selector);
          if (!node) {
            return null;
          }
          const style = getComputedStyle(node);
          return {
            borderRadius: Number.parseFloat(style.borderTopLeftRadius),
            cornerShape: style.getPropertyValue("corner-shape"),
            paddingBottom: Number.parseFloat(style.paddingBottom),
            paddingLeft: Number.parseFloat(style.paddingLeft),
            paddingRight: Number.parseFloat(style.paddingRight),
            paddingTop: Number.parseFloat(style.paddingTop),
          };
        };
        return {
          assistantBubble: styleFor(".chat-group.assistant .chat-bubble:first-child"),
          bubble: styleFor(".chat-group.user .chat-bubble:first-child"),
          codeBlock: styleFor(".code-block-wrapper"),
          composer: styleFor(".agent-chat__composer-shell > .agent-chat__input"),
          footer: styleFor(".agent-chat__composer-footer"),
          textarea: styleFor(".agent-chat__composer-combobox > textarea"),
        };
      });

      for (const style of Object.values(geometry)) {
        expect(style).not.toBeNull();
      }

      expect(geometry.codeBlock?.borderRadius).toBeGreaterThan(0);
      expect(geometry.bubble).toMatchObject({
        borderRadius: geometry.codeBlock?.borderRadius,
        cornerShape: geometry.codeBlock?.cornerShape,
        paddingTop: 16,
        paddingRight: 16,
        paddingBottom: 16,
        paddingLeft: 16,
      });
      // Assistant replies render flat (no bubble card): zero horizontal inset
      // keeps the text on the tool-row left edge.
      expect(geometry.assistantBubble?.paddingLeft).toBe(0);
      expect(geometry.assistantBubble?.paddingRight).toBe(0);
      // The composer rests one radius step above the bubble: it is the surface
      // the thread sits on, not another card in the same stack.
      expect(geometry.composer?.borderRadius).toBe(20 * (await readCornerScale(page)));

      // The editor's horizontal inset belongs to its row, not to the control,
      // so the text keeps one origin while the surface changes shape.
      const textareaBlockInset = width <= 768 || (width <= 932 && height <= 500) ? 10 : 6;
      expect(geometry.textarea?.paddingTop).toBe(textareaBlockInset);
      expect(geometry.textarea?.paddingRight).toBe(0);
      expect(geometry.textarea?.paddingBottom).toBe(textareaBlockInset);
      expect(geometry.textarea?.paddingLeft).toBe(0);
      const shortLandscape = width <= 932 && height <= 500;
      const footerInset = width <= 768 || shortLandscape ? 4 : 8;
      expect(geometry.footer?.paddingLeft).toBe(footerInset);
      expect(geometry.footer?.paddingRight).toBe(footerInset);
      // Multiline keeps optical breathing room inside the footer on both edges;
      // the outer margin only docks the complete row above the surface edge.
      expect(geometry.footer?.paddingTop).toBe(width <= 768 ? 4 : shortLandscape ? 2 : 6);
      expect(geometry.footer?.paddingBottom).toBe(width <= 768 ? 4 : shortLandscape ? 0 : 6);

      // The resting shape is two stacked regions, not one line that may grow
      // into two: a draft that fits on a single line still leaves the surface at
      // its multiline floor, with the whole action row below the editor.
      const { surface, editor, actionRow } = await page.evaluate(() => {
        const rectFor = (selector: string) => {
          const [element, ...others] = document.querySelectorAll<HTMLElement>(selector);
          if (!element || others.length > 0) {
            throw new Error(`Expected one layout element: ${selector}`);
          }
          const {
            x,
            y,
            width: rectWidth,
            height: rectHeight,
            top,
            bottom,
          } = element.getBoundingClientRect();
          return { x, y, width: rectWidth, height: rectHeight, top, bottom };
        };
        return {
          surface: rectFor(".agent-chat__composer-shell > .agent-chat__input"),
          editor: rectFor(".agent-chat__composer-combobox > textarea"),
          actionRow: rectFor(".agent-chat__composer-footer"),
        };
      });
      for (const rect of [surface, editor, actionRow]) {
        expectFiniteRect(rect);
      }
      expect(surface.height).toBeGreaterThanOrEqual(98);
      expect(actionRow.top).toBeGreaterThanOrEqual(editor.bottom - 1);
      expect(surface.bottom - actionRow.bottom).toBeGreaterThanOrEqual(0);
    });
  });

  it.each(VIEWPORTS)("keeps the chat shell inside the viewport at %sx%s", async (width, height) => {
    await withBrowserPage(openFixture(width, height), async (page) => {
      await expectNoHorizontalOverflow(page);
      const code = await getBoundingBox(page, ".chat-text pre");
      expect(code.x + code.width).toBeLessThanOrEqual(width + 1);
    });
  });

  it.each([
    [320, 568],
    [1366, 900],
  ] as const)(
    "keeps short assistant names and actions compact below the bubble at %sx%s",
    async (width, height) => {
      await withBrowserPage(openBrowserPage(width, height), async (page) => {
        await page.setContent(
          `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
            <div class="chat-thread" role="log">
              <div class="chat-thread-inner">
                <div class="chat-group assistant chat-group--with-footer">
                  <div class="chat-avatar assistant">A</div>
                  <div class="chat-group-messages">
                    <div class="chat-bubble">
                      <div class="chat-text"><p>Done.</p></div>
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
          </body></html>`,
        );
        await page.locator(".chat-bubble").hover();

        const text = await getTextContentRect(page, ".chat-text p");
        const actions = await getRect(page, ".chat-group-footer-actions");
        expect(text.bottom).toBeLessThanOrEqual(actions.top - 1);
        const bubble = await getRect(page, ".chat-bubble");
        const name = await getRect(page, ".chat-sender-name");
        const icon = await getRect(page, ".chat-group-footer-actions button svg");
        // Turn spacing belongs after this whole set, not above its metadata.
        expect(name.top - bubble.bottom).toBeLessThanOrEqual(10);
        expect(icon.top - bubble.bottom).toBeLessThanOrEqual(10);
      });
    },
  );

  it.each([
    [320, 568],
    [1366, 900],
  ] as const)("wraps long inline code without clipping at %sx%s", async (width, height) => {
    await withBrowserPage(openBrowserPage(width, height), async (page) => {
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
    });
  });

  it.each(["dark", "light"] as const)(
    "keeps punctuation attached to inline code in %s mode",
    async (themeMode) => {
      await withBrowserPage(openBrowserPage(800, 400), async (page) => {
        await page.setContent(
          `<!doctype html><html data-theme-mode="${themeMode}"><head><style>${readUiCss()}</style></head><body>
            <div class="chat-text"><p>Use <code>status</code>; then <code>restart</code>.</p></div>
          </body></html>`,
        );

        const spacing = await page.locator(".chat-text code").evaluateAll((nodes) =>
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

  it.each(["dark", "light"] as const)(
    "fits short table cards to their columns in %s mode",
    async (themeMode) => {
      await withBrowserPage(openBrowserPage(800, 400), async (page) => {
        await page.setContent(
          `<!doctype html><html data-theme-mode="${themeMode}"><head><style>${readUiCss()}</style></head><body>
            <div class="chat-text">
              <div data-table-lane style="width: 680px">
                <table data-short-table><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody><tr><td>Gateway</td><td>Ready</td></tr></tbody></table>
              </div>
              <div data-narrow-table-lane style="width: 160px">
                <table data-narrow-table><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody><tr><td>Gateway</td><td>Ready</td></tr></tbody></table>
              </div>
            </div>
          </body></html>`,
        );

        const geometry = await page.evaluate(() => {
          const rectFor = (selector: string) =>
            document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
          const shortTable = rectFor("[data-short-table]");
          const lastCell = rectFor("[data-short-table] tbody td:last-child");
          return {
            laneWidth: rectFor("[data-table-lane]").width,
            narrowLaneWidth: rectFor("[data-narrow-table-lane]").width,
            narrowTableWidth: rectFor("[data-narrow-table]").width,
            shortTableWidth: shortTable.width,
            trailingGap: shortTable.right - lastCell.right,
          };
        });

        expect(geometry.shortTableWidth).toBeLessThan(geometry.laneWidth);
        expect(geometry.trailingGap).toBeLessThanOrEqual(1);
        expect(geometry.narrowTableWidth).toBeCloseTo(geometry.narrowLaneWidth, 0);
      });
    },
  );

  it("keeps primary composer actions desktop-sized on phones", async () => {
    await withBrowserPage(openFixture(320, 568), async (page) => {
      const sizes = await page.locator(".chat-send-btn").evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = (node as HTMLElement).getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        }),
      );
      expect(sizes.length).toBeGreaterThan(0);
      for (const size of sizes) {
        expect(size.width).toBeCloseTo(32, 2);
        expect(size.height).toBeCloseTo(32, 2);
      }
      const attach = await getRect(page, ".agent-chat__input-btn--attach");
      expect(attach.width).toBeGreaterThanOrEqual(36);
      expect(attach.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
    });
  });

  it("uses the model picker's corner radii for permissions and attachments", async () => {
    await withBrowserPage(openFixture(1024, 768), async (page) => {
      const radii = await page.evaluate(() => {
        const radius = (selector: string) => {
          const node = document.querySelector<HTMLElement>(selector);
          return node ? getComputedStyle(node).borderRadius : null;
        };
        return {
          attachTrigger: radius(".agent-chat__input-btn--attach"),
          modelOption: radius(".chat-controls__model-option"),
          modelTrigger: radius(".chat-controls__model-trigger"),
          permissionOption: radius(".chat-controls__permission-option"),
          permissionTrigger: radius(".chat-controls__permission-trigger"),
        };
      });

      expect(radii.permissionOption).toBe(radii.modelOption);
      expect(radii.permissionTrigger).toBe(radii.modelTrigger);
      expect(radii.attachTrigger).toBe(radii.modelTrigger);
    });
  });

  it("shows the current effort beside its heading in the accent color", async () => {
    await withBrowserPage(openBrowserPage(393, 852), async (page) => {
      await page.setContent(`
        <!doctype html>
        <html>
          <head><style>${readUiCss()}</style></head>
          <body>
            <div class="chat-controls__reasoning-panel">
              <div class="chat-controls__reasoning-head">
                <span class="chat-controls__effort-heading">Effort</span>
                <span class="chat-controls__effort-value">Extra high</span>
              </div>
            </div>
            <span data-accent-probe style="color: var(--accent)"></span>
          </body>
        </html>
      `);

      const layout = await page.evaluate(() => {
        const heading = document
          .querySelector<HTMLElement>(".chat-controls__effort-heading")!
          .getBoundingClientRect();
        const valueNode = document.querySelector<HTMLElement>(".chat-controls__effort-value")!;
        const value = valueNode.getBoundingClientRect();
        return {
          accentColor: getComputedStyle(document.querySelector<HTMLElement>("[data-accent-probe]")!)
            .color,
          heading: { right: heading.right, y: heading.y, height: heading.height },
          value: {
            color: getComputedStyle(valueNode).color,
            x: value.x,
            y: value.y,
            height: value.height,
          },
        };
      });

      expect(layout.value.x).toBeGreaterThanOrEqual(layout.heading.right);
      expect(
        Math.abs(
          layout.value.y + layout.value.height / 2 - (layout.heading.y + layout.heading.height / 2),
        ),
      ).toBeLessThanOrEqual(1);
      expect(layout.value.color).toBe(layout.accentColor);
    });
  });

  it("aligns the reasoning default action with the reasoning heading", async () => {
    await withBrowserPage(openBrowserPage(520, 600), async (page) => {
      await page.setContent(`
        <!doctype html>
        <html>
          <head><style>${readUiCss()}</style></head>
          <body>
            <div class="chat-controls__reasoning-panel">
              <div class="chat-controls__reasoning-heading">
                <span class="chat-controls__inline-select-section-label">Reasoning</span>
                <button class="chat-controls__reasoning-default">(Default is High)</button>
              </div>
            </div>
          </body>
        </html>
      `);

      const [headingBox, defaultBox] = await Promise.all([
        page.locator(".chat-controls__reasoning-heading > span").boundingBox(),
        page.locator(".chat-controls__reasoning-default").boundingBox(),
      ]);
      expect(headingBox).not.toBeNull();
      expect(defaultBox).not.toBeNull();
      if (!headingBox || !defaultBox) {
        throw new Error("Expected reasoning labels to have layout boxes");
      }
      expect(defaultBox.x).toBeGreaterThanOrEqual(headingBox.x + headingBox.width - 1);
      expect(
        Math.abs(defaultBox.y + defaultBox.height / 2 - (headingBox.y + headingBox.height / 2)),
      ).toBeLessThanOrEqual(2);
    });
  });

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
      expect(shell.x).toBeCloseTo(16, 0);
      expect(layout.viewportWidth - (shell.x + shell.width)).toBeCloseTo(shell.x, 0);
      expect(attach.x - input.x).toBeLessThanOrEqual(10);
      expect(model.x).toBeGreaterThanOrEqual(context.x + context.width - 1);
      expect(input.x + input.width - (send.x + send.width)).toBeLessThanOrEqual(8);
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
          status: rectFor(".agent-chat__composer-run-status"),
          typing: rectFor(".agent-chat__typing-indicator--outside"),
        };
      });

      expect(layout.viewport).toEqual({ width: 320, height: 568 });
      expect(layout.controls.scrollWidth).toBeLessThanOrEqual(layout.controls.clientWidth + 1);
      for (const control of [layout.status, layout.settings]) {
        expect(control.x).toBeGreaterThanOrEqual(layout.footer.x - 1);
        expect(control.x + control.width).toBeLessThanOrEqual(
          layout.footer.x + layout.footer.width + 1,
        );
      }
      expect(layout.status.x).toBeGreaterThanOrEqual(layout.input.x - 1);
      expect(layout.status.x + layout.status.width).toBeLessThanOrEqual(
        layout.input.x + layout.input.width + 1,
      );
      expect(layout.typing.x).toBeGreaterThanOrEqual(0);
      expect(layout.typing.x + layout.typing.width).toBeLessThanOrEqual(layout.viewport.width);
      expect(layout.settings.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
      expect(layout.settings.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
      for (const [left, right] of [
        [layout.status, layout.settings],
        [layout.settings, layout.meta],
      ] as const) {
        expect(rectsOverlap(left, right)).toBe(false);
      }
      expect(rectsOverlap(layout.typing, layout.footer)).toBe(false);
    });
  });

  it.each([
    [320, 568],
    [393, 852],
    [568, 320],
    [1366, 900],
    [1920, 1080],
  ] as const)(
    "keeps the composer bottom controls, attachment, and primary action aligned at %sx%s",
    async (width, height) => {
      await withBrowserPage(openFixture(width, height), async (page) => {
        await expectNoHorizontalOverflow(page);
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
            ".chat-controls__permission-trigger .chat-controls__inline-select-label",
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
          labels: [14, 14, 14],
          placeholder: 16,
          textarea: 16,
        });
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
        if (width <= 768) {
          expect(send.width).toBeCloseTo(32, 2);
          expect(send.height).toBeCloseTo(32, 2);
          expect(footer.height).toBeLessThanOrEqual(53);
        } else {
          // The editor reads at input size, while the controls around it stay
          // chrome-sized — that difference is what marks the text as the
          // subject of the surface.
          expect(send.width).toBeCloseTo(32, 2);
          expect(send.height).toBeCloseTo(32, 2);
        }

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

  it("keeps the compact mobile composer bottom edge stable when its textarea is focused", async () => {
    await withBrowserPage(openFixture(390, 844), async (page) => {
      const shell = page.locator(".agent-chat__composer-shell");
      const readPosition = () => shell.evaluate((node) => getComputedStyle(node).marginBottom);
      const unfocused = await readPosition();

      await page.locator(".agent-chat__composer-combobox > textarea").focus();
      const focused = await readPosition();

      expect(focused).toBe(unfocused);
      expect(focused).toBe("6px");
    });
  });

  it.each([
    [320, 568],
    [393, 852],
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
          expect(remove.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
          expect(remove.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
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

  it("keeps crowded task sections independently scrollable in the side rail", async () => {
    await withBrowserPage(openBrowserPage(1000, 700), async (page) => {
      const taskRows = Array.from(
        { length: 10 },
        (_, index) => `<div class="chat-tasks-rail__task">Task ${index + 1}</div>`,
      ).join("");
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div style="width: 360px; height: 320px; display: flex;">
              <aside class="chat-tasks-rail" style="width: 100%; height: 100%;">
                <div class="chat-tasks-rail__scroll">
                  <section class="chat-tasks-rail__section">
                    <div class="chat-tasks-rail__section-title">Running</div>
                    <div class="chat-tasks-rail__list">${taskRows}</div>
                  </section>
                  <section class="chat-tasks-rail__section">
                    <div class="chat-tasks-rail__section-title">Finished</div>
                    <div class="chat-tasks-rail__list">${taskRows}</div>
                  </section>
                </div>
              </aside>
          </div>
        </body></html>`,
      );

      const sections = await page.$$eval(".chat-tasks-rail__section", (nodes) =>
        nodes.map((node) => {
          const section = node as HTMLElement;
          section.scrollTop = 100;
          return {
            clientHeight: section.clientHeight,
            overflowY: getComputedStyle(section).overflowY,
            scrollHeight: section.scrollHeight,
            scrollTop: section.scrollTop,
          };
        }),
      );

      expect(sections).toHaveLength(2);
      for (const section of sections) {
        expect(section.overflowY).toBe("auto");
        expect(section.scrollHeight).toBeGreaterThan(section.clientHeight);
        expect(section.scrollTop).toBeGreaterThan(0);
      }
    });
  });

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

  it("keeps the mobile queue steer label visible", async () => {
    await withBrowserPage(openBrowserPage(390, 844), async (page) => {
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <button class="chat-queue__action chat-queue__steer"><span>Steer</span></button>
      </body></html>`);
      expect(
        await page
          .locator(".chat-queue__steer span")
          .evaluate((node) => getComputedStyle(node).display),
      ).not.toBe("none");
    });
  });

  it("covers every reachable queue presentation cell without repeating global state", async () => {
    const page = await openBrowserPage(1520, 2400);
    const reachableCells = QUEUE_MATRIX_MODES.flatMap((mode) =>
      QUEUE_MATRIX_RUNTIMES.flatMap((runtime) =>
        QUEUE_MATRIX_VARIANTS.filter((variant) => queueMatrixCellReachable(mode, variant)).map(
          (variant) => ({ mode, runtime, variant }),
        ),
      ),
    );
    const unreachableCells = QUEUE_MATRIX_MODES.flatMap((mode) =>
      QUEUE_MATRIX_RUNTIMES.flatMap((runtime) =>
        QUEUE_MATRIX_VARIANTS.filter((variant) => !queueMatrixCellReachable(mode, variant)).map(
          (variant) => ({ mode, runtime, variant }),
        ),
      ),
    );
    try {
      const exceptionCells = [
        queueExceptionCellHtml(
          "item-reconnect",
          "",
          "chat-queue__item--reconnect",
          '<span class="chat-queue__state">Waiting for reconnect</span>',
        ),
        queueExceptionCellHtml(
          "running-command",
          "",
          "",
          '<span class="chat-queue__state">Running command</span>',
        ),
        queueExceptionCellHtml(
          "failed",
          "",
          "chat-queue__item--failed",
          "",
          '<span class="chat-queue__error"><span class="chat-queue__badge">Failed</span><span class="chat-queue__error-text">Request rejected</span></span>',
        ),
        queueExceptionCellHtml(
          "unconfirmed-local-command",
          "",
          "chat-queue__item--failed",
          "",
          '<span class="chat-queue__error"><span class="chat-queue__badge">Delivery uncertain</span><span class="chat-queue__error-text">Reconnected before delivery was confirmed. Check the conversation — retry only if your message didn\'t arrive.</span></span>',
        ),
        queueExceptionCellHtml(
          "applying-settings",
          '<div class="chat-queue__global-state" data-chat-queue-global-state="settings">Applying chat settings</div>',
          "",
          "",
          "",
          `<button class="chat-queue__action chat-queue__steer" disabled>${iconSvg()}<span>Steer</span></button><button class="chat-queue__remove">${iconSvg()}</button>`,
        ),
      ];
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}
        body { padding: 20px; background: var(--bg); color: var(--text); }
        .queue-matrix { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
        .queue-matrix-cell { min-width: 0; }
        .queue-matrix-cell > header { margin: 0 0 6px; color: var(--muted); font: 11px/1.3 var(--mono); }
        .queue-matrix-cell .agent-chat__composer-shell { width: 100%; }
        .queue-matrix-cell .agent-chat__input { min-height: 54px; }
      </style></head><body>
        <main class="queue-matrix">
          ${reachableCells.map(({ mode, runtime, variant }) => queueMatrixCellHtml(mode, runtime, variant)).join("")}
          ${exceptionCells.join("")}
        </main>
      </body></html>`);

      expect(reachableCells).toHaveLength(27);
      expect(unreachableCells).toHaveLength(9);
      expect(await page.locator("[data-queue-cell]").count()).toBe(reachableCells.length);
      expect(await page.getByText("Waiting for current run", { exact: true }).count()).toBe(0);
      expect(
        await page.locator('[data-queue-cell*="-disconnected-"] .chat-queue__global-state').count(),
      ).toBe(0);
      expect(
        await page.locator('[data-queue-cell*="-disconnected-"] .chat-queue__state').count(),
      ).toBe(5);
      expect(
        await page
          .locator('[data-queue-cell*="-connected-running-"] .chat-queue__global-state')
          .count(),
      ).toBe(0);
      expect(
        await page
          .locator('[data-queue-cell*="-connected-idle-"] .chat-queue__global-state')
          .count(),
      ).toBe(0);
      expect(
        await page
          .locator('[data-queue-exception="applying-settings"] .chat-queue__global-state')
          .count(),
      ).toBe(1);
      expect(
        await page.locator('[data-queue-exception="applying-settings"] .chat-queue__state').count(),
      ).toBe(0);
      expect(
        await page
          .locator('[data-queue-exception="applying-settings"] .chat-queue__steer')
          .isDisabled(),
      ).toBe(true);

      const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactDir) {
        await mkdir(artifactDir, { recursive: true });
        for (const { mode, runtime, variant } of reachableCells) {
          await page.locator(`[data-queue-cell="${mode}-${runtime}-${variant}"]`).screenshot({
            animations: "disabled",
            path: path.join(artifactDir, `${mode}-${runtime}-${variant}.png`),
          });
        }
        for (const key of [
          "item-reconnect",
          "running-command",
          "failed",
          "unconfirmed-local-command",
          "applying-settings",
        ]) {
          await page.locator(`[data-queue-exception="${key}"]`).screenshot({
            animations: "disabled",
            path: path.join(artifactDir, `exception-${key}.png`),
          });
        }
      }
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("keeps a long task panel full-width with a fixed header and an internal body scroll", async () => {
    const page = await openBrowserPage(980, 844);
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
    try {
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
                <span class="session-progress-card__summary-indicator">
                  <span class="session-run-spinner"></span>
                </span>
                <span class="session-progress-card__summary-collapsed">
                  <span class="session-progress-card__current">Abrir a interface</span>
                </span>
                <span class="session-progress-card__summary-count session-progress-card__summary-count--collapsed">1/${stepCount}</span>
                <span class="session-progress-card__summary-expanded">
                  <span class="session-progress-card__summary-title">Task progress</span>
                  <span class="session-progress-card__heading-actions">6 of ${stepCount}</span>
                </span>
                <span class="session-progress-card__summary-chevron">${iconSvg()}</span>
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
        page.evaluate(() => {
          const style = (selector: string) =>
            getComputedStyle(document.querySelector<HTMLElement>(selector)!);
          const bounds = (selector: string) =>
            document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
          const spinner = style(".session-progress-card__summary-indicator .session-run-spinner");
          return {
            cardBackground: style(".session-progress-card--composer").backgroundColor,
            summaryBackground: style(".session-progress-card__summary").backgroundColor,
            titleColor: style(".session-progress-card__summary-title").color,
            actionsColor: style(".session-progress-card__heading-actions").color,
            currentColor: style(".session-progress-card__current").color,
            countColor: style(".session-progress-card__summary-count--collapsed").color,
            chevronColor: style(".session-progress-card__summary-chevron").color,
            spinnerBorderColor: spinner.borderColor,
            spinnerBorderTopColor: spinner.borderTopColor,
            titleLeft: bounds(".session-progress-card__summary-title").left,
            firstMarkerLeft: bounds(".session-progress-card__step-marker").left,
            y: bounds(".session-progress-card__summary").y,
          };
        });
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
      const { shellBounds, stackSurfaces, warnGoalSurfaces } = await page.evaluate(() => {
        const snapshot = (selector: string) => {
          const node = document.querySelector<HTMLElement>(selector)!;
          const bounds = node.getBoundingClientRect();
          return {
            background: getComputedStyle(node).backgroundColor,
            borderColor: getComputedStyle(node).borderColor,
            boxShadow: getComputedStyle(node).boxShadow,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            bottom: bounds.bottom,
            topLeftRadius: getComputedStyle(node).borderTopLeftRadius,
            topRightRadius: getComputedStyle(node).borderTopRightRadius,
            bottomLeftRadius: getComputedStyle(node).borderBottomLeftRadius,
            bottomRightRadius: getComputedStyle(node).borderBottomRightRadius,
          };
        };
        const goal = document.querySelector<HTMLElement>(".agent-chat__goal")!;
        const activeSurface = snapshot(".agent-chat__goal");
        const warnSurfaces = ["blocked", "budget_limited", "usage_limited"].map((state) => {
          goal.className = `agent-chat__goal agent-chat__goal--${state}`;
          return { state, surface: snapshot(".agent-chat__goal") };
        });
        goal.className = "agent-chat__goal agent-chat__goal--active";
        const shell = document
          .querySelector<HTMLElement>(".agent-chat__composer-shell")!
          .getBoundingClientRect();
        return {
          shellBounds: { left: shell.left, right: shell.right },
          stackSurfaces: [
            snapshot(".session-progress-card--composer"),
            snapshot(".chat-queue"),
            activeSurface,
            snapshot(".agent-chat__input"),
          ],
          warnGoalSurfaces: warnSurfaces,
        };
      });
      await setSummaryHover(true);
      const widthAfter = (await card.boundingBox())?.width;
      const expandedAfter = await readSummaryState();
      expect(widthBefore).toBeCloseTo(760, 1);
      expect(widthAfter).toBeCloseTo(widthBefore ?? 0, 1);
      for (const surface of stackSurfaces) {
        expect(surface.left).toBeCloseTo(shellBounds.left, 1);
        expect(surface.right).toBeCloseTo(shellBounds.right, 1);
      }
      expect(new Set(stackSurfaces.slice(0, 3).map(({ background }) => background))).toHaveProperty(
        "size",
        1,
      );
      for (const [index, surface] of stackSurfaces.entries()) {
        expect(Number.parseFloat(surface.topLeftRadius)).toBeGreaterThan(0);
        expect(surface.topRightRadius).toBe(surface.topLeftRadius);
        expect(surface.bottomLeftRadius).toBe(surface.topLeftRadius);
        expect(surface.bottomRightRadius).toBe(surface.topLeftRadius);
        if (index > 0) {
          expect(surface.top).toBeGreaterThan(stackSurfaces[index - 1]!.bottom);
        }
      }
      expect(stackSurfaces[2]?.borderColor).toBe(stackSurfaces[1]?.borderColor);
      expect(stackSurfaces[2]?.boxShadow).toBe(stackSurfaces[1]?.boxShadow.split(", rgba")[0]);
      for (const { state, surface } of warnGoalSurfaces) {
        expect(surface.background, state).not.toBe(stackSurfaces[2]?.background);
        expect(surface.borderColor, state).not.toBe(stackSurfaces[2]?.borderColor);
      }
      expect(new Set(warnGoalSurfaces.map(({ surface }) => surface.borderColor))).toHaveProperty(
        "size",
        1,
      );
      expect(expandedBefore.titleLeft).toBeCloseTo(expandedBefore.firstMarkerLeft, 1);
      expect(expandedAfter.cardBackground).toBe(expandedBefore.cardBackground);
      expect(expandedAfter.summaryBackground).toBe(expandedBefore.summaryBackground);
      expect(expandedAfter.titleColor).not.toBe(expandedBefore.titleColor);
      expect(expandedAfter.actionsColor).not.toBe(expandedBefore.actionsColor);
      expect(expandedAfter.chevronColor).not.toBe(expandedBefore.chevronColor);

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
      const openStackAxes = await page.evaluate(() => {
        const centerX = (selector: string) => {
          const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
          return rect.left + rect.width / 2;
        };
        const left = (selector: string) =>
          document.querySelector<HTMLElement>(selector)!.getBoundingClientRect().left;
        return {
          iconCenters: [
            ...[
              ...document.querySelectorAll<HTMLElement>(".session-progress-card__step-marker > *"),
            ].map((icon) => {
              const rect = icon.getBoundingClientRect();
              return rect.left + rect.width / 2;
            }),
            centerX(".chat-queue__leading svg"),
            centerX(".agent-chat__goal-icon svg"),
          ],
          contentLefts: [
            left(".session-progress-card__step-text"),
            left(".chat-queue__copy"),
            left(".agent-chat__goal-label"),
          ],
          trailingCenterDelta:
            centerX(".session-progress-card__summary-chevron svg") -
            centerX(".agent-chat__goal-expand svg"),
        };
      });
      expect(
        Math.max(...openStackAxes.iconCenters) - Math.min(...openStackAxes.iconCenters),
      ).toBeLessThan(0.5);
      expect(
        Math.max(...openStackAxes.contentLefts) - Math.min(...openStackAxes.contentLefts),
      ).toBeLessThan(0.5);
      expect(Math.abs(openStackAxes.trailingCenterDelta)).toBeLessThan(0.5);
      await body.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      expect((await summary.boundingBox())?.y).toBeCloseTo(expandedBefore.y, 1);
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
      expect(collapsedAfter.cardBackground).toBe(collapsedBefore.cardBackground);
      expect(collapsedAfter.summaryBackground).toBe(collapsedBefore.summaryBackground);
      expect(collapsedAfter.currentColor).not.toBe(collapsedBefore.currentColor);
      expect(collapsedAfter.countColor).not.toBe(collapsedBefore.countColor);
      expect(collapsedAfter.chevronColor).not.toBe(collapsedBefore.chevronColor);
      expect(collapsedAfter.spinnerBorderColor).toBe(collapsedBefore.spinnerBorderColor);
      expect(collapsedAfter.spinnerBorderTopColor).toBe(collapsedBefore.spinnerBorderTopColor);
      const collapsed = await page.evaluate(() => {
        const rect = (selector: string) =>
          document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
        const current = rect(".session-progress-card__current");
        const count = rect(".session-progress-card__summary-count--collapsed");
        const chevron = rect(".session-progress-card__summary-chevron");
        const iconCenter = (selector: string) => {
          const bounds = rect(selector);
          return bounds.left + bounds.width / 2;
        };
        return {
          countLeft: count.left,
          countRight: count.right,
          currentRight: current.right,
          chevronLeft: chevron.left,
          iconCenters: [
            iconCenter(".session-progress-card__summary-indicator > *"),
            iconCenter(".chat-queue__leading svg"),
            iconCenter(".agent-chat__goal-icon svg"),
          ],
          trailingCenterDelta:
            iconCenter(".session-progress-card__summary-chevron svg") -
            iconCenter(".agent-chat__goal-expand svg"),
        };
      });
      expect(collapsed.countLeft).toBeGreaterThan(collapsed.currentRight);
      expect(collapsed.countRight).toBeLessThanOrEqual(collapsed.chevronLeft);
      expect(Math.max(...collapsed.iconCenters) - Math.min(...collapsed.iconCenters)).toBeLessThan(
        0.5,
      );
      expect(Math.abs(collapsed.trailingCenterDelta)).toBeLessThan(0.5);
      const closedRowCenters = await page.evaluate(() => {
        const centerY = (selector: string) => {
          const bounds = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
          return bounds.top + bounds.height / 2;
        };
        return [
          centerY(".session-progress-card__summary-indicator > *"),
          centerY(".session-progress-card__current"),
          centerY(".session-progress-card__summary-count--collapsed"),
          centerY(".session-progress-card__summary-chevron > svg"),
        ];
      });
      expect(Math.max(...closedRowCenters) - Math.min(...closedRowCenters)).toBeLessThan(0.5);
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
    } finally {
      await closeBrowserPage(page);
    }
  });

  it("keeps queued states neutral and puts the editing ring only on the input", async () => {
    await withBrowserPage(openBrowserPage(820, 640), async (page) => {
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <div class="chat-queue">
          <div class="chat-queue__item chat-queue__item--steered">
            <span class="chat-queue__badge chat-queue__badge--steered">Steer</span>
            <span class="chat-queue__state">Waiting for reconnect</span>
          </div>
          <div class="chat-queue__item chat-queue__item--editing">
            <textarea class="chat-queue__edit-input">Change course</textarea>
          </div>
        </div>
      </body></html>`);
      await page.locator(".chat-queue__edit-input").focus();

      const styles = await page.evaluate(() => {
        const steered = getComputedStyle(document.querySelector(".chat-queue__item--steered")!);
        const badge = getComputedStyle(document.querySelector(".chat-queue__badge--steered")!);
        const state = getComputedStyle(document.querySelector(".chat-queue__state")!);
        const editing = getComputedStyle(document.querySelector(".chat-queue__item--editing")!);
        const input = getComputedStyle(document.querySelector(".chat-queue__edit-input")!);
        return {
          steeredBackground: steered.backgroundColor,
          badgeBackground: badge.backgroundColor,
          badgeColor: badge.color,
          stateBackground: state.backgroundColor,
          stateBorder: state.borderStyle,
          editingShadow: editing.boxShadow,
          inputOutlineStyle: input.outlineStyle,
          inputOutlineWidth: input.outlineWidth,
        };
      });

      expect(styles.steeredBackground).toBe("rgba(0, 0, 0, 0)");
      expect(styles.badgeBackground).not.toContain("96, 165, 250");
      expect(styles.badgeColor).not.toContain("96, 165, 250");
      expect(styles.stateBackground).toBe("rgba(0, 0, 0, 0)");
      expect(styles.stateBorder).toBe("none");
      expect(styles.editingShadow).toBe("none");
      expect(styles.inputOutlineStyle).toBe("solid");
      expect(styles.inputOutlineWidth).toBe("2px");
    });
  });

  it("renders the terminal turn recap as plain transcript text", async () => {
    await withBrowserPage(openBrowserPage(820, 640), async (page) => {
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <div class="chat-tasks-status chat-turn-recap">Done in 7 seconds · 58 tokens</div>
      </body></html>`);
      const style = await page.locator(".chat-turn-recap").evaluate((element) => {
        const computed = getComputedStyle(element);
        return {
          background: computed.backgroundColor,
          border: computed.borderStyle,
          borderRadius: computed.borderRadius,
          boxShadow: computed.boxShadow,
          minHeight: computed.minHeight,
          padding: computed.padding,
        };
      });

      expect(style).toEqual({
        background: "rgba(0, 0, 0, 0)",
        border: "none",
        borderRadius: "0px",
        boxShadow: "none",
        minHeight: "0px",
        padding: "0px",
      });
    });
  });

  describe("slash command keyboard navigation", () => {
    let page: Page;

    beforeAll(async () => {
      page = await getSharedAppPage();
      await page.setViewportSize({ width: 568, height: 320 });
      await page.getByText(SHARED_APP_SLASH_TEXT).waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
      const textarea = page.locator(".agent-chat__composer-combobox > textarea");
      await textarea.fill("/");
      await textarea.focus();
    });

    afterAll(async () => {
      if (!page) {
        return;
      }
      await page.locator(".agent-chat__composer-combobox > textarea").fill("");
      await page.setViewportSize({ width: 1366, height: 900 });
    });

    it("scrolls the keyboard-active slash option into view in short landscape", async () => {
      const initiallyHidden = await page.evaluate(() => {
        const scrollRegion = document.querySelector<HTMLElement>(".slash-menu__scroll");
        const options = Array.from(
          document.querySelectorAll<HTMLElement>(".slash-menu-item[role='option']"),
        );
        const hiddenOption = options.find((option) => {
          const menuRect = scrollRegion?.getBoundingClientRect();
          const optionRect = option.getBoundingClientRect();
          return Boolean(menuRect && optionRect.bottom > menuRect.bottom + 1);
        });
        if (!scrollRegion || !hiddenOption) {
          throw new Error("Expected an initially hidden slash option");
        }
        scrollRegion.scrollTop = 0;
        const menuRect = scrollRegion.getBoundingClientRect();
        const itemRect = hiddenOption.getBoundingClientRect();
        return {
          id: hiddenOption.id,
          index: options.indexOf(hiddenOption),
          visible: itemRect.top >= menuRect.top - 1 && itemRect.bottom <= menuRect.bottom + 1,
        };
      });
      expect(initiallyHidden.visible).toBe(false);

      for (let index = 0; index < initiallyHidden.index; index += 1) {
        await page.keyboard.press("ArrowDown");
      }
      await page.waitForFunction((expectedId) => {
        const input = document.querySelector<HTMLTextAreaElement>(
          ".agent-chat__composer-combobox > textarea",
        );
        return input?.getAttribute("aria-activedescendant") === expectedId;
      }, initiallyHidden.id);
      await page.waitForFunction((expectedId) => {
        const active = document.getElementById(expectedId);
        const scrollRegion = active?.closest<HTMLElement>(".slash-menu__scroll");
        if (!active || !scrollRegion) {
          return false;
        }
        const menuRect = scrollRegion.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        return activeRect.top >= menuRect.top - 1 && activeRect.bottom <= menuRect.bottom + 1;
      }, initiallyHidden.id);

      const result = await page.evaluate(() => {
        const input = document.querySelector<HTMLTextAreaElement>(
          ".agent-chat__composer-combobox > textarea",
        );
        const scrollRegion = document.querySelector<HTMLElement>(".slash-menu__scroll");
        const active = document.querySelector<HTMLElement>(".slash-menu-item--active");
        if (!input || !scrollRegion || !active) {
          throw new Error("Expected active slash option after keyboard navigation");
        }
        const menuRect = scrollRegion.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        return {
          activeDescendant: input.getAttribute("aria-activedescendant"),
          focusedTag: document.activeElement?.tagName,
          scrollTop: scrollRegion.scrollTop,
          visible: activeRect.top >= menuRect.top - 1 && activeRect.bottom <= menuRect.bottom + 1,
        };
      });

      expect(result.focusedTag).toBe("TEXTAREA");
      expect(result.activeDescendant).toBe(initiallyHidden.id);
      expect(result.scrollTop).toBeGreaterThan(0);
      expect(result.visible).toBe(true);
    });
  });

  it("keeps overflowing skill suggestions on the nested scroll viewport", async () => {
    await withBrowserPage(openBrowserPage(568, 320), async (page) => {
      const items = Array.from({ length: 16 }, (_, index) => {
        const active = index === 15 ? " slash-menu-item--active" : "";
        return `<div class="slash-menu-item${active}" role="option">
          <span class="slash-menu-icon">${iconSvg()}</span>
          <span class="slash-menu-copy"><span class="slash-menu-name">$skill_${index + 1}</span></span>
        </div>`;
      }).join("");
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <div class="slash-menu skill-menu" role="listbox">
          <div class="slash-menu__scroll">${items}</div>
        </div>
      </body></html>`);

      const result = await page.evaluate(() => {
        const active = document.querySelector<HTMLElement>(".slash-menu-item--active");
        const scrollRegion = active?.closest<HTMLElement>(".slash-menu__scroll");
        if (!active || !scrollRegion) {
          throw new Error("Expected an active skill inside the nested viewport");
        }
        const viewport = scrollRegion.getBoundingClientRect();
        const option = active.getBoundingClientRect();
        scrollRegion.scrollTop += option.bottom - viewport.bottom;
        const settledOption = active.getBoundingClientRect();
        const settledViewport = scrollRegion.getBoundingClientRect();
        return {
          outerScrollTop: active.closest<HTMLElement>(".skill-menu")?.scrollTop,
          scrollTop: scrollRegion.scrollTop,
          visible:
            settledOption.top >= settledViewport.top - 1 &&
            settledOption.bottom <= settledViewport.bottom + 1,
        };
      });

      expect(result.outerScrollTop).toBe(0);
      expect(result.scrollTop).toBeGreaterThan(0);
      expect(result.visible).toBe(true);
    });
  });

  it("allows pointer selection in the embedded side-chat transcript", async () => {
    await withBrowserPage(openBrowserPage(1024, 768), async (page) => {
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <section class="chat-session-rail chat-session-rail--expanded chat-session-rail--embedded">
          <div class="chat-session-rail__thread">
            <article class="chat-session-rail__exchange">
              <div class="chat-session-rail__answer">
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

  it("keeps the embedded side-chat composer trailing and flush with the tab strip", async () => {
    await withBrowserPage(openBrowserPage(1024, 768), async (page) => {
      await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <section class="chat-session-rail chat-session-rail--expanded chat-session-rail--embedded">
          <div class="chat-session-rail__thread">Side chat</div>
          <form class="agent-chat__input chat-session-rail__composer">
            <div class="agent-chat__composer-input-row">
              <label class="agent-chat__composer-combobox chat-session-rail__prompt">
                <textarea class="chat-session-rail__input" rows="1" placeholder="Ask a question"></textarea>
              </label>
            </div>
            <div class="agent-chat__composer-footer">
              <div class="agent-chat__composer-trail">
                <div class="agent-chat__composer-actions">
                  <button class="chat-send-btn">${iconSvg()}</button>
                </div>
              </div>
            </div>
          </form>
        </section>
      </body></html>`);

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
    });
  });

  it.each([
    [1024, 768],
    [1366, 900],
  ] as const)(
    "scrolls long session-rail conversations instead of expanding the overlay at %sx%s",
    async (width, height) => {
      await withBrowserPage(
        openFixture(width, height, {
          sessionRailBody: LONG_SESSION_RAIL_BODY,
        }),
        async (page) => {
          const panel = await page.evaluate(() => {
            const element = document.querySelector(".chat-session-rail") as HTMLElement;
            const pane = document.querySelector(".chat-main") as HTMLElement;
            return {
              clientHeight: element.clientHeight,
              paneHeight: pane.clientHeight,
              position: getComputedStyle(element).position,
            };
          });
          expect(panel.position).toBe("absolute");
          // The rail fills its pane and no more; growth past the container is what
          // the old floating card was capped against, and the sheet must not
          // reintroduce it. Long threads scroll internally instead — asserted below.
          expect(panel.clientHeight).toBeLessThanOrEqual(panel.paneHeight);

          const body = await page.locator(".chat-session-rail__thread").evaluate((node) => {
            const style = getComputedStyle(node as HTMLElement);
            return {
              overflowY: style.overflowY,
              clientHeight: (node as HTMLElement).clientHeight,
              scrollHeight: (node as HTMLElement).scrollHeight,
            };
          });
          expect(body.overflowY).toBe("auto");
          expect(body.clientHeight).toBeLessThan(body.scrollHeight);

          const scrollTop = await page.locator(".chat-session-rail__thread").evaluate((node) => {
            const element = node as HTMLElement;
            element.scrollTop = element.scrollHeight;
            return element.scrollTop;
          });
          expect(scrollTop).toBeGreaterThan(0);
        },
      );
    },
  );

  it("renders the session rail as a mobile overlay without horizontal overflow", async () => {
    await withBrowserPage(
      openFixture(320, 568, {
        sessionRailBody: LONG_SESSION_RAIL_BODY,
      }),
      async (page) => {
        await expectNoHorizontalOverflow(page);
        const panel = await page.locator(".chat-session-rail").evaluate((node) => {
          const element = node as HTMLElement;
          return {
            clientHeight: element.clientHeight,
            position: getComputedStyle(element).position,
          };
        });
        expect(panel.position).toBe("fixed");
        // Full-screen sheet at this width: bounded by the viewport, never beyond.
        expect(panel.clientHeight).toBeLessThanOrEqual(568);

        const scroll = await page.locator(".chat-session-rail__thread").evaluate((node) => {
          const element = node as HTMLElement;
          return {
            overflowY: getComputedStyle(element).overflowY,
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
          };
        });
        expect(scroll.overflowY).toBe("auto");
        expect(scroll.clientHeight).toBeLessThan(scroll.scrollHeight);

        const scrollTop = await page.locator(".chat-session-rail__thread").evaluate((node) => {
          const element = node as HTMLElement;
          element.scrollTop = element.scrollHeight;
          return element.scrollTop;
        });
        expect(scrollTop).toBeGreaterThan(0);
      },
    );
  });

  it("keeps rail metadata out of the scrolling thread's layout", async () => {
    await withBrowserPage(
      openFixture(1024, 768, { sessionRailBody: LONG_SESSION_RAIL_BODY }),
      async (page) => {
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
            timestamp: read(".chat-session-rail__timestamp"),
            hint: read(".chat-session-rail__hint"),
          };
        });

        // PR checks, timestamps and hints are metadata inside an exchange. Sharing the
        // thread's rule would give each one a 96px scrolling bordered box; the
        // selector list has silently merged before.
        expect(styles.thread.minHeight).toBe("96px");
        expect(styles.thread.overflowY).toBe("auto");
        for (const metadata of [styles.prChecks, styles.timestamp, styles.hint]) {
          // Relational, not a literal: the point is that these nodes do not share
          // the thread's rule, whatever the thread's own numbers become.
          expect(metadata.minHeight).not.toBe(styles.thread.minHeight);
          expect(metadata.overflowY).toBe("visible");
          expect(metadata.borderTopWidth).toBe("0px");
        }
      },
    );
  });

  it("degrades an undocked session rail to a full-height edge sheet, never a floating card", async () => {
    await withBrowserPage(
      openFixture(900, 800, {
        sessionRailBody: LONG_SESSION_RAIL_BODY,
      }),
      async (page) => {
        const geometry = await page.evaluate(() => {
          const rail = document.querySelector(".chat-session-rail") as HTMLElement;
          const main = document.querySelector(".chat-main") as HTMLElement;
          const railBox = rail.getBoundingClientRect();
          const mainBox = main.getBoundingClientRect();
          const style = getComputedStyle(rail);
          return {
            topGap: Math.round(railBox.top - mainBox.top),
            bottomGap: Math.round(mainBox.bottom - railBox.bottom),
            rightGap: Math.round(mainBox.right - railBox.right),
            borderRadius: style.borderTopLeftRadius,
            boxShadow: style.boxShadow,
            backdropFilter: style.backdropFilter,
            animationName: style.animationName,
          };
        });

        // Flush to the pane on three sides with square corners: a surface that
        // took the pane over, not a card hovering above the conversation.
        expect(geometry.topGap).toBe(0);
        expect(geometry.bottomGap).toBe(0);
        expect(geometry.rightGap).toBe(0);
        expect(geometry.borderRadius).toBe("0px");
      },
    );
  });

  it("matches the reading prototype's transcript letter spacing without changing shared text", async () => {
    await withBrowserPage(openBrowserPage(1366, 900), async (page) => {
      await page.setContent(`<!doctype html><html data-theme-mode="dark"><head><style>${readUiCss()}</style></head><body>
        <div class="chat-thread chat-thread--direct" role="log">
          <div class="chat-thread-inner">
            <div class="chat-group assistant">
              <div class="chat-group-messages">
                <div class="chat-bubble">
                  <div class="chat-text">
                    <p>Aa Bb Cc — Smooth reading depends on the shape, spacing, and contrast of every glyph in a transcript.</p>
                    <p>Keep this fixture about text rendering; width and block rhythm are intentionally not asserted here.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <section class="custodian-surface">
          <div class="chat-bubble"><div class="chat-text">Custodian output</div></div>
        </section>
        <div class="chat-notice"><div class="chat-text chat-notice__body">Compact notice</div></div>
        <div class="cron-run-entry__body chat-text">Cron output</div>
      </body></html>`);

      const transcriptLetterSpacing = await page
        .locator(".chat-thread .chat-bubble .chat-text")
        .evaluate((element) => getComputedStyle(element).letterSpacing);
      const custodianLetterSpacing = await page
        .locator(".custodian-surface .chat-bubble .chat-text")
        .evaluate((element) => getComputedStyle(element).letterSpacing);
      const noticeLetterSpacing = await page
        .locator(".chat-notice .chat-text")
        .evaluate((element) => getComputedStyle(element).letterSpacing);
      const cronLetterSpacing = await page
        .locator(".cron-run-entry__body.chat-text")
        .evaluate((element) => getComputedStyle(element).letterSpacing);
      const bodyLetterSpacing = await page
        .locator("body")
        .evaluate((element) => getComputedStyle(element).letterSpacing);
      expect(transcriptLetterSpacing).toBe("normal");
      expect(custodianLetterSpacing).toBe(bodyLetterSpacing);
      expect(noticeLetterSpacing).toBe(bodyLetterSpacing);
      expect(cronLetterSpacing).toBe(bodyLetterSpacing);
    });
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
