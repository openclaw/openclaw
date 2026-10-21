import { it, expect } from "vitest";
import { pauseVirtualClock, reconnectMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import * as ui from "./session-management.compact.test-support.ts";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { openSidebarPages } from "./sidebar-customization.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each(["stay", "navigate"] as const)(
    "offers Undo when an individual archive completes after %s on the Sessions page",
    (transition) =>
      suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const main = sessionRow("agent:main:main", "Main", 1);
        const target = sessionRow("agent:main:pending-archive", "Pending archive", 2, {
          pinned: true,
        });
        const gateway = await installMockGateway(page, {
          sessions: [main, target],
          sessionKey: main.key,
          sessionArchiveFiltering: true,
        });

        await page.goto(`${suite.server.baseUrl}sessions`);
        const row = page.locator(".session-data-row").filter({ hasText: target.label });
        await ui.visible(row);
        await gateway.deferNext("sessions.patch", { key: target.key, archived: true });
        await ui.archiveSession(page, row, "list");
        const archived = await ui.sessionPatch(gateway, target.key, { archived: true });
        expect(archived.params).toMatchObject({
          key: target.key,
          expectedSessionId: target.sessionId,
          archived: true,
        });
        const undo = ui.button(page, "Undo");
        expect(await undo.count()).toBe(0);
        if (transition === "navigate") {
          const pages = await openSidebarPages(page);
          await pages.getByRole("link", { name: "Agents", exact: true }).click();
          await page.waitForURL((url) => url.pathname.endsWith("/agents"));
          await page.locator("openclaw-sessions-page").waitFor({ state: "detached" });
        }
        const destination = new URL(page.url()).pathname;

        // Only the archive acknowledgement is held; the canonical mock owns its row update.
        await gateway.resolveDeferred("sessions.patch");
        await ui.visible(undo);

        await undo.click();
        const restored = await ui.sessionPatch(gateway, target.key, { archived: false });
        expect(restored.params).toMatchObject({
          key: target.key,
          expectedSessionId: target.sessionId,
          archived: false,
          pinned: true,
        });
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(2);
        await ui.visible(page.locator(`.sidebar-recent-session[data-session-key="${target.key}"]`));
        expect(new URL(page.url()).pathname).toBe(destination);
      }),
  );

  it.each([
    { surface: "header", reconnect: false },
    { surface: "header", reconnect: true },
    { surface: "sidebar", reconnect: false },
  ] as const)(
    "$surface archive Undo survives navigation and fences reconnect=$reconnect",
    ({ surface, reconnect }) =>
      suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const main = sessionRow("agent:main:main", "Main", 1);
        const target = sessionRow("agent:main:undo-target", "Undo target", 2);
        const archived = sessionRow("agent:main:undo-archive", "Undo archive", 3, { pinned: true });
        const gateway = await ui.installSessionRows(page, [main, target, archived], {
          sessionArchiveFiltering: true,
          sessionKey: archived.key,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, archived.key));
        const rowFor = ui.sessionRows(page);
        await ui.visible(rowFor(archived.key));
        await ui.archiveSession(page, rowFor(archived.key), surface);
        await ui.sessionPatch(gateway, archived.key, { archived: true });
        const undo = ui.button(page, "Undo");
        await ui.visible(undo);
        await rowFor(target.key).click();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe(controlUiSessionPath(target.key));
        if (reconnect) {
          await undo.hover();
          await reconnectMockGateway(page, gateway);
        }
        await undo.click();
        if (reconnect) {
          await expectRequestCountStable(gateway, "sessions.patch", 1);
          expect(await rowFor(archived.key).count()).toBe(0);
          return;
        }
        const restored = await ui.sessionPatch(gateway, archived.key, { archived: false });
        expect(restored.params).toMatchObject({
          key: archived.key,
          expectedSessionId: archived.sessionId,
          archived: false,
          ...(surface === "header" ? { pinned: true } : {}),
        });
        // Header Undo retains the legacy shared flag; the personal sidebar does not write it.
        if (surface === "sidebar") {
          expect(restored.params).not.toHaveProperty("pinned");
        }
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(2);
        await ui.visible(rowFor(archived.key));
        expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(target.key));
      }),
  );

  it.each([false, true])(
    "keeps another agent's pagination usable after Undo (selection queued=%s)",
    (queued) =>
      suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        await page.clock.install();
        const archived = sessionRow("agent:main:undo-cross-agent", "Restored original", 3, {
          pinned: true,
        });
        const mainRows = [sessionRow("agent:main:main", "Main", 1), archived];
        const researchRows = [
          sessionRow("agent:research:main", "Research", 4),
          sessionRow("agent:research:first", "Research first", 3),
          sessionRow("agent:research:second", "Research second", 2),
        ] as const;
        const gateway = await installMockGateway(page, {
          sessions: [...mainRows, ...researchRows],
          methodResponses: {
            "agents.list": ui.mainAndResearchAgents,
            "sessions.list": {
              cases: [
                ...[2, 0].map((offset) => ({
                  match: { agentId: "research", ...(offset ? { offset } : {}) },
                  response: { ...ui.sessionPage(researchRows, offset, 2), limitApplied: 50 },
                })),
                { response: sessionsListResponse(mainRows) },
              ],
            },
          },
          sessionArchiveFiltering: true,
          sessionKey: archived.key,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, archived.key));
        const sidebar = page.locator("openclaw-app-sidebar");
        const rowFor = ui.sessionRows(sidebar);
        await ui.visible(rowFor(archived.key));

        await ui.archiveSession(page, rowFor(archived.key), "header");
        const undo = ui.button(page, "Undo");
        await ui.visible(undo);
        if (queued) {
          await undo.hover();
          const mainRoster = { agentId: "main", includeGlobal: true };
          const listsBefore = await ui.requestCount(gateway, "sessions.list", mainRoster);
          await gateway.deferNext("sessions.list", mainRoster);
          await pauseVirtualClock(page);
          await gateway.emitGatewayEvent("sessions.changed", { agentId: "main", reason: "update" });
          await page.clock.fastForward(5_001);
          await page.clock.resume();
          await gateway.waitForRequest("sessions.list", {
            after: listsBefore,
            match: mainRoster,
          });
        }
        await ui.switchAgent(sidebar, "Research");
        if (!queued) {
          await ui.visible(rowFor(researchRows[1].key));
        }
        await undo.click();
        await ui.sessionPatch(gateway, archived.key, { archived: false });
        await expectRequestCountStable(gateway, "sessions.patch", 2);
        if (queued) {
          await gateway.resolveDeferred("sessions.list", sessionsListResponse(mainRows));
        }

        await ui.visible(rowFor(researchRows[1].key));
        await ui.button(sidebar, "Load more sessions").click();
        await gateway.waitForRequest("sessions.list", {
          match: { agentId: "research", offset: 2 },
        });
        await ui.visible(rowFor(researchRows[2].key));

        await ui.switchAgent(sidebar, "Main");
        await ui.visible(rowFor(archived.key));
        // Restoring legacy shared metadata does not author a personal navigation pin.
        await ui.button(rowFor(archived.key), "Pin session").waitFor({ state: "attached" });
        expect(
          await page
            .locator(`.sidebar-rail [data-sidebar-entry="session:${archived.key}"]`)
            .count(),
        ).toBe(0);
      }),
  );
});
