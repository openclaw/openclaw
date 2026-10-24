import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";
import { seedSidebarSettings, sidebarSession, style } from "./sidebar-contract.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Subagent restart attention" });

async function checkRestartAttention({ page }: { page: Page }) {
  const now = Date.UTC(2026, 8, 26, 12);
  await page.clock.setFixedTime(now);
  await seedSidebarSettings(page, suite.server.baseUrl, {
    sidebarAgentsMode: "chip",
    navWidth: 320,
  });
  const childKey = "agent:main:validation-child";
  const parent = sidebarSession("agent:main:validation-parent", "Release validation", {
    sessionId: "validation-parent",
    status: "running",
    hasActiveRun: true,
    updatedAt: now,
    childSessions: [childKey],
  });
  const child = sidebarSession(childKey, "Check retained work", {
    sessionId: "validation-child",
    spawnedBy: parent.key,
    status: "failed",
    hasActiveRun: false,
    updatedAt: now,
    endedAt: now,
    lastRunError: "Subagent execution was interrupted by a Gateway restart.",
  });
  const gateway = await installMockGateway(page, {
    sessionKey: parent.key,
    sessions: [parent, child],
  });
  const publishChild = async (session: GatewaySessionRow) => {
    await gateway.setSessionsListResponse(sessionsListResponse([parent, session]));
    await gateway.emitGatewayEvent("sessions.changed", {
      sessionKey: child.key,
      reason: "subagent-status",
      ts: session.updatedAt,
      session: { ...session, lastRunError: session.lastRunError ?? null },
      ancestorSessions: [parent],
    });
  };
  await page.goto(`${suite.server.baseUrl}chat`);
  await waitForControlUiRoute(page, { routeId: "chat" });
  const sidebar = page.locator("openclaw-app-sidebar");
  const parentRow = sidebar.locator(`[data-session-key="${parent.key}"]`);
  const childRow = sidebar.locator(`[data-session-key="${child.key}"]`);
  const parentError = parentRow.locator('[data-session-attention="error"]');
  await parentError.waitFor({ state: "visible" });
  const failureColor = await style(parentError, "color");
  const toggle = sidebar.locator(`[data-child-session-toggle="${parent.key}"]`);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await childRow.waitFor({ state: "visible" });

  await publishChild({
    ...child,
    status: "interrupted",
    lastRunError: undefined,
    updatedAt: now + 1,
  });
  const interruption = childRow.getByRole("img", { name: "Interrupted", exact: true });
  await interruption.waitFor({ state: "visible" });
  await toggle.click();
  await parentError.waitFor({ state: "detached" });
  expect(await parentRow.locator(".sidebar-child-session__status--failed").count()).toBe(0);
  await toggle.click();
  await interruption.waitFor({ state: "visible" });
  expect(await childRow.locator('[data-session-attention="error"]').count()).toBe(0);
  expect(await style(interruption, "color")).not.toBe(failureColor);

  await publishChild({
    ...child,
    lastRunError: "Dependency installation failed. Check registry access.",
    updatedAt: now + 2,
    endedAt: now + 2,
  });
  await childRow.locator('[data-session-attention="error"]').waitFor({ state: "visible" });
  await interruption.waitFor({ state: "detached" });
  await toggle.click();
  await parentError.waitFor({ state: "visible" });
}

suite.define(() => {
  it("shows restart interruption neutrally and preserves actionable child failures", () =>
    suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      checkRestartAttention,
    ));
});
