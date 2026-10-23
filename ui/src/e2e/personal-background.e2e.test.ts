import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  DEFAULT_BACKGROUND_PREFERENCE,
  type BackgroundPreference,
} from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import type { UserBackgroundAsset } from "../../../packages/gateway-protocol/src/schema/users-background.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
  waitForControlUiSettingsTakeover,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI personal backgrounds" });
const sectionSelector = "#settings-appearance-background";
const profileId = "background-demo";
const assetId = "private-background-demo";
const desktop = { width: 1280, height: 900 };
const largeDesktop = { width: 1440, height: 1000 };
const backgroundImage = "openclaw-session-background .session-background__image";
const chatImage = ".sidebar-region__background openclaw-session-background img";
const uploadSelector = "[data-background-upload]";
const thumbnailSelector = ".settings-background-option__sample img";
const expectCount = async (page: Page | Locator, selector: string, count: number) =>
  expect(await page.locator(selector).count()).toBe(count);
const expectPlacement = async (page: Page, label: string, checked: boolean) =>
  expect(await placement(page, label).isChecked()).toBe(checked);
const expectNoWrites = async (gateway: MockGatewayControls, methods: string[]) => {
  for (const method of methods) {
    expect(await gateway.getRequests(method)).toEqual([]);
  }
};
const preferenceFor = (kind: "none" | "theme"): BackgroundPreference => ({
  ...DEFAULT_BACKGROUND_PREFERENCE,
  source: { kind },
});
const backgroundReply = (
  asset: UserBackgroundAsset | null,
  preference: BackgroundPreference | null,
) => ({ status: "ok", asset, preference });
const preferenceReply = (entries: Record<string, unknown>) => ({ status: "ok", entries });
async function installBackground(
  page: Page,
  preference: BackgroundPreference | null,
  overrides: Parameters<typeof installMockGateway>[1] = {},
  asset: UserBackgroundAsset | null = null,
) {
  return installMockGateway(page, {
    presenceUsers,
    ...overrides,
    methodResponses: {
      "config.get": configResponse({}, "personal-background"),
      "users.prefs.get": preferenceReply(preference ? { "ui.background": preference } : {}),
      "users.background.get": backgroundReply(asset, preference),
      ...overrides.methodResponses,
    },
  });
}
async function visitAppearance(page: Page, waitForTakeover = false) {
  await page.goto(suite.server.baseUrl + "settings/appearance");
  if (waitForTakeover) {
    await waitForControlUiSettingsTakeover(page);
  }
  const section = page.locator(sectionSelector);
  await section.scrollIntoViewIfNeeded();
  return section;
}

function placement(page: Page, label: string): Locator {
  return page
    .locator(sectionSelector)
    .locator(".settings-row")
    .filter({
      has: page.locator(".settings-row__title", { hasText: label }),
    })
    .getByRole("switch");
}

const source = (scope: Page | Locator, kind: string) =>
  scope.locator(`[data-background-source="${kind}"]`);
const expectSelected = (scope: Page | Locator, kind: string) =>
  expect.poll(() => source(scope, kind).getAttribute("aria-pressed")).toBe("true");
const presenceUsers = [{ id: profileId, name: "Background demo", self: true }];
const backgroundMethods = [
  "users.background.get",
  "users.background.upload",
  "users.background.remove",
];
function imageAsset(jpeg: Buffer): UserBackgroundAsset {
  return { assetId, width: 960, height: 640, mime: "image/jpeg", byteLength: jpeg.length };
}
async function uploadImage(page: Page, section: Locator, name: string, buffer: Buffer) {
  const chooser = page.waitForEvent("filechooser");
  await section.locator(uploadSelector).click();
  await (await chooser).setFiles({ name, mimeType: "image/png", buffer });
}
async function openRoute(page: Page, routePath: string, routeId: "new-session" | "chat") {
  await page.goto(suite.server.baseUrl + routePath);
  await waitForControlUiRoute(page, { routeId });
}

async function busyImage(page: Page) {
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
  await gateway.setMethodResponse(
    "users.prefs.get",
    preferenceReply({
      "ui.theme": "claw",
      "ui.themeMode": mode,
      ...(preference ? { "ui.background": preference } : {}),
    }),
  );
  await gateway.setMethodResponse("users.background.get", backgroundReply(asset, preference));
}

async function changePreference(
  page: Page,
  gateway: MockGatewayControls,
  action: () => Promise<unknown>,
  preference: BackgroundPreference,
  expectedPreference: BackgroundPreference | null = null,
  asset: UserBackgroundAsset | null = null,
  mode: "light" | "dark" = "light",
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
  await gateway.deferNext("users.prefs.set", params, { exactParams: true });
  await action();
  const request = await gateway.waitForRequest("users.prefs.set", { after });
  expect(request.params).toEqual(params);
  await updateSnapshot(gateway, preference, asset, mode);
  // Successful writes are readable before the Gateway acknowledges the commit.
  await gateway.resolveDeferred("users.prefs.set");
  await expect.poll(() => page.locator(uploadSelector).isEnabled()).toBe(true);
}

suite.define(() => {
  it("keeps anonymous None and per-surface theme choices browser-local across reload", () =>
    suite.withPage({ viewport: desktop }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        presenceUsers: [],
        methodResponses: {
          "config.get": configResponse({ themeMode: "light" }, "anonymous-background"),
          "users.background.get": { status: "no_durable_identity" },
        },
      });
      const section = await visitAppearance(page);
      expect(await section.locator(uploadSelector).isDisabled()).toBe(true);
      await source(section, "none").click();
      await expectSelected(section, "none");
      await page.reload();
      await section.scrollIntoViewIfNeeded();
      await expectSelected(section, "none");
      expect(await section.getByRole("alert").count()).toBe(0);
      await section.getByText("Saved in this browser.", { exact: false }).waitFor();
      await source(section, "theme").click();
      await placement(page, "Conversations").click();
      await page.reload();
      await section.scrollIntoViewIfNeeded();
      await expectPlacement(page, "Conversations", false);
      await openRoute(page, "new", "new-session");
      await page.locator("openclaw-session-background .session-background__image--theme").waitFor();
      await openRoute(page, "chat", "chat");
      await expectCount(page, backgroundImage, 0);
      await expectNoWrites(gateway, ["config.patch", "users.prefs.set", "users.background.upload"]);
    }));

  it.each(["light", "dark"] as const)(
    "uses private upload controls and independent placements without covering the %s transcript",
    (mode) =>
      suite.withPage(
        { colorScheme: mode, locale: "en-US", viewport: largeDesktop },
        async ({ page }) => {
          const gateway = await installBackground(page, null, {
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "users.prefs.get",
              "users.prefs.set",
              ...backgroundMethods,
            ],
            historyMessages: [
              chatMessage("assistant", "## A readable conversation\n\nText.\n\n- Item."),
            ],
            methodResponses: {
              "config.get": configResponse({ themeMode: mode }, "personal-background"),
              "users.prefs.get": preferenceReply({ "ui.theme": "claw", "ui.themeMode": mode }),
              "users.prefs.set": { status: "ok" },
            },
          });
          const section = await visitAppearance(page, true);
          await gateway.waitForRequest("users.background.get");
          expect(await section.locator("[data-background-source]").count()).toBe(3);
          await expectSelected(section, "theme");

          const imageFixture = await busyImage(page);
          const asset = imageAsset(imageFixture.jpeg);
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
          await uploadImage(page, section, "bright-checker.png", imageFixture.png);
          const upload = await gateway.waitForRequest("users.background.upload");
          expect(upload.params).toEqual({
            expectedAssetId: null,
            expectedPreference: null,
            imageBase64: imageFixture.png.toString("base64"),
          });
          await updateSnapshot(gateway, preference, asset, mode);
          await gateway.resolveDeferred(
            "users.background.upload",
            backgroundReply(asset, preference),
          );
          await section
            .getByRole("status")
            .filter({ hasText: "Background image saved." })
            .waitFor();
          await expectSelected(section, "custom");
          expect((await gateway.getRequests("users.prefs.set")).length).toBe(priorWrites);
          await expectPlacement(page, "New session page", true);
          await expectPlacement(page, "Conversations", false);
          await expect
            .poll(() =>
              section
                .locator(thumbnailSelector)
                .evaluate(
                  (image) =>
                    image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
                ),
            )
            .toBe(true);

          await openRoute(page, "new", "new-session");
          await page.locator(".new-session-page openclaw-session-background img").waitFor();
          reads.length = 0;
          await page.goto(suite.server.baseUrl + "chat");
          await page.getByText("A readable conversation", { exact: true }).waitFor();
          await expectCount(page, chatImage, 0);
          expect(reads).toEqual([]);
          const composer = page.locator(".agent-chat__composer-combobox textarea");
          await composer.fill("An unfinished thought stays here.");
          await page.keyboard.press("ControlOrMeta+Shift+Comma");
          await waitForControlUiSettingsTakeover(page);
          await page.locator(sectionSelector).scrollIntoViewIfNeeded();
          const change = async (
            action: () => Promise<unknown>,
            patch: Partial<BackgroundPreference>,
          ) => {
            const previous = preference;
            preference = { ...preference, ...patch };
            await changePreference(page, gateway, action, preference, previous, asset, mode);
          };
          await change(() => placement(page, "Conversations").click(), { showInSessions: true });
          await expectPlacement(page, "New session page", true);
          await change(() => placement(page, "New session page").click(), {
            showOnNewSession: false,
            visibility: 0.5,
          });
          await expectPlacement(page, "Conversations", true);
          await page.getByRole("button", { name: "Back to app" }).click();
          await waitForControlUiRoute(page, { routeId: "chat" });
          expect(await composer.inputValue()).toBe("An unfinished thought stays here.");
          const decoration = page.locator(chatImage);
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

          await page.setViewportSize({ width: 390, height: 844 });
          await page.locator(".shell--mobile-nav").waitFor();
          expect(await composer.inputValue()).toBe("An unfinished thought stays here.");
          expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
          await openRoute(page, "new", "new-session");
          await expectCount(page, ".new-session-page openclaw-session-background img", 0);
          await visitAppearance(page);

          await page.setViewportSize(largeDesktop);
          await change(() => source(section, "none").click(), { source: { kind: "none" } });
          await page.locator(".settings-theme-card--tide").click();
          await gateway.waitForRequest("themes.set");
          await expectSelected(section, "none");
          await page
            .getByRole("radio", { name: mode === "light" ? "Dark" : "Light", exact: true })
            .click();
          await expectSelected(section, "none");
          await page.reload();
          await page.locator(sectionSelector).scrollIntoViewIfNeeded();
          await expectSelected(section, "none");
          await page.goto(suite.server.baseUrl + "chat");
          await page.getByText("A readable conversation", { exact: true }).waitFor();
          await expectCount(page, backgroundImage, 0);
          await expectNoWrites(gateway, ["config.patch"]);
        },
      ),
  );

  it("saves an initial explicit None only with the absent-value CAS", () =>
    suite.withPage({ viewport: desktop }, async ({ page }) => {
      const gateway = await installBackground(page, null, {
        methodResponses: { "users.prefs.set": { status: "conflict" } },
      });
      await visitAppearance(page, true);
      await gateway.waitForRequest("users.background.get");
      const preference = preferenceFor("none");
      await changePreference(page, gateway, () => source(page, "none").click(), preference);
      await page.reload();
      await expectSelected(page, "none");
    }));

  it.each(["none", "theme"] as const)(
    "refreshes retained-image metadata when another device removes it while %s is selected",
    (kind) =>
      suite.withPage({ viewport: desktop }, async ({ page }) => {
        const image = await busyImage(page);
        const preference = preferenceFor(kind);
        const asset = imageAsset(image.jpeg);
        const gateway = await installBackground(
          page,
          preference,
          {
            featureMethods: [...defaultControlUiFeatureMethods, ...backgroundMethods],
          },
          asset,
        );
        await page.route("**/__openclaw__/users/background/*", (route) =>
          route.fulfill({ status: 200, contentType: "image/jpeg", body: image.jpeg }),
        );
        const section = await visitAppearance(page, true);
        const thumbnail = section.locator(thumbnailSelector);
        await thumbnail.waitFor();
        const before = (await gateway.getRequests("users.background.get")).length;
        await gateway.setMethodResponse("users.background.get", backgroundReply(null, preference));
        await gateway.emitGatewayEvent("users.prefs.changed", {
          profileId,
          keys: ["ui.background"],
        });
        await expect
          .poll(async () => (await gateway.getRequests("users.background.get")).length)
          .toBeGreaterThan(before);
        await expect.poll(() => thumbnail.count()).toBe(0);
        await expectCount(section, "[data-background-remove]", 0);
        expect(await source(section, kind).getAttribute("aria-pressed")).toBe("true");
        const chooser = page.waitForEvent("filechooser");
        await section.locator('[data-background-source="custom"]').click();
        await (await chooser).setFiles([]);
        await expectNoWrites(gateway, ["users.prefs.set"]);
      }),
  );

  it("keeps an existing background after an upload conflict and exposes recovery", () =>
    suite.withPage({ viewport: desktop }, async ({ page }) => {
      const preference = preferenceFor("none");
      const gateway = await installBackground(page, preference, {
        methodResponses: { "users.background.upload": { status: "conflict" } },
      });
      const section = await visitAppearance(page);
      const imageFixture = await busyImage(page);
      await uploadImage(page, section, "replacement.png", imageFixture.png);
      await gateway.waitForRequest("users.background.upload");
      await section
        .getByRole("alert")
        .filter({ hasText: "Your background changed elsewhere." })
        .waitFor();
      expect(await source(section, "none").getAttribute("aria-pressed")).toBe("true");
      expect(await section.locator(uploadSelector).isEnabled()).toBe(true);
      await expectNoWrites(gateway, ["users.prefs.set"]);
    }));
});
