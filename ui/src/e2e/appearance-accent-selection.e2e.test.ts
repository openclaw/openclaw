import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI accent selection",
});

suite.define(() => {
  it("keeps the theme default first and reveals its reset icon only for overrides", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const config = { ui: { prefs: { locale: "en" } } };
        await installMockGateway(page, {
          presenceUsers: [{ id: "appearance-user", name: "Appearance User", self: true }],
          methodResponses: {
            "config.get": {
              appliedConfigHash: "appearance-accent",
              config,
              configRevisionHash: "appearance-accent",
              hash: "appearance-accent",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
            "users.prefs.get": { status: "ok", entries: {} },
            "users.prefs.set": { status: "ok" },
          },
        });
        const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
        expect(response?.status()).toBe(200);
        await waitForControlUiSettingsTakeover(page);

        const accentSection = page.locator("#settings-appearance-accent");
        const swatches = accentSection.locator(".settings-accent-swatch");
        const defaultSwatch = accentSection.locator('[data-accent-preset="default"]');
        const coralSwatch = accentSection.locator('[data-accent-preset="coral"]');
        await accentSection.scrollIntoViewIfNeeded();
        expect(await swatches.first().getAttribute("data-accent-preset")).toBe("default");
        await expect.poll(() => defaultSwatch.getAttribute("aria-pressed")).toBe("true");
        await expect
          .poll(() => defaultSwatch.locator(".settings-accent-swatch__reset").count())
          .toBe(0);

        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const artifactDir = createControlUiE2eArtifactDir("appearance-accent-selection");
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, "theme-default-selected.png"),
          });
        }

        await coralSwatch.click();

        await expect.poll(() => coralSwatch.getAttribute("aria-pressed")).toBe("true");
        await expect.poll(() => defaultSwatch.getAttribute("aria-pressed")).toBe("false");
        await expect
          .poll(() => defaultSwatch.locator(".settings-accent-swatch__reset").count())
          .toBe(1);
        await expect
          .poll(() =>
            page.evaluate(() =>
              getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
            ),
          )
          .toBe("#ff8066");
        await expect
          .poll(() => accentSection.locator("#settings-accent-status").textContent())
          .toContain("Using Coral");
        const settingsStorageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
        await expect
          .poll(() =>
            page.evaluate(
              (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
              settingsStorageKey,
            ),
          )
          .toMatchObject({ accent: "#ff8066" });

        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const artifactDir = createControlUiE2eArtifactDir("appearance-accent-override");
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, "coral-selected-with-reset.png"),
          });
        }

        await defaultSwatch.click();
        await expect.poll(() => defaultSwatch.getAttribute("aria-pressed")).toBe("true");
        await expect
          .poll(() => defaultSwatch.locator(".settings-accent-swatch__reset").count())
          .toBe(0);
        await expect.poll(() => coralSwatch.getAttribute("aria-pressed")).toBe("false");
        await expect
          .poll(() =>
            page.evaluate(
              (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
              settingsStorageKey,
            ),
          )
          .not.toHaveProperty("accent");
      },
    );
  });
});
