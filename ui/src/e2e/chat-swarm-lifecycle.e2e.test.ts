import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { swarmSnapshot } from "./chat-swarm.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Delegated work history" });
const sessionKey = "agent:main:dashboard:11111111-2222-4333-8444-555555555555";
const groupId = "release-review";
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
  runId = "review",
) => ({
  role,
  content,
  __openclaw: { id, runId },
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
        const pane = page.locator(".chat-pane-cache__pane--active");
        await pane
          .getByText("I’ll review the change before publishing it.", { exact: true })
          .waitFor();
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
        await gateway.setMethodResponse("chat.history", {
          messages: completed,
          sessionId: "parent",
        });
        await gateway.setMethodResponse("sessions.describe", { session: retiredParent });
        await gateway.setMethodResponse("sessions.list", chatSessionListResponse([retiredParent]));
        await page.reload();
        await pane.getByText("Now look at the next change.", { exact: true }).waitFor();
        // Opening the turn disclosure mounts its nested raw tool disclosure.
        const closedGroups = pane.locator('.chat-activity-group__summary[aria-expanded="false"]');
        while (await closedGroups.count()) {
          await closedGroups.first().click();
        }
        const tools = pane.locator(".chat-tool-msg-summary");
        await expect.poll(() => tools.count()).toBe(viewport.count + 1);
        await tools.first().click();
        const launchResult = pane.locator(".chat-tool-msg-body").first();
        await expect.poll(() => launchResult.textContent()).toContain("accepted");
        expect(await launchResult.textContent()).toContain(children[0]!.key);
        await tools.last().click();
        const collectorResult = pane.locator(".chat-tool-msg-body").last();
        await expect
          .poll(() => collectorResult.textContent())
          .toContain(
            viewport.failure
              ? "Review timed out before completion."
              : "Review completed without findings.",
          );
        expect(await collectorResult.textContent()).toContain(
          viewport.failure ? "timeout" : "done",
        );
        expect(await pane.locator('[data-test-id="chat-delegation"]').count()).toBe(0);
        expect(await pane.locator(".chat-thread openclaw-chat-subagent-activity").count()).toBe(0);
        // The retained tool stays with the completed request, before the next user turn.
        const next = pane.getByText("Now look at the next change.", { exact: true });
        const collectorBounds = await tools.last().boundingBox();
        const nextBounds = await next.boundingBox();
        expect(collectorBounds).not.toBeNull();
        expect(nextBounds).not.toBeNull();
        expect(collectorBounds!.y + collectorBounds!.height).toBeLessThan(nextBounds!.y);
      });
    },
  );
});
