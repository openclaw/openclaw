import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat side panel helper" });

suite.define(() => {
  it("keeps Subagents open when a batch starts during Layout opening, when visible, and after reopening", async () => {
    await suite.withPage({}, async ({ page }) => {
      const parentKey = "agent:main:helper-parent";
      const parent = {
        key: parentKey,
        sessionId: "helper-parent",
        kind: "direct",
        label: "Helper parent",
        hasActiveSubagentRun: false,
      } satisfies GatewaySessionRow;
      const child = {
        key: "agent:main:subagent:helper-child",
        sessionId: "helper-child",
        kind: "direct",
        label: "Helper child",
        spawnedBy: parentKey,
        parentSessionKey: parentKey,
        hasActiveRun: true,
        activeRunIds: ["helper-child-run"],
        updatedAt: Date.now(),
      } satisfies GatewaySessionRow;
      const gateway = await installMockGateway(page, {
        sessionKey: parentKey,
        sessions: [parent],
        historyMessages: [{ role: "assistant", content: "Ready for a batch." }],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
      const panel = page.locator(
        'openclaw-chat-pane.chat-pane-cache__pane--active [data-panel-slot="subagents"]',
      );
      await page.getByText("Ready for a batch.", { exact: true }).waitFor();
      const runningParent = { ...parent, hasActiveSubagentRun: true };
      await gateway.setSessionsListResponse({ sessions: [runningParent, child] });
      await page.evaluate(
        ({ parentRow, childRow }) => {
          const revealBatch = (event: Event) => {
            if (
              !(event.target instanceof HTMLElement) ||
              !event.target.matches(".chat-pane__layout-menu")
            ) {
              return;
            }
            document.removeEventListener("wa-show", revealBatch);
            (window as MockGatewayWindow).openclawControlUiE2eGateway?.emit("sessions.changed", {
              sessionKey: childRow.key,
              reason: "run-start",
              ts: childRow.updatedAt,
              session: childRow,
              ancestorSessions: [parentRow],
            });
          };
          document.addEventListener("wa-show", revealBatch);
        },
        { parentRow: runningParent, childRow: child },
      );
      await openChatSidePanelType(page, "Subagents");
      await panel.getByText(child.label!, { exact: true }).waitFor();

      await openChatSidePanelType(page, "Subagents");
      expect(await panel.isVisible()).toBe(true);

      await selectChatLayoutAction(page, "Subagents");
      await panel.waitFor({ state: "hidden" });
      await openChatSidePanelType(page, "Subagents");
      await panel.waitFor({ state: "visible" });
    });
  });
});
