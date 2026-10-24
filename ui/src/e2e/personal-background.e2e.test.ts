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
  return { assetId, width: 2, height: 2, mime: "image/jpeg", byteLength: jpeg.length };
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

async function imageFixture(page: Page) {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 2;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas unavailable for image fixture");
    }
    context.fillStyle = "#18568a";
    context.fillRect(0, 0, 2, 2);
    return {
      png: canvas.toDataURL("image/png").split(",")[1]!,
      jpeg: canvas.toDataURL("image/jpeg", 0.85).split(",")[1]!,
    };
  });
  return {
    png: Buffer.from(encoded.png, "base64"),
    jpeg: Buffer.from(encoded.jpeg, "base64"),
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

          const image = await imageFixture(page);
          const asset = imageAsset(image.jpeg);
          const reads: string[] = [];
          await page.route("**/__openclaw__/users/background/*", async (route) => {
            reads.push(route.request().url());
            await route.fulfill({
              status: 200,
              contentType: "image/jpeg",
              body: image.jpeg,
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
          await uploadImage(page, section, "background.png", image.png);
          const upload = await gateway.waitForRequest("users.background.upload");
          expect(upload.params).toEqual({
            expectedAssetId: null,
            expectedPreference: null,
            imageBase64: image.png.toString("base64"),
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
                  (element) =>
                    element instanceof HTMLImageElement &&
                    element.complete &&
                    element.naturalWidth > 0,
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
          await visitAppearance(page);
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
          await openRoute(page, "new", "new-session");
          await expectCount(page, ".new-session-page openclaw-session-background img", 0);
          await visitAppearance(page);

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
        const image = await imageFixture(page);
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
      const image = await imageFixture(page);
      await uploadImage(page, section, "replacement.png", image.png);
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
