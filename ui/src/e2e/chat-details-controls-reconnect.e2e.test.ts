import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { SessionGoal } from "../api/types.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { requireRecord } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mobile Details controls reconnect" });
const sessionKey = "agent:main:main";
const machineName = "Demo workstation";
const goalMethod = "sessions.goal.update";
const viewport = { width: 390, height: 844 };

const environment = (label: string) => ({
  id: "node:demo-device",
  type: "node",
  label,
  status: "available",
  sessionHost: true,
  workerSlots: { total: 1, available: 1 },
});

async function installControls(page: Page) {
  const now = Date.now();
  const goal: SessionGoal = {
    schemaVersion: 1,
    id: "demo-review-goal",
    objective: "Review the sample document and record the findings",
    status: "paused",
    createdAt: now - 60_000,
    updatedAt: now - 30_000,
    pausedAt: now - 30_000,
    tokenStart: 0,
    tokensUsed: 120,
    continuationTurns: 1,
  };
  const row = createControlUiSessionRow(sessionKey, "Demo review", now, {
    sessionId: "demo-review-session",
    model: "demo-model",
    modelProvider: "openai",
    sharingRole: "owner",
    goal,
    placement: {
      state: "active",
      generation: 1,
      createdAtMs: now - 60_000,
      updatedAtMs: now,
      stateChangedAtMs: now,
      environmentId: "node:demo-device",
      activeOwnerEpoch: 1,
      workerBundleHash: "a".repeat(64),
      workspaceBaseManifestRef: "demo-base",
      remoteWorkspaceDir: "/workspace/demo",
      runner: { kind: "device", status: "available", deviceId: "demo-device" },
    },
  });
  const gateway = await installMockGateway(page, {
    sessionKey,
    sessionInfo: row,
    sessions: [row],
    models: [{ id: "demo-model", name: "Demo model", provider: "openai" }],
    agentModel: "openai/demo-model",
    operatorScopes: ["operator.read", "operator.write", "operator.admin"],
    heldMethods: [goalMethod],
    featureMethods: [
      ...new Set([
        ...defaultControlUiFeatureMethods,
        "environments.list",
        goalMethod,
        "sessions.goal.clear",
      ]),
    ],
    historyMessages: [{ role: "assistant", content: "The sample document is ready for review." }],
    methodResponses: {
      "environments.list": { profiles: [], environments: [environment(machineName)] },
    },
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  await page.getByText("The sample document is ready for review.", { exact: true }).waitFor();
  return { gateway, goal, row };
}

suite.define(() => {
  it("retains mobile environment and Goal controls through a real socket reconnect", async () => {
    await suite.withPage({ viewport, hasTouch: true, locale: "en-US" }, async ({ page }) => {
      const { gateway, goal, row } = await installControls(page);
      const details = await openChatDetails(page);
      const machine = details
        .locator(".chat-environment-mobile")
        .getByRole("button", { name: machineName, exact: true });
      await machine.waitFor();
      await closeChatDetails(page);

      const goalPill = page.locator('.activity-pill[data-family="goal"]').filter({ visible: true });
      await goalPill.click();
      const goalPage = details
        .locator('.chat-mobile-details-page[data-details-page="goal"]')
        .filter({ visible: true });
      const resume = goalPage.getByRole("button", { name: "Resume goal", exact: true });
      await resume.waitFor();
      await expect.poll(() => resume.isEnabled()).toBe(true);

      // Closing is local; it must not forget which actions were available before the outage.
      await closeChatDetails(page);
      const reads = await gateway.deferNext("environments.list");
      const sockets = await gateway.getSocketCount();
      await gateway.setOnline(false);
      await gateway.closeLatest(1001, "Demo Gateway restart");
      await page.waitForFunction(
        () => window.openclawControlUi?.snapshot().gatewayPhase === "reconnecting",
      );
      await openChatDetails(page);
      await machine.waitFor();
      expect(await gateway.getRequests("environments.list")).toHaveLength(reads);
      await closeChatDetails(page);
      await goalPill.click();
      await goalPage.waitFor();
      expect(await goalPage.getByText(goal.objective, { exact: true }).isVisible()).toBe(true);
      for (const name of ["Edit goal", "Resume goal", "Clear goal"]) {
        const button = goalPage.getByRole("button", { name, exact: true });
        expect(await button.isVisible()).toBe(true);
        expect(await button.isDisabled()).toBe(true);
        await button.dispatchEvent("click");
      }
      expect(await gateway.getRequests(goalMethod)).toHaveLength(0);
      expect(await gateway.getRequests("sessions.goal.clear")).toHaveLength(0);

      await gateway.setOnline(true);
      await page.waitForFunction(
        () => window.openclawControlUi?.snapshot().gatewayPhase === "connected",
      );
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(sockets);
      await expect.poll(() => resume.isEnabled()).toBe(true);
      await gateway.waitForRequest("environments.list", { after: reads });
      await closeChatDetails(page);
      await openChatDetails(page);
      expect(await machine.isVisible()).toBe(true);
      await gateway.resolveDeferred("environments.list", {
        profiles: [],
        environments: [environment("Demo workstation updated")],
      });
      const updated = details
        .locator(".chat-environment-mobile")
        .getByRole("button", { name: "Demo workstation updated", exact: true });
      await updated.waitFor();

      await closeChatDetails(page);
      await goalPill.click();
      await resume.click();
      const params = requireRecord((await gateway.waitForRequest(goalMethod)).params);
      expect(params).toMatchObject({
        sessionKey,
        sessionId: row.sessionId,
        goalId: goal.id,
        action: "resume",
      });
      const { pausedAt: _pausedAt, ...retained } = goal;
      const resumed: SessionGoal = { ...retained, status: "active", updatedAt: Date.now() };
      await gateway.setSessionsListResponse({ sessions: [{ ...row, goal: resumed }] });
      await gateway.resolveDeferred(goalMethod, {
        operationId: params.operationId,
        action: "resume",
        status: "started",
        sessionId: row.sessionId,
        goalId: goal.id,
        goal: resumed,
        runId: "demo-goal-run",
      });
      expect(await gateway.getRequests(goalMethod)).toHaveLength(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });
});
