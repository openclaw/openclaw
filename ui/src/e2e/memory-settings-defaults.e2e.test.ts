import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import { createSettingsPageOptions } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Memory defaults mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const memoryPlugins = ["memory-core", "memory-lancedb"].map((id) => ({
  id,
  name: id === "memory-core" ? id : "Memory LanceDB",
  installed: true,
  enabled: true,
  state: "enabled",
  kind: ["memory"],
}));

function objectSchema<T>(properties: T) {
  return { type: "object", properties };
}

function installMemoryGateway(page: Page, config: Record<string, unknown>, configSchema?: unknown) {
  const hash = configSchema ? "memory-search-e2e" : "memory-defaults-e2e";
  return installMockGateway(page, {
    methodResponses: {
      "config.get": {
        config,
        hash,
        ...(configSchema ? {} : { appliedConfigHash: hash }),
        raw: JSON.stringify(config),
        valid: true,
        issues: [],
      },
      ...(configSchema ? { "config.schema": configSchema } : {}),
      "plugins.list": { plugins: memoryPlugins, diagnostics: [], mutationAllowed: true },
    },
  });
}

function withMemoryPage(run: (page: Page) => Promise<void>) {
  return suite.withPage(createSettingsPageOptions(), ({ page }) => run(page));
}

async function expectQuery(advanced: Locator, section: Locator) {
  await expect
    .poll(() => advanced.evaluate((element) => (element as HTMLDetailsElement).open))
    .toBe(true);
  await section.locator("summary").filter({ hasText: "Query" }).click();
  expect(await section.getByRole("spinbutton").inputValue()).toBe("6");
}

async function expectCollapsed(advanced: Locator) {
  await advanced.waitFor();
  expect(await advanced.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
}

function requestRaw(request: MockGatewayRequest): Record<string, unknown> {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected config.set params");
  }
  return JSON.parse(String((params as Record<string, unknown>).raw)) as Record<string, unknown>;
}

function settingsRow(page: Page, title: string): Locator {
  return page.locator(".settings-row").filter({
    has: page.locator(".settings-row__title").getByText(title, { exact: true }),
  });
}

suite.define(() => {
  it("reveals advanced Memory search matches across navigation, reload, and legacy links", () =>
    withMemoryPage(async (page) => {
      const config = { memory: { search: { enabled: true, query: { maxResults: 6 } } } };
      await installMemoryGateway(page, config, {
        schema: objectSchema({
          memory: objectSchema({
            search: objectSchema({
              enabled: { type: "boolean", title: "Enable Memory Search" },
              query: objectSchema({
                maxResults: { type: "integer", title: "Memory Search Max Results" },
              }),
            }),
          }),
        }),
        uiHints: {
          "memory.search.enabled": { advanced: false },
          "memory.search.query.maxResults": { advanced: true },
        },
        version: "memory-search-e2e",
      });
      await page.goto(`${suite.server.baseUrl}settings/memory/settings`);
      const section = page.locator("#config-section-memory");
      const advanced = section.locator("details.config-advanced-disclosure");
      await expectCollapsed(advanced);

      await page
        .getByRole("searchbox", { name: "Search settings", exact: true })
        .fill("max results");
      await page.locator(".settings-sidebar__subitem").filter({ hasText: "Memory" }).click();
      await expect.poll(() => new URL(page.url()).hash).toBe("#config-section-memory");
      await section.waitFor();
      await expectQuery(advanced, section);
      expect(new URL(page.url()).pathname).toBe("/settings/memory/settings");

      await page.reload();
      await expectQuery(advanced, section);

      await page.goto(
        `${suite.server.baseUrl}settings/memory?section=memory&advanced=1#config-section-memory`,
      );
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/memory/settings");
      await expectQuery(advanced, section);

      await page.goto(`${suite.server.baseUrl}settings/memory/settings`);
      await expectCollapsed(advanced);
    }));

  it("persists a cleared dreaming frequency and preserves the explicit engine across reload", () =>
    withMemoryPage(async (page) => {
      const dreaming = { frequency: "0 6 * * *", verboseLogging: true };
      const config = {
        agents: { defaults: { userTimezone: "Asia/Singapore" } },
        plugins: {
          slots: { memory: "memory-core" },
          entries: { "memory-core": { config: { dreaming } } },
        },
      };
      const gateway = await installMemoryGateway(page, config);

      const response = await page.goto(`${suite.server.baseUrl}settings/memory/settings`);
      expect(response?.status()).toBe(200);

      const engineRow = settingsRow(page, "Memory engine");
      const frequencyRow = settingsRow(page, "Dreaming frequency");
      await expect.poll(() => engineRow.textContent()).toContain("Default: OpenClaw Memory");
      await expect.poll(() => frequencyRow.textContent()).toContain("Default: 0 3 * * *");
      await expect.poll(() => frequencyRow.getByRole("textbox").inputValue()).toBe("0 6 * * *");

      await frequencyRow.getByRole("textbox").fill("");
      await frequencyRow.getByRole("textbox").blur();

      const saved = requestRaw(await gateway.waitForRequest("config.set"));
      expect(saved).toMatchObject({
        plugins: {
          slots: { memory: "memory-core" },
          entries: { "memory-core": { config: { dreaming: { verboseLogging: true } } } },
        },
      });
      expect(saved).not.toHaveProperty("plugins.entries.memory-core.config.dreaming.frequency");
      await expect
        .poll(() => page.locator("openclaw-settings-save-indicator").textContent())
        .toContain("Apply changes");

      await page.reload();
      await expect.poll(() => engineRow.textContent()).toContain("Default: OpenClaw Memory");
      await expect.poll(() => frequencyRow.textContent()).not.toContain("Using default:");
      await expect.poll(() => frequencyRow.getByRole("textbox").inputValue()).toBe("");
      await expect
        .poll(() => frequencyRow.getByRole("textbox").getAttribute("placeholder"))
        .toBe("0 3 * * *");
    }));
});
