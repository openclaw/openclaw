import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import postcss from "postcss";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import { controlUiHoverGuardPlugin } from "../../config/control-ui-hover-guard.ts";
import { withBrowserPage } from "../test-helpers/browser-page.ts";
import { readStyles, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("cursor-policy-", { ignoreCloseErrors: true });

// What `DashboardWindowController.installNativeChromeScript` stamps on <html>.
const NATIVE_HOST_MARKERS = ["openclaw-native-macos", "openclaw-native-web-chrome"] as const;

function cursorGroup(expected: string, selectors: string, shadow = false) {
  return postcss.list.comma(selectors).map((selector) => ({ expected, selector, shadow }));
}
const CURSOR_CASES = [
  ...cursorGroup(
    "default",
    `.btn, #plain-summary, #plain-select, #plain-checkbox, #role-button,
    .settings-secret__toggle, .nav-item, .nav-item__text, .sidebar-recent-session__link,
    .sidebar-recent-session__name, .sidebar-online__person, .sidebar-new-session,
    .sidebar-session-catalog-new, .settings-sidebar__item, .settings-sidebar__subitem,
    .sidebar-issues-panel__navigation-link, .sidebar-approval-row__open-session,
    .sidebar-footer-build, .agent-tools-runtime-chip--more, .chat-assistant-attachment-card[data-openable]`,
  ),
  ...cursorGroup(
    "pointer",
    `#real-link, #sidebar-external-link, #sidebar-help-link,
    #sidebar-new-tab-link, #sidebar-new-tab-action, #new-tab-link, #new-tab-button,
    .markdown-file-link, .markdown-github-item`,
  ),
  ...cursorGroup("pointer", "#shadow-new-tab-button", true),
  ...cursorGroup("default", "#shadow-disabled-new-tab-button", true),
  ...cursorGroup("text", "#plain-text-input, .chat-pane__session-title-button"),
  ...cursorGroup("zoom-in", ".chat-message-image-button"),
  ...cursorGroup("not-allowed", ".btn--ghost:disabled, #disabled-new-tab-button"),
  ...cursorGroup("wait", ".sidebar-update-card__hold:disabled"),
];

function readUiCss(): string {
  const css = readStyles(
    "styles/base",
    "styles/components",
    "styles/layout",
    "styles/sidebar-update-card",
    "styles/sidebar-issues",
    "styles/sidebar-markdown",
    "styles/sessions",
    "styles/settings-controls",
    "styles/settings",
    "styles/agents",
    "styles/skill-workshop",
    "styles/rail-header",
    "styles/chat/startup-layout",
    "styles/chat/layout",
    "styles/chat/message-layout",
    "styles/chat/composer-surface",
    "styles/chat/composer",
    "styles/chat/split-view",
    "styles/chat/text",
  );
  return postcss([controlUiHoverGuardPlugin()]).process(css, { from: undefined }).css;
}

const fixtureDocument =
  () => `<!doctype html><html data-theme-mode="light"><head><style>${readUiCss()}</style></head><body>
    <main>
      <button class="btn" type="button">Primary</button>
      <button class="btn btn--ghost" type="button" disabled>Ghost disabled</button>
      <details><summary id="plain-summary">Details</summary><p>body</p></details>
      <select id="plain-select"><option>option</option></select>
      <input id="plain-checkbox" type="checkbox" />
      <input id="plain-text-input" type="text" value="text" />
      <div id="role-button" role="button" tabindex="0">Role button</div>
      <a id="real-link" href="https://example.com">Real link</a>
      <a id="primary-button-link" class="btn primary" href="/new">Primary action</a>
      <a id="ghost-button-link" class="btn btn--ghost" href="/new">Secondary action</a>
      <a id="role-button-link" role="button" href="/new">Action</a>
      <div class="callout"><a id="docs-link" href="https://example.com/docs">Documentation</a></div>
      <div class="chat-text">
        <a id="chat-content-link" href="https://example.com">Chat link</a>
        <a id="chat-button-link" class="btn" href="/new">Chat action</a>
      </div>
      <div class="sidebar-markdown"><a id="sidebar-content-link" href="https://example.com">Sidebar link</a></div>
      <div class="markdown"><a class="markdown-bare-url" href="https://example.com">Transcript link</a></div>
      <div class="chat-thinking"><a class="markdown-bare-url" href="https://example.com">Reasoning link</a></div>
      <div class="markdown-body"><a class="markdown-bare-url" href="https://example.com">Logbook link</a></div>
      <div class="chat-position-rail__preview-copy" inert>
        <a class="markdown-bare-url" href="https://example.com">Preview URL</a>
        <a id="preview-github-link" class="markdown-github-link" href="https://github.com/example/project">Preview repository</a>
      </div>
      <div class="dreams-diary__para"><a class="markdown-bare-url" href="https://example.com">Diary link</a></div>
      <a class="activity-entry__run-link" href="/activity">Run</a>
      <a class="settings-row__value" href="https://example.com/docs">Setup documentation</a>
      <a class="memory-page__link" href="/settings/memory">Memory settings</a>
      <a class="portals-preview__notice-url" href="https://example.com">Portal address</a>
      <a class="settings-account" href="https://github.com/example">Account</a>
      <a class="transcripts-back" href="/meetings">Transcripts</a>
      <a id="person-link" class="person-activity-link" href="/activity">Person</a>
      <a id="participant-link" class="session-menu__item learn-more-link session-hovercard__participant-link person-activity-link" href="/activity">Participant</a>
      <aside class="sidebar">
        <a class="nav-item" href="/chat"><span class="nav-item__text">Home</span></a>
        <a class="sidebar-recent-session__link" href="/chat/test"><span class="sidebar-recent-session__name">Session</span></a>
        <a class="sidebar-online__person" href="/activity"><span class="sidebar-online__person-name">Person</span></a>
        <button class="sidebar-online__person" type="button"><span class="sidebar-online__person-name">Viewer</span></button>
        <a class="sidebar-new-session" href="/new">New group session</a>
        <a class="sidebar-session-catalog-new" href="/new">New catalog session</a>
        <a class="sidebar-issues-panel__navigation-link" href="/settings/channels">Channel issue</a>
        <a class="sidebar-approval-row__open-session" href="/chat/test">Open approval session</a>
        <a id="sidebar-external-link" href="https://example.com">External link</a>
        <a id="sidebar-new-tab-link" class="nav-item" href="/chat" target="_BLANK">New tab</a>
        <a id="sidebar-new-tab-action" class="nav-item" href="/chat" data-new-tab-action>New window</a>
      </aside>
      <aside class="settings-sidebar">
        <a class="settings-sidebar__item" href="/settings">Settings</a>
        <a class="settings-sidebar__subitem" href="/settings#theme">Theme</a>
        <a class="sidebar-footer-build" href="/settings/about">Build</a>
      </aside>
      <div class="sidebar-agent-menu"><div class="sidebar-customize-menu__item"><a id="sidebar-help-link" href="https://example.com/docs" target="_blank">Docs</a></div></div>
      <a id="new-tab-link" class="btn" href="https://example.com/docs" target="_blank">Docs</a>
      <button id="new-tab-button" class="btn" type="button" data-new-tab-action>New tab</button>
      <button id="disabled-new-tab-button" class="btn btn--ghost" type="button" data-new-tab-action disabled>Unavailable new tab</button>
      <button class="settings-secret__toggle" type="button">Reveal</button>
      <button class="sidebar-update-card__hold" type="button" disabled>Hold</button>
      <button class="chat-pane__session-title-button" type="button">Session title</button>
      <button class="chat-message-image-button" type="button">Image</button>
      <div class="chat-assistant-attachment-card" data-openable>Attachment</div>
      <span class="agent-tools-runtime-chip--more">+3</span>
      <div class="chat-text"><a class="markdown-file-link">src/index.ts</a></div>
      <div class="chat-text"><a class="markdown-github-link markdown-github-item" data-github-kind="pull" href="https://github.com/openclaw/openclaw/pull/3434" target="_blank">#3434</a></div>
      <div id="shadow-policy-host"><template shadowrootmode="open">
        <style>${readStyleSheet("ui/src/components/dock-panel.css")}</style>
        <button id="shadow-new-tab-button" class="rail-header__action" type="button" data-new-tab-action>New tab</button>
        <button id="shadow-disabled-new-tab-button" class="rail-header__action" type="button" data-new-tab-action disabled>Unavailable new tab</button>
      </template></div>
    </main>
  </body></html>`;

async function probeWindow(page: Page) {
  return await page.evaluate((cursorCases) => {
    const modes = ["browser", "standalone", "minimal-ui", "window-controls-overlay", "fullscreen"];
    const cursors = cursorCases.map(({ selector, shadow }) => {
      const element = shadow
        ? document
            .querySelector<HTMLElement>("#shadow-policy-host")
            ?.shadowRoot?.querySelector(selector)
        : document.querySelector(selector);
      if (!element) {
        throw new Error(`Missing cursor fixture element for ${selector}`);
      }
      return [selector, getComputedStyle(element).cursor] as const;
    });
    return {
      cursors: Object.fromEntries(cursors),
      displayMode: modes.find((mode) => matchMedia(`(display-mode: ${mode})`).matches) ?? "unknown",
    };
  }, CURSOR_CASES);
}

const expectedCursors = Object.fromEntries(CURSOR_CASES.map((row) => [row.selector, row.expected]));

function style(
  locator: Locator,
  property: "color" | "textDecorationLine" | "textDecorationThickness",
) {
  return locator.evaluate((element, key) => getComputedStyle(element)[key], property);
}

let fixtureDirectory: string;
let fixtureFile: string;
let appContext: BrowserContext;

beforeAll(async () => {
  if (!fixture.available) {
    return;
  }
  fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-policy-"));
  fixtureFile = path.join(fixtureDirectory, "fixture.html");
  fs.writeFileSync(fixtureFile, fixtureDocument(), "utf8");
  // Only a real app window, not media emulation, proves standalone display mode.
  appContext = await chromium.launchPersistentContext(path.join(fixtureDirectory, "profile"), {
    args: [`--app=file://${fixtureFile}`],
    executablePath: fixture.executablePath,
    headless: true,
  });
});

afterAll(async () => {
  await appContext?.close().catch(() => {});
  if (fixtureDirectory) {
    fs.rmSync(fixtureDirectory, { force: true, recursive: true });
  }
});

fixture.describe("Control UI cursor policy", () => {
  it.each([
    { theme: "light", hasTouch: false },
    { theme: "dark", hasTouch: false },
    { theme: "light", hasTouch: true },
    { theme: "dark", hasTouch: true },
  ])("underlines content, not controls ($theme, touch=$hasTouch)", async ({ theme, hasTouch }) => {
    await withBrowserPage(fixture.page({ hasTouch }), async (page) => {
      await page.goto(`file://${fixtureFile}`);
      await page.evaluate((mode) => {
        document.documentElement.dataset.themeMode = mode;
      }, theme);
      expect(await style(page.locator("#new-tab-link"), "color")).toBe(
        await style(page.locator("#new-tab-button"), "color"),
      );
      const people = await page.locator(".sidebar-online__person").all();
      expect(people).toHaveLength(2);
      for (const person of people) {
        // Ancestor decorations propagate visually without inheriting the computed value.
        expect(await style(person, "textDecorationLine")).toBe("none");
        expect(
          await style(person.locator(".sidebar-online__person-name"), "textDecorationLine"),
        ).toBe("none");
      }
      for (const [expected, selectors] of Object.entries({
        none: `#new-tab-link, #primary-button-link, #ghost-button-link, #role-button-link,
          #chat-button-link, .person-activity-link, .markdown-github-item, .markdown-file-link,
          .chat-position-rail__preview-copy a`,
        underline: `#real-link, #docs-link, #chat-content-link, #sidebar-content-link,
          .markdown-bare-url:not(.chat-position-rail__preview-copy a), .activity-entry__run-link,
          .settings-row__value, .memory-page__link, .portals-preview__notice-url,
          .settings-account, .transcripts-back`,
      })) {
        for (const selector of postcss.list.comma(selectors)) {
          const links = await page.locator(selector).all();
          expect(links.length, selector).toBeGreaterThan(0);
          for (const link of links) {
            expect(await style(link, "textDecorationLine"), selector).toBe(expected);
          }
        }
      }
      for (const link of await page.locator(".chat-position-rail__preview-copy a").all()) {
        expect(await style(link, "color")).toBe(
          await style(page.locator(".chat-position-rail__preview-copy"), "color"),
        );
      }
      for (const [id, decoration] of [
        ["person-link", "underline"],
        ["participant-link", "none"],
      ]) {
        const link = page.locator(`#${id}`);
        if (!hasTouch) {
          await link.hover();
          expect(await style(link, "textDecorationLine")).toBe(decoration);
          if (id === "person-link") {
            expect(await style(link, "textDecorationThickness")).toBe("2px");
          }
        }
        await page.mouse.move(0, 0);
        await page.keyboard.press("Tab");
        await link.focus();
        expect(await style(link, "textDecorationLine")).toBe(decoration);
      }
    });
  });

  it.each([false, true])(
    "uses semantic cursors in a browser window (native=%s)",
    async (native) => {
      await withBrowserPage(fixture.page(), async (page) => {
        await page.goto(`file://${fixtureFile}`);
        if (native) {
          await page.evaluate((markers: readonly string[]) => {
            document.documentElement.classList.add(...markers);
          }, NATIVE_HOST_MARKERS);
        }
        expect(await probeWindow(page)).toEqual({
          displayMode: "browser",
          cursors: expectedCursors,
        });
      });
    },
  );

  it("uses the same semantic cursors in an installed window", async () => {
    const [page] = appContext.pages();
    expect(page, "Chromium --app window did not expose a page").toBeDefined();
    await page!.waitForLoadState("load");
    expect(await probeWindow(page!)).toEqual({
      displayMode: "standalone",
      cursors: expectedCursors,
    });
  });
});
