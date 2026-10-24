import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Inline delegated work",
  startServerBeforeBrowser: true,
});
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
const launches = labels.map((label, index) => ({
  runId: "child-" + index,
  childSessionKey: "agent:main:subagent:review-" + index,
  label,
  groupId,
  status: "accepted",
}));
const message = (id: string, role: string, content: string, runId: string) => ({
  role,
  content,
  __openclaw: { id, runId },
  timestamp: Number(id.replace(/\D/g, "")) || 1,
});
const launchMessage = (count: number) => ({
  ...message("2", "assistant", "I’ll review the change before publishing it.", "review"),
  activity: launches.slice(0, count).map((receipt, index) => ({
    itemId: "tool:spawn-" + index,
    toolCallId: "spawn-" + index,
    name: "sessions_spawn",
    kind: "tool",
    title: receipt.label,
    phase: "end",
    status: "completed",
    delegation: [receipt],
  })),
});
const completionMessage = (count: number, failure: boolean) => ({
  ...message("3", "assistant", "The checks are finished.", "review"),
  activity: [
    {
      itemId: "tool:collect",
      toolCallId: "collect",
      name: "agents_wait",
      kind: "tool",
      title: "Collect review results",
      phase: "end",
      status: "completed",
      delegation: launches.slice(0, count).map((receipt, index) => ({
        runId: receipt.runId,
        childSessionKey: receipt.childSessionKey,
        status: failure && index === count - 1 ? "timeout" : "done",
      })),
    },
  ],
});

suite.define(() => {
  it.each([
    { name: "desktop", width: 1440, height: 900, count: 6, failure: false },
    { name: "mobile", width: 390, height: 844, count: 1, failure: true },
  ])("keeps delegated work inline through completion and reload on $name", async (viewport) => {
    const proofDir = createControlUiE2eArtifactDir("inline-delegation-" + viewport.name);
    await suite.withPage({ viewport }, async ({ page }) => {
      const children = launches.slice(0, viewport.count).map((receipt, index) => ({
        key: receipt.childSessionKey,
        kind: "direct",
        sessionId: receipt.runId,
        label: receipt.label,
        parentSessionKey: sessionKey,
        spawnedBy: sessionKey,
        swarmGroupId: groupId,
        status: index < 4 ? "done" : "running",
        runtimeMs: 42000,
        updatedAt: 1,
      }));
      const parent = {
        updatedAt: 1,
        key: sessionKey,
        kind: "direct",
        label: "Review and publish",
        sessionId: "parent",
        swarm: {
          otherActiveGroups: 0,
          groups: [
            {
              groupId,
              createdAt: 1,
              queued: 0,
              running: Math.max(0, viewport.count - 4),
              done: Math.min(viewport.count, 4),
              failed: 0,
              children: children.map((row) => ({ sessionKey: row.key, status: row.status })),
            },
          ],
        },
      };
      const initial = [
        message("1", "user", "Review the change and publish the PR.", "review"),
        launchMessage(viewport.count),
      ];
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [parent, ...children],
        historyMessages: initial,
        methodResponses: {
          "sessions.list": chatSessionListResponse([parent, ...children]),
          "sessions.describe": { session: parent },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const activity = page.locator('[data-test-id="chat-delegation"]');
      const summary = activity.locator(".chat-delegation__summary");
      await activity.waitFor();
      expect(await page.locator(".chat-footer [data-test-id=chat-delegation]").count()).toBe(0);
      await expect
        .poll(() => summary.getAttribute("aria-expanded"))
        .toBe(viewport.count > 5 ? "true" : "false");
      if (viewport.count > 5) {
        await expect
          .poll(() => activity.locator("[role=progressbar]").getAttribute("aria-valuenow"))
          .toBe("4");
        await expect.poll(() => activity.locator(".chat-delegation__task").count()).toBe(6);
      }
      const capture = async (name: string) => {
        const frame = await takeControlUiScreenshotFrame(page, activity, [summary], {
          scrollTo: activity,
          animations: "disabled",
        });
        await fs.writeFile(path.join(proofDir, name + ".png"), frame.png);
      };
      await capture("active");
      const completed = [
        ...initial,
        completionMessage(viewport.count, viewport.failure),
        message(
          "4",
          "assistant",
          "Review complete. The result is attached to this turn.",
          "review",
        ),
        message("5", "user", "Now look at the next change.", "next"),
      ];
      // Reload with only durable history. Registry summaries and child sessions have expired.
      const retiredParent = {
        updatedAt: 1,
        key: sessionKey,
        kind: "direct",
        label: "Review and publish",
        sessionId: "parent",
      };
      await gateway.setMethodResponse("chat.history", { messages: completed, sessionId: "parent" });
      await gateway.setMethodResponse("sessions.describe", { session: retiredParent });
      await gateway.setMethodResponse("sessions.list", chatSessionListResponse([retiredParent]));
      await page.reload();
      await expect
        .poll(() => summary.textContent())
        .toContain(viewport.failure ? "1 needing attention" : "Completed");
      await expect.poll(() => summary.getAttribute("aria-expanded")).toBe("false");
      expect(await activity.count()).toBe(1);
      const next = page.getByText("Now look at the next change.", { exact: true });
      expect(await activity.evaluate((element) => !element.closest(".chat-footer"))).toBe(true);
      await next.waitFor();
      const beforeNext = await next.evaluate((target) => {
        const element = document.querySelector('[data-test-id="chat-delegation"]');
        return element
          ? Boolean(element.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING)
          : false;
      });
      expect(beforeNext).toBe(true);
      await capture("completed");
      await summary.click();
      await expect
        .poll(() => activity.locator(".chat-delegation__task").count())
        .toBe(viewport.count);
      expect(await activity.getByRole("button", { name: labels[0], exact: true }).count()).toBe(0);
      await capture("details");
      console.info("Inline delegation proof: " + proofDir);
    });
  });
});
