import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installNativePluginMockGateway } from "../test-helpers/control-ui-plugin-e2e.ts";
import { prepareNativeControlUiPluginFixtures } from "../test-helpers/control-ui-plugin-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Lobsterdex bundled plugin parity",
});

suite.define(() => {
  it("retains the existing collection and its first and shiny visit memories", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        reducedMotion: "reduce",
        serviceWorkers: "block",
        locale: "en-US",
      },
      async ({ page }) => {
        await page.addInitScript(() => {
          if (sessionStorage.getItem("lobsterdex-proof-seeded")) {
            return;
          }
          sessionStorage.setItem("lobsterdex-proof-seeded", "true");
          localStorage.setItem(
            "openclaw.control.lobsterdex.v1",
            JSON.stringify({
              crimson: { name: "Pinchy", firstSeenAt: 1788868800000, shinySeenAt: 1791460800000 },
              blue: { name: "Bluebell", firstSeenAt: 1788868800000 },
              gold: { name: "Goldie", firstSeenAt: 1791460800000 },
            }),
          );
        });
        const fixtures = [
          {
            pluginId: "lobsterdex",
            rootDir: path.resolve("extensions/lobsterdex"),
            source: "browser/index.tsx",
          },
        ];
        const prepared = await prepareNativeControlUiPluginFixtures(fixtures);
        const gateway = await installNativePluginMockGateway(page, {
          controlUiTabs: [
            {
              pluginId: "lobsterdex",
              id: "collection",
              label: "Lobsterdex",
              placement: "route:lobsterdex",
              group: "settings",
            },
          ],
          nativePlugins: [
            {
              pluginId: "lobsterdex",
              rootDir: path.resolve("extensions/lobsterdex"),
              source: "browser/index.tsx",
            },
          ],
        });
        await page.goto(`${suite.server.baseUrl}settings/lobsterdex`);
        const surface = page.locator("openclaw-lobsterdex-page");
        const pinchy = surface.getByRole("heading", { name: "Pinchy", exact: true });
        await pinchy.waitFor();
        expect(await surface.locator(".lobsterdex-page__card").count()).toBe(52);
        expect(await surface.locator(".lobsterdex-page__count").textContent()).toBe("3/52 visited");
        expect(await surface.locator("#lobsterdex-crimson time").count()).toBe(2);
        const frame = await takeControlUiScreenshotFrame(
          page,
          surface,
          [pinchy, surface.locator(".lobsterdex-page__count")],
          { animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, "collection.png"), frame.png);
        expect((await gateway.waitForRequest("plugins.controlUi.report")).params).toMatchObject({
          reports: [{ pluginId: "lobsterdex", status: "activated" }],
        });
        await page.goto(suite.server.baseUrl + "settings/appearance");
        const visits = page.getByRole("switch", { name: "Lobster visits", exact: true });
        await visits.waitFor();
        expect(await visits.isChecked()).toBe(true);
        const blue = page.getByRole("button", { name: "Blueberry", exact: true });
        await blue.click();
        await expect.poll(() => blue.getAttribute("aria-pressed")).toBe("true");
        const appearance = await takeControlUiScreenshotFrame(
          page,
          page.locator(".settings-tab-icon"),
          [blue],
          { animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, "tab-icon.png"), appearance.png);
        await visits.click();
        await expect.poll(() => visits.isChecked()).toBe(false);
        await visits.click();
        await expect.poll(() => visits.isChecked()).toBe(true);
        await page.goto(suite.server.baseUrl + "new");
        const pet = page.locator("openclaw-lobster-pet");
        await pet.waitFor();
        await expect.poll(() => pet.getAttribute("data-scene-ready")).toBe("");
        const input = page.locator(".new-session-page__composer textarea").first();
        const retained = await input.elementHandle();
        const retainedPet = await pet.elementHandle();
        await gateway.setOnline(false);
        await gateway.closeLatest(1006, "Offline presentation proof");
        await pet.locator(".lobster-pet--offline").first().waitFor();
        expect(await pet.evaluate((node, original) => node === original, retainedPet)).toBe(true);
        expect(await input.inputValue()).toBe("");
        const offline = await takeControlUiScreenshotFrame(
          page,
          page.locator(".new-session-page__composer"),
          [pet, input],
          { animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, "offline-visitor.png"), offline.png);
        await pet.locator(".lobster-pet--offline").first().click({ button: "right" });
        await page
          .getByRole("menuitem", { name: /^Dismiss and don.t show again$/, exact: true })
          .click();
        const connections = (await gateway.getRequests("connect")).length;
        await gateway.setOnline(true);
        await gateway.waitForRequest("connect", { after: connections });
        await expect.poll(() => pet.locator(".lobster-pet--offline").count()).toBe(0);
        await input.fill("A draft survives the visitor lifecycle.");

        // The real offline visitor may add a discovery. Retain that exact collection,
        // rather than requiring a successful visit to leave the seeded count unchanged.
        const retainedCollection = await page.evaluate(() =>
          localStorage.getItem("openclaw.control.lobsterdex.v1"),
        );
        expect(retainedCollection).not.toBeNull();
        await gateway.setMethodResponse("plugins.controlUi.list", {
          revision: "disabled",
          plugins: [],
          diagnostics: [],
          inlineViews: [],
        });
        await gateway.emitGatewayEvent("plugins.changed", {});
        await expect.poll(() => pet.count()).toBe(0);
        expect(await input.inputValue()).toBe("A draft survives the visitor lifecycle.");
        expect(await input.evaluate((node, original) => node === original, retained)).toBe(true);
        await gateway.setMethodResponse("plugins.controlUi.list", prepared.catalog);
        await gateway.emitGatewayEvent("plugins.changed", {});
        await pet.waitFor();
        expect(await input.inputValue()).toBe("A draft survives the visitor lifecycle.");
        await page.goto(suite.server.baseUrl + "settings/appearance");
        await visits.waitFor();
        expect(await visits.isChecked()).toBe(false);
        await page.getByRole("link", { name: /Lobsterdex/ }).click();
        await pinchy.waitFor();
        expect(
          await page.evaluate(() => localStorage.getItem("openclaw.control.lobsterdex.v1")),
        ).toBe(retainedCollection);
        expect(await surface.locator("#lobsterdex-crimson time").count()).toBe(2);
        await page.goto(suite.server.baseUrl + "settings/appearance");
        await page.getByRole("button", { name: "Phosphor", exact: true }).click();
        await expect.poll(() => visits.count()).toBe(0);
        await expect.poll(() => blue.count()).toBe(0);
        await page.goto(suite.server.baseUrl + "settings/lobsterdex");
        await page
          .getByText(
            "This theme hides Lobsterdex. Your collection and preferences are preserved.",
            { exact: true },
          )
          .waitFor();
        await page.goto(suite.server.baseUrl + "settings/appearance");
        await page.getByRole("button", { name: "Claw", exact: true }).click();
        await visits.waitFor();
        expect(await visits.isChecked()).toBe(false);
        await blue.waitFor();
        await expect.poll(() => blue.getAttribute("aria-pressed")).toBe("true");
        console.log(`Lobsterdex proof: ${suite.artifactDir}`);
      },
    );
  });
});
