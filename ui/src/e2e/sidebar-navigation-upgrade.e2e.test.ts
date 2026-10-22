import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  installPreferenceServer,
  expectCount,
  seedStorage,
} from "./sidebar-assertions.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Rail shortcut storage upgrade" });
const legacyEntries = ["route:agents-home", "plugin:reports/daily", "session:agent:main:planning"];
const sessions = [
  { key: "agent:main:planning", kind: "direct" as const, label: "Planning", pinned: true },
];
const appearance = {
  theme: "claw",
  themeMode: "dark",
  navWidth: 333,
  textScale: 110,
  realtimeTalkInputDeviceId: "synthetic-microphone",
  pinnedAgentIds: ["research"],
};

suite.define(() => {
  it.each([false, true])(
    "ignores the Team-seeded sidebar identity without writing preferences (saved=%s)",
    async (saved) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const key = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
        const stable = {
          gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
          ...appearance,
          sidebarEntries: legacyEntries,
          sidebarPinnedRoutes: ["sessions", "dashboards", "systems", "usage"],
          navigationByProfile: { alex: { sidebarEntries: legacyEntries } },
        };
        await seedStorage(page, { [key]: JSON.stringify(stable) });
        const gateway = await installMockGateway(page, {
          assistantName: "Atlas",
          sessions,
          presenceUsers: [{ id: "alex", name: "Alex", self: true }],
          controlUiTabs: [{ id: "daily", label: "Reports", pluginId: "reports", icon: "plug" }],
          featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
          methodResponses: {
            "config.get": {
              config: { ui: { prefs: { sidebarEntries: legacyEntries } } },
              hash: "legacy-navigation",
            },
            "users.prefs.get": {
              status: "ok",
              entries: saved
                ? { "ui.themeMode": "dark", "ui.sidebarEntries": legacyEntries }
                : { "ui.themeMode": "dark" },
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        await gateway.waitForRequest("users.prefs.get");
        await page.locator('[data-session-key="agent:main:planning"]').first().waitFor();
        const pins = page.locator("openclaw-app-sidebar .sidebar-rail .sidebar-rail__pin");
        await expectCount(pins, 0);
        expect(await gateway.getRequests("users.prefs.set")).toEqual([]);
        expect(await gateway.getRequests("sessions.list", { pinned: true })).toEqual([]);
        expect(
          await page.evaluate(
            (storageKey) => JSON.parse(localStorage.getItem(storageKey) ?? "{}"),
            key,
          ),
        ).toMatchObject(appearance);
        expect(await gateway.getRequests("config.patch")).toEqual([]);
        expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      });
    },
  );

  it("ignores stable browser sidebar order and pins, then retains a dragged shortcut after reload", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ context, page }) => {
      const key = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await seedStorage(
        page,
        {
          [key]: JSON.stringify({
            sidebarEntries: legacyEntries,
            sidebarPinnedRoutes: ["agents-home", "dashboards", "systems", "usage"],
          }),
        },
        "legacy-browser-seeded",
      );
      const gateway = await installMockGateway(page, { sessions });
      await page.goto(suite.server.baseUrl + "chat");
      const sidebar = page.locator("openclaw-app-sidebar");
      const rail = sidebar.locator(".sidebar-rail__pins");
      const source = sidebar.locator('[data-session-key="agent:main:planning"]').first();
      await source.waitFor();
      expect(await rail.locator(".sidebar-rail__pin").count()).toBe(0);
      const sibling = await context.newPage();
      const siblingShortcut = sibling
        .locator(".sidebar-rail")
        .getByRole("link", { name: "Planning", exact: true });
      await installMockGateway(sibling, { sessions });
      await sibling.goto(suite.server.baseUrl + "chat");
      await sibling.locator('[data-session-key="agent:main:planning"]').first().waitFor();
      expect(await sibling.locator(".sidebar-rail__pin").count()).toBe(0);
      await source.dragTo(rail, { targetPosition: { x: 20, y: 80 } });
      const shortcut = rail.getByRole("link", { name: "Planning", exact: true });
      await shortcut.waitFor();
      await siblingShortcut.waitFor();
      await expect
        .poll(() =>
          page.evaluate(
            (storageKey) => JSON.parse(localStorage.getItem(storageKey) ?? "{}").railShortcuts,
            key,
          ),
        )
        .toEqual(["session:agent:main:planning"]);
      expect(await gateway.getRequests("users.prefs.set")).toEqual([]);
      await page.reload();
      await shortcut.waitFor();
      expect(await rail.locator(".sidebar-rail__pin").count()).toBe(1);
      await sibling.reload();
      await siblingShortcut.waitFor();
    });
  });

  it.each(["recorded", "missing", "corrupt", "fresh-confirmed"] as const)(
    "discards legacy pending sidebar replay while preserving appearance (%s)",
    async (baseline) => {
      await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
        const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
        const scope = controlUiBundledGatewayUrl(suite.server.baseUrl) + ":profile:alex";
        const pendingKey = "openclaw.control.serverPrefs.pending.v1:" + scope;
        const lastSeenKey = "openclaw.control.serverPrefs.v1:" + scope;
        const stored = {
          [storageKey]: JSON.stringify({ sidebarEntries: ["route:plugins"], themeMode: "dark" }),
          [pendingKey]: JSON.stringify({ sidebarEntries: ["route:plugins"], accent: "#ff0000" }),
        };
        if (baseline !== "missing") {
          stored[lastSeenKey] =
            baseline === "corrupt"
              ? "{"
              : JSON.stringify({
                  sidebarEntries: ["route:usage"],
                  ...(baseline === "fresh-confirmed"
                    ? { navigationConfirmation: { sidebarEntries: "fresh-read" } }
                    : {}),
                });
        }
        await seedStorage(page, stored);
        const gateway = await installMockGateway(page, {
          heldMethods: ["connect"],
          sessions,
          presenceUsers: [{ id: "alex", name: "Alex", self: true }],
          featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
        });
        await page.goto(suite.server.baseUrl + "chat");
        await gateway.waitForRequest("connect");
        await installPreferenceServer(page, {
          "ui.sidebarEntries": legacyEntries,
          "ui.themeMode": "dark",
        });
        await gateway.resolveDeferred("connect");
        await page.locator('[data-session-key="agent:main:planning"]').first().waitFor();
        await expect
          .poll(async () =>
            (await gateway.getRequests("users.prefs.set")).map((request) => request.params),
          )
          .toEqual([{ entries: { "ui.accent": "#ff0000" } }]);
        expect(await page.locator(".sidebar-rail__pin").count()).toBe(0);
        await expect
          .poll(() =>
            page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), pendingKey),
          )
          .toBeNull();
      });
    },
  );
});
