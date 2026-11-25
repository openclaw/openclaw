import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  chatSessionListResponse,
  waitForTranscriptScrollIdle,
  openAiAuthor,
} from "./chat-flow.test-support.ts";
import { swarmSnapshot } from "./chat-swarm.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Delegated work history" });
const sessionKey = "agent:main:dashboard:11111111-2222-4333-8444-555555555555";
const groupId = `swarm:${sessionKey}:review`;
const labels = [
  "Check release notes",
  "Review API contracts",
  "Verify desktop layout",
  "Check keyboard navigation",
  "Review accessibility",
  "Verify mobile layout",
];
const message = (
  id: string,
  role: string,
  content: unknown,
  timestamp: number,
  runId: string | null = "review",
) => ({
  role,
  ...(role === "assistant" ? openAiAuthor : {}),
  content,
  __openclaw: { id, ...(runId ? { runId } : {}) },
  timestamp,
});

suite.define(() => {
  it.each([
    { name: "desktop", width: 1440, height: 900, count: 6, failure: false },
    { name: "mobile", width: 390, height: 844, count: 1, failure: true },
  ])(
    "retains launch and collector results after child expiry and reload on $name",
    async (viewport) => {
      await suite.withPage({ viewport, locale: "en-US" }, async ({ page }) => {
        const children = labels.slice(0, viewport.count).map((label, index) => ({
          key: "agent:main:subagent:review-" + index,
          kind: "direct",
          sessionId: "child-" + index,
          label,
          parentSessionKey: sessionKey,
          spawnedBy: sessionKey,
          swarmGroupId: groupId,
          status: index < 4 ? "done" : "running",
          hasActiveRun: index >= 4,
          runtimeMs: 42_000,
          updatedAt: 1,
        }));
        const parent = {
          updatedAt: 1,
          key: sessionKey,
          kind: "direct",
          label: "Review and publish",
          sessionId: "parent",
          childSessions: children.map((child) => child.key),
          swarm: swarmSnapshot(groupId, 1, children),
        };
        const initial = [
          message("request", "user", "Review the change and publish the PR.", 1),
          message("intro", "assistant", "I’ll review the change before publishing it.", 2),
          message("peer", "user", "Please flag anything that blocks release.", 2, null),
          message(
            "launch",
            "assistant",
            children.map((child, index) => ({
              type: "toolCall",
              id: "spawn-" + index,
              name: "sessions_spawn",
              arguments: { label: child.label, task: "Review the assigned area.", groupId },
            })),
            2,
          ),
          ...children.map((child, index) => ({
            ...message(
              "spawn-result-" + index,
              "toolResult",
              [
                {
                  type: "text",
                  text: JSON.stringify({
                    status: "accepted",
                    runId: child.sessionId,
                    childSessionKey: child.key,
                    groupId,
                  }),
                },
              ],
              3,
            ),
            toolCallId: "spawn-" + index,
            toolName: "sessions_spawn",
          })),
        ];
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessions: [parent, ...children],
          historyMessages: initial,
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
        await pane
          .getByText("I’ll review the change before publishing it.", { exact: true })
          .waitFor();
        const swarm = pane.locator('.chat-thread [data-test-id="chat-inline-swarm"]');
        expect(await swarm.count()).toBe(0);
        await selectChatLayoutAction(pane, "Subagents");
        const panel = pane.locator("openclaw-chat-subagents-panel");
        await expect.poll(() => panel.locator("[data-session-key]").count()).toBe(viewport.count);
        await pane.getByRole("button", { name: "Close Subagents", exact: true }).click();
        await panel.waitFor({ state: "hidden" });

        const completed = [
          ...initial,
          message(
            "collect",
            "assistant",
            [
              {
                type: "toolCall",
                id: "collect",
                name: "agents_wait",
                arguments: { ids: children.map((child) => child.sessionId) },
              },
            ],
            4,
          ),
          {
            ...message(
              "collect-result",
              "toolResult",
              [
                {
                  type: "text",
                  text: JSON.stringify({
                    completed: children.map((child, index) => ({
                      runId: child.sessionId,
                      sessionKey: child.key,
                      status: viewport.failure && index === viewport.count - 1 ? "timeout" : "done",
                      result:
                        viewport.failure && index === viewport.count - 1
                          ? "Review timed out before completion."
                          : "Review completed without findings.",
                    })),
                    pending: [],
                  }),
                },
              ],
              5,
            ),
            toolCallId: "collect",
            toolName: "agents_wait",
          },
          message(
            "answer",
            "assistant",
            "Review complete. The result is attached to this turn.",
            6,
          ),
          message("next", "user", "Now look at the next change.", 7, "next"),
        ];
        // Child retention can expire independently of durable tool results.
        const retiredParent = {
          updatedAt: 1,
          key: sessionKey,
          kind: "direct",
          label: "Review and publish",
          sessionId: "parent",
        };
        const completedSwarm = swarmSnapshot(
          groupId,
          1,
          children.map((child) => ({ ...child, status: "done" })),
        );
        if (viewport.failure) {
          const group = completedSwarm.groups[0]!;
          group.done = 0;
          group.failed = 1;
          completedSwarm.groups[0] = { ...group, children: [] };
        }
        await gateway.setMethodResponse("chat.history", {
          messages: completed,
          sessionId: "parent",
        });
        await gateway.setMethodResponse("sessions.describe", {
          session: { ...retiredParent, swarm: completedSwarm },
        });
        await gateway.setMethodResponse("sessions.list", chatSessionListResponse([retiredParent]));
        await page.reload();
        await pane.getByText("Now look at the next change.", { exact: true }).waitFor();
        expect(await swarm.count()).toBe(0);
        // Open retained work, then any aggregates; standalone launches need no second group.
        await pane.locator(".chat-work-group .chat-activity-group__summary").click();
        const closedGroups = pane.locator(
          '.chat-activity-group:not(.chat-work-group) > .chat-activity-group__summary[aria-expanded="false"]',
        );
        while (await closedGroups.count()) {
          await closedGroups.first().click();
        }
        // Launches share one lifecycle row; the hidden wait becomes a row per outcome.
        const tools = pane.locator(".chat-tool-msg-summary");
        await expect.poll(() => tools.count()).toBe(2);
        await tools
          .first()
          .locator(".chat-tool-row__toggle")
          .click({ position: { x: 4, y: 4 } });
        if (viewport.count > 1) {
          // The shared row opens to one row per launch; each keeps its own receipt.
          await tools
            .nth(1)
            .locator(".chat-tool-row__toggle")
            .click({ position: { x: 4, y: 4 } });
        }
        const launchResult = pane.locator(".chat-tool-msg-body").first();
        await expect.poll(() => launchResult.textContent()).toContain("accepted");
        expect(await launchResult.textContent()).toContain(children[0]!.key);
        expect(await tools.last().textContent()).toContain(
          viewport.failure ? "An agent timed out" : `${viewport.count} agents finished`,
        );
        expect(await pane.locator('[data-test-id="chat-delegation"]').count()).toBe(0);
        expect(await pane.locator(".chat-thread .chat-subagent-activity").count()).toBe(0);
        // The retained tool stays with the completed request, before the next user turn.
        const next = pane.getByText("Now look at the next change.", { exact: true });
        // Expanded results can push the next turn past the mounted transcript window on a phone.
        const thread = pane.locator(".chat-thread");
        await waitForTranscriptScrollIdle(thread);
        await thread.hover({ position: { x: 16, y: 16 } });
        await page.mouse.wheel(0, await thread.evaluate((element) => element.scrollHeight));
        await waitForTranscriptScrollIdle(thread);
        await next.waitFor();
        const collectorBounds = await tools.last().boundingBox();
        const nextBounds = await next.boundingBox();
        expect(collectorBounds).not.toBeNull();
        expect(nextBounds).not.toBeNull();
        expect(collectorBounds!.y + collectorBounds!.height).toBeLessThan(nextBounds!.y);
      });
    },
  );
});
