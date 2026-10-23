import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
import { applyAppearanceTheme } from "./appearance-prefs.test-support.ts";
import { configSnapshot } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI theme selection defaults" });

suite.define(() => {
  it("preserves design overrides through explicit preview, apply, and profile reads", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        reducedMotion: "reduce",
        viewport: { width: 1440, height: 1000 },
      },
      async ({ page }) => {
        const profileId = "theme-defaults-user";
        const config = {
          ui: {
            prefs: { theme: "claw", accent: "#abcdef", locale: "en", chatShowThinking: false },
          },
        };
        const initialEntries = {
          "ui.theme": "dash",
          "ui.themeMode": "dark",
          "ui.fontUi": "jetbrains-mono",
          "ui.fontChat": "jetbrains-mono",
          "ui.accent": "#5b9cf6",
        };
        const gateway = await installMockGateway(page, {
          presenceUsers: [{ id: profileId, name: "Theme demo", self: true }],
          heldMethods: ["users.prefs.get"],
          methodResponses: {
            "config.get": configSnapshot(config, "theme-defaults"),
            "users.prefs.set": { status: "ok" },
          },
        });
        const read = () =>
          page.evaluate(() => ({
            theme: document.documentElement.dataset.theme,
            ui: getComputedStyle(document.body).fontFamily,
            chat: getComputedStyle(document.documentElement).getPropertyValue("--font-chat").trim(),
            accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
          }));
        const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
        const mirror = () =>
          page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), storageKey);
        const respondProfile = async (entries: Record<string, string>, after = 0) => {
          await gateway.waitForRequest("users.prefs.get", { after });
          await gateway.resolveDeferred("users.prefs.get", { status: "ok", entries });
        };
        const fonts = (ui: string, chat = ui) => ({
          ui: expect.stringContaining(ui),
          chat: expect.stringContaining(chat),
        });
        const preservedDesign = {
          theme: "absolutely",
          accent: "#5b9cf6",
          ...fonts("JetBrains Mono"),
        };
        const customized = { theme: "absolutely", accent: "#52c99a", ...fonts("Geist") };
        await page.goto(suite.server.baseUrl + "settings/appearance");
        await respondProfile(initialEntries);
        await waitForControlUiSettingsTakeover(page);
        // Boot and profile arrival retain existing customization.
        await expect
          .poll(read)
          .toMatchObject({ theme: "dash", accent: "#5b9cf6", ...fonts("JetBrains Mono") });
        await applyAppearanceTheme(page, "absolutely");
        await expect.poll(read).toMatchObject(preservedDesign);
        await expect
          .poll(async () => (await gateway.getRequests("themes.set")).map((r) => r.params))
          .toContainEqual({
            id: "absolutely",
          });
        expect(await gateway.getRequests("config.patch")).toEqual([]);
        await expect.poll(mirror).toMatchObject({
          theme: "absolutely",
          themeMode: "dark",
          accent: "#5b9cf6",
          fontUi: "jetbrains-mono",
          fontChat: "jetbrains-mono",
          locale: "en",
          chatShowThinking: false,
        });
        expect(await mirror()).toHaveProperty("fontUi", "jetbrains-mono");
        expect(await mirror()).toHaveProperty("fontChat", "jetbrains-mono");
        expect(await page.locator("[data-accent-custom]").inputValue()).toMatch(/^#[0-9a-f]{6}$/u);

        const selected = { ...initialEntries, "ui.theme": "absolutely" };
        // Reconcile a fresh authoritative snapshot after applying the theme alone.
        let reads = await gateway.deferNext("users.prefs.get");
        await gateway.emitGatewayEvent("users.prefs.changed", {
          profileId,
          keys: Object.keys(initialEntries),
        });
        await respondProfile(selected, reads);
        await page.reload();
        // The mirror retains customization while the profile read is held.
        await expect.poll(read).toMatchObject({ theme: "absolutely", accent: "#5b9cf6" });
        await respondProfile(selected);
        await waitForControlUiSettingsTakeover(page);
        await expect.poll(read).toMatchObject(preservedDesign);
        await page.getByRole("radio", { name: "Light", exact: true }).click();
        await expect.poll(read).toMatchObject({ theme: "absolutely-light", accent: "#5b9cf6" });

        for (const field of ["ui", "chat"]) {
          await selectPickerValue(
            page.locator(`openclaw-select-picker:has(#settings-font-${field})`),
            "geist",
          );
        }
        await page.locator('[data-accent-preset="mint"]').click();
        await applyAppearanceTheme(page, "absolutely");
        await page.getByRole("radio", { name: "Dark", exact: true }).click();
        await expect.poll(read).toMatchObject(customized);
        const custom = {
          ...selected,
          "ui.fontUi": "geist",
          "ui.fontChat": "geist",
          "ui.accent": "#52c99a",
        };
        await expect
          .poll(async () => (await gateway.getRequests("users.prefs.set")).map((r) => r.params))
          .toContainEqual({ entries: { "ui.accent": "#52c99a" } });
        reads = await gateway.deferNext("users.prefs.get");
        await gateway.closeLatest();
        await respondProfile(custom, reads);
        await expect.poll(read).toMatchObject(customized);
        await page.reload();
        await respondProfile(custom);
        await waitForControlUiSettingsTakeover(page);
        await expect.poll(read).toMatchObject(customized);
        await expect.poll(mirror).toMatchObject({ locale: "en", chatShowThinking: false });
      },
    );
  });
});
