import { expect, it } from "vitest";
import type { SessionGoal } from "../../../packages/gateway-protocol/src/schema/sessions-goal.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatMessage, exactButton, requireRecord } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI goal recovery" });
const viewport = { width: 1440, height: 900 };
const pageOptions = { viewport, colorScheme: "light" } as const;

function goalFixture(now: number, id: string, overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    schemaVersion: 1,
    id,
    objective: "Verify the sample deployment",
    status: "paused",
    createdAt: now,
    updatedAt: now,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
    ...overrides,
  };
}

function goalSessions(
  now: number,
  sessionId: string,
  goal: SessionGoal,
  extra: { displayName?: string } = {},
) {
  return {
    ts: now,
    path: "",
    count: 1,
    defaults: { model: "test-model", modelProvider: "test", contextTokens: 128_000 },
    sessions: [
      { key: "agent:main:main", sessionId, kind: "direct", updatedAt: now, goal, ...extra },
    ],
  };
}

suite.define(() => {
  it("lets an invalid Goal edit be corrected without reload or recovery", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const now = Date.now();
      const goal = goalFixture(now, "goal-edit");
      const method = "sessions.goal.update";
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:main",
        heldMethods: [method],
        methodResponses: {
          "sessions.list": goalSessions(now, "goal-edit-session", goal),
        },
      });
      await page.goto(`${suite.server.baseUrl}chat/main`);
      await exactButton(page, "Edit goal").click();
      const objective = page.locator(".agent-chat__composer-combobox textarea");
      const save = exactButton(page, "Save goal");
      const invalid = page.getByText("Goal update is invalid. Check the objective and try again.", {
        exact: true,
      });
      await objective.fill("x".repeat(16_001));
      await save.click();
      await expect
        .poll(
          async () => (await gateway.getRequests(method)).length > 0 || (await invalid.isVisible()),
        )
        .toBe(true);
      expect(await gateway.getRequests(method)).toHaveLength(0);
      expect(await invalid.isVisible()).toBe(true);
      expect(await exactButton(page, "Check outcome").count()).toBe(0);

      const corrected = "Verify only the sample deployment";
      await objective.fill(corrected);
      await save.click();
      const request = await gateway.waitForRequest(method);
      expect(request.params).toMatchObject({ action: "edit", objective: corrected });
      const committed = { ...goal, objective: corrected, updatedAt: now + 1 };
      // The real Gateway commits before ACK; later reads must see the same Goal.
      await gateway.setSessionsListResponse({
        sessions: [{ ...(await gateway.getSessionRow("agent:main:main")), goal: committed }],
      });
      await gateway.resolveDeferred(method, {
        status: "updated",
        goalId: goal.id,
        goal: committed,
      });
      await expect.poll(() => save.count()).toBe(0);
      // Release the Goal refresh after the ACK to exercise the losing read order.
      const lists = await gateway.deferNext("sessions.list");
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: "agent:main:main",
        agentId: "main",
        reason: "goal",
      });
      await gateway.waitForRequest("sessions.list", { after: lists });
      await gateway.resolveDeferred("sessions.list");
      await expect
        .poll(() => page.locator(".agent-chat__goal-objective").textContent())
        .toBe(corrected);
      expect(await gateway.getRequests(method)).toHaveLength(1);
      expect(await invalid.count()).toBe(0);
    });
  });

  it.each([
    { action: "pause", legacyScope: false },
    { action: "clear", legacyScope: false },
    { action: "resume", legacyScope: false },
    { action: "resume", legacyScope: true },
  ] as const)(
    "bounds $action recovery by its authenticated scope (empty scope=$legacyScope)",
    async ({ action, legacyScope }) => {
      await suite.withPage(pageOptions, async ({ page }) => {
        if (legacyScope) {
          await page.addInitScript(() => {
            Object.defineProperty(window.crypto, "subtle", { value: undefined });
          });
        }
        const now = Date.now();
        const goal = goalFixture(now, "goal-recovery", {
          status: action === "pause" ? "active" : "paused",
          createdAt: now - 60_000,
          pausedAt: now,
          tokensUsed: 100,
        });
        const sessions = goalSessions(now, "goal-recovery-session", goal, {
          displayName: "Deployment checks",
        });
        const method = action === "clear" ? "sessions.goal.clear" : "sessions.goal.update";
        const gateway = await installMockGateway(page, {
          sessionKey: "agent:main:main",
          heldMethods: [method],
          omitConnectHelloAuth: legacyScope,
          historyMessages: [chatMessage("assistant", "Deployment checks are ready.")],
          methodResponses: { "sessions.list": sessions },
        });
        await page.goto(`${suite.server.baseUrl}chat/main`);
        const original = exactButton(
          page,
          `${action.charAt(0).toUpperCase()}${action.slice(1)} goal`,
        );
        await original.waitFor();
        await page.clock.install();
        await original.click();
        if (legacyScope) {
          await page
            .getByText("Goal update was not sent because its recovery request could not be saved.")
            .waitFor();
          expect(await gateway.getRequests(method)).toHaveLength(0);
          expect(
            await page.evaluate(() =>
              Object.keys(sessionStorage).filter((key) =>
                key.startsWith("openclaw.control.goalOperation.v1:"),
              ),
            ),
          ).toHaveLength(0);
          await page.reload();
          await original.waitFor();
          expect(await exactButton(page, "Check outcome").count()).toBe(0);
          expect(await gateway.getRequests(method)).toHaveLength(0);
          return;
        }
        const first = await gateway.waitForRequest(method);
        const firstParams = requireRecord(first.params);
        if (action === "resume") {
          await page.locator(".agent-chat__goal-label").waitFor({ state: "visible" });
          expect(await page.locator(".agent-chat__goal-label").textContent()).toBe(
            "Resuming goal…",
          );
        }
        // Commit and publish the authoritative state while withholding only this RPC's ACK.
        const committed =
          action === "clear"
            ? undefined
            : {
                ...goal,
                status: action === "pause" ? "paused" : "active",
                updatedAt: now + 1_000,
              };
        await gateway.setSessionsListResponse({
          ...sessions,
          sessions: [{ ...sessions.sessions[0], goal: committed }],
        });
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: "agent:main:main",
          reason: "goal",
        });
        const sockets = await gateway.getSocketCount();
        for (let tick = 0; tick < 6; tick += 1) {
          await gateway.emitGatewayEvent("tick", { ts: Date.now() });
          await page.clock.fastForward(5_001);
        }
        if (action === "resume") {
          await page.clock.fastForward(1_001);
          const automatic = await gateway.waitForRequest(method, { after: 1 });
          expect(automatic.params).toEqual(first.params);
          await gateway.rejectDeferred(method, {
            code: "UNAVAILABLE",
            message: "ACK still unavailable",
          });
        } else if (committed) {
          await page.locator(`.agent-chat__goal--${committed.status}`).waitFor();
        } else {
          await expect.poll(() => page.locator(".agent-chat__goal").count()).toBe(0);
        }
        const checkOutcome = exactButton(
          page,
          action === "resume" ? "Retry resume" : "Check outcome",
        );
        await expect.poll(() => checkOutcome.isEnabled()).toBe(true);
        expect(await gateway.getSocketCount()).toBe(sockets);
        expect(await gateway.getRequests(method)).toHaveLength(action === "resume" ? 2 : 1);
        if (action === "resume") {
          await page.setViewportSize({ width: 390, height: 844 });
          await page.locator(".agent-chat__goal-label").waitFor({ state: "visible" });
          await checkOutcome.waitFor({ state: "visible" });
          expect(await checkOutcome.isVisible()).toBe(true);
          await page.setViewportSize(viewport);
        }
        await page.reload();
        await checkOutcome.waitFor();
        expect(await gateway.getRequests(method)).toHaveLength(0);
        expect(await original.count()).toBe(0);
        if (committed) {
          await page
            .locator(`.agent-chat__goal--${action === "resume" ? "resuming" : committed.status}`)
            .waitFor();
        } else {
          expect(await page.locator(".agent-chat__goal").count()).toBe(0);
        }
        await checkOutcome.click();
        const retried = await gateway.waitForRequest(method);
        expect(retried.params).toEqual(first.params);
        await gateway.resolveDeferred(method, {
          operationId: firstParams.operationId,
          action,
          status: action === "resume" ? "started" : action === "clear" ? "cleared" : "updated",
          goalId: goal.id,
          goal: committed,
          ...(action === "resume" ? { runId: "already-settled-run" } : {}),
          replayed: true,
        });
        await checkOutcome.waitFor({ state: "detached" });
        if (committed) {
          await exactButton(page, action === "pause" ? "Resume goal" : "Pause goal").waitFor();
        }
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests(method)).toHaveLength(1);
      });
    },
  );

  it("shows a failed Resume retry without retiring or replaying a different goal operation", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const now = Date.now();
      const method = "sessions.goal.update";
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:main",
        heldMethods: [method, "chat.startup"],
        historyMessages: [
          chatMessage("assistant", "Goal recovery context loaded.", { timestamp: now }),
        ],
        methodResponses: {
          "sessions.list": goalSessions(now, "goal-check-session", goalFixture(now, "goal-check")),
        },
      });
      const admitHistory = async () => {
        await gateway.waitForRequest("chat.startup");
        await gateway.resolveDeferred("chat.startup");
        await page.getByText("Goal recovery context loaded.", { exact: true }).waitFor();
      };
      await page.goto(`${suite.server.baseUrl}chat/main`);
      await gateway.waitForRequest("chat.startup");
      await page.locator(".agent-chat__goal-objective").waitFor();
      const resume = exactButton(page, "Resume goal");
      expect(await resume.count()).toBe(0);
      expect(await gateway.getRequests(method)).toHaveLength(0);
      await admitHistory();
      await page.clock.install();
      await resume.click();
      const first = await gateway.waitForRequest(method);
      expect(first.params).toMatchObject({ sessionId: "goal-check-session" });
      const beforeRetry = (await gateway.getRequests(method)).length;
      const unavailable = { code: "UNAVAILABLE", message: "Gateway response unavailable" };
      await gateway.deferNext(method);
      await gateway.rejectDeferred(method, unavailable);
      await page.clock.fastForward(1_001);
      await gateway.waitForRequest(method, { after: beforeRetry });
      await gateway.rejectDeferred(method, unavailable);
      const checkOutcome = exactButton(page, "Retry resume");
      await checkOutcome.waitFor();
      await page.reload();
      await admitHistory();
      await checkOutcome.waitFor();
      await checkOutcome.click();
      const retried = await gateway.waitForRequest(method);
      expect(retried.params).toEqual(first.params);
      await gateway.deferNext(method);
      await gateway.rejectDeferred(method, unavailable);
      await page.clock.fastForward(1_001);
      const automatic = await gateway.waitForRequest(method, { after: 1 });
      expect(automatic.params).toEqual(first.params);
      await gateway.rejectDeferred(method, unavailable);
      await page.getByText("Gateway response unavailable", { exact: false }).waitFor();
      expect(await checkOutcome.isEnabled()).toBe(true);
      expect(await gateway.getRequests(method)).toHaveLength(2);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await page.reload();
      await admitHistory();
      await checkOutcome.waitFor();
      expect(await gateway.getRequests(method)).toHaveLength(0);
    });
  });
});
