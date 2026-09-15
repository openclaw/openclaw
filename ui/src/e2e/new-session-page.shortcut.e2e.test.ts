import { expect, it } from "vitest";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("opens a draft for the current agent without sending or discarding the chat draft", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const sessionKey = "agent:research:existing-session";
      const gateway = await installMockGateway(page, {
        sessionKey,
        methodResponses: {
          "agents.list": {
            agents: [{ id: "main" }, { id: "research" }],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "sessions.list": createdSessionListResult(sessionKey),
        },
      });
      await page.goto(`${suite.server.baseUrl}${controlUiSessionPath(sessionKey).slice(1)}`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Keep this unsent chat draft");
      // This proves the page's keyboard/navigation boundary, not browser-reserved accelerators.
      await composer.press("ControlOrMeta+Alt+n");
      await page.waitForURL((url) => url.pathname === "/new" && url.search === "?agent=research");
      await page.locator(".new-session-page__message").waitFor();
      await expect
        .poll(() =>
          page.locator(".new-session-page__select--agent .agent-select__label").textContent(),
        )
        .toBe("research");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await page.goBack();
      await expect.poll(() => composer.inputValue()).toBe("Keep this unsent chat draft");
    });
  });
});
