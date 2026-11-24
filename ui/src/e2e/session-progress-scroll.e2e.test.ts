import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
} from "../test-helpers/control-ui-e2e.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps wheel disclosure on the compact Subagents progress card", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const parent = {
        key: "agent:main:workspace-review",
        kind: "direct",
        sessionId: "workspace-review",
        label: "Review workspace",
        updatedAt: Date.now(),
        hasActiveSubagentRun: true,
      } as const;
      const child = {
        key: "agent:main:subagent:reviewer",
        kind: "direct",
        sessionId: "workspace-review-child",
        classification: "subagent",
        spawnedBy: parent.key,
        label: "Check release notes",
        updatedAt: Date.now(),
      } as const;
      await installMockGateway(page, {
        sessionKey: parent.key,
        sessions: [parent, child],
        featureMethods: [...defaultControlUiFeatureMethods, "chat.history", "progressCard.get"],
        methodResponses: {
          "progressCard.get": {
            cases: [
              {
                match: { sessionKey: child.key },
                response: {
                  card: {
                    sessionKey: child.key,
                    revision: 1,
                    updatedAt: Date.now(),
                    steps: [
                      { step: "Read release notes", status: "completed" },
                      { step: "Compare the summary with the changes", status: "pending" },
                    ],
                  },
                },
              },
            ],
            fallback: { card: null },
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
      const pane = page.locator(".chat-pane-cache__pane--active");
      await openChatSidePanelType(pane, "Subagents");
      const panel = pane.locator("openclaw-chat-subagents-panel");
      await panel.locator(`[data-session-key="${child.key}"] .subagents-desktop__open`).click();
      const card = panel.locator('[data-progress-card-placement="composer"]');
      const summary = card.locator("summary");
      await summary.waitFor();
      if ((await card.getAttribute("open")) !== null) {
        await summary.click();
      }
      await expect.poll(() => card.getAttribute("open")).toBeNull();
      await summary.hover();
      await page.mouse.wheel(0, -1000);
      await expect.poll(() => card.getAttribute("open")).toBe("");
      await card
        .locator(".session-progress-card__body")
        .getByText("Compare the summary with the changes", { exact: true })
        .waitFor();
      await summary.press("Enter");
      await expect.poll(() => card.getAttribute("open")).toBeNull();
    });
  });
});
