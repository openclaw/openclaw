import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const viewport = { width: 390, height: 844 };
const suite = createControlUiE2eSuite({
  name: "Control UI mobile Inbox sheet",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
});

async function setTheme(page: import("playwright").Page, theme: "dark" | "light") {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((nextTheme) => {
    const root = document.documentElement;
    root.dataset.themeMode = nextTheme;
    root.dataset.themeResolved = nextTheme;
    root.style.colorScheme = nextTheme;
  }, theme);
}

suite.define(() => {
  it("closes both mobile surfaces for Inbox destinations but keeps local actions in place", async () => {
    await suite.withPage(
      { viewport, reducedMotion: "reduce", serviceWorkers: "block" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          presenceUsers: [
            {
              self: true,
              id: "viewer",
              identity: { type: "profile", id: "viewer" },
              name: "Viewer",
            },
          ],
          featureMethods: [...defaultControlUiFeatureMethods, "mentions.list", "mentions.dismiss"],
          methodResponses: {
            "mentions.list": {
              gatewayInstanceId: "e2e-gateway-boot",
              revision: 1,
              items: [
                {
                  id: "mobile-mention",
                  senderProfileId: "riley",
                  senderLabel: "Riley",
                  sessionKey: "agent:main:main",
                  agentId: "main",
                  sessionTitle: "Release checklist",
                  messageId: "message-1",
                  createdAt: 1_000,
                  expiresAt: 10_000,
                },
              ],
            },
          },
        });
        await page.goto(suite.server.baseUrl + "activity");
        const panel = page.locator("#sidebar-issues-panel");
        const drawer = page.locator(".nav-drawer");
        const openInbox = async () => {
          await page.getByRole("button", { name: "Expand sidebar" }).click();
          await drawer.waitFor();
          await page.locator(".sidebar-issues-button:visible").click();
          await panel.waitFor();
        };
        const expectClosed = async () => {
          await panel.waitFor({ state: "hidden" });
          await page.locator('.nav-drawer[aria-hidden="true"]').waitFor({ state: "attached" });
        };
        await openInbox();
        expect(await panel.evaluate((element) => getComputedStyle(element).animationName)).toBe(
          "none",
        );
        await panel.getByRole("tab", { name: /Mentions/ }).click();
        expect(await drawer.getAttribute("aria-hidden")).toBeNull();
        await panel.getByRole("button", { name: "Close", exact: true }).click();
        await panel.waitFor({ state: "hidden" });
        expect(await drawer.getAttribute("aria-hidden")).toBeNull();
        await page.locator(".sidebar-issues-button:visible").click();
        await panel.locator('[data-mention-id="mobile-mention"] summary').click();
        await panel.locator('[data-mention-id="mobile-mention"] a').click();
        await waitForControlUiRoute(page, { pathname: "/chat/main", routeId: "chat" });
        await expectClosed();
        // An Inbox link to the already-open session must close the drawer too.
        await openInbox();
        await panel.locator('[data-mention-id="mobile-mention"] summary').click();
        await panel.locator('[data-mention-id="mobile-mention"] a').click();
        await expectClosed();
        expect(await gateway.getRequests("mentions.dismiss")).toHaveLength(0);
        await gateway.emitGatewayEvent("exec.approval.requested", {
          id: "mobile-approval",
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
          request: { command: "pnpm test", agentId: "main", sessionKey: "agent:main:main" },
        });
        await openInbox();
        await panel.locator('[data-approval-id="mobile-approval"] a').click();
        await expectClosed();
        expect(await gateway.getRequests("exec.approval.resolve")).toHaveLength(0);
        await openInbox();
        await panel.getByRole("link", { name: "Notification settings" }).click();
        await expectClosed();
        await waitForControlUiRoute(page, {
          pathname: "/settings/notifications",
          routeId: "notifications",
        });
      },
    );
  });

  it("rises from the bottom with a continuous header and compact close control", async () => {
    for (const theme of ["light", "dark"] as const) {
      const context = await suite.newBrowserContext({
        colorScheme: theme,
        deviceScaleFactor: 1,
        locale: "en-US",
        reducedMotion: "no-preference",
        serviceWorkers: "block",
        viewport,
      });
      const page = await context.newPage();
      await installMockGateway(page, { operatorScopes: ["operator.read", "operator.write"] });
      await page.goto(`${suite.server.baseUrl}activity`);
      await setTheme(page, theme);
      await page.getByRole("button", { name: "Expand sidebar" }).click();
      await page.locator(".nav-drawer").waitFor();
      await page.locator(".sidebar-issues-button:visible").click();
      const panel = page.locator("#sidebar-issues-panel");
      await panel.waitFor({ state: "attached" });

      const result = await panel.evaluate(async (element) => {
        const findEntrance = () =>
          element.getAnimations().find((candidate) => {
            const effect = candidate.effect;
            return effect instanceof KeyframeEffect && effect.target === element;
          });
        let animation = findEntrance();
        if (!animation) {
          // Finished animations disappear; replay real keyframes on loaded runners.
          element.style.animation = "none";
          void element.getBoundingClientRect();
          element.style.removeProperty("animation");
          animation = findEntrance();
        }
        if (!animation?.effect) {
          throw new Error("Expected the mobile Inbox sheet entrance animation");
        }
        const timing = animation.effect.getComputedTiming();
        // Rewind so start geometry is independent of runner scheduling.
        animation.pause();
        animation.currentTime = 0;
        const startTop = element.getBoundingClientRect().top;
        animation.play();
        await animation.finished;
        const close = element.querySelector<HTMLElement>(".sidebar-issues-panel__mobile-close")!;
        const header = element.querySelector<HTMLElement>(".sidebar-issues-panel__header")!;
        const list = element.querySelector<HTMLElement>(".sidebar-issues-panel__list-wrap")!;
        const tabTrack = element.querySelector<HTMLElement>(".sidebar-issues-panel__tabs")!;
        const tabTrackBounds = tabTrack.getBoundingClientRect();
        const tabs = Array.from(element.querySelectorAll<HTMLElement>(".hub-tab"));
        const paint = document.createElement("canvas").getContext("2d")!;
        paint.fillStyle = getComputedStyle(element).backgroundColor;
        paint.fillRect(0, 0, 1, 1);
        return {
          sheetBackgroundAlpha: paint.getImageData(0, 0, 1, 1).data[3],
          closeBackground: getComputedStyle(close).backgroundColor,
          closeHeight: close.getBoundingClientRect().height,
          closeWidth: close.getBoundingClientRect().width,
          duration: Number(timing.duration),
          finalTop: element.getBoundingClientRect().top,
          sheetBackground: getComputedStyle(element).backgroundColor,
          headerBackground: getComputedStyle(header).backgroundColor,
          tabsBackground: getComputedStyle(tabTrack).backgroundColor,
          listBackground: getComputedStyle(list).backgroundColor,
          startTop,
          tabCount: tabs.length,
          tabFailures: tabs.flatMap((tab, index) => {
            const label = Array.from(tab.childNodes).find(
              (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
            )!;
            const range = document.createRange();
            range.selectNodeContents(label);
            const text = range.getBoundingClientRect();
            const bounds = tab.getBoundingClientRect();
            const fits =
              text.width > 0 && text.left >= bounds.left - 1 && text.right <= bounds.right + 1;
            const ordered =
              index === 0
                ? Math.abs(bounds.left - tabTrackBounds.left - 16) < 0.05
                : bounds.left >= tabs[index - 1]!.getBoundingClientRect().right - 1;
            const inTrack = bounds.right <= tabTrackBounds.right + 0.05;
            return fits && ordered && inTrack ? [] : [tab.getAttribute("data-tab-value")];
          }),
        };
      });

      for (const tab of await panel.getByRole("tab").all()) {
        const id = await tab.getAttribute("id");
        expect(id).toMatch(/^sidebar-issues-tab-/u);
        await tab.click();
        await expect.poll(() => tab.getAttribute("aria-selected")).toBe("true");
        await expect
          .poll(() => panel.getByRole("tabpanel").getAttribute("aria-labelledby"))
          .toBe(id);
      }
      await panel.getByRole("button", { name: "Close", exact: true }).click();
      await panel.waitFor({ state: "hidden" });
      await suite.closeBrowserContext(context);
      expect(result.startTop).toBeGreaterThan(result.finalTop + 100);
      expect(result.duration).toBeGreaterThanOrEqual(200);
      // The shared sheet spring: ~0.3 s perceptual pace plus its settle tail.
      expect(result.duration).toBeLessThan(500);
      expect(result).toMatchObject({
        closeWidth: 36,
        closeHeight: 36,
      });
      expect(result.headerBackground).toBe("rgba(0, 0, 0, 0)");
      expect(result.tabsBackground).toBe(result.headerBackground);
      expect(result.sheetBackgroundAlpha).toBe(255);
      expect(result.listBackground).toBe(result.sheetBackground);
      expect(result.closeBackground).not.toBe("rgba(0, 0, 0, 0)");
      expect(result.tabCount).toBeGreaterThan(0);
      expect(result.tabFailures).toEqual([]);
    }
  });
});
