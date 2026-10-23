import type { Page } from "playwright";
import { expect, it } from "vitest";
import { openChatSidePanelType } from "../e2e/chat-side-panel.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "../e2e/control-ui-built-module.test-support.ts";
import { createControlUiE2eSuite } from "../e2e/control-ui-e2e-suite.test-support.ts";
import { openChatPanels } from "./chat-layout-menu.ts";
import { waitForConfirmModal, waitForControlUiGatewayReady } from "./control-ui-e2e-readiness.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  navigateToControlUiSession,
} from "./control-ui-e2e.ts";

const suite = createControlUiE2eSuite({ name: "Initial roster navigation readiness" });
function trackReadinessRequests(page: Page) {
  const requests: string[] = [];
  const module = controlUiE2eBuiltModuleRequest("ui/src/app/control-ui-readiness-solid.ts");
  page.on("request", (request) => {
    if (module.test(request.url())) {
      requests.push(request.url());
    }
  });
  return requests;
}

suite.define(() => {
  it.each(["exec-approval-card", "gateway-switch", "session-worker-stop"])(
    "waits for delayed %s confirmation content rather than an unrelated open modal",
    async (contentClass) => {
      await suite.withPage({}, async ({ page }) => {
        // Exercise the helper's rendered-host contract without booting an unrelated page.
        // DOM order is not modal ownership: an existing detail dialog may follow the confirm host.
        await page.setContent(
          '<div id="pending-confirm"></div>' +
            '<openclaw-modal-dialog id="details"><dialog open>Channel details</dialog></openclaw-modal-dialog>' +
            '<button id="publish">Render confirmation</button>',
        );
        await page.evaluate((content) => {
          document.querySelector("#publish")!.addEventListener("click", () => {
            document.querySelector("#pending-confirm")!.innerHTML =
              '<openclaw-modal-dialog id="confirmation"><dialog open>' +
              '<div class="' +
              content +
              '"><div>Confirm logout</div>' +
              "<button>Cancel</button><button>Logout</button></div></dialog></openclaw-modal-dialog>";
          });
        }, contentClass);
        expect(await page.locator("." + contentClass).count()).toBe(0);
        const ready = waitForConfirmModal(
          page,
          page.locator("openclaw-modal-dialog").filter({ has: page.locator("." + contentClass) }),
        );
        await page.getByRole("button", { name: "Render confirmation", exact: true }).click();
        const confirmation = await ready;
        expect(await confirmation.getAttribute("id")).toBe("confirmation");
        expect(
          await confirmation.getByRole("button", { name: "Logout", exact: true }).isVisible(),
        ).toBe(true);
        expect(await page.locator("#details dialog").isVisible()).toBe(true);
      });
    },
  );

  it.each([
    { mode: "mobile", stale: false },
    { mode: "desktop", stale: false },
    { mode: "mobile", stale: true },
    { mode: "desktop", stale: true },
  ] as const)(
    "waits for the requested $mode Panels control (previous presentation visible: $stale)",
    async ({ mode, stale }) => {
      await suite.withPage({}, async ({ page }) => {
        await page.setContent(
          '<openclaw-chat-pane class="chat-pane-cache__pane--active"></openclaw-chat-pane>' +
            '<button id="publish">Render panel controls</button>',
        );
        await page.evaluate(
          ({ presentation, previous }) => {
            const pane = document.querySelector("openclaw-chat-pane")!;
            const renderControls = (mobile: boolean) => {
              pane.innerHTML = mobile
                ? '<div class="agent-chat__header--mobile"><openclaw-chat-header-session-menu>' +
                  '<button class="chat-header-session-menu__trigger" aria-expanded="false">Session actions</button>' +
                  '<div class="oc-menu" role="menu" hidden><button role="menuitem">Panels</button></div>' +
                  '</openclaw-chat-header-session-menu></div><div class="chat-mobile-host" hidden>Panel sheet</div>'
                : '<div class="sidebar-region__header">Session</div>' +
                  '<div class="sidebar-region__panels-toggle"><button aria-expanded="false">Panels</button></div>';
              const trigger = pane.querySelector("button")!;
              trigger.addEventListener("click", () => {
                pane.setAttribute(
                  "data-trigger-clicks",
                  String(Number(pane.getAttribute("data-trigger-clicks")) + 1),
                );
                trigger.setAttribute("aria-expanded", "true");
                pane.querySelector(".oc-menu")?.removeAttribute("hidden");
              });
              pane.querySelector('[role="menuitem"]')?.addEventListener("click", () => {
                pane.querySelector(".oc-menu")!.setAttribute("hidden", "");
                pane.querySelector(".chat-mobile-host")!.removeAttribute("hidden");
              });
            };
            if (previous) {
              renderControls(presentation !== "mobile");
            }
            document.querySelector("#publish")!.addEventListener("click", () => {
              renderControls(presentation === "mobile");
            });
          },
          { presentation: mode, previous: stale },
        );
        const pane = page.locator("openclaw-chat-pane");
        const target =
          mode === "mobile"
            ? pane.locator(".agent-chat__header--mobile")
            : pane.locator(".sidebar-region__panels-toggle");
        expect(await target.count()).toBe(0);
        const opened = openChatPanels(page, mode);
        // The caller owns the intended presentation; an old control can remain visible until commit.
        await page.getByRole("button", { name: "Render panel controls", exact: true }).click();
        const trigger = await opened;
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
        if (mode === "mobile") {
          expect(await pane.locator(".chat-mobile-host").isVisible()).toBe(true);
        }
        await openChatPanels(pane, mode);
        expect(await pane.getAttribute("data-trigger-clicks")).toBe("1");
      });
    },
  );

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
      const requests = trackReadinessRequests(page);
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
        const requests = trackReadinessRequests(page);
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
        const terminal = page.locator("openclaw-terminal-panel");
        await terminal.locator(".tp-session.is-current").click();
        await terminal.locator(".tp-host canvas").waitFor();
        if (offline) {
          await gateway.setOnline(false);
          await page
            .locator(".sidebar-shell__footer .gateway-status")
            .getByText("Reconnecting…", { exact: true })
            .waitFor();
        }
        expect(requests).toEqual([]);

        if (!offline) {
          await navigateToControlUiSession(page, key);
        }
        await page.waitForFunction(() => window.openclawControlUi?.snapshot().ready === true);
        const snapshot = await page.evaluate(() => window.openclawControlUi?.snapshot());
        expect(snapshot).toMatchObject({
          booted: true,
          gatewayPhase: offline ? "reconnecting" : "connected",
          sessionKey: key,
          terminalActivationReady: true,
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
