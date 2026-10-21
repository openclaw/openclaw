import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { swarmSnapshot } from "./chat-swarm.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Swarm descriptor request volume" });

suite.define(() => {
  it("uses delivered swarm rows through frequent child updates and a new member", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const parentKey = "agent:main:swarm-describe-parent";
      const groupId = `swarm:${parentKey}:run`;
      const startedAt = Date.now();
      const active = {
        kind: "direct",
        agentId: "main",
        status: "running",
        hasActiveRun: true,
        archived: false,
      };
      const clock = (step = 0) => ({ updatedAt: startedAt + step, snapshotAt: startedAt + step });
      const childRow = (
        index: number,
        label = `Worker ${index + 1}`,
        step = 0,
        status = "running",
      ) => ({
        ...active,
        ...clock(step),
        key: `agent:main:subagent:describe-worker-${index}`,
        sessionId: `describe-worker-${index}`,
        label,
        status,
        hasActiveRun: status === "running",
        spawnedBy: parentKey,
        parentSessionKey: parentKey,
        swarmGroupId: groupId,
      });
      let children = Array.from({ length: 4 }, (_, index) => childRow(index));
      const parentRow = (time: number) => ({
        ...active,
        key: parentKey,
        sessionId: "describe-parent",
        label: "Swarm request volume",
        updatedAt: time,
        snapshotAt: time,
        childSessions: children.map((child) => child.key),
        swarm: swarmSnapshot(groupId, startedAt, children),
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

      const publish = async (child: ReturnType<typeof childRow>, step: number, reason: string) => {
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
        const child = childRow(index, `Worker ${index + 1}, update ${step}`, step, status);
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

      const added = childRow(4, "Worker 5, newly launched", 13);
      children = [...children, added];
      const beforeMember = (await gateway.getRequests("sessions.describe")).length;
      await publish(added, 13, "create");
      await expect.poll(() => tasks.count()).toBe(5);
      const memberDescribes =
        (await gateway.getRequests("sessions.describe")).length - beforeMember;
      expect(memberDescribes).toBeLessThanOrEqual(1);
      expect((await taskNames.allTextContents()).toSorted()).toEqual(
        children.map((child) => child.label).toSorted(),
      );
    });
  });
});
