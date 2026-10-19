import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import {
  logSwarmDiagnostic,
  type SwarmDiagnosticPane,
  type SwarmDiagnosticWindow,
} from "./chat-swarm-lifecycle-diagnostic.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Swarm lifecycle",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:dashboard:11111111-2222-4333-8444-555555555555";
const groupId = `swarm:${sessionKey}:11111111-2222-4333-8444-666666666666`;
const capture = (page: Page, dir: string, name: string) =>
  page.screenshot({ path: path.join(dir, name + ".png"), animations: "disabled" });
const expectVisible = (locator: Locator, visible = true) =>
  expect.poll(() => locator.isVisible()).toBe(visible);
const expectCount = (locator: Locator, count: number) =>
  expect.poll(() => locator.count()).toBe(count);
const expectHeader = (widget: Locator, text: string) =>
  expect.poll(() => widget.locator(".chat-swarm__header").textContent()).toContain(text);
const makeParent = (updatedAt: number) => ({
  key: sessionKey,
  sessionId: `session:${sessionKey}`,
  kind: "direct",
  label: "Research comparison",
  updatedAt,
});
const swarm = <T>(group: T) => ({ groups: [group], otherActiveGroups: 0 });
function makeGroup(
  createdAt: number,
  children: { key: string; status: string }[],
  counts: Partial<Record<"queued" | "running" | "done" | "failed", number>>,
) {
  return {
    groupId,
    createdAt,
    queued: 0,
    running: 0,
    done: 0,
    failed: 0,
    ...counts,
    children: children.map(({ key, status }) => ({ sessionKey: key, status })),
  };
}
const changeEvent = { sessionKey, agentId: "main", reason: "swarm" };

suite.define(() => {
  it.each([
    { name: "desktop", width: 1440, height: 900, count: 1 },
    { name: "desktop-many", width: 1440, height: 900, count: 30 },
    { name: "mobile", width: 390, height: 844, count: 1 },
    { name: "mobile-many", width: 390, height: 844, count: 30 },
  ])("collapses successful child runs without hiding their details on $name", async (viewport) => {
    const proofDir = createControlUiE2eArtifactDir(`completed-swarm-${viewport.name}`);
    await suite.withPage(
      { viewport, hasTouch: viewport.name.startsWith("mobile") },
      async ({ page }) => {
        const children = Array.from({ length: viewport.count }, (_, index) => ({
          key: `agent:main:subagent:completed-${index}`,
          sessionId: `session:agent:main:subagent:completed-${index}`,
          kind: "direct",
          label: "Research worker visibility after reconnect",
          parentSessionKey: sessionKey,
          swarmGroupId: groupId,
          status: "running",
          updatedAt: 1,
        }));
        const group = makeGroup(1, children, { running: viewport.count });
        const parent = {
          ...makeParent(1),
          swarm: swarm(group),
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessions: [parent, ...children],
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Research results are in the conversation." }],
            },
          ],
          methodResponses: {
            "sessions.list": chatSessionListResponse([parent, ...children]),
            "sessions.describe": { session: parent },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const widget = page.locator('[data-test-id="chat-swarm"]');
        const disclosure = widget.locator("details");
        const summary = disclosure.locator("summary");
        await expectCount(widget.locator(".chat-swarm__task"), viewport.count);
        expect(await widget.locator(".chat-swarm__markers").isVisible()).toBe(true);
        await capture(page, proofDir, "active");

        // The collector summary owns completion even while child rows are stale.
        const completedParent = {
          ...parent,
          status: "running",
          hasActiveRun: true,
          updatedAt: 2,
          swarm: swarm({
            ...group,
            running: 0,
            done: viewport.count,
            children: children.map((child) => ({ sessionKey: child.key, status: "done" })),
          }),
        };
        await gateway.setMethodResponse("sessions.describe", { session: completedParent });
        await gateway.setMethodResponse(
          "sessions.list",
          chatSessionListResponse([completedParent, ...children]),
        );
        await gateway.emitGatewayEvent("sessions.changed", changeEvent);
        await expectCount(
          widget.locator(".chat-swarm__tasks .chat-swarm__task-icon--done"),
          viewport.count,
        );
        await capture(page, proofDir, "completed");
        const box = await disclosure.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeLessThanOrEqual(64);
        expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect(await summary.textContent()).toContain(`${viewport.count} completed`);
        expect(await disclosure.getAttribute("open")).toBeNull();
        expect(await widget.locator(".chat-swarm__tasks").isVisible()).toBe(false);
        expect(await page.locator(".agent-chat__composer-combobox textarea").isVisible()).toBe(
          true,
        );
        await summary.focus();
        await page.keyboard.press("Enter");
        await expectVisible(
          widget.getByText("Child runs finished. The parent is processing their results."),
        );
        const outcomeClearance = await summary.evaluate((element) => {
          const pane = element.closest<SwarmDiagnosticPane>("openclaw-chat-pane");
          (window as SwarmDiagnosticWindow).openclawSwarmDiagnostic = {
            expandedDetails: element.parentElement,
            expandedEpoch: pane?.state?.connectionEpoch,
          };
          const outcome = element.parentElement?.querySelector(".chat-swarm__outcome");
          if (!outcome) {
            throw new Error("Expanded Swarm outcome is missing");
          }
          const range = document.createRange();
          range.selectNodeContents(outcome);
          const firstLine = range.getClientRects()[0];
          if (!firstLine) {
            throw new Error("Expanded Swarm outcome has no rendered text");
          }
          const style = getComputedStyle(element);
          const outlineWidth = Number.parseFloat(style.outlineWidth);
          const outlineBottom =
            element.getBoundingClientRect().bottom +
            Number.parseFloat(style.outlineOffset) +
            outlineWidth;
          return {
            focused: element.matches(":focus-visible"),
            outlineWidth,
            clearance: firstLine.top - outlineBottom,
          };
        });
        expect(outcomeClearance.focused).toBe(true);
        expect(outcomeClearance.outlineWidth).toBeGreaterThan(0);
        expect(outcomeClearance.clearance).toBeGreaterThanOrEqual(0);
        await capture(page, proofDir, "completed-details");

        // When the parent turn also settles, the card directs to the final response.
        const settledParent = {
          ...completedParent,
          status: "done",
          hasActiveRun: false,
          updatedAt: 3,
        };
        await gateway.setMethodResponse("sessions.describe", { session: settledParent });
        await gateway.setMethodResponse(
          "sessions.list",
          chatSessionListResponse([settledParent, ...children]),
        );
        await gateway.emitGatewayEvent("sessions.changed", changeEvent);
        try {
          await expectVisible(
            widget.getByText("Child runs finished. Check the conversation for the final response."),
          );
        } finally {
          await logSwarmDiagnostic(page, gateway, sessionKey).catch(() => {
            console.info("[swarm-final-diagnostic] unavailable");
          });
        }
        await capture(page, proofDir, "settled-details");
        await page.keyboard.press("Space");
        await expectVisible(widget.locator(".chat-swarm__tasks"), false);
        await page.reload();
        await expectCount(
          widget.locator(".chat-swarm__tasks .chat-swarm__task-icon--done"),
          viewport.count,
        );
        expect((await disclosure.boundingBox())!.height).toBeLessThanOrEqual(64);
        expect(await disclosure.getAttribute("open")).toBeNull();
        await summary.click();
        await expectVisible(widget.locator(".chat-swarm__tasks"));
      },
    );
  });
  it.each([
    { name: "desktop", width: 1440, height: 900, childAgent: "main" },
    { name: "mobile", width: 390, height: 844, childAgent: "main" },
    { name: "cross-agent", width: 1440, height: 900, childAgent: "worker" },
  ])("keeps a thirty-child outcome visible after the parent fails on $name", async (viewport) => {
    const proofDir = createControlUiE2eArtifactDir(`swarm-lifecycle-${viewport.name}`);
    await suite.withPage({ viewport, hasTouch: viewport.name === "mobile" }, async ({ page }) => {
      const now = Date.now();
      const children = Array.from({ length: 30 }, (_, index) => ({
        key: `agent:${viewport.childAgent}:subagent:research-${index}`,
        sessionId: `session:agent:${viewport.childAgent}:subagent:research-${index}`,
        kind: "direct",
        label: `Research lane ${index + 1}`,
        parentSessionKey: sessionKey,
        spawnedBy: sessionKey,
        swarmGroupId: groupId,
        status: index < 8 ? "running" : "queued",
        hasActiveRun: true,
        updatedAt: now,
        ...(index < 8 ? { startedAt: now - 1_000 } : {}),
      }));
      const parent = {
        ...makeParent(now),
        status: "running",
        hasActiveRun: true,
        swarm: swarm(makeGroup(now, children, { queued: 22, running: 8 })),
      };
      // Keep children outside the sidebar page so only real child hydration can
      // populate the chart. A whole-session fixture would hide a broken fetch.
      const listResponse = (rows: typeof children, parentRow = parent) => ({
        cases: [
          { match: { spawnedBy: sessionKey }, response: chatSessionListResponse(rows) },
          { match: {}, response: chatSessionListResponse([parentRow]) },
        ],
      });
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [parent, ...children],
        historyMessages: [
          { role: "assistant", content: [{ type: "text", text: "Research is running." }] },
        ],
        methodResponses: {
          "sessions.list": listResponse(children),
          "sessions.describe": { session: parent },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("sessions.list", { match: { spawnedBy: sessionKey } });
      const widget = page.locator('[data-test-id="chat-swarm"]');
      await widget.waitFor();
      await expectCount(widget.locator(".chat-swarm__task"), 30);
      await expectHeader(widget, "0 of 30");
      expect(
        await widget.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= innerHeight;
        }),
      ).toBe(true);
      await capture(page, proofDir, "active");
      const group = widget.locator("[data-swarm-group]");
      if (viewport.name === "mobile") {
        await group.locator("summary").tap();
      } else {
        await group.locator("summary").click();
      }
      await expectVisible(widget.locator(".chat-swarm__tasks"));
      const finalChild = widget.getByRole("listitem").filter({ hasText: "Research lane 30" });
      await expectVisible(finalChild.getByRole("img", { name: "Queued", exact: true }));
      await capture(page, proofDir, "active-details");

      const endedAt = now + 60_000;
      const completed = children.map((row, index) =>
        Object.assign(row, {
          status: index < 25 ? "done" : "failed",
          hasActiveRun: false,
          updatedAt: endedAt,
          startedAt: now,
          endedAt,
        }),
      );
      const failedParent = {
        ...parent,
        status: "failed",
        hasActiveRun: false,
        updatedAt: endedAt,
        swarm: swarm(makeGroup(now, completed, { done: 25, failed: 5 })),
      };
      await gateway.setSessionsListResponse(
        chatSessionListResponse([failedParent, ...completed.slice(18)]),
      );
      await gateway.setMethodResponse(
        "sessions.list",
        listResponse(completed.slice(18), failedParent),
      );
      await gateway.setMethodResponse("sessions.describe", { session: failedParent });
      const reads = (await gateway.getRequests("sessions.list", { spawnedBy: sessionKey })).length;
      await gateway.emitGatewayEvent("sessions.changed", changeEvent);
      await gateway.waitForRequest("sessions.list", {
        after: reads,
        match: { spawnedBy: sessionKey },
      });
      await expectCount(widget, 1);
      await expectHeader(widget, "30 of 30");
      expect(await widget.locator(".chat-swarm__marker--failed").count()).toBe(5);
      expect(await widget.locator(".chat-swarm__marker--done").count()).toBe(25);
      await expectVisible(finalChild.getByRole("img", { name: "Failed or stopped", exact: true }));
      await capture(page, proofDir, "terminal");
      await page.reload();
      await widget.waitFor();
      await expectCount(widget, 1);
      await expectHeader(widget, "30 of 30");
      await capture(page, proofDir, "terminal-reloaded");
    });
  });
});
