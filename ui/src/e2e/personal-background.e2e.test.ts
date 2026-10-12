import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  DEFAULT_BACKGROUND_PREFERENCE,
  type BackgroundPreference,
} from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import type { UserBackgroundAsset } from "../../../packages/gateway-protocol/src/schema/users-background.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
  waitForControlUiSettingsTakeover,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI personal backgrounds" });
const sectionSelector = "#settings-appearance-background";
const profileId = "background-demo";
const assetId = "private-background-demo";

function placement(page: Page, label: string): Locator {
  return page
    .locator(sectionSelector)
    .locator(".settings-row")
    .filter({
      has: page.locator(".settings-row__title", { hasText: label }),
    })
    .getByRole("switch");
}

async function checked(toggle: Locator): Promise<boolean> {
  return toggle.isChecked();
}

async function openAppearance(page: Page) {
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await waitForControlUiSettingsTakeover(page);
  await page.locator(sectionSelector).scrollIntoViewIfNeeded();
}

async function busyImage(page: Page) {
  // Synthetic image fixture, not a replacement for the application's rendering.
  const imageFixture = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 640;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas unavailable for image fixture");
    }
    for (let y = 0; y < 640; y += 40) {
      for (let x = 0; x < 960; x += 40) {
        context.fillStyle = (x / 40 + y / 40) % 2 ? "#fff5a0" : "#18568a";
        context.fillRect(x, y, 40, 40);
      }
    }
    return {
      png: canvas.toDataURL("image/png").split(",")[1]!,
      jpeg: canvas.toDataURL("image/jpeg", 0.85).split(",")[1]!,
    };
  });
  return {
    png: Buffer.from(imageFixture.png, "base64"),
    jpeg: Buffer.from(imageFixture.jpeg, "base64"),
  };
}

async function updateSnapshot(
  gateway: MockGatewayControls,
  preference: BackgroundPreference | null,
  asset: UserBackgroundAsset | null,
  mode: "light" | "dark",
) {
  await gateway.setMethodResponse("users.prefs.get", {
    status: "ok",
    entries: {
      "ui.theme": "claw",
      "ui.themeMode": mode,
      ...(preference ? { "ui.background": preference } : {}),
    },
  });
  await gateway.setMethodResponse("users.background.get", { status: "ok", asset, preference });
}

async function changePreference(
  page: Page,
  gateway: MockGatewayControls,
  action: () => Promise<unknown>,
  preference: BackgroundPreference,
  expectedPreference: BackgroundPreference | null,
  asset: UserBackgroundAsset | null,
  mode: "light" | "dark",
) {
  const after = (await gateway.getRequests("users.prefs.set")).length;
  const params = {
    entries: { "ui.background": preference },
    expectedEntries: { "ui.background": expectedPreference },
  };
  // The fixture only commits an exact CAS match, as the real preference owner does.
  await gateway.setMethodResponse("users.prefs.set", {
    cases: [{ match: params, response: { status: "ok" } }, { response: { status: "conflict" } }],
  });
  await action();
  const request = await gateway.waitForRequest("users.prefs.set", { after });
  expect(request.params).toEqual(params);
  await updateSnapshot(gateway, preference, asset, mode);
  await expect.poll(() => page.locator("[data-background-upload]").isEnabled()).toBe(true);
}

suite.define(() => {
  it("keeps anonymous None and per-surface theme choices browser-local across reload", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        presenceUsers: [],
        methodResponses: {
          "config.get": configResponse({ themeMode: "light" }, "anonymous-background"),
          "users.background.get": { status: "no_durable_identity" },
        },
      });
      await page.goto(suite.server.baseUrl + "settings/appearance");
      const section = page.locator(sectionSelector);
      await section.scrollIntoViewIfNeeded();
      expect(await section.locator("[data-background-upload]").isDisabled()).toBe(true);
      await section.locator('[data-background-source="none"]').click();
      await expect
        .poll(() => section.locator('[data-background-source="none"]').getAttribute("aria-pressed"))
        .toBe("true");
      await page.reload();
      await section.scrollIntoViewIfNeeded();
      await expect
        .poll(() => section.locator('[data-background-source="none"]').getAttribute("aria-pressed"))
        .toBe("true");
      expect(await section.getByRole("alert").count()).toBe(0);
      await section.getByText("Saved in this browser.", { exact: false }).waitFor();
      await section.locator('[data-background-source="theme"]').click();
      await placement(page, "Conversations").click();
      await page.reload();
      await section.scrollIntoViewIfNeeded();
      expect(await checked(placement(page, "Conversations"))).toBe(false);
      await page.goto(suite.server.baseUrl + "new");
      await waitForControlUiRoute(page, { routeId: "new-session" });
      await page.locator("openclaw-session-background .session-background__image--theme").waitFor();
      await page.goto(suite.server.baseUrl + "chat");
      await waitForControlUiRoute(page, { routeId: "chat" });
      expect(
        await page.locator("openclaw-session-background .session-background__image").count(),
      ).toBe(0);
      expect(await gateway.getRequests("config.patch")).toEqual([]);
      expect(await gateway.getRequests("users.prefs.set")).toEqual([]);
      expect(await gateway.getRequests("users.background.upload")).toEqual([]);
    });
  });

  it.each(["light", "dark"] as const)(
    "uses private upload controls and independent placements without covering the %s transcript",
    async (mode) => {
      await suite.withPage(
        { colorScheme: mode, locale: "en-US", viewport: { width: 1440, height: 1000 } },
        async ({ page }) => {
          const artifactDir =
            process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
              ? createControlUiE2eArtifactDir("personal-background-" + mode)
              : null;
          const capture = async (name: string) => {
            if (artifactDir) {
              await page.screenshot({
                path: path.join(artifactDir, name + ".png"),
                animations: "disabled",
              });
            }
          };
          const gateway = await installMockGateway(page, {
            assistantName: "Assistant",
            agentModel: "demo/example",
            models: [{ id: "example", name: "Example model", provider: "demo" }],
            presenceUsers: [{ id: profileId, name: "Background demo", self: true }],
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "users.prefs.get",
              "users.prefs.set",
              "users.background.get",
              "users.background.upload",
              "users.background.remove",
            ],
            historyMessages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "## A readable conversation\n\nKeep the writing clear while choosing a personal backdrop.\n\n- The transcript remains selectable.\n- The composer keeps your draft.",
                  },
                ],
              },
            ],
            methodResponses: {
              "config.get": configResponse({ themeMode: mode }, "personal-background"),
              "users.prefs.get": {
                status: "ok",
                entries: { "ui.theme": "claw", "ui.themeMode": mode },
              },
              "users.prefs.set": { status: "ok" },
              "users.background.get": { status: "ok", asset: null, preference: null },
            },
          });
          await page.goto(suite.server.baseUrl + "settings/appearance");
          await waitForControlUiSettingsTakeover(page);
          await gateway.waitForRequest("users.background.get");
          const section = page.locator(sectionSelector);
          await section.scrollIntoViewIfNeeded();
          expect(await section.locator("[data-background-source]").count()).toBe(3);
          await expect
            .poll(() =>
              section.locator('[data-background-source="theme"]').getAttribute("aria-pressed"),
            )
            .toBe("true");
          await capture("desktop-controls-before-upload");

          const imageFixture = await busyImage(page);
          const asset: UserBackgroundAsset = {
            assetId,
            width: 960,
            height: 640,
            mime: "image/jpeg",
            byteLength: imageFixture.jpeg.length,
          };
          const reads: string[] = [];
          await page.route("**/__openclaw__/users/background/*", async (route) => {
            reads.push(route.request().url());
            await route.fulfill({
              status: 200,
              contentType: "image/jpeg",
              body: imageFixture.jpeg,
              headers: { "Cache-Control": "private, no-store" },
            });
          });
          let preference: BackgroundPreference = {
            source: { kind: "custom", assetId },
            showOnNewSession: true,
            showInSessions: false,
            visibility: 0.5,
          };
          await gateway.deferNext("users.background.upload");
          const priorWrites = (await gateway.getRequests("users.prefs.set")).length;
          const chooser = page.waitForEvent("filechooser");
          await section.locator("[data-background-upload]").click();
          await (
            await chooser
          ).setFiles({
            name: "bright-checker.png",
            mimeType: "image/png",
            buffer: imageFixture.png,
          });
          const upload = await gateway.waitForRequest("users.background.upload");
          expect(upload.params).toEqual({
            expectedAssetId: null,
            expectedPreference: null,
            imageBase64: imageFixture.png.toString("base64"),
          });
          await updateSnapshot(gateway, preference, asset, mode);
          await gateway.resolveDeferred("users.background.upload", {
            status: "ok",
            asset,
            preference,
          });
          await section
            .getByRole("status")
            .filter({ hasText: "Background image saved." })
            .waitFor();
          await expect
            .poll(() =>
              section.locator('[data-background-source="custom"]').getAttribute("aria-pressed"),
            )
            .toBe("true");
          expect((await gateway.getRequests("users.prefs.set")).length).toBe(priorWrites);
          expect(await checked(placement(page, "New session page"))).toBe(true);
          expect(await checked(placement(page, "Conversations"))).toBe(false);
          await expect
            .poll(() =>
              section
                .locator(".settings-background-option__sample img")
                .evaluate(
                  (image) =>
                    image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
                ),
            )
            .toBe(true);
          await capture("desktop-custom-uploaded");

          await page.goto(suite.server.baseUrl + "new");
          await waitForControlUiRoute(page, { routeId: "new-session" });
          await page.locator(".new-session-page openclaw-session-background img").waitFor();
          await capture("desktop-custom-new");
          reads.length = 0;
          await page.goto(suite.server.baseUrl + "chat");
          await page.getByText("A readable conversation", { exact: true }).waitFor();
          expect(
            await page
              .locator(".sidebar-region__background openclaw-session-background img")
              .count(),
          ).toBe(0);
          expect(reads).toEqual([]);
          const composer = page.locator(".agent-chat__composer-combobox textarea");
          await composer.fill("An unfinished thought stays here.");
          await openAppearance(page);
          let previousPreference = preference;
          preference = { ...preference, showInSessions: true };
          await changePreference(
            page,
            gateway,
            () => placement(page, "Conversations").click(),
            preference,
            previousPreference,
            asset,
            mode,
          );
          expect(await checked(placement(page, "New session page"))).toBe(true);
          previousPreference = preference;
          preference = { ...preference, showOnNewSession: false, visibility: 0.5 };
          await changePreference(
            page,
            gateway,
            () => placement(page, "New session page").click(),
            preference,
            previousPreference,
            asset,
            mode,
          );
          expect(await checked(placement(page, "Conversations"))).toBe(true);
          await page.getByRole("button", { name: "Back to app" }).click();
          await waitForControlUiRoute(page, { routeId: "chat" });
          expect(await composer.inputValue()).toBe("An unfinished thought stays here.");
          const decoration = page.locator(
            ".sidebar-region__background openclaw-session-background img",
          );
          await decoration.waitFor();
          expect(await decoration.getAttribute("src")).toMatch(/^blob:/u);
          expect(await decoration.evaluate((image) => getComputedStyle(image).filter)).toBe("none");
          expect(
            await decoration.evaluate((image) => Number(getComputedStyle(image).opacity)),
          ).toBeGreaterThan(0);
          for (const selector of [".chat-thread", ".chat-thread-inner", ".chat-group.assistant"]) {
            const surface = page.locator(selector).first();
            await surface.waitFor();
            expect(
              await surface.evaluate((element) => getComputedStyle(element).backgroundColor),
            ).toBe("rgba(0, 0, 0, 0)");
          }
          await capture("desktop-custom-chat");

          await page.setViewportSize({ width: 390, height: 844 });
          await page.locator(".shell--mobile-nav").waitFor();
          expect(await composer.inputValue()).toBe("An unfinished thought stays here.");
          expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
          await capture("mobile-custom-chat");
          await page.goto(suite.server.baseUrl + "new");
          await waitForControlUiRoute(page, { routeId: "new-session" });
          expect(
            await page.locator(".new-session-page openclaw-session-background img").count(),
          ).toBe(0);
          await page.goto(suite.server.baseUrl + "settings/appearance");
          await page.locator(sectionSelector).scrollIntoViewIfNeeded();
          await capture("mobile-independent-placements");

          await page.setViewportSize({ width: 1440, height: 1000 });
          previousPreference = preference;
          preference = { ...preference, source: { kind: "none" } };
          await changePreference(
            page,
            gateway,
            () => section.locator('[data-background-source="none"]').click(),
            preference,
            previousPreference,
            asset,
            mode,
          );
          await page.locator(".settings-theme-card--tide").click();
          await gateway.waitForRequest("themes.set");
          await expect
            .poll(() =>
              section.locator('[data-background-source="none"]').getAttribute("aria-pressed"),
            )
            .toBe("true");
          await page
            .getByRole("radio", { name: mode === "light" ? "Dark" : "Light", exact: true })
            .click();
          await expect
            .poll(() =>
              section.locator('[data-background-source="none"]').getAttribute("aria-pressed"),
            )
            .toBe("true");
          await page.reload();
          await page.locator(sectionSelector).scrollIntoViewIfNeeded();
          await expect
            .poll(() =>
              section.locator('[data-background-source="none"]').getAttribute("aria-pressed"),
            )
            .toBe("true");
          await capture("desktop-none-after-theme-and-reload");
          await page.goto(suite.server.baseUrl + "chat");
          await page.getByText("A readable conversation", { exact: true }).waitFor();
          expect(
            await page.locator("openclaw-session-background .session-background__image").count(),
          ).toBe(0);
          expect(await gateway.getRequests("config.patch")).toEqual([]);
        },
      );
    },
  );

  it("saves an initial explicit None only with the absent-value CAS", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        presenceUsers: [{ id: profileId, name: "Background demo", self: true }],
        methodResponses: {
          "config.get": configResponse({}, "background-absent-cas"),
          "users.prefs.get": { status: "ok", entries: {} },
          "users.prefs.set": { status: "conflict" },
          "users.background.get": { status: "ok", asset: null, preference: null },
        },
      });
      await page.goto(suite.server.baseUrl + "settings/appearance");
      await waitForControlUiSettingsTakeover(page);
      await gateway.waitForRequest("users.background.get");
      const preference: BackgroundPreference = {
        ...DEFAULT_BACKGROUND_PREFERENCE,
        source: { kind: "none" },
      };
      await changePreference(
        page,
        gateway,
        () => page.locator('[data-background-source="none"]').click(),
        preference,
        null,
        null,
        "light",
      );
      await page.reload();
      await expect
        .poll(() => page.locator('[data-background-source="none"]').getAttribute("aria-pressed"))
        .toBe("true");
    });
  });

  it.each(["none", "theme"] as const)(
    "refreshes retained-image metadata when another device removes it while %s is selected",
    async (kind) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const image = await busyImage(page);
        const preference: BackgroundPreference = {
          ...DEFAULT_BACKGROUND_PREFERENCE,
          source: { kind },
        };
        const asset: UserBackgroundAsset = {
          assetId,
          width: 960,
          height: 640,
          mime: "image/jpeg",
          byteLength: image.jpeg.length,
        };
        const gateway = await installMockGateway(page, {
          presenceUsers: [{ id: profileId, name: "Background demo", self: true }],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "users.background.get",
            "users.background.upload",
            "users.background.remove",
          ],
          methodResponses: {
            "config.get": configResponse({}, "background-retained-invalidation"),
            "users.prefs.get": { status: "ok", entries: { "ui.background": preference } },
            "users.background.get": { status: "ok", asset, preference },
          },
        });
        await page.route("**/__openclaw__/users/background/*", (route) =>
          route.fulfill({ status: 200, contentType: "image/jpeg", body: image.jpeg }),
        );
        await page.goto(suite.server.baseUrl + "settings/appearance");
        await waitForControlUiSettingsTakeover(page);
        const section = page.locator(sectionSelector);
        await section.scrollIntoViewIfNeeded();
        const thumbnail = section.locator(".settings-background-option__sample img");
        await thumbnail.waitFor();
        const before = (await gateway.getRequests("users.background.get")).length;
        await gateway.setMethodResponse("users.background.get", {
          status: "ok",
          asset: null,
          preference,
        });
        await gateway.emitGatewayEvent("users.prefs.changed", {
          profileId,
          keys: ["ui.background"],
        });
        await expect
          .poll(async () => (await gateway.getRequests("users.background.get")).length)
          .toBeGreaterThan(before);
        await expect.poll(() => thumbnail.count()).toBe(0);
        expect(await section.locator("[data-background-remove]").count()).toBe(0);
        expect(
          await section
            .locator('[data-background-source="' + kind + '"]')
            .getAttribute("aria-pressed"),
        ).toBe("true");
        const chooser = page.waitForEvent("filechooser");
        await section.locator('[data-background-source="custom"]').click();
        await (await chooser).setFiles([]);
        expect(await gateway.getRequests("users.prefs.set")).toEqual([]);
      });
    },
  );

  it("keeps an existing background after an upload conflict and exposes recovery", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const preference: BackgroundPreference = {
        ...DEFAULT_BACKGROUND_PREFERENCE,
        source: { kind: "none" },
      };
      const gateway = await installMockGateway(page, {
        presenceUsers: [{ id: profileId, name: "Background demo", self: true }],
        methodResponses: {
          "config.get": configResponse({}, "background-conflict"),
          "users.prefs.get": { status: "ok", entries: { "ui.background": preference } },
          "users.background.get": { status: "ok", asset: null, preference },
          "users.background.upload": { status: "conflict" },
        },
      });
      await page.goto(suite.server.baseUrl + "settings/appearance");
      const section = page.locator(sectionSelector);
      await section.scrollIntoViewIfNeeded();
      const imageFixture = await busyImage(page);
      const chooser = page.waitForEvent("filechooser");
      await section.locator("[data-background-upload]").click();
      await (
        await chooser
      ).setFiles({ name: "replacement.png", mimeType: "image/png", buffer: imageFixture.png });
      await gateway.waitForRequest("users.background.upload");
      await section
        .getByRole("alert")
        .filter({ hasText: "Your background changed elsewhere." })
        .waitFor();
      expect(
        await section.locator('[data-background-source="none"]').getAttribute("aria-pressed"),
      ).toBe("true");
      expect(await section.locator("[data-background-upload]").isEnabled()).toBe(true);
      expect(await gateway.getRequests("users.prefs.set")).toEqual([]);
    });
  });
});
