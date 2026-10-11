import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat side panel helper" });

suite.define(() => {
  it("keeps an already visible Subagents panel open and can reopen it after closing", async () => {
    await suite.withPage({}, async ({ page }) => {
      const parentKey = "agent:main:helper-parent";
      await installMockGateway(page, {
        sessionKey: parentKey,
        sessions: [
          {
            key: parentKey,
            kind: "direct",
            label: "Helper parent",
            hasActiveSubagentRun: true,
          },
          {
            key: "agent:main:subagent:helper-child",
            kind: "direct",
            label: "Helper child",
            spawnedBy: parentKey,
            hasActiveRun: true,
            activeRunIds: ["helper-child-run"],
          },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
      const panel = page.locator(
        'openclaw-chat-pane.chat-pane-cache__pane--active [data-panel-slot="subagents"]',
      );
      await panel.waitFor({ state: "visible" });

      await openChatSidePanelType(page, "Subagents");
      expect(await panel.isVisible()).toBe(true);

      await selectChatLayoutAction(page, "Subagents");
      await panel.waitFor({ state: "hidden" });
      await openChatSidePanelType(page, "Subagents");
      await panel.waitFor({ state: "visible" });
    });
  });
});
