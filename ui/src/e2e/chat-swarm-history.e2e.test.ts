import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import {
  seedChatSettings,
  sessionResponseCase,
  splitColumns,
} from "./chat-layout-fixtures.test-support.ts";
import { swarmSnapshot } from "./chat-swarm.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Swarm history freshness" });

suite.define(() => {
  it("keeps a completed Swarm outcome when compaction finishes in an unfocused pane", async () => {
    await suite.withPage({ viewport: { width: 1800, height: 1000 } }, async ({ page }) => {
      const parentKey = "agent:main:research";
      const otherKey = "agent:main:notes";
      const child = {
        key: "agent:main:subagent:research-worker",
        sessionId: "research-worker-session",
        kind: "direct",
        label: "Research worker",
        spawnedBy: parentKey,
        parentSessionKey: parentKey,
        swarmGroupId: `swarm:${parentKey}:research-run`,
        status: "done",
        updatedAt: 3,
      };
      const parent = {
        key: parentKey,
        sessionId: "research-session",
        kind: "direct",
        label: "Research",
        status: "done",
        hasActiveRun: false,
        updatedAt: 3,
        swarm: swarmSnapshot(child.swarmGroupId, 1, [child]),
      };
      const other = { key: otherKey, kind: "direct", label: "Notes", updatedAt: 3 };
      const researchMessage = (content: string) => ({
        role: "assistant",
        content,
        __openclaw: { id: "research-launch", runId: "research-run" },
        activity: [
          {
            itemId: "research-spawn",
            kind: "tool",
            title: "Research worker",
            phase: "end",
            status: "completed",
            delegation: [
              {
                runId: child.sessionId,
                childSessionKey: child.key,
                groupId: child.swarmGroupId,
                status: "accepted",
              },
            ],
          },
        ],
      });
      await seedChatSettings(page, suite.server.baseUrl, {
        chatSplitLayout: splitColumns([parent, other], 0),
      });
      const gateway = await installMockGateway(page, {
        sessionKey: parentKey,
        sessions: [parent, other, child],
        sessionTranscripts: {
          [parentKey]: { messages: [researchMessage("Research conversation.")] },
          [otherKey]: { messages: [{ role: "assistant", content: "Notes conversation." }] },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
      const cells = page.locator("openclaw-chat-page .chat-split-view__cell");
      await expect.poll(() => cells.count()).toBe(2);
      const research = cells.first().locator('openclaw-chat-pane[aria-hidden="false"]');
      const widget = research.locator('[data-test-id="chat-delegation"]');
      const outcome = widget
        .locator(".chat-delegation__summary")
        .getByText("Completed", { exact: true });
      await widget.locator(".chat-delegation__summary").click();
      await widget.getByRole("button", { name: "Research worker", exact: true }).waitFor();
      await expect.poll(() => outcome.isVisible()).toBe(true);
      // Finish compaction after the other pane replaces the primary session page.
      await gateway.deferNext("sessions.compact");
      const composer = research.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("/compact ");
      await composer.press("Enter");
      await gateway.waitForRequest("sessions.compact");
      await cells.last().locator(".agent-chat__composer-combobox textarea").focus();
      await expect.poll(() => page.url()).toBe(controlUiSessionUrl(suite.server.baseUrl, otherKey));

      await gateway.setMethodResponse("sessions.list", {
        cases: [
          { match: { spawnedBy: parentKey }, response: chatSessionListResponse([child]) },
          { match: {}, response: chatSessionListResponse([other]) },
        ],
      });
      await evaluateControlUiContext(
        page,
        async (context, key) => {
          const sessions = context.sessions;
          await sessions.refresh({ agentId: "main", force: true });
          if (sessions.state.result?.sessions.some((row) => row.key === key)) {
            throw new Error("Research parent must be outside the primary roster");
          }
        },
        parentKey,
      );
      await gateway.setMethodResponse(
        "chat.history",
        sessionResponseCase(
          { sessionKey: parentKey },
          {
            sessionId: parent.sessionId,
            messages: [researchMessage("Refreshed research results.")],
            sessionInfo: { ...parent, updatedAt: 2, status: "running", hasActiveRun: true },
          },
        ),
      );
      await gateway.resolveDeferred("sessions.compact", { ok: true, compacted: true });
      await research.getByText("Refreshed research results.", { exact: true }).waitFor();
      await expect.poll(() => outcome.isVisible()).toBe(true);
    });
  });
});
