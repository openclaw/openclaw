// @vitest-environment node
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withBrowserPage } from "../../test-helpers/browser-page.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const names = [
  "maintain-verification-evidence-for-long-running-release-workflows",
  "validate-and-publish-accessibility-regression-evidence-for-mobile-clients",
  `skill${"x".repeat(90)}`,
];

describe("Skills menu touch readability", () => {
  let browser: Browser;
  let server: ControlUiE2eServer;

  beforeAll(async () => {
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each([390, 1280])(
    "keeps full names readable before tapping at %ipx without relying on hover",
    async (width) => {
      await withBrowserPage(
        browser.newPage({ hasTouch: true, viewport: { width, height: 844 }, colorScheme: "dark" }),
        async (page) => {
          const url = new URL("skills-menu-touch-fixture", server.baseUrl).href;
          await page.route(url, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: '<!doctype html><html data-theme-mode="dark"><body><div id="fixture" class="agent-chat__input" style="position:fixed;bottom:20px;left:16px;width:calc(100% - 32px);max-width:760px"></div></body></html>',
            }),
          );
          await page.goto(url);
          const litUrl = new URL(
            `/@fs${new URL(import.meta.resolve("lit")).pathname}`,
            server.baseUrl,
          ).href;
          const themeUrl = new URL(
            `/@fs${new URL(import.meta.resolve("@awesome.me/webawesome/dist/styles/themes/default.css")).pathname}`,
            server.baseUrl,
          ).href;
          await page.addScriptTag({
            type: "module",
            content: `
              import ${JSON.stringify(themeUrl)};
              import { render } from ${JSON.stringify(litUrl)};
              import { renderChatComposerPlusMenu } from '/src/pages/chat/components/chat-composer-plus-menu.ts';
              import { installTitleTooltips } from '/src/components/tooltip-title.ts';
              import '/src/styles/base.css';
              import '/src/styles/chat/composer.css';
              import '/src/styles/chat/composer-surface.css';
              const host = document.querySelector('#fixture');
              const names = ${JSON.stringify(names)};
              let open = false;
              let view = 'root';
              let overrides = null;
              let patches = 0;
              installTitleTooltips(document);
              function draw() {
                render(renderChatComposerPlusMenu({
                  attachments: {}, disabled: false, open, view, toolOverrides: overrides,
                  onOpenChange: (value) => { open = value; draw(); },
                  onViewChange: (value) => { view = value; draw(); },
                  capabilityMenu: {
                    basePath: '', skillsLoading: false, skillsError: false,
                    skills: names.map((name, index) => ({
                      key: 'skill-' + index, name, baseEnabled: index !== 1,
                      enabled: index !== 1 && overrides?.skills?.['skill-' + index] !== false,
                      missingDeps: index === 1,
                    })),
                    mcpServers: [], toolsEffectiveResult: null, toolsEffectiveLoading: false,
                    toolsEffectiveError: false, toolAccessMutationBlockedReason: null,
                    webSearchBaseEnabled: true, mutationBlockedReason: null, canAdmin: true,
                    adminBlockedReason: null, onLoadSkills: () => {}, onNavigate: () => {},
                    onPatchToolOverrides: (next) => {
                      overrides = next; host.dataset.patches = String(++patches); draw();
                    },
                  },
                }), host);
              }
              draw();
              document.documentElement.dataset.fixtureReady = 'true';
            `,
          });
          await page.waitForFunction(
            () => document.documentElement.dataset.fixtureReady === "true",
          );
          expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
          await page.getByRole("button", { name: "Add attachment" }).tap();
          const menu = page.locator(".agent-chat__capability-menu");
          await menu.getByRole("menuitem", { name: "Skills", exact: true }).tap();
          await expectBrowser(menu).toHaveAttribute("data-view", "skills");
          await page.evaluate(() => document.fonts.ready);

          const artifactParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
          if (artifactParent) {
            const dir = createControlUiE2eArtifactDir(`skills-menu-touch-${width}`, artifactParent);
            await page.screenshot({ path: path.join(dir, "menu.png"), animations: "disabled" });
          }

          const rows = menu.locator('[value^="skill:"]');
          for (const row of await rows.all()) {
            await row.scrollIntoViewIfNeeded();
            const layout = await row.evaluate((element) => {
              const name = element.querySelector<HTMLElement>(
                ".agent-chat__capability-menu-label > span",
              )!;
              const text = name.getBoundingClientRect();
              const bounds = element.getBoundingClientRect();
              const control = element.querySelector("wa-switch")!.getBoundingClientRect();
              return {
                height: text.height,
                lineHeight: Number.parseFloat(getComputedStyle(name).lineHeight),
                clientWidth: name.clientWidth,
                scrollWidth: name.scrollWidth,
                insideRow: text.top >= bounds.top && text.bottom <= bounds.bottom,
                beforeSwitch: text.right <= control.left,
              };
            });
            expect(layout.height).toBeGreaterThan(layout.lineHeight * 1.5);
            expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
            expect(layout.insideRow).toBe(true);
            expect(layout.beforeSwitch).toBe(true);
          }
          const disabled = rows.nth(1);
          await expectBrowser(disabled).toHaveAttribute("aria-disabled", "true");
          await expectBrowser(disabled).toContainText("deps missing");
          await rows.first().tap();
          await expectBrowser(rows.first()).toHaveAttribute("aria-checked", "false");
          await expectBrowser(page.locator("#fixture")).toHaveAttribute("data-patches", "1");
          await expectBrowser(menu).toHaveAttribute("data-view", "skills");
        },
      );
    },
  );
});
