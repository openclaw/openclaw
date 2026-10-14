// Control UI tests cover Memory default provenance and clearing optional overrides.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Memory defaults mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let uiProofArtifactDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    uiProofArtifactDir = createControlUiE2eArtifactDir("memory-settings-defaults");
  }
});

const memoryPlugins = [
  {
    id: "memory-core",
    name: "memory-core",
    installed: true,
    enabled: true,
    state: "enabled",
    kind: ["memory"],
  },
  {
    id: "memory-lancedb",
    name: "Memory LanceDB",
    installed: true,
    enabled: true,
    state: "enabled",
    kind: ["memory"],
  },
];

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

function scheduleSection(page: Page): Locator {
  return page.locator(".settings-section").filter({
    has: page.locator(".settings-section__heading").getByText("Schedule", { exact: true }),
  });
}

async function captureProof(page: Page, name: string, locator?: Locator) {
  if (!captureUiProofEnabled) {
    return;
  }
  await locator?.scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: "disabled",
    path: path.join(uiProofArtifactDir, name),
  });
}

suite.define(() => {
  it("reveals advanced Memory search matches across navigation, reload, and legacy links", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const config = { memory: { search: { enabled: true, query: { maxResults: 6 } } } };
        await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              config,
              hash: "memory-search-e2e",
              raw: JSON.stringify(config),
              valid: true,
              issues: [],
            },
            "config.schema": {
              schema: {
                type: "object",
                properties: {
                  memory: {
                    type: "object",
                    properties: {
                      search: {
                        type: "object",
                        properties: {
                          enabled: { type: "boolean", title: "Enable Memory Search" },
                          query: {
                            type: "object",
                            properties: {
                              maxResults: { type: "integer", title: "Memory Search Max Results" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
              uiHints: {
                "memory.search.enabled": { advanced: false },
                "memory.search.query.maxResults": { advanced: true },
              },
              version: "memory-search-e2e",
            },
            "plugins.list": { plugins: memoryPlugins, diagnostics: [], mutationAllowed: true },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/memory/settings`);
        const section = page.locator("#config-section-memory");
        const advanced = section.locator("details.config-advanced-disclosure");
        await advanced.waitFor();
        expect(await advanced.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(
          false,
        );

        await page
          .getByRole("searchbox", { name: "Search settings", exact: true })
          .fill("max results");
        await page.locator(".settings-sidebar__subitem").filter({ hasText: "Memory" }).click();
        await expect.poll(() => new URL(page.url()).hash).toBe("#config-section-memory");
        await section.waitFor();
        if (captureUiProofEnabled) {
          const frame = await takeControlUiScreenshotFrame(page, section, [advanced], {
            animations: "disabled",
            scrollTo: section,
          });
          await writeFile(
            path.join(uiProofArtifactDir, "memory-search-destination.png"),
            frame.png,
          );
        }
        await expect
          .poll(() => advanced.evaluate((element) => (element as HTMLDetailsElement).open))
          .toBe(true);
        await section.locator("summary").filter({ hasText: "Query" }).click();
        expect(await section.getByRole("spinbutton").inputValue()).toBe("6");
        expect(new URL(page.url()).pathname).toBe("/settings/memory/settings");

        await page.reload();
        await expect
          .poll(() => advanced.evaluate((element) => (element as HTMLDetailsElement).open))
          .toBe(true);
        await section.locator("summary").filter({ hasText: "Query" }).click();
        expect(await section.getByRole("spinbutton").inputValue()).toBe("6");

        await page.goto(
          `${suite.server.baseUrl}settings/memory?section=memory&advanced=1#config-section-memory`,
        );
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/memory/settings");
        await expect
          .poll(() => advanced.evaluate((element) => (element as HTMLDetailsElement).open))
          .toBe(true);
        await section.locator("summary").filter({ hasText: "Query" }).click();
        expect(await section.getByRole("spinbutton").inputValue()).toBe("6");

        await page.goto(`${suite.server.baseUrl}settings/memory/settings`);
        await advanced.waitFor();
        expect(await advanced.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(
          false,
        );
      },
    );
  });

  it("persists a cleared dreaming frequency and preserves the explicit engine across reload", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const config = {
          agents: { defaults: { userTimezone: "Asia/Singapore" } },
          plugins: {
            slots: { memory: "memory-core" },
            entries: {
              "memory-core": {
                config: {
                  dreaming: {
                    frequency: "0 6 * * *",
                    verboseLogging: true,
                  },
                },
              },
            },
          },
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              config,
              hash: "memory-defaults-e2e",
              appliedConfigHash: "memory-defaults-e2e",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
            "plugins.list": {
              plugins: memoryPlugins,
              diagnostics: [],
              mutationAllowed: true,
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/memory/settings`);
        expect(response?.status()).toBe(200);

        const engineRow = settingsRow(page, "Memory engine");
        const frequencyRow = settingsRow(page, "Dreaming frequency");
        await expect.poll(() => engineRow.textContent()).toContain("Default: OpenClaw Memory");
        await expect.poll(() => frequencyRow.textContent()).toContain("Default: 0 3 * * *");
        await expect.poll(() => frequencyRow.getByRole("textbox").inputValue()).toBe("0 6 * * *");

        await captureProof(page, "01-explicit-engine.png");
        await captureProof(page, "02-explicit-dreaming.png", scheduleSection(page));

        await frequencyRow.getByRole("textbox").fill("");
        await frequencyRow.getByRole("textbox").blur();

        const saved = requestRaw(await gateway.waitForRequest("config.set"));
        expect(saved).toHaveProperty("plugins.slots.memory", "memory-core");
        expect(saved).not.toHaveProperty("plugins.entries.memory-core.config.dreaming.frequency");
        expect(saved).toHaveProperty(
          "plugins.entries.memory-core.config.dreaming.verboseLogging",
          true,
        );
        await expect
          .poll(() => page.locator("openclaw-settings-save-indicator").textContent())
          .toContain("Saved");

        await page.reload();
        const reloadedEngineRow = settingsRow(page, "Memory engine");
        const reloadedFrequencyRow = settingsRow(page, "Dreaming frequency");
        await expect
          .poll(() => reloadedEngineRow.textContent())
          .toContain("Default: OpenClaw Memory");
        await expect.poll(() => reloadedFrequencyRow.textContent()).not.toContain("Using default:");
        await expect.poll(() => reloadedFrequencyRow.getByRole("textbox").inputValue()).toBe("");
        await expect
          .poll(() => reloadedFrequencyRow.getByRole("textbox").getAttribute("placeholder"))
          .toBe("0 3 * * *");
        await captureProof(page, "03-preserved-engine.png");
        await captureProof(page, "04-inherited-dreaming.png", scheduleSection(page));
      },
    );
  });
});
