import { expect, it, onTestFinished } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mobile Details loading" });

suite.define(() => {
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
