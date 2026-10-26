import { expect, it } from "vitest";
import {
  BUILTIN_THEMES,
  type ThemeDescriptor,
} from "../../../packages/gateway-protocol/src/theme.ts";
import { createThemeDefinitionFixture } from "../../../test/helpers/theme-fixture.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Appearance theme discovery" });
const personal: ThemeDescriptor = {
  id: "user/ch-aurora",
  name: "Aurora",
  description: "Quiet indigo surfaces and bright mint controls.",
  source: "user",
  modes: ["dark"],
};
const definition = createThemeDefinitionFixture({
  name: personal.name,
  description: personal.description,
});
const selection = {
  current: {
    id: personal.id,
    mode: "dark",
    scope: "profile",
    overrides: { id: personal.id, mode: "dark" },
  },
  theme: personal,
  definition,
};
const fallback = {
  current: { id: "claw", mode: "dark", scope: "profile", overrides: {} },
  theme: BUILTIN_THEMES[0],
};
const listing = {
  items: [
    {
      id: "studio/aurora",
      name: personal.name,
      description: personal.description,
      version: "1.0.0",
      category: "themes",
      author: { handle: "studio" },
      updatedAt: 1,
    },
  ],
  nextCursor: null,
};

suite.define(() => {
  it("discovers only on demand, retries search, installs, selects, persists, and removes personal themes", async () => {
    await suite.withPage(
      {
        viewport: { width: 1440, height: 1000 },
        colorScheme: "dark",
        locale: "en-US",
        reducedMotion: "reduce",
      },
      async ({ page }) => {
        const profileId = "theme-demo";
        const gateway = await installMockGateway(page, {
          presenceUsers: [{ id: profileId, name: "Theme demo", self: true }],
          featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
          heldMethods: ["themes.install", "themes.remove"],
          methodResponses: {
            "config.get": configResponse({ themeMode: "dark" }, "themes"),
            "users.prefs.get": { status: "ok", entries: {} },
            "themes.browse": listing,
          },
        });
        await page.goto(suite.server.baseUrl + "settings/appearance");
        await waitForControlUiSettingsTakeover(page);
        expect(await gateway.getRequests("themes.browse")).toEqual([]);
        await page.getByRole("button", { name: "Browse and manage themes" }).click();
        await gateway.waitForRequest("themes.browse");
        await expect.poll(() => page.locator(".settings-theme-discovery__card").count()).toBe(1);
        const input = page.getByRole("searchbox", { name: "Search themes" });
        await input.fill("aurora");
        const beforeSearch = await gateway.deferNext("themes.browse");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await gateway.waitForRequest("themes.browse", { after: beforeSearch });
        await expect
          .poll(() => page.locator(".settings-theme-discovery [role=status]").allTextContents())
          .toContain("Loading…");
        await gateway.rejectDeferred("themes.browse", {
          message: "Registry unavailable. Try searching again.",
        });
        await expect
          .poll(() => page.locator(".settings-theme-discovery [role=alert]").textContent())
          .toContain("Registry unavailable");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await expect
          .poll(() => page.locator(".settings-theme-discovery [role=alert]").count())
          .toBe(0);
        expect((await gateway.getRequests("themes.browse")).at(-1)?.params).toMatchObject({
          query: "aurora",
        });
        await page.getByRole("button", { name: "Install and apply" }).click();
        await gateway.waitForRequest("themes.install");
        expect((await gateway.getRequests("themes.install")).at(-1)?.params).toEqual({
          id: "studio/aurora",
          version: "1.0.0",
        });
        expect(await page.getByRole("button", { name: "Installing…" }).isDisabled()).toBe(true);
        await gateway.setMethodResponse("themes.list", {
          ...selection,
          themes: [...BUILTIN_THEMES, personal],
        });
        await gateway.setMethodResponse("themes.get", selection);
        const saved = { "ui.theme": personal.id, "ui.themeMode": "dark" };
        await gateway.setMethodResponse("users.prefs.get", { status: "ok", entries: saved });
        await gateway.resolveDeferred("themes.install", { ...selection, application: "saved" });
        await gateway.emitGatewayEvent("users.prefs.changed", {
          profileId,
          keys: Object.keys(saved),
        });
        await expect
          .poll(() =>
            page
              .locator('.settings-theme-card[data-theme-id="user/ch-aurora"]')
              .getAttribute("aria-pressed"),
          )
          .toBe("true");
        await expect
          .poll(() => page.evaluate(() => document.documentElement.dataset.themeId))
          .toBe(personal.id);
        await page.reload();
        await gateway.waitForRequest("users.prefs.get");
        await gateway.setMethodResponse("users.prefs.get", { status: "ok", entries: saved });
        await gateway.setMethodResponse("themes.list", {
          ...selection,
          themes: [...BUILTIN_THEMES, personal],
        });
        await gateway.setMethodResponse("themes.get", selection);
        await gateway.emitGatewayEvent("users.prefs.changed", {
          profileId,
          keys: Object.keys(saved),
        });
        await expect
          .poll(() => page.evaluate(() => document.documentElement.dataset.themeId))
          .toBe(personal.id);
        const reset = await gateway.deferNext("themes.set", { id: null });
        await page.locator('.settings-theme-card[data-theme-id="claw"]').click();
        await gateway.waitForRequest("themes.set", { after: reset, match: { id: null } });
        // The fixture persists only after the actual profile write is observed.
        await gateway.setMethodResponse("users.prefs.get", {
          status: "ok",
          entries: { "ui.themeMode": "dark" },
        });
        await gateway.resolveDeferred("themes.set", { ...fallback, application: "saved" });
        await expect
          .poll(() =>
            page.locator('.settings-theme-card[data-theme-id="claw"]').getAttribute("aria-pressed"),
          )
          .toBe("true");
        const select = await gateway.deferNext("themes.set", { id: personal.id });
        await page.locator('.settings-theme-card[data-theme-id="user/ch-aurora"]').click();
        await gateway.waitForRequest("themes.set", { after: select, match: { id: personal.id } });
        await gateway.setMethodResponse("users.prefs.get", { status: "ok", entries: saved });
        await gateway.resolveDeferred("themes.set", { ...selection, application: "saved" });
        await expect
          .poll(() => page.evaluate(() => document.documentElement.dataset.themeId))
          .toBe(personal.id);
        await page.getByRole("button", { name: "Browse and manage themes" }).click();
        await page.getByRole("button", { name: "Remove", exact: true }).click();
        await gateway.waitForRequest("themes.remove");
        expect((await gateway.getRequests("themes.remove")).at(-1)?.params).toEqual({
          id: personal.id,
        });
        await gateway.setMethodResponse("themes.list", { ...fallback, themes: BUILTIN_THEMES });
        await gateway.setMethodResponse("users.prefs.get", { status: "ok", entries: {} });
        await gateway.resolveDeferred("themes.remove", { ...fallback, application: "saved" });
        await gateway.emitGatewayEvent("users.prefs.changed", { profileId, keys: ["ui.theme"] });
        await expect
          .poll(() => page.locator('.settings-theme-card[data-theme-id="user/ch-aurora"]').count())
          .toBe(0);
        expect(await gateway.getRequests("plugins.install")).toEqual([]);
      },
    );
  });
});
