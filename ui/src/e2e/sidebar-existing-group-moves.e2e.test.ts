import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { openSessionMenuSubmenu, sessionsListResponse } from "./session-management.test-support.ts";
import { chooseSidebarMenuOption, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Move existing conversations into a group" });

suite.define(() => {
  it.each([
    { agentId: "main", rejected: false },
    { agentId: "advisor-new", rejected: false },
    { agentId: "advisor-new", rejected: true },
  ])(
    "moves physical sessions for agent $agentId by menu and drag (rejected=$rejected)",
    ({ agentId, rejected }) =>
      suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        await page.addInitScript((key) => {
          localStorage.setItem(key, JSON.stringify({ sidebarAgentsMode: "chip", navWidth: 360 }));
          localStorage.setItem("openclaw:sidebar:sessions:grouping", "category");
          localStorage.setItem("openclaw:sidebar:sessions:hide-empty-groups", "false");
          if (!localStorage.getItem("openclaw:sidebar:sessions:collapsed-sections")) {
            localStorage.setItem(
              "openclaw:sidebar:sessions:collapsed-sections",
              JSON.stringify(["category:Project folder"]),
            );
          }
        }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
        const rows = ["menu", "drag"].map((kind, index) =>
          sessionRow(`agent:${agentId}:${kind}`, `Conversation ${kind}`, 100 - index, {
            sessionId: `00000000-0000-4000-8000-00000000000${index + 1}`,
            parentSessionKey: `agent:${agentId}:main`,
            sidebarRoot: false,
          }),
        );
        const gateway = await installMockGateway(page, {
          sessions: rows,
          sessionKey: rows[0]!.key,
          sessionGroups: ["Project folder"],
          methodResponses: {
            ...(rejected
              ? {
                  "sessions.patch": {
                    __mockError: { code: "UNAVAILABLE", message: "Move refused" },
                  },
                }
              : {}),
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [
                { id: "main", name: "Main" },
                { id: "advisor-new", name: "Advisor" },
              ],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, rows[0]!.key, "chat"));
        const sidebar = page.locator("openclaw-app-sidebar:visible");
        const row = (index: number) => sidebar.locator(`[data-session-key="${rows[index]!.key}"]`);
        const group = sidebar.locator('[data-session-section="category:Project folder"]');
        await row(0).waitFor();
        await chooseSidebarMenuOption(page, "Hide empty groups", "Never");
        await closeSidebarMenu(page);
        await group.waitFor();
        expect(
          await group.locator(".sidebar-session-group-toggle").getAttribute("aria-expanded"),
        ).toBe("false");
        await row(0).click({ button: "right" });
        await openSessionMenuSubmenu(page, "Move to group");
        await page.getByRole("menuitemradio", { name: "Project folder", exact: true }).click();
        await gateway.waitForRequest("sessions.patch");
        if (rejected) {
          await page.getByRole("alert").filter({ hasText: "Move refused" }).waitFor();
          expect(
            await group.locator(".sidebar-session-group-toggle").getAttribute("aria-expanded"),
          ).toBe("false");
          expect(await group.locator(".sidebar-recent-session").count()).toBe(0);
          return;
        }
        await group.locator(`[data-session-key="${rows[0]!.key}"]`).waitFor();
        await group.locator(".sidebar-session-group-toggle").click();
        expect(
          await group.locator(".sidebar-session-group-toggle").getAttribute("aria-expanded"),
        ).toBe("false");
        await row(1).dragTo(group);
        await expect.poll(() => group.locator(".sidebar-recent-session").count()).toBe(2);
        const writes = await gateway.getRequests("sessions.patch");
        expect(writes).toHaveLength(2);
        for (const [index, request] of writes.entries()) {
          expect(request.params).toMatchObject({
            key: rows[index]!.key,
            agentId,
            expectedSessionId: rows[index]!.sessionId,
            category: "Project folder",
          });
        }
        for (const moved of rows) {
          moved.category = "Project folder";
        }
        await gateway.setSessionsListResponse(sessionsListResponse(rows));
        await page.reload();
        await expect.poll(() => group.locator(".sidebar-recent-session").count()).toBe(2);
      }),
  );
});
