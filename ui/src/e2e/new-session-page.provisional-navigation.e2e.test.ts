import { expect, it } from "vitest";
import { fillComposer } from "../test-helpers/composer-editor.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  navigateInApp,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("keeps a revoked provisional page display-only while the next route loads", async () => {
    const browser = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    let releaseRoute = () => {};
    const routeReady = new Promise<void>((resolve) => {
      releaseRoute = resolve;
    });
    try {
      const page = await browser.newPage();
      let loadingNextRoute = false;
      await page.route("**/assets/about-page-*.js*", async (route) => {
        loadingNextRoute = true;
        await routeReady;
        await route.continue();
      });
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await fillComposer(page.locator(".new-session-page__message"), "private pending draft");
      await gateway.deferNext("sessions.create");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      const request = await gateway.waitForRequest("sessions.create");
      // SAFETY: This is the mocked sessions.create request produced by the submit above.
      const params = request.params as { key: string };
      await expect
        .poll(() => page.locator(".chat-thread").textContent())
        .toContain("private pending draft");
      const display = await page.locator("openclaw-chat-page").evaluateHandle((element) => {
        let mountedPane = false;
        const observer = new MutationObserver((changes) => {
          for (const change of changes) {
            for (const node of change.addedNodes) {
              if (
                node instanceof Element &&
                (node.matches("openclaw-chat-pane") || node.querySelector("openclaw-chat-pane"))
              ) {
                mountedPane = true;
              }
            }
          }
        });
        observer.observe(element, { childList: true, subtree: true });
        return {
          read: () => ({ mountedPane, text: element.isConnected ? element.textContent : "" }),
          stop: () => observer.disconnect(),
        };
      });
      await navigateInApp(page, "about");
      await expect.poll(() => loadingNextRoute).toBe(true);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      const observed = await display.evaluate((value) => value.read());
      expect(observed.mountedPane).toBe(false);
      expect(await page.locator("openclaw-chat-pane").count()).toBe(0);
      expect(observed.text).not.toContain("private pending draft");
      await display.evaluate((value) => value.stop());
      expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
      const settings = await page.evaluate(() =>
        Object.keys(localStorage)
          .filter((key) => key.startsWith("openclaw.control.settings.v1"))
          .map((key) => localStorage.getItem(key)),
      );
      expect(settings.join("\n")).not.toContain(params.key);
      releaseRoute();
      await expect.poll(() => page.locator("openclaw-about-page").count()).toBe(1);
      const targetUrl = page.url();
      await gateway.resolveDeferred("sessions.create", {
        key: params.key,
        runStarted: true,
        runId: "late-run",
      });
      expect(page.url()).toBe(targetUrl);
      expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
    } finally {
      releaseRoute();
      await browser.close();
    }
  });
});
