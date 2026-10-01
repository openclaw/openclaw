import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Subagent restart attention" });

suite.define(() => {
  it("shows restart interruption neutrally and preserves actionable child failures", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const now = Date.UTC(2026, 8, 26, 12);
        await page.clock.setFixedTime(now);
        await page.addInitScript(
          ({ key }) => {
            localStorage.setItem(
              key,
              JSON.stringify({ sidebarAgentsMode: "roster", navWidth: 320 }),
            );
            localStorage.setItem(
              "openclaw:control-ui:community-invite",
              JSON.stringify({ dismissedAtMs: Date.now() }),
            );
          },
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
        );
        const childKey = "agent:main:validation-child";
        const parent = {
          key: "agent:main:validation-parent",
          sessionId: "validation-parent",
          kind: "direct",
          label: "Release validation",
          status: "running",
          hasActiveRun: true,
          updatedAt: now,
          childSessions: [childKey],
        } satisfies GatewaySessionRow;
        const child = {
          key: childKey,
          sessionId: "validation-child",
          kind: "direct",
          label: "Check retained work",
          spawnedBy: parent.key,
          status: "failed",
          hasActiveRun: false,
          updatedAt: now,
          endedAt: now,
          lastRunError: "Subagent execution was interrupted by a Gateway restart.",
        } satisfies GatewaySessionRow;
        const gateway = await installMockGateway(page, {
          sessionKey: parent.key,
          sessions: [parent, child],
          historyMessages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Continue the release validation after the restart." },
              ],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "I am checking retained child work before continuing validation.",
                },
              ],
            },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiRoute(page, { routeId: "chat" });
        const sidebar = page.locator("openclaw-app-sidebar");
        const parentRow = sidebar.locator(`[data-session-key="${parent.key}"]`);
        const childRow = sidebar.locator(`[data-session-key="${child.key}"]`);
        const parentError = parentRow.locator('[data-session-attention="error"]');
        await parentError.waitFor({ state: "visible" });
        const failureColor = await parentError.evaluate(
          (element) => getComputedStyle(element).color,
        );
        const toggle = sidebar.locator(`[data-child-session-toggle="${parent.key}"]`);
        if ((await toggle.getAttribute("aria-expanded")) !== "true") {
          await toggle.click();
        }
        await childRow.waitFor({ state: "visible" });
        await captureSidebarUiProof(suite, page, "restart-attention-before.png");

        const interrupted: GatewaySessionRow = {
          ...child,
          status: "interrupted",
          lastRunError: undefined,
          updatedAt: now + 1,
        };
        await gateway.setSessionsListResponse(sessionsListResponse([parent, interrupted]));
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: child.key,
          reason: "subagent-status",
          ts: now + 1,
          session: { ...interrupted, lastRunError: null },
          ancestorSessions: [parent],
        });
        const interruption = childRow.getByRole("img", { name: "Interrupted", exact: true });
        await interruption.waitFor({ state: "visible" });
        await toggle.click();
        await parentError.waitFor({ state: "detached" });
        expect(await parentRow.locator(".sidebar-child-session__status--failed").count()).toBe(0);
        await toggle.click();
        await interruption.waitFor({ state: "visible" });
        expect(await childRow.locator('[data-session-attention="error"]').count()).toBe(0);
        expect(await interruption.evaluate((element) => getComputedStyle(element).color)).not.toBe(
          failureColor,
        );
        await captureSidebarUiProof(suite, page, "restart-attention-after.png");

        const failed: GatewaySessionRow = {
          ...child,
          lastRunError: "Dependency installation failed. Check registry access.",
          updatedAt: now + 2,
          endedAt: now + 2,
        };
        await gateway.setSessionsListResponse(sessionsListResponse([parent, failed]));
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: child.key,
          reason: "subagent-status",
          ts: now + 2,
          session: failed,
          ancestorSessions: [parent],
        });
        await childRow.locator('[data-session-attention="error"]').waitFor({ state: "visible" });
        await interruption.waitFor({ state: "detached" });
        await toggle.click();
        await parentError.waitFor({ state: "visible" });
      },
    );
  });
});
