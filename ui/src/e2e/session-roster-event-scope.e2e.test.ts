import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { expectText, expectCount } from "./sidebar-assertions.test-support.ts";

const suite = createSessionManagementE2eSuite();
const pageOptions = {
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { height: 900, width: 1280 },
};
const key = "agent:main:weekly-report";
const row = sessionRow(key, "Weekly report", 1);
const activityQuery = {
  archived: "all",
  includeDerivedTitles: true,
  includeLastMessage: true,
  limit: 100,
};
const agents: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Main" },
    { id: "research", name: "Research" },
  ],
};

async function installRoster(page: Page, global = false) {
  return installMockGateway(page, {
    sessionKey: key,
    methodResponses: {
      "sessions.list": sessionsListResponse([row]),
      ...(global ? { "agents.list": agents } : {}),
    },
    historyMessages: global
      ? [{ role: "assistant", content: [{ type: "text", text: "The weekly report is ready." }] }]
      : undefined,
  });
}

suite.define(() => {
  it.each(["global", "selected"] as const)(
    "keeps %s quiet until membership changes",
    async (scope) => {
      const global = scope === "global";
      await suite.withPage(pageOptions, async ({ page }) => {
        const gateway = await installRoster(page, global);
        const sidebar = page.locator("openclaw-app-sidebar");
        const selectedRow = sidebar.locator('[data-session-key="' + key + '"]');
        const roster = sidebar.locator(".sidebar-agent-roster__row");
        const query = global ? activityQuery : undefined;
        const count = async (filter: Record<string, unknown> | undefined = query) =>
          (await gateway.getRequests("sessions.list", filter)).length;
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        await expectText(selectedRow, "Weekly report");
        if (global) {
          await sidebar.locator(".sidebar-agent-card__main").click();
          await sidebar.locator('[data-value="scope:all"]').click();
          await expectCount(roster, 2);
          await gateway.waitForRequest("sessions.list", { match: activityQuery });
        } else {
          await gateway.waitForRequest("sessions.subscribe");
        }
        await page.waitForTimeout(1_200);
        const before = await count();
        for (let burst = 0; burst < 3; burst += 1) {
          for (let index = 0; index < (global ? 1 : 20); index += 1) {
            await gateway.emitGatewayEvent(
              "sessions.changed",
              global
                ? { sessionKey: key, agentId: "main", reason: "activity-summary", session: row }
                : {
                    sessionKey: "agent:research:task-" + index,
                    reason: "update",
                    updatedAt: burst + 2,
                  },
            );
          }
          // Cross the debounce window between bursts, not just within one batch.
          await page.waitForTimeout(300);
        }
        expect((await count()) - before).toBe(0);
        expect(await selectedRow.textContent()).toContain("Weekly report");
        if (global) {
          expect(await roster.count()).toBe(2);
          expect(await page.locator(".chat-thread").textContent()).toContain(
            "The weekly report is ready.",
          );
        }
        const changedQuery = global ? activityQuery : { agentId: "main", limit: 200 };
        const changedBefore = global ? before : await count(changedQuery);
        const changed = global
          ? sessionRow("agent:main:new-report", "New report", 2)
          : { ...row, label: "Weekly report ready", updatedAt: 5 };
        await gateway.setSessionsListResponse(
          sessionsListResponse(global ? [changed, row] : [changed]),
        );
        await gateway.emitGatewayEvent(
          "sessions.changed",
          global
            ? { sessionKey: changed.key, agentId: "main", reason: "create", session: changed }
            : { sessionKey: key, reason: "update", updatedAt: 5 },
        );
        if (!global) {
          await expectText(selectedRow, "Weekly report ready");
        }
        await expect.poll(async () => (await count(changedQuery)) - changedBefore).toBe(1);
      });
    },
  );

  it("keeps the page Refresh control stable during background roster reads", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const gateway = await installRoster(page);
      let heldRequest = false;
      try {
        await page.goto(`${suite.server.baseUrl}sessions`);
        const refresh = page.getByRole("button", { name: "Refresh", exact: true });
        await refresh.waitFor();
        await gateway.waitForRequest("sessions.subscribe");
        await page.waitForTimeout(1_200);
        const pageQuery = { includeUnknown: false };
        await gateway.deferNext("sessions.list", pageQuery);
        const before = (await gateway.getRequests("sessions.list", pageQuery)).length;
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: key,
          reason: "update",
          updatedAt: 2,
        });
        await gateway.waitForRequest("sessions.list", { after: before, match: pageQuery });
        heldRequest = true;
        await page.waitForTimeout(50);
        expect({
          label: await refresh.getAttribute("aria-label"),
          enabled: await refresh.isEnabled(),
        }).toEqual({ label: "Refresh", enabled: true });
      } finally {
        if (heldRequest) {
          await gateway.resolveDeferred("sessions.list");
        }
      }
    });
  });
});
