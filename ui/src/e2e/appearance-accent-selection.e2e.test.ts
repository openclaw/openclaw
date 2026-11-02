import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { polledAttribute, polledCount, polledText } from "./chat-presentation.test-support.ts";
import {
  configProof,
  configSnapshot,
  settingsPageOptions,
} from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI accent selection",
});
const { capture } = configProof("appearance-accent-selection");

suite.define(() => {
  it("keeps the theme default first and reveals its reset icon only for overrides", async () => {
    await suite.withPage(settingsPageOptions, async ({ page }) => {
      const config = { ui: { prefs: { locale: "en" } } };
      const gateway = await installMockGateway(page, {
        presenceUsers: [{ id: "appearance-user", name: "Appearance User", self: true }],
        methodResponses: {
          "config.get": configSnapshot(config, "appearance-accent", true),
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
      const expectSelection = async (preset: "coral" | "default", resets: number) => {
        await polledAttribute(defaultSwatch, "aria-pressed").toBe(String(preset === "default"));
        await polledAttribute(coralSwatch, "aria-pressed").toBe(String(preset === "coral"));
        await polledCount(defaultSwatch.locator(".settings-accent-swatch__reset")).toBe(resets);
      };
      const storedSettings = () =>
        page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
          controlUiBundledSettingsStorageKey(suite.server.baseUrl),
        );
      const selectAccent = async (preset: "coral" | "default", accent: string | null) => {
        const after = await gateway.deferNext("users.prefs.set");
        await accentSection.locator(`[data-accent-preset="${preset}"]`).click();
        const request = await gateway.waitForRequest("users.prefs.set", { after });
        expect(request.params).toEqual({ entries: { "ui.accent": accent } });
        // Profile reads must observe the commit before its successful reply.
        await gateway.setMethodResponse("users.prefs.get", {
          status: "ok",
          entries: accent === null ? {} : { "ui.accent": accent },
        });
        await gateway.resolveDeferred("users.prefs.set");
      };
      await accentSection.scrollIntoViewIfNeeded();
      expect(await swatches.first().getAttribute("data-accent-preset")).toBe("default");
      await expectSelection("default", 0);
      await capture(page, "theme-default-selected.png");

      await selectAccent("coral", "#ff8066");

      await expectSelection("coral", 1);
      await expect
        .poll(() =>
          page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
          ),
        )
        .toBe("#ff8066");
      await polledText(accentSection.locator("#settings-accent-status")).toContain("Using Coral");
      await expect.poll(storedSettings).toMatchObject({ accent: "#ff8066" });
      await capture(page, "coral-selected-with-reset.png");

      await selectAccent("default", null);
      await expectSelection("default", 0);
      await expect.poll(storedSettings).not.toHaveProperty("accent");
    });
  });
});
