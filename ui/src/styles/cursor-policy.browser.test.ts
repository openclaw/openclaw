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
// Expectations live beside the fixture, not in a second selector inventory.
const samples = (cursor: string | null, decoration: string | null, ...html: string[]) =>
  html
    .map((markup) =>
      markup.replace(
        /^(<\w+)/,
        `$1${cursor ? ` data-cursor="${cursor}"` : ""}${decoration ? ` data-decoration="${decoration}"` : ""}`,
      ),
    )
    .join("");
const classLinks = (cursor: string, decoration: string | null, classes: string) =>
  samples(
    cursor,
    decoration,
    ...classes.split(" ").map((name) => `<a class="${name}" href="/fixture">Link</a>`),
  );

function fixtureDocument() {
  const css = readStyles(
    ...`base components layout sidebar-update-card sidebar-issues
    sidebar-markdown sessions settings-controls settings agents skill-workshop rail-header
    chat/startup-layout chat/layout chat/message-layout chat/composer-surface chat/composer
    chat/split-view chat/text`
      .split(/\s+/)
      .map((name) => `styles/${name}`),
  );
  return `<!doctype html><html data-theme-mode="light"><head><style>${postcss([controlUiHoverGuardPlugin()]).process(css, { from: undefined }).css}</style></head><body>
    ${samples(
      "default",
      null,
      '<button class="btn">Primary</button>',
      "<select><option>option</option></select>",
      '<input type="checkbox">',
      '<div role="button" tabindex="0">Role button</div>',
      '<button class="settings-secret__toggle">Reveal</button>',
      '<div class="chat-assistant-attachment-card" data-openable>Attachment</div>',
      '<span class="agent-tools-runtime-chip--more">+3</span>',
    )}
    <details>${samples("default", null, "<summary>Details</summary>")}<p>body</p></details>
    ${samples("text", null, '<input type="text" value="text">', '<button class="chat-pane__session-title-button">Session title</button>')}
    ${samples("zoom-in", null, '<button class="chat-message-image-button">Image</button>')}
    ${samples("not-allowed", null, '<button class="btn btn--ghost" disabled>Ghost disabled</button>', '<button class="btn btn--ghost" data-new-tab-action disabled>Unavailable new tab</button>')}
    ${samples("wait", null, '<button class="sidebar-update-card__hold" disabled>Hold</button>')}
    ${samples("pointer", "underline", '<a href="https://example.com">Real link</a>')}
    ${samples(
      null,
      "none",
      '<a class="btn primary" href="/new">Primary action</a>',
      '<a class="btn btn--ghost" href="/new">Secondary action</a>',
      '<a role="button" href="/new">Action</a>',
      '<a id="person-link" class="person-activity-link" href="/activity">Person</a>',
      '<a id="participant-link" class="session-menu__item learn-more-link session-hovercard__participant-link person-activity-link" href="/activity">Participant</a>',
    )}
    <div class="callout">${samples(null, "underline", '<a href="https://example.com/docs">Documentation</a>')}</div>
    <div class="chat-text">
      ${samples(null, "underline", '<a href="https://example.com">Chat link</a>')}
      ${samples(null, "none", '<a class="btn" href="/new">Chat action</a>')}
      ${samples("pointer", "none", '<a class="markdown-file-link">src/index.ts</a>', '<a class="markdown-github-link markdown-github-item" data-github-kind="pull" href="https://github.com/openclaw/openclaw/pull/3434" target="_blank">#3434</a>')}
    </div>
    <div class="sidebar-markdown">${samples(null, "underline", '<a href="https://example.com">Sidebar link</a>')}</div>
    ${["markdown", "chat-thinking", "markdown-body", "dreams-diary__para"].map((name) => `<div class="${name}">${samples(null, "underline", '<a class="markdown-bare-url" href="https://example.com">Content link</a>')}</div>`).join("")}
    <div class="chat-position-rail__preview-copy" inert>${samples(null, "none", '<a class="markdown-bare-url" href="https://example.com">Preview URL</a>', '<a class="markdown-github-link" href="https://github.com/example/project">Preview repository</a>')}</div>
    ${classLinks("pointer", "underline", "activity-entry__run-link settings-row__value memory-page__link portals-preview__notice-url settings-account transcripts-back")}
    <aside class="sidebar">
      ${samples(
        "default",
        null,
        '<a class="nav-item" href="/chat"><span data-cursor="default" class="nav-item__text">Home</span></a>',
        '<a class="sidebar-recent-session__link" href="/chat/test"><span data-cursor="default" class="sidebar-recent-session__name">Session</span></a>',
      )}
      ${samples("default", "none", '<a class="sidebar-online__person" href="/activity"><span data-decoration="none" class="sidebar-online__person-name">Person</span></a>', '<button class="sidebar-online__person"><span data-decoration="none" class="sidebar-online__person-name">Viewer</span></button>')}
      ${classLinks("default", null, "sidebar-new-session sidebar-session-catalog-new sidebar-issues-panel__navigation-link sidebar-approval-row__open-session")}
      ${samples("pointer", null, '<a href="https://example.com">External link</a>', '<a class="nav-item" href="/chat" target="_BLANK">New tab</a>', '<a class="nav-item" href="/chat" data-new-tab-action>New window</a>')}
    </aside>
    <aside class="settings-sidebar">${classLinks("default", null, "settings-sidebar__item settings-sidebar__subitem sidebar-footer-build")}</aside>
    <div class="sidebar-agent-menu"><div class="sidebar-customize-menu__item">${samples("pointer", null, '<a href="https://example.com/docs" target="_blank">Docs</a>')}</div></div>
    ${samples("pointer", "none", '<a id="new-tab-link" class="btn" href="https://example.com/docs" target="_blank">Docs</a>')}
    ${samples("pointer", null, '<button id="new-tab-button" class="btn" data-new-tab-action>New tab</button>')}
    <div id="shadow-policy-host"><template shadowrootmode="open"><style>${readStyleSheet("ui/src/components/dock-panel.css")}</style>
      ${samples("pointer", null, '<button class="rail-header__action" data-new-tab-action>New tab</button>')}
      ${samples("default", null, '<button class="rail-header__action" data-new-tab-action disabled>Unavailable new tab</button>')}
    </template></div></body></html>`;
}

async function expectCursors(page: Page, displayMode: string) {
  const observed = await page.evaluate(() => {
    const roots = [document, document.querySelector("#shadow-policy-host")!.shadowRoot!];
    const cursors = roots.flatMap((root) =>
      Array.from(root.querySelectorAll<HTMLElement>("[data-cursor]"), (element) => [
        element.dataset.cursor,
        getComputedStyle(element).cursor,
      ]),
    );
    const modes = ["browser", "standalone", "minimal-ui", "window-controls-overlay", "fullscreen"];
    return {
      cursors,
      displayMode: modes.find((mode) => matchMedia(`(display-mode: ${mode})`).matches) ?? "unknown",
    };
  });
  expect(observed.displayMode).toBe(displayMode);
  expect(observed.cursors.length).toBeGreaterThan(0);
  for (const [expected, actual] of observed.cursors) {
    expect(actual).toBe(expected);
  }
}
const style = (
  locator: Locator,
  property: "color" | "textDecorationLine" | "textDecorationThickness",
) => locator.evaluate((element, key) => getComputedStyle(element)[key], property);

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
      for (const element of await page.locator("[data-decoration]").all()) {
        expect(await style(element, "textDecorationLine")).toBe(
          await element.getAttribute("data-decoration"),
        );
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
          await page.evaluate(() =>
            document.documentElement.classList.add(
              "openclaw-native-macos",
              "openclaw-native-web-chrome",
            ),
          );
        }
        await expectCursors(page, "browser");
      });
    },
  );
  it("uses the same semantic cursors in an installed window", async () => {
    const [page] = appContext.pages();
    expect(page, "Chromium --app window did not expose a page").toBeDefined();
    await page!.waitForLoadState("load");
    await expectCursors(page!, "standalone");
  });
});
