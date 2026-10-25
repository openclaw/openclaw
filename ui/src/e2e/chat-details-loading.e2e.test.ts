import { expect, it, onTestFinished } from "vitest";
import { persistColdLoadWarmState } from "../../../scripts/lib/control-ui-bench-warm-state.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Details loading" });

suite.define(() => {
  it("keeps the warm Details column blank until its composition loads after the transcript", async () => {
    await suite.withPage({ viewport: { width: 1700, height: 900 } }, async ({ page }) => {
      const sessionKey = "agent:main:00000000-0000-4000-8000-00000000d201";
      const text = "The cached transcript is ready before Details.";
      await installMockGateway(page, {
        sessions: [
          {
            key: sessionKey,
            sessionId: "00000000-0000-4000-8000-00000000d201",
            kind: "direct",
            label: "Inspect reload",
            worktree: {
              id: "details-worktree",
              branch: "feature/details",
              repoRoot: "/workspace/details",
            },
          },
        ],
        historyMessages: [
          { role: "assistant", content: text, __openclaw: { id: "details-cached", seq: 1 } },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.locator(".chat-details-desktop-section").first().waitFor();
      await page.locator('aside.sidebar[data-snapshot-saved="true"]').waitFor();
      const warm = await page.evaluate(persistColdLoadWarmState, {
        sessionKey,
        sidebarView: "sessions",
      });
      expect(warm.messages).toBe(1);

      const module = await holdModuleResponse(
        page,
        controlUiE2eBuiltModuleRequest("ui/src/pages/chat/components/chat-details-session.tsx"),
      );
      onTestFinished(module.release);
      await page.reload();
      await page.locator(".chat-thread").getByText(text, { exact: true }).waitFor();
      const details = page.locator(".chat-details[data-open]");
      await details.waitFor();
      const moduleUrl = await module.request;
      expect(await details.locator(".chat-details-session").count()).toBe(0);
      expect(await details.locator("openclaw-panel-loading-skeleton").count()).toBe(0);
      const width = await details.evaluate((panel) => panel.getBoundingClientRect().width);
      expect(width).toBe(300);

      module.release();
      await page.evaluate(`import(${JSON.stringify(moduleUrl)}).then(() => undefined)`);
      await details.locator(".chat-details-session").waitFor();
      expect(await details.locator("openclaw-panel-loading-skeleton").count()).toBe(0);
      expect(await details.evaluate((panel) => panel.getBoundingClientRect().width)).toBe(width);
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
