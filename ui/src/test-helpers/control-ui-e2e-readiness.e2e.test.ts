import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "./control-ui-e2e.ts";

const suite = createControlUiE2eSuite({ name: "Initial roster navigation readiness" });

suite.define(() => {
  it("resolves navigation only after a delayed roster has rendered", async () => {
    await suite.withPage({}, async ({ page }) => {
      const key = "agent:main:roster-only";
      const gateway = await installMockGateway(page, {
        awaitInitialRoster: true,
        deferredMethods: ["sessions.list"],
        sessions: [{ key, label: "Roster-only session", kind: "direct", updatedAt: 1 }],
      });
      const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      for (const [index, navigate] of [
        () => page.goto(`${suite.server.baseUrl}chat`, { waitUntil: "commit" }),
        () => page.reload({ waitUntil: "commit" }),
      ].entries()) {
        let navigated = false;
        const loaded = page.waitForEvent("domcontentloaded");
        const navigation = navigate().then((response) => {
          navigated = true;
          return response;
        });
        await loaded;
        await gateway.waitForRequest("sessions.list");
        await page.waitForLoadState("load");
        if (index === 0) {
          expect(await row.count()).toBe(0);
        }
        expect(navigated).toBe(false);
        expect(await page.evaluate(() => window.openclawControlUi?.snapshot().rosterReady)).toBe(
          false,
        );
        await gateway.resolveDeferred("sessions.list");
        expect((await navigation)?.ok()).toBe(true);
        expect(await row.count()).toBe(1);
        expect(
          await page.evaluate(() => {
            const snapshot = window.openclawControlUi?.snapshot();
            return {
              ready: snapshot?.ready,
              routeReady: snapshot?.routeReady,
              rosterReady: snapshot?.rosterReady,
              published:
                document.querySelector("openclaw-app")?.getAttribute("data-openclaw-ready") ===
                String(snapshot?.generation),
            };
          }),
        ).toEqual({ ready: true, routeReady: true, rosterReady: true, published: true });
      }
      expect(await page.goto("about:blank")).toBeNull();
      expect(await page.reload()).toBeNull();
    });
  });
});
