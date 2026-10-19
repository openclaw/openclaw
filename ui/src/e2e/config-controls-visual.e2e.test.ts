import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../../../src/infra/session-cost-usage-totals.ts";
import {
  takeControlUiElementScreenshot,
  waitForControlUiProofSurface,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  configSnapshot,
  objectSchema,
  configSchema,
  pageRunner,
  configProof,
  settingsPageOptions,
  createConfigSuite,
  computedStyles,
} from "./config-composer-fixtures.test-support.ts";

const suite = createConfigSuite("Control UI Settings controls mocked Gateway E2E");

const proof = configProof("settings-controls");

type NativeLinkWindow = Window & {
  openclawNativeLinkMessages?: unknown[];
  webkit?: { messageHandlers?: { openclawLink?: { postMessage: (message: unknown) => void } } };
};

function browserCase(method: string, requestPath: string, response: unknown) {
  return { match: { method, path: requestPath }, response };
}

async function addProofLink(page: Page, handled: boolean) {
  await page.evaluate((isHandled) => {
    const link = document.createElement("a");
    link.href = `https://example.com/${isHandled ? "application-handled" : "control-ui-proof"}`;
    link.textContent = isHandled ? "Application-handled link" : "Open proof link";
    link.dataset[isHandled ? "controlUiBrowserHandled" : "controlUiBrowserProof"] = "true";
    if (isHandled) {
      link.addEventListener("click", (event) => event.preventDefault());
    }
    Object.assign(link.style, {
      background: "white",
      left: "16px",
      padding: "8px",
      position: "fixed",
      top: "16px",
      zIndex: "99999",
    });
    document.body.append(link);
  }, handled);
}

async function resolvedBackground(page: Page, value: string): Promise<string> {
  return page.evaluate((background) => {
    const probe = document.createElement("div");
    probe.style.background = background;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return resolved;
  }, value);
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  return errors;
}

function browserConfigMocks() {
  const config = { browser: { enabled: true } };
  return {
    "config.get": configSnapshot(config, "hash-1"),
    "config.schema": configSchema(
      objectSchema("", {
        browser: objectSchema("Browser", {
          enabled: { type: "boolean", title: "Browser Enabled" },
        }),
      }),
    ),
  };
}

async function openBrowserSettings(page: Page, baseUrl: string) {
  const response = await page.goto(
    `${baseUrl}settings/infrastructure?section=browser&advanced=1#config-section-browser`,
  );
  expect(response?.status()).toBe(200);
  const section = page.locator("#config-section-browser");
  await section.waitFor();
  return section;
}

async function captureBrowserSettingProof(
  page: Page,
  section: ReturnType<Page["locator"]>,
  name: string,
) {
  if (!proof.enabled) {
    return;
  }
  const row = section.locator(".settings-row").first();
  for (const size of ["desktop", "narrow"]) {
    if (size === "narrow") {
      await page.setViewportSize({ height: 844, width: 390 });
      if (page.video()) {
        await waitForControlUiProofSurface(page.locator(".shell.shell--mobile-nav"), [row]);
      }
    }
    const file = path.join(proof.directory(), `${name}-${size}.png`);
    if (page.video()) {
      await writeFile(file, await takeControlUiElementScreenshot(page, section, [row]));
    } else {
      await section.screenshot({ animations: "disabled", path: file });
    }
  }
}

const withPage = pageRunner(suite, {
  ...settingsPageOptions,
  viewport: { height: 900, width: 1280 },
});

const capture = proof.capture;

suite.define(() => {
  it.each(["light", "dark"] as const)(
    "keeps selected Usage accents at rest and on hover in %s mode",
    async (colorScheme) => {
      await withPage(
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            methodResponses: {
              "sessions.usage": {
                updatedAt: Date.now(),
                startDate: "2026-09-01",
                endDate: "2026-09-07",
                sessions: [],
                totals: createEmptyCostUsageTotals(),
                aggregates: {
                  messages: {
                    total: 0,
                    user: 0,
                    assistant: 0,
                    toolCalls: 0,
                    toolResults: 0,
                    errors: 0,
                  },
                  tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
                  byModel: [],
                  byProvider: [],
                  byAgent: [],
                  byChannel: [],
                  daily: [],
                  costDaily: [],
                },
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}usage`);
          await gateway.waitForRequest("sessions.usage");
          await expect
            .poll(() => page.locator("html").getAttribute("data-theme-mode"))
            .toBe(colorScheme);
          const expected = await resolvedBackground(page, "var(--accent-subtle)");
          const filters = page.locator(".usage-view-options");
          for (const label of ["Cost", "Tokens"]) {
            const selected = filters.getByRole("button", { name: label, exact: true });
            await selected.click();
            await page.mouse.move(0, 0);
            for (const state of ["rest", "hover"]) {
              if (state === "hover") {
                await selected.hover();
              }
              await capture(filters, `usage-${colorScheme}-${label}-${state}.png`);
              await expect
                .poll(() =>
                  selected.evaluate((element) => getComputedStyle(element).backgroundColor),
                )
                .toBe(expected);
            }
          }
        },
        { colorScheme, viewport: { width: 1280, height: 900 }, serviceWorkers: undefined },
      );
    },
  );

  it("keeps selected segmented options distinct in forced colors", async () => {
    const cases = [
      {
        colorScheme: "dark" as const,
        config: { ui: { prefs: { themeMode: "dark" } } },
        featureMethods: undefined,
        route: "settings/appearance",
        selected: "Dark",
        unselected: "Light",
      },
      {
        colorScheme: "light" as const,
        config: { update: { auto: { enabled: true }, channel: "beta" } },
        featureMethods: ["config.get", "config.set", "config.apply", "update.run"],
        route: "settings/updates",
        selected: "Beta",
        unselected: "Stable",
      },
    ];

    for (const scenario of cases) {
      await withPage(
        async ({ page }) => {
          await installMockGateway(page, {
            featureMethods: scenario.featureMethods,
            methodResponses: {
              "config.get": {
                ...configSnapshot(scenario.config, `forced-colors-${scenario.route}`),
                runtimeConfig: scenario.config,
              },
            },
            operatorScopes: ["operator.read", "operator.admin"],
          });

          const response = await page.goto(`${suite.server.baseUrl}${scenario.route}`);
          expect(response?.status()).toBe(200);
          expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(
            true,
          );

          const selected = page.getByRole("radio", { name: scenario.selected, exact: true });
          const unselected = page.getByRole("radio", { name: scenario.unselected, exact: true });
          await selected.waitFor();
          expect(await selected.isChecked()).toBe(true);
          expect(await unselected.isChecked()).toBe(false);
          const selectedLabel = selected.locator("..");
          const unselectedLabel = unselected.locator("..");
          await capture(
            selected.locator(
              "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' settings-row ')][1]",
            ),
            `segmented-forced-colors-${scenario.colorScheme}.png`,
          );
          expect(
            await computedStyles(selectedLabel, [
              "text-decoration-line",
              "text-decoration-thickness",
            ]),
          ).toEqual({ "text-decoration-line": "underline", "text-decoration-thickness": "2px" });
          expect(await computedStyles(unselectedLabel, ["text-decoration-line"])).toEqual({
            "text-decoration-line": "none",
          });

          await selected.focus();
          expect(await selected.evaluate((element) => element.matches(":focus-visible"))).toBe(
            true,
          );
          expect(
            await computedStyles(selectedLabel, [
              "outline-offset",
              "outline-style",
              "outline-width",
              "text-decoration-line",
            ]),
          ).toEqual({
            "outline-offset": "2px",
            "outline-style": "solid",
            "outline-width": "2px",
            "text-decoration-line": "underline",
          });
        },
        { colorScheme: scenario.colorScheme, forcedColors: "active" },
      );
    }
  });

  it("keeps checked switches on the scene accent on the security page", async () => {
    await withPage(async ({ page }) => {
      const config = { browser: { enabled: true } };
      await installMockGateway(page, {
        methodResponses: {
          "config.get": configSnapshot(config, "hash-1"),
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/security`);
      expect(response?.status()).toBe(200);

      const overview = page.locator(".security-page");
      const browserSwitchRole = overview.getByRole("switch", {
        name: "Browser enabled",
        exact: true,
      });
      await browserSwitchRole.waitFor();
      expect(await browserSwitchRole.isChecked()).toBe(true);
      const browserSwitchControl = browserSwitchRole.locator("+ .settings-toggle__control");
      expect(
        await browserSwitchControl.evaluate((element) => getComputedStyle(element).backgroundColor),
      ).toBe(await resolvedBackground(page, "var(--accent)"));

      await capture(page.locator(".content-header"), "01-settings-view.png");
      await capture(overview.locator(".settings-section").first(), "02-security-controls.png");

      await browserSwitchRole.click();
      await expect.poll(() => browserSwitchRole.isChecked()).toBe(false);
    });
  });

  it("hides the link-routing preference when the Control UI browser is unavailable", async () => {
    await withPage(
      async ({ page }) => {
        await installMockGateway(page, { methodResponses: browserConfigMocks() });

        const section = await openBrowserSettings(page, suite.server.baseUrl);
        await expect
          .poll(() =>
            section
              .getByRole("switch", { name: "Open links in Control UI browser", exact: true })
              .count(),
          )
          .toBe(0);
        await captureBrowserSettingProof(page, section, "browser-before");
      },
      { viewport: { height: 1000, width: 1180 } },
    );
  });

  for (const host of ["browser", "app"] as const) {
    it(`routes links to the Control UI browser in a ${host}-hosted UI`, async () => {
      await withPage(
        async ({ page }) => {
          const pageErrors = collectPageErrors(page);
          if (host === "app") {
            await page.context().addInitScript(() => {
              const messages: unknown[] = [];
              const appWindow = window as NativeLinkWindow;
              appWindow.openclawNativeLinkMessages = messages;
              appWindow.webkit = {
                messageHandlers: {
                  openclawLink: { postMessage: (message: unknown) => messages.push(message) },
                },
              };
            });
          }
          const tab = {
            tabId: "tab-1",
            targetId: "target-1",
            title: "Example",
            url: "https://example.com/control-ui-proof",
          };
          const gateway = await installMockGateway(page, {
            featureMethods: [
              "browser.request",
              "chat.metadata",
              "chat.startup",
              "config.apply",
              "config.patch",
              "config.schema",
              "config.set",
            ],
            methodResponses: {
              ...browserConfigMocks(),
              "browser.request": {
                cases: [
                  browserCase("POST", "/tabs/open", tab),
                  browserCase("GET", "/tabs", { running: true, tabs: [tab] }),
                  browserCase("POST", "/screenshot", {
                    path: "/proof.png",
                    targetId: tab.targetId,
                    url: tab.url,
                  }),
                  browserCase("POST", "/act", {
                    result: { cssHeight: 720, cssWidth: 1280, title: tab.title, url: tab.url },
                  }),
                ],
              },
            },
          });
          await page.route("**/__openclaw__/assistant-media?**", async (route) => {
            await route.fulfill({
              body: Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                "base64",
              ),
              contentType: "image/png",
              status: 200,
            });
          });

          const section = await openBrowserSettings(page, suite.server.baseUrl);
          const preference = section.getByRole("switch", {
            name: "Open links in Control UI browser",
            exact: true,
          });
          await preference.waitFor();
          expect(await preference.isChecked()).toBe(false);
          await preference.click();
          await expect.poll(() => preference.isChecked()).toBe(true);
          await page.reload();
          await preference.waitFor();
          expect(await preference.isChecked()).toBe(true);

          if (host === "browser") {
            await captureBrowserSettingProof(
              page,
              page.locator("#config-section-browser"),
              "browser-after",
            );
          }

          await page.goto(`${suite.server.baseUrl}chat`);
          await addProofLink(page, true);
          await page.locator("[data-control-ui-browser-handled]").click();
          expect(await gateway.getRequests("browser.request")).toEqual([]);
          if (host === "app") {
            expect(
              await page.evaluate(() => (window as NativeLinkWindow).openclawNativeLinkMessages),
            ).toEqual([]);
          }
          await page.locator("[data-control-ui-browser-handled]").evaluate((link) => link.remove());
          await addProofLink(page, false);
          await page.locator("[data-control-ui-browser-proof]").click();
          await expect
            .poll(async () =>
              (await gateway.getRequests("browser.request")).map((request) => request.params),
            )
            .toContainEqual({
              body: { url: "https://example.com/control-ui-proof" },
              method: "POST",
              path: "/tabs/open",
              tabScope: { sessionKey: "agent:main:main" },
            });
          const browserPanel = page.locator("openclaw-browser-panel[embedded]");
          await browserPanel.waitFor();
          expect(
            await browserPanel.evaluate(
              (panel) => (panel as HTMLElement & { available?: boolean }).available,
            ),
          ).toBe(true);
          await page
            .locator('[data-region-header="side"] .tabstrip-tab__label')
            .getByText("Example", { exact: true })
            .waitFor();
          await expect
            .poll(() =>
              browserPanel
                .locator('openclaw-panel-loading-skeleton[data-panel-skeleton="browser"]')
                .count(),
            )
            .toBe(0);
          expect(await browserPanel.textContent()).not.toContain("Browser request failed");

          if (host === "app") {
            expect(
              await page.evaluate(() => (window as NativeLinkWindow).openclawNativeLinkMessages),
            ).toEqual([]);
          }
          expect(pageErrors).toEqual([]);
        },
        {
          recordVideo: proof.enabled
            ? { dir: proof.directory(), size: { height: 900, width: 1180 } }
            : undefined,
          viewport: { height: 1000, width: 1180 },
        },
      );
    });
  }
});
