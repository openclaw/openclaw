import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Swarm descriptor request volume" });

type SwarmSessionRow = GatewaySessionRow & {
  kind: string;
  label: string;
  updatedAt: number;
};

suite.define(() => {
  it("uses delivered swarm rows through frequent child updates and a new member", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const parentKey = "agent:main:swarm-describe-parent";
      const groupId = `swarm:${parentKey}:run`;
      const startedAt = Date.now();
      let children: SwarmSessionRow[] = Array.from({ length: 4 }, (_, index) => ({
        key: `agent:main:subagent:describe-worker-${index}`,
        sessionId: `describe-worker-${index}`,
        kind: "direct",
        agentId: "main",
        label: `Worker ${index + 1}`,
        spawnedBy: parentKey,
        parentSessionKey: parentKey,
        swarmGroupId: groupId,
        status: "running",
        hasActiveRun: true,
        archived: false,
        updatedAt: startedAt,
        snapshotAt: startedAt,
      }));
      const parentRow = (clock: number): SwarmSessionRow => ({
        key: parentKey,
        sessionId: "describe-parent",
        agentId: "main",
        kind: "direct",
        label: "Swarm request volume",
        status: "running",
        hasActiveRun: true,
        archived: false,
        updatedAt: clock,
        snapshotAt: clock,
        childSessions: children.map((child) => child.key),
        swarm: {
          groups: [
            {
              groupId,
              createdAt: startedAt,
              queued: 0,
              running: children.filter((child) => child.status === "running").length,
              done: children.filter((child) => child.status === "done").length,
              failed: 0,
              children: children.map((child) => ({
                sessionKey: child.key,
                status: child.status === "done" ? "done" : "running",
              })),
            },
          ],
          otherActiveGroups: 0,
        },
      });
      const gateway = await installMockGateway(page, {
        sessionKey: parentKey,
        sessions: [parentRow(startedAt), ...children],
        historyMessages: [{ role: "assistant", content: "Coordinating four workers." }],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
      const widget = page.locator('[data-test-id="chat-swarm"]');
      const tasks = widget.locator(".chat-swarm__task");
      const taskNames = widget.locator(".chat-swarm__task-name");
      await expect.poll(() => tasks.count()).toBe(4);
      await gateway.waitForRequest("sessions.list", {
        match: { spawnedBy: parentKey, limit: 10_000 },
      });
      const initialDescribes = (await gateway.getRequests("sessions.describe")).length;

      const publish = async (child: SwarmSessionRow, step: number, reason: string) => {
        const parent = parentRow(startedAt + step);
        await gateway.setMethodResponse("sessions.describe", { session: parent });
        await gateway.setMethodResponse(
          "sessions.list",
          chatSessionListResponse([parent, ...children]),
        );
        await gateway.emitGatewayEvent(step % 2 ? "session.message" : "sessions.changed", {
          sessionKey: child.key,
          agentId: "main",
          sessionId: child.sessionId,
          reason,
          ts: startedAt + step,
          session: child,
          ancestorSessions: [parent],
        });
        await expect.poll(() => taskNames.allTextContents()).toContain(child.label);
        await expect
          .poll(() => widget.locator(".chat-swarm__tasks .chat-swarm__task-icon--done").count())
          .toBe(children.filter((entry) => entry.status === "done").length);
      };
      for (let step = 1; step <= 12; step += 1) {
        const index = (step - 1) % 4;
        const status = Math.floor((step - 1) / 4) % 2 === 0 ? "done" : "running";
        const child = {
          ...children[index]!,
          label: `Worker ${index + 1}, update ${step}`,
          status,
          hasActiveRun: status === "running",
          updatedAt: startedAt + step,
          snapshotAt: startedAt + step,
        } satisfies GatewaySessionRow;
        children = children.map((entry, offset) => (offset === index ? child : entry));
        await publish(child, step, "run");
      }
      await expect
        .poll(() => widget.locator(".chat-swarm__outcome").textContent())
        .toContain("Child runs finished. The parent is processing their results.");
      const updateDescribes =
        (await gateway.getRequests("sessions.describe")).length - initialDescribes;
      expect.soft(updateDescribes).toBe(0);
      expect(await tasks.count()).toBe(4);

      const added = {
        ...children[0]!,
        key: "agent:main:subagent:describe-worker-4",
        sessionId: "describe-worker-4",
        label: "Worker 5, newly launched",
        status: "running",
        hasActiveRun: true,
        updatedAt: startedAt + 13,
        snapshotAt: startedAt + 13,
      } satisfies GatewaySessionRow;
      children = [...children, added];
      const beforeMember = (await gateway.getRequests("sessions.describe")).length;
      await publish(added, 13, "create");
      await expect.poll(() => tasks.count()).toBe(5);
      const memberDescribes =
        (await gateway.getRequests("sessions.describe")).length - beforeMember;
      expect(memberDescribes).toBeLessThanOrEqual(1);
      expect(
        (await taskNames.allTextContents()).toSorted((left, right) => left.localeCompare(right)),
      ).toEqual(
        children.map((child) => child.label).toSorted((left, right) => left.localeCompare(right)),
      );
      console.info("swarm-describe-churn", {
        events: 12,
        initialDescribes,
        updateDescribes,
        membershipEvents: 1,
        memberDescribes,
      });
    });
  });
});
