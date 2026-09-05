import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("matches full, mobile, and compact chat geometry", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { deferredMethods: ["chat.startup"] });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const loadingSkeleton = page.locator(
        '.chat-thread openclaw-panel-loading-skeleton[data-panel-skeleton="chat"]',
      );
      await loadingSkeleton.waitFor({ state: "visible" });

      const desktop = await loadingSkeleton.evaluate((element) => {
        const thread = element.closest<HTMLElement>(".chat-thread");
        const firstTurn = element.shadowRoot?.querySelector<HTMLElement>(".chat-turn");
        const userTurn = element.shadowRoot?.querySelector<HTMLElement>(
          '.chat-turn[data-skeleton-role="user"]',
        );
        const assistantTurn = element.shadowRoot?.querySelector<HTMLElement>(
          '.chat-turn[data-skeleton-role="assistant"]',
        );
        if (!thread || !firstTurn || !userTurn || !assistantTurn) {
          return null;
        }
        const skeletonWidth = element.getBoundingClientRect().width;
        return {
          assistantBackground: getComputedStyle(assistantTurn).backgroundColor,
          assistantWidthRatio: assistantTurn.getBoundingClientRect().width / skeletonWidth,
          firstTurnInset:
            firstTurn.getBoundingClientRect().top - thread.getBoundingClientRect().top,
          userBackground: getComputedStyle(userTurn).backgroundColor,
          userWidthRatio: userTurn.getBoundingClientRect().width / skeletonWidth,
        };
      });
      expect(desktop).not.toBeNull();
      expect(desktop!.firstTurnInset).toBeLessThan(80);
      expect(desktop!.assistantWidthRatio).toBeGreaterThan(0.9);
      expect(desktop!.userWidthRatio).toBeGreaterThan(0.64);
      expect(desktop!.userWidthRatio).toBeLessThan(0.72);
      expect(desktop!.assistantBackground).toBe("rgba(0, 0, 0, 0)");
      expect(desktop!.userBackground).not.toBe(desktop!.assistantBackground);

      await page.setViewportSize({ height: 844, width: 390 });
      const mobileUserWidthRatio = await loadingSkeleton.evaluate((element) => {
        const conversation = element.shadowRoot?.querySelector<HTMLElement>(".conversation");
        const userTurn = element.shadowRoot?.querySelector<HTMLElement>(
          '.chat-turn[data-skeleton-role="user"]',
        );
        return conversation && userTurn
          ? userTurn.getBoundingClientRect().width / conversation.getBoundingClientRect().width
          : null;
      });
      expect(mobileUserWidthRatio).not.toBeNull();
      expect(mobileUserWidthRatio!).toBeGreaterThan(0.84);
      expect(mobileUserWidthRatio!).toBeLessThan(0.92);

      await page.setViewportSize({ height: 900, width: 1280 });
      await page.evaluate(async () => {
        const compact = document.createElement("openclaw-panel-loading-skeleton");
        compact.setAttribute("data-panel-skeleton", "chat");
        compact.setAttribute("compact", "");
        document.body.replaceChildren(compact);
        await (compact as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
      });
      const compactSkeleton = page.locator(
        'openclaw-panel-loading-skeleton[data-panel-skeleton="chat"][compact]',
      );
      const compact = await compactSkeleton.evaluate((element) => {
        const conversation = element.shadowRoot?.querySelector<HTMLElement>(".conversation");
        const userTurn = element.shadowRoot?.querySelector<HTMLElement>(
          '.chat-turn[data-skeleton-role="user"]',
        );
        const assistantTurn = element.shadowRoot?.querySelector<HTMLElement>(
          '.chat-turn[data-skeleton-role="assistant"]',
        );
        if (!conversation || !userTurn || !assistantTurn) {
          return null;
        }
        const conversationWidth = conversation.getBoundingClientRect().width;
        return {
          assistantWidthRatio: assistantTurn.getBoundingClientRect().width / conversationWidth,
          userWidthRatio: userTurn.getBoundingClientRect().width / conversationWidth,
        };
      });
      expect(compact).not.toBeNull();
      expect(compact!.assistantWidthRatio).toBeGreaterThan(0.84);
      expect(compact!.assistantWidthRatio).toBeLessThan(0.92);
      expect(compact!.userWidthRatio).toBeGreaterThan(0.6);
      expect(compact!.userWidthRatio).toBeLessThan(0.68);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
