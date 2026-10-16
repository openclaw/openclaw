import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { NativeDeviceSettingsSnapshot } from "../app/native-device-settings.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createIosNativeDeviceSettingsSnapshot,
  createNativeDeviceSettingsSnapshot,
} from "../test-helpers/native-device-settings.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { nativeForm } from "./native-form.test-support.ts";
import { installNativeEmbed, installNativeWebChrome } from "./native-nav.test-support.ts";

type DeviceSettingsTestWindow = Window & {
  __OPENCLAW_NATIVE_DEVICE_SETTINGS__?: NativeDeviceSettingsSnapshot;
  nativeDeviceSettingsMessages?: unknown[];
  nativeDeviceSettingsReplies?: Array<(snapshot: NativeDeviceSettingsSnapshot) => void>;
};

const settingMessages = (page: Page) =>
  page.evaluate(() => (window as DeviceSettingsTestWindow).nativeDeviceSettingsMessages);
async function expectSetting(page: Page, key: string, value: unknown) {
  await expect.poll(() => settingMessages(page)).toContainEqual({ type: "set", key, value });
}

async function installDeviceSettingsBridge(page: Page, snapshot: NativeDeviceSettingsSnapshot) {
  if (snapshot.device.platform === "macos") {
    await installNativeWebChrome(page);
  }
  await page.addInitScript((initial: NativeDeviceSettingsSnapshot) => {
    const messages: unknown[] = [];
    const replies: Array<(snapshot: NativeDeviceSettingsSnapshot) => void> = [];
    const nativeWindow = window as DeviceSettingsTestWindow;
    Object.assign(nativeWindow, {
      __OPENCLAW_NATIVE_DEVICE_SETTINGS__: initial,
      nativeDeviceSettingsMessages: messages,
      nativeDeviceSettingsReplies: replies,
    });
    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: {
        messageHandlers: {
          openclawDeviceSettings: {
            postMessage(message: unknown) {
              messages.push(message);
              if (
                typeof message === "object" &&
                message !== null &&
                "type" in message &&
                message.type === "set"
              ) {
                return new Promise<NativeDeviceSettingsSnapshot>((resolve) => {
                  replies.push(resolve);
                });
              }
              return Promise.resolve(nativeWindow["__OPENCLAW_NATIVE_DEVICE_SETTINGS__"]);
            },
          },
        },
      },
    });
  }, snapshot);
}

async function replyToDeviceSetting(page: Page, snapshot: NativeDeviceSettingsSnapshot) {
  await page.evaluate((next: NativeDeviceSettingsSnapshot) => {
    const nativeWindow = window as DeviceSettingsTestWindow;
    const reply = nativeWindow.nativeDeviceSettingsReplies?.shift();
    if (!reply) {
      throw new Error("No native settings request is waiting for a reply");
    }
    nativeWindow["__OPENCLAW_NATIVE_DEVICE_SETTINGS__"] = next;
    reply(next);
  }, snapshot);
}

const suite = createControlUiE2eSuite({
  name: "Control UI native device settings E2E",
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const desktopOptions = {
  colorScheme: "light",
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { width: 1440, height: 1800 },
} as const;

async function withDevice(
  snapshot: NativeDeviceSettingsSnapshot,
  run: (page: Page) => Promise<void>,
) {
  await suite.withPage(desktopOptions, async ({ page }) => {
    await installDeviceSettingsBridge(page, snapshot);
    await installMockGateway(page, { operatorScopes: ["operator.read"] });
    expect((await page.goto(`${suite.server.baseUrl}settings/device`))?.status()).toBe(200);
    await run(page);
  });
}

suite.define(() => {
  for (const colorScheme of ["light", "dark"] as const) {
    it(`edits this iPhone in embedded settings in ${colorScheme}`, async () => {
      const viewport = { width: 375, height: 812 };
      await suite.withPage(
        { viewport, colorScheme, hasTouch: true, locale: "en-US", serviceWorkers: "block" },
        async ({ page }) => {
          const snapshot = createIosNativeDeviceSettingsSnapshot();
          await installNativeEmbed(page, { platform: "ios", formFactor: "phone" });
          await installDeviceSettingsBridge(page, snapshot);
          await installMockGateway(page, { operatorScopes: ["operator.read"] });
          await page.goto(`${suite.server.baseUrl}settings`);
          const list = page.locator(".settings-embed-list");
          await list
            .locator(".settings-sidebar__group-label")
            .filter({ hasText: /^This iPhone$/ })
            .waitFor();
          await list.getByRole("link", { name: "This iPhone", exact: true }).click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/device");
          await page
            .locator(".native-embed-header")
            .getByRole("heading", { name: "This iPhone", exact: true })
            .waitFor();
          const devicePage = page.locator("openclaw-device-page");
          const appearance = devicePage.getByRole("combobox", { name: "Appearance", exact: true });
          await expect.poll(() => appearance.inputValue()).toBe("system");
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ).toBe(true);
          await appearance.scrollIntoViewIfNeeded();
          await appearance.selectOption("dark");
          await expectSetting(page, "app.appearance", "dark");
          snapshot.app = { ...snapshot.app, appearance: "dark" };
          await replyToDeviceSetting(page, snapshot);
          await expect.poll(() => appearance.inputValue()).toBe("dark");
          await page.locator(".native-embed-header__back").click();
          await list.locator('a[href="/settings/device/permissions"]').click();
          const permissionsPage = page.locator("openclaw-device-permissions-page");
          const precise = permissionsPage.locator(".settings-row").filter({
            has: page.locator(".settings-row__title").filter({ hasText: /^Precise location$/ }),
          });
          await precise
            .getByRole("button", { name: "Open Settings: Precise location", exact: true })
            .waitFor();
          expect(await precise.getByRole("switch").count()).toBe(0);
        },
      );
    });
  }

  it("edits this Mac without Gateway admin scope and hides device settings in browsers", async () => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    await withDevice(snapshot, async (page) => {
      const form = nativeForm(page);

      const sidebar = page.locator(".settings-sidebar");
      await sidebar
        .locator(".settings-sidebar__group-label")
        .filter({ hasText: /^\s*This Mac\s*$/ })
        .waitFor();
      await sidebar.locator('a[href="/settings/device"]').waitFor();
      const devicePage = page.locator("openclaw-device-page");
      const dockIcon = devicePage.getByRole("switch", { name: "Show Dock icon", exact: true });
      await expect.poll(() => dockIcon.isChecked()).toBe(true);
      expect(await dockIcon.isDisabled()).toBe(false);
      const messages = () => settingMessages(page);
      await expect.poll(messages).toContainEqual({ type: "status" });

      const sharing = devicePage.getByRole("switch", { name: "Desktop sharing", exact: true });
      const computerControl = devicePage.getByRole("switch", {
        name: "Allow Computer Control",
        exact: true,
      });
      await expect.poll(() => sharing.isChecked()).toBe(true);
      const sharingLabel = devicePage
        .locator(".settings-row__title")
        .filter({ hasText: /^Desktop sharing$/ });
      await sharingLabel.click();
      await expectSetting(page, "capabilities.desktopSharingEnabled", false);
      snapshot.capabilities.desktopSharingEnabled = false;
      await replyToDeviceSetting(page, snapshot);
      await expect.poll(() => sharing.isChecked()).toBe(false);
      expect(await computerControl.isChecked()).toBe(true);
      await sharingLabel.click();
      await expectSetting(page, "capabilities.desktopSharingEnabled", true);
      snapshot.capabilities.desktopSharingEnabled = true;
      await replyToDeviceSetting(page, snapshot);
      await expect.poll(() => sharing.isChecked()).toBe(true);

      const iconStyle = devicePage.getByRole("combobox", { name: "Dock icon", exact: true });
      await expect.poll(() => iconStyle.inputValue()).toBe("paper");
      await iconStyle.selectOption("origami");
      await expectSetting(page, "app.iconStyle", "origami");
      snapshot.app.iconStyle!.selectedId = "origami";

      await devicePage
        .locator(".settings-row__title")
        .filter({ hasText: /^Show Dock icon$/ })
        .click();
      await expectSetting(page, "app.showDockIcon", false);
      snapshot.app.showDockIcon = false;
      snapshot.app.quickChatShortcut = "⌘⇧Space";
      await replyToDeviceSetting(page, snapshot);
      await replyToDeviceSetting(page, snapshot);
      await devicePage.getByText("⌘⇧Space", { exact: true }).waitFor();
      await expect.poll(() => dockIcon.isChecked()).toBe(false);
      await expect.poll(() => iconStyle.inputValue()).toBe("origami");

      await sidebar.locator('a[href="/settings/device/permissions"]').click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/device/permissions");
      const permissionsPage = page.locator("openclaw-device-permissions-page");
      const notifications = permissionsPage.locator(".settings-row").filter({
        has: page.locator(".settings-row__title").filter({ hasText: /^Notifications$/ }),
      });
      await notifications
        .getByRole("button", { name: "Grant…: Notifications", exact: true })
        .click();
      await expect
        .poll(messages)
        .toContainEqual({ type: "request-permission", id: "notifications" });

      await sidebar.locator('a[href="/settings/updates"]').click();
      await form.button("Check for Updates…").click();
      await expect.poll(messages).toContainEqual({ type: "check-for-updates" });
    });

    await suite.withPage({ ...desktopOptions, colorScheme: undefined }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["voicewake.get", "voicewake.set"],
        deferredMethods: ["voicewake.set"],
        methodResponses: { "voicewake.get": { triggers: ["openclaw"] } },
      });
      for (const route of ["device", "device/permissions"]) {
        expect((await page.goto(`${suite.server.baseUrl}settings/${route}`))?.status()).toBe(200);
        await page.getByText(/only available inside the OpenClaw app/).waitFor();
        await page.locator('.settings-sidebar__item[href="/settings/devices"]').waitFor();
        expect(
          await page
            .locator(
              '.settings-sidebar__item[href="/settings/device"], .settings-sidebar__item[href="/settings/device/permissions"]',
            )
            .count(),
        ).toBe(0);
        expect(
          await page
            .locator(".settings-sidebar__group-label")
            .filter({ hasText: /^\s*This Mac\s*$/ })
            .count(),
        ).toBe(0);
      }
      await page.goto(`${suite.server.baseUrl}settings/talk`);
      const triggers = page.getByRole("textbox", { name: "Trigger words", exact: true });
      await expect.poll(() => triggers.inputValue()).toBe("openclaw");
      await triggers.fill("first phrase");
      await gateway.waitForRequest("voicewake.set");
      expect(await triggers.isEnabled()).toBe(true);
      expect(await triggers.evaluate((element) => element === document.activeElement)).toBe(true);
      await triggers.fill("second phrase");
      await gateway.deferNext("voicewake.set");
      await gateway.resolveDeferred("voicewake.set", { triggers: ["first phrase"] });
      await expect.poll(() => gateway.getRequests("voicewake.set")).toHaveLength(2);
      expect((await gateway.getRequests("voicewake.set"))[1]?.params).toEqual({
        triggers: ["second phrase"],
      });
      expect(await triggers.inputValue()).toBe("second phrase");
      expect(await triggers.evaluate((element) => element === document.activeElement)).toBe(true);
      await gateway.resolveDeferred("voicewake.set", { triggers: ["second phrase"] });
      await page
        .getByRole("status")
        .filter({ hasText: /^Saved$/ })
        .waitFor();
      expect(await triggers.inputValue()).toBe("second phrase");
    });
  });

  it("settles canceled cookie edits and preserves newer drafts across native replies and navigation", async () => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    snapshot.browser.cookieSync.enabled = true;
    snapshot.browser.cookieSync.state = "idle";
    await withDevice(snapshot, async (page) => {
      const devicePage = page.locator("openclaw-device-page");
      const sidebar = page.locator(".settings-sidebar");
      const profile = devicePage.getByRole("textbox", { name: "Target profile", exact: true });
      const revisit = async () => {
        await sidebar.locator('a[href="/settings/device/permissions"]').click();
        await page.locator("openclaw-device-permissions-page").waitFor();
        await sidebar.locator('a[href="/settings/device"]').click();
        await profile.waitFor();
      };
      const addDomain = async (domain: string) => {
        await devicePage.getByRole("textbox", { name: "Add hostname", exact: true }).fill(domain);
        await devicePage.getByRole("button", { name: "Add hostname", exact: true }).click();
      };
      const expectProfileRequest = (value: string) =>
        expectSetting(page, "browser.cookieSync.targetProfile", value);

      await addDomain("cancelled.example.com");
      await expectSetting(page, "browser.cookieSync.domains", [
        "example.com",
        "cancelled.example.com",
      ]);
      await revisit();
      const cancelledDomain = devicePage.getByRole("button", {
        name: "Remove cancelled.example.com",
        exact: true,
      });
      await cancelledDomain.waitFor();
      // Cancel returns the native owner's unchanged snapshot, without a matching-value ACK.
      await replyToDeviceSetting(page, snapshot);
      await expect.poll(() => cancelledDomain.count()).toBe(0);

      await addDomain("approved.example.com");
      await expectSetting(page, "browser.cookieSync.domains", [
        "example.com",
        "approved.example.com",
      ]);
      snapshot.browser.cookieSync.domains.push("approved.example.com");
      await replyToDeviceSetting(page, snapshot);

      await profile.fill("cancelled-profile");
      await revisit();
      await expectProfileRequest("cancelled-profile");
      await expect.poll(() => profile.inputValue()).toBe("cancelled-profile");
      await replyToDeviceSetting(page, snapshot);
      await expect.poll(() => profile.inputValue()).toBe("default");
      await expect.poll(() => cancelledDomain.count()).toBe(0);

      await profile.fill("first-profile");
      await profile.press("Tab");
      await expectProfileRequest("first-profile");
      await profile.fill("second-profile");
      await revisit();
      await expectProfileRequest("second-profile");
      await replyToDeviceSetting(page, snapshot);
      await expect.poll(() => profile.inputValue()).toBe("second-profile");
      snapshot.browser.cookieSync.targetProfile = "second-profile";
      await replyToDeviceSetting(page, snapshot);
      await expect.poll(() => profile.inputValue()).toBe("second-profile");

      // An external update must be visible once the latest request has settled.
      snapshot.browser.cookieSync.targetProfile = "external-profile";
      await page.evaluate((next: NativeDeviceSettingsSnapshot) => {
        (window as DeviceSettingsTestWindow)["__OPENCLAW_NATIVE_DEVICE_SETTINGS__"] = next;
        window.dispatchEvent(
          new CustomEvent("openclaw:native-device-settings-changed", { detail: next }),
        );
      }, snapshot);
      await expect.poll(() => profile.inputValue()).toBe("external-profile");
    });
  });
});
