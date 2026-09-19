import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI theme selection defaults" });

suite.define(() => {
  it("resets design overrides only on explicit theme selection and persists the result through profile reads", async () => {
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
            seamColor: "#123456",
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
            "config.get": {
              config,
              raw: JSON.stringify(config),
              hash: "theme-defaults",
              valid: true,
              issues: [],
            },
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
        await page.goto(suite.server.baseUrl + "settings/appearance");
        await respondProfile(initialEntries);
        await waitForControlUiSettingsTakeover(page);
        // Boot and profile arrival retain existing customization.
        await expect.poll(read).toMatchObject({
          theme: "dash",
          accent: "#5b9cf6",
          ui: expect.stringContaining("JetBrains Mono"),
          chat: expect.stringContaining("JetBrains Mono"),
        });
        await page.locator(".settings-theme-card--absolutely").click();
        await expect.poll(read).toMatchObject({
          theme: "absolutely",
          accent: "#d97757",
          ui: expect.stringContaining("Space Grotesk"),
          chat: expect.stringContaining("Lora"),
        });
        await expect
          .poll(async () => (await gateway.getRequests("users.prefs.set")).map((r) => r.params))
          .toContainEqual({
            entries: {
              "ui.theme": "absolutely",
              "ui.accent": "theme",
              "ui.fontUi": null,
              "ui.fontChat": null,
            },
          });
        expect(await gateway.getRequests("config.patch")).toEqual([]);
        await expect.poll(mirror).toMatchObject({
          theme: "absolutely",
          themeMode: "dark",
          accent: "theme",
          locale: "en",
          chatShowThinking: false,
        });
        expect(await mirror()).not.toHaveProperty("fontUi");
        expect(await mirror()).not.toHaveProperty("fontChat");
        expect(
          await page.locator(".settings-accent-swatch--custom").getAttribute("class"),
        ).not.toContain("--active");
        expect(await page.locator("#settings-accent-status").textContent()).toContain(
          "Using theme accent",
        );
        expect(await page.locator("[data-accent-custom]").inputValue()).toMatch(/^#[0-9a-f]{6}$/u);

        const selected = { "ui.theme": "absolutely", "ui.themeMode": "dark", "ui.accent": "theme" };
        // Reconcile a fresh authoritative snapshot after the outgoing atomic reset.
        let reads = (await gateway.getRequests("users.prefs.get")).length;
        await gateway.deferNext("users.prefs.get");
        await gateway.emitGatewayEvent("users.prefs.changed", {
          profileId,
          keys: Object.keys(initialEntries),
        });
        await respondProfile(selected, reads);
        await page.reload();
        // The mirror already paints defaults while the profile read is held.
        await expect.poll(read).toMatchObject({ theme: "absolutely", accent: "#d97757" });
        await respondProfile(selected);
        await waitForControlUiSettingsTakeover(page);
        await expect.poll(read).toMatchObject({
          ui: expect.stringContaining("Space Grotesk"),
          chat: expect.stringContaining("Lora"),
          accent: "#d97757",
        });
        await page.getByRole("radio", { name: "Light", exact: true }).click();
        await expect.poll(read).toMatchObject({ theme: "absolutely-light", accent: "#a8452a" });

        await selectPickerValue(
          page.locator("openclaw-select-picker:has(#settings-font-ui)"),
          "geist",
        );
        await selectPickerValue(
          page.locator("openclaw-select-picker:has(#settings-font-chat)"),
          "geist",
        );
        await page.locator('[data-accent-preset="blue"]').click();
        await page.locator(".settings-theme-card--absolutely").click();
        await page.getByRole("radio", { name: "Dark", exact: true }).click();
        await expect.poll(read).toMatchObject({
          theme: "absolutely",
          ui: expect.stringContaining("Geist"),
          chat: expect.stringContaining("Geist"),
          accent: "#5b9cf6",
        });
        const custom = {
          ...selected,
          "ui.fontUi": "geist",
          "ui.fontChat": "geist",
          "ui.accent": "#5b9cf6",
        };
        await expect
          .poll(async () => (await gateway.getRequests("users.prefs.set")).map((r) => r.params))
          .toContainEqual({ entries: { "ui.accent": "#5b9cf6" } });
        reads = (await gateway.getRequests("users.prefs.get")).length;
        await gateway.deferNext("users.prefs.get");
        await gateway.closeLatest();
        await respondProfile(custom, reads);
        await expect.poll(read).toMatchObject({
          theme: "absolutely",
          ui: expect.stringContaining("Geist"),
          chat: expect.stringContaining("Geist"),
          accent: "#5b9cf6",
        });
        await page.reload();
        await respondProfile(custom);
        await waitForControlUiSettingsTakeover(page);
        await expect.poll(read).toMatchObject({
          theme: "absolutely",
          ui: expect.stringContaining("Geist"),
          chat: expect.stringContaining("Geist"),
          accent: "#5b9cf6",
        });
        await expect.poll(mirror).toMatchObject({ locale: "en", chatShowThinking: false });
      },
    );
  });
});
