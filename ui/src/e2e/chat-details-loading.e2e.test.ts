import { expect, it, onTestFinished } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Details loading" });

suite.define(() => {
  it("loads the docked Details chunk while the transcript is held without mounting its body", async () => {
    await suite.withPage({ viewport: { width: 1700, height: 900 } }, async ({ page }) => {
      const module = await holdModuleResponse(
        page,
        controlUiE2eBuiltModuleRequest("ui/src/pages/chat/components/chat-details-session.tsx"),
      );
      onTestFinished(module.release);
      const gateway = await installMockGateway(page, {
        heldMethods: ["chat.startup"],
        sessions: [
          {
            key: "agent:main:main",
            sessionId: "loading-desktop-details",
            kind: "direct",
            label: "Inspect reload",
          },
        ],
        historyMessages: [{ role: "assistant", content: "The transcript is ready." }],
      });
      await page.goto(suite.server.baseUrl + "chat");
      await gateway.waitForRequest("chat.startup");
      const details = page.locator(".chat-details[data-open]");
      await details.waitFor();
      const moduleUrl = await module.request;
      expect(await details.locator(".chat-details-session").count()).toBe(0);
      expect(await details.locator("openclaw-panel-loading-skeleton").count()).toBe(0);

      module.release();
      await page.evaluate((url) => import(url).then(() => undefined), moduleUrl);
      expect(await details.locator(".chat-details-session").count()).toBe(0);
      const flashes = await details.evaluateHandle((element) => {
        let count = 0;
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (
                node instanceof Element &&
                (node.matches("openclaw-panel-loading-skeleton") ||
                  node.querySelector("openclaw-panel-loading-skeleton"))
              ) {
                count += 1;
              }
            }
          }
        });
        observer.observe(element, { childList: true, subtree: true });
        return {
          stop() {
            observer.disconnect();
            return count;
          },
        };
      });
      await gateway.resolveDeferred("chat.startup");
      await details.locator(".chat-details-session").waitFor();
      expect(await flashes.evaluate((probe) => probe.stop())).toBe(0);
      await flashes.dispose();
      expect(module.requests()).toBe(1);
    });
  });

  it("shows a skeleton on first open and settles after closing and reopening a pending Details view", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, hasTouch: true },
      async ({ page }) => {
        const module = await holdModuleResponse(
          page,
          controlUiE2eBuiltModuleRequest("ui/src/pages/chat/chat-details-mobile-host-content.tsx"),
        );
        onTestFinished(module.release);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await installMockGateway(page, {
          sessions: [
            {
              key: "agent:main:main",
              sessionId: "loading-details",
              kind: "direct",
              label: "Review release notes",
            },
          ],
        });
        await page.goto(suite.server.baseUrl + "chat");
        await page.locator(".mobile-header__title").waitFor();
        expect(module.requests()).toBe(0);
        const details = await openChatDetails(page);
        await module.request;
        const loading = details.getByRole("status", { name: "Loading…", exact: true });
        await loading.waitFor();
        expect(await loading.getByText("Loading…", { exact: true }).count()).toBe(0);
        expect(await loading.getAttribute("aria-busy")).toBe("true");
        await closeChatDetails(page);
        module.release();
        await page.locator(".chat-mobile-host").waitFor({ state: "hidden" });
        const reopened = await openChatDetails(page);
        await reopened.locator(".chat-details-mobile-root").waitFor();
        expect(await reopened.getByRole("status", { name: "Loading…", exact: true }).count()).toBe(
          0,
        );
        expect(module.requests()).toBe(1);
        expect(errors).toEqual([]);
      },
    );
  });
});
