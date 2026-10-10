import { expect, it } from "vitest";
import { openChatSidePanelType } from "../e2e/chat-side-panel.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "../e2e/control-ui-built-module.test-support.ts";
import { createControlUiE2eSuite } from "../e2e/control-ui-e2e-suite.test-support.ts";
import { waitForControlUiGatewayReady } from "./control-ui-e2e-readiness.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  navigateToControlUiSession,
} from "./control-ui-e2e.ts";

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
        await waitForControlUiGatewayReady(page);
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

  it("navigates through a lazily loaded readiness hook after reload", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const key = "agent:main:lazy-readiness-navigation";
      const requests: string[] = [];
      const readinessModule = controlUiE2eBuiltModuleRequest(
        "ui/src/app/control-ui-readiness-lit.ts",
      );
      page.on("request", (request) => {
        if (readinessModule.test(request.url())) {
          requests.push(request.url());
        }
      });
      await installMockGateway(page, {
        awaitInitialRoster: false,
        sessions: [{ key, label: "Lazy navigation target", kind: "direct", updatedAt: 1 }],
        historyMessages: [{ role: "assistant", content: "Navigated after reloading." }],
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await page.reload();
      await page.locator(".new-session-page__message").waitFor();
      expect(requests).toEqual([]);
      await navigateToControlUiSession(page, key);
      await page.getByText("Navigated after reloading.", { exact: true }).waitFor();
      expect(requests).toHaveLength(1);
      expect(await page.evaluate(() => window.openclawControlUi?.snapshot().sessionKey)).toBe(key);
    });
  });

  it.each([false, true])(
    "catches up after boot, navigation, and terminal activation before its first read (offline: %s)",
    async (offline) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const key = "agent:main:late-readiness";
        const requests: string[] = [];
        const readinessModule = controlUiE2eBuiltModuleRequest(
          "ui/src/app/control-ui-readiness-lit.ts",
        );
        page.on("request", (request) => {
          if (readinessModule.test(request.url())) {
            requests.push(request.url());
          }
        });
        const gateway = await installMockGateway(page, {
          awaitInitialRoster: false,
          sessionKey: key,
          terminalEnabled: true,
          featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
          sessions: [{ key, label: "Late readiness conversation", kind: "direct", updatedAt: 1 }],
          historyMessages: [{ role: "assistant", content: "Ready before diagnostics." }],
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await page.locator(".agent-chat__composer-combobox textarea").waitFor();
        await page.locator(`[data-session-key="${key}"] .sidebar-recent-session__link`).click();
        await page.getByText("Ready before diagnostics.", { exact: true }).waitFor();
        await openChatSidePanelType(page, "Terminal");
        await page.locator("openclaw-terminal-panel .tp-host canvas").waitFor();
        if (offline) {
          await gateway.setOnline(false);
          // The rail exposes status on the visible profile control, not its clipped text.
          await page.getByRole("button", { name: /Reconnecting…/ }).waitFor();
        }
        expect(requests).toEqual([]);

        await page.waitForFunction(() => window.openclawControlUi?.snapshot().ready === true);
        const snapshot = await page.evaluate(() => window.openclawControlUi?.snapshot());
        expect(snapshot).toMatchObject({
          booted: true,
          gatewayPhase: offline ? "reconnecting" : "connected",
          sessionKey: key,
          terminalActivationReady: !offline,
          route: { matches: [{ routeId: "chat" }] },
        });
        if (!offline) {
          expect(snapshot).toMatchObject({ routeReady: true, rosterReady: true });
        }
        expect(requests).toHaveLength(1);
      });
    },
  );
});
