import { expect, it } from "vitest";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Notification agent scope",
  startServer: startControlUiE2eServer,
});

suite.define(() => {
  it("returns focus with a pending scope, preserves a newer draft and recovers a refused choice after navigation", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        reducedMotion: "reduce",
        permissions: ["notifications"],
        serviceWorkers: "block",
      },
      async ({ page }) => {
        // A registered browser endpoint, not a call to the OS or a vendor push service.
        await page.addInitScript(() => {
          const endpoint = "https://push.example.test/browser";
          const subscription = {
            endpoint,
            options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
            toJSON: () => ({ endpoint, keys: { auth: "fixture", p256dh: "fixture" } }),
          };
          Object.defineProperty(navigator.serviceWorker, "getRegistration", {
            value: async () => ({ pushManager: { getSubscription: async () => subscription } }),
          });
        });
        const user = {
          categories: {
            approvalRequested: true,
            agentFinished: false,
            agentQuestion: false,
            humanMentioned: false,
            scheduledTaskFailed: false,
          },
          detailLevel: "private",
          quietHours: { enabled: false, startMinute: 1320, endMinute: 420, timeZone: "UTC" },
          agentIds: [] as string[],
        };
        const device = { enabled: true, label: "Work browser" };
        const preferences = {
          durableIdentity: true,
          user,
          device,
          effective: { ...user, ...device },
        };
        const set = "push.web.preferences.set",
          get = "push.web.preferences.get";
        const gateway = await installMockGateway(page, {
          awaitInitialRoster: false,
          deferredMethods: [set],
          methodResponses: {
            "push.web.vapidPublicKey": { vapidPublicKey: "AQID" },
            "push.web.subscribe": {},
            [get]: preferences,
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [
                { id: "main", name: "Assistant" },
                { id: "research", name: "Research" },
              ],
            },
          },
        });
        await page.goto(suite.server.baseUrl + "settings/notifications");
        const rows = page.getByRole("button", { name: "Choose notification agents" });
        const dialog = page.getByRole("dialog", { name: "Choose notification agents" });
        const research = dialog.getByRole("checkbox", { name: "Research research" });
        const assistant = dialog.getByRole("checkbox", { name: "Assistant main" });
        const save = dialog.getByRole("button", { name: "Save", exact: true });
        await rows.first().click();
        await dialog.getByRole("combobox", { name: "Notify for" }).selectOption("specific");
        await research.check();
        await save.click();
        const write = await gateway.waitForRequest(set);
        expect(write.params).toMatchObject({
          scope: "user",
          preferences: { agentIds: ["research"] },
        });
        await expect
          .poll(() => rows.allTextContents())
          .toEqual(["Research", "Account default: Research"]);
        expect(await dialog.count()).toBe(0);
        expect(await rows.first().evaluate((el) => el === document.activeElement)).toBe(true);
        await page.getByRole("status").filter({ hasText: "Saving…" }).waitFor();
        await rows.first().click();
        expect(await research.isChecked()).toBe(true);
        expect(await save.isDisabled()).toBe(true);
        await assistant.check();
        await gateway.rejectDeferred(set, {
          code: "UNAVAILABLE",
          message: "The notification service is unavailable.",
        });
        await expect.poll(() => save.isEnabled()).toBe(true);
        expect(await assistant.isChecked()).toBe(true);
        await dialog.getByRole("button", { name: "Cancel" }).click();
        await expect
          .poll(() => rows.allTextContents())
          .toEqual(["All agents", "Account default: All agents"]);
        await page
          .getByRole("alert")
          .filter({ hasText: "The notification service is unavailable." })
          .waitFor();
        await page.locator('a[href="/settings/appearance"]').first().click();
        await page.locator(".settings-theme-card").first().waitFor();
        await page.locator('a[href="/settings/notifications"]').first().click();
        await rows.first().click();
        expect(await research.isChecked()).toBe(true);
        expect(await assistant.isChecked()).toBe(false);
        // Hold the readback too: even a successful write is not the confirmed selection yet.
        const beforeRead = await gateway.deferNext(get);
        await gateway.setMethodResponse(set, {});
        await save.click();
        expect((await gateway.waitForRequest(set, { after: 1 })).params).toEqual(write.params);
        await gateway.waitForRequest(get, { after: beforeRead });
        await page.getByRole("status").filter({ hasText: "Saving…" }).waitFor();
        await gateway.resolveDeferred(get, {
          ...preferences,
          user: { ...user, agentIds: ["research"] },
        });
        await expect
          .poll(() => page.getByRole("status").filter({ hasText: "Saving…" }).count())
          .toBe(0);
        expect(await rows.allTextContents()).toEqual(["Research", "Account default: Research"]);
      },
    );
  });
});
