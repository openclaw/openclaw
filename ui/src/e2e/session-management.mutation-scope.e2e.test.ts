import { it, expect } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import * as ui from "./session-management.compact.test-support.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";
import { chooseSidebarMenuOption, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each([
    { operation: "rename", filter: "Active" },
    { operation: "batch archive", filter: "Active" },
    { operation: "rename", filter: "All" },
    { operation: "batch archive", filter: "All" },
  ] as const)(
    "keeps $filter rows, pagination, and updates after another agent's $operation settles",
    ({ operation, filter }) =>
      ui.withSessionPage(suite, async (page) => {
        await page.clock.install();
        const original = sessionRow("agent:main:rename-cross-agent", "Original name", 3);
        const batch = [original, sessionRow("agent:main:batch-sibling", "Batch sibling", 2)];
        const mainRows = [sessionRow("agent:main:main", "Main", 1), ...batch];
        const pageSize = SIDEBAR_SESSION_ROSTER_LIMIT;
        const researchRows = [
          sessionRow("agent:research:main", "Research", pageSize + 4),
          sessionRow("agent:research:first", "Research first", pageSize + 3),
          sessionRow("agent:research:second", "Research second", 2),
        ];
        // Scheduled sessions occupy the server page while normal sidebar filters hide them.
        const scheduledRows = Array.from({ length: pageSize - 2 }, (_, index) =>
          sessionRow(
            `agent:research:cron:history-${index}`,
            `Scheduled session ${index}`,
            pageSize + 2 - index,
          ),
        );
        const researchInventory = [...researchRows.slice(0, 2), ...scheduledRows, researchRows[2]!];
        const retainedLimit = researchInventory.length + 1;
        const responseFor = (rows: typeof researchRows) => ({
          cases: [
            ...[pageSize, retainedLimit].map((offset) => ({
              match: { agentId: "research", offset },
              response: ui.sessionPage(rows, offset, pageSize),
            })),
            ...[retainedLimit, retainedLimit + 1].map((limit) => ({
              match: { agentId: "research", limit },
              response: ui.sessionPage(rows, 0, limit),
            })),
            {
              match: { agentId: "research" },
              response: ui.sessionPage(rows, 0, pageSize),
            },
            { response: sessionsListResponse(mainRows) },
          ],
        });
        const gateway = await installMockGateway(page, {
          sessions: [...mainRows, ...researchInventory],
          sessionKey: original.key,
          sessionArchiveFiltering: true,
          methodResponses: {
            "agents.list": ui.mainAndResearchAgents,
            "sessions.list": responseFor(researchInventory),
          },
        });
        const sidebar = page.locator("openclaw-app-sidebar");
        const rowFor = ui.sessionRows(sidebar);
        const waitForList = (match: Record<string, unknown>, after?: number) =>
          gateway.waitForRequest("sessions.list", { match, after });
        const countLists = (match: Record<string, unknown>) =>
          ui.requestCount(gateway, "sessions.list", match);
        const refreshAfterEvent = async (
          sessionKey: string,
          reason: "create" | "update",
          match: Record<string, unknown>,
        ) => {
          const before = await countLists(match);
          await pauseVirtualClock(page);
          await gateway.emitGatewayEvent("sessions.changed", {
            sessionKey,
            agentId: "research",
            reason,
          });
          await page.clock.fastForward(5_001);
          await page.clock.resume();
          return waitForList(match, before);
        };

        const selectResearchAgent = () => ui.switchAgent(sidebar, "Research");
        let researchHistory: { url: string; connections: number } | null = null;

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, original.key));
        await ui.visible(rowFor(original.key));

        if (operation === "rename" && filter === "All") {
          // Navigate around the pending modal through same-document browser history.
          const originalUrl = page.url();
          const connections = await ui.requestCount(gateway, "connect");
          await selectResearchAgent();
          const researchPath = new URL(
            controlUiSessionUrl(suite.server.baseUrl, researchRows[0]!.key),
          ).pathname;
          await page.waitForURL(
            (url) =>
              (url.pathname === researchPath || url.pathname.startsWith(`${researchPath}/`)) &&
              url.search === "",
          );
          await ui.visible(rowFor(researchRows[1]!.key));
          researchHistory = { url: page.url(), connections };
          await page.goBack();
          await page.waitForURL(originalUrl);
          await ui.visible(rowFor(original.key));
        }
        if (filter === "All") {
          if (operation === "rename") {
            await gateway.deferNext("sessions.list", { agentId: "main", archived: "all" });
          }
          await chooseSidebarMenuOption(page, "Status", filter);
          await closeSidebarMenu(page);
          await waitForList({ agentId: "main", archived: "all" });
        }
        const method = operation === "rename" ? "sessions.patch" : "sessions.patchMany";
        await gateway.deferNext(method);
        if (operation === "rename") {
          if (filter === "All") {
            await rowFor(original.key).click({ button: "right" });
            await ui.menuItem(page, "Rename…").click();
          } else {
            await ui.button(page, "Rename session Original name").click();
          }
          const input = page.locator(
            filter === "All"
              ? 'openclaw-modal-dialog[label="Rename session"] input'
              : ".chat-pane__session-title-input",
          );
          await input.fill("Renamed original");
          await input.press("Enter");
          await waitForPatch(gateway, (params) => params.label === "Renamed original");
          if (filter === "All") {
            await gateway.resolveDeferred("sessions.list");
          }
        } else {
          for (const row of batch) {
            await rowFor(row.key).click({ modifiers: ["Alt"] });
          }
          await rowFor(original.key).click({ button: "right" });
          await ui.visible(ui.menuItem(page.locator("openclaw-session-menu"), "Archive 2"));
          await page.keyboard.press("A");
          await gateway.waitForRequest(method);
        }
        if (researchHistory) {
          await page.goForward();
          await page.waitForURL(researchHistory.url);
          expect(await gateway.getRequests("connect")).toHaveLength(researchHistory.connections);
        } else {
          await selectResearchAgent();
        }
        await ui.visible(rowFor(researchRows[1]!.key));
        const loadMore = ui.button(sidebar, "Load more sessions");
        await ui.visible(loadMore);

        const listsBefore = await countLists({
          agentId: "main",
          includeGlobal: true,
        });
        await gateway.deferNext("sessions.list", { agentId: "main", includeGlobal: true });
        const filteredMatch = { agentId: "research", archived: "all" };
        const refreshMatch = {
          ...filteredMatch,
          includeDerivedTitles: true,
          includeLastMessage: true,
        };
        const filteredReadsBefore = await countLists(filteredMatch);
        await gateway.resolveDeferred(method);
        await waitForList({ agentId: "main", includeGlobal: true }, listsBefore);
        await gateway.resolveDeferred("sessions.list");
        if (researchHistory) {
          await page
            .locator('openclaw-modal-dialog[label="Rename session"]')
            .waitFor({ state: "hidden" });
          expect(await gateway.getRequests("connect")).toHaveLength(researchHistory.connections);
        }
        if (operation === "batch archive") {
          await ui.expectText(page.locator(".app-toast"), "Archived 2 sessions");
        }

        if (filter === "All") {
          expect(await gateway.getRequests("sessions.list", filteredMatch)).toHaveLength(
            filteredReadsBefore,
          );
        }
        await ui.visible(rowFor(researchRows[1]!.key));
        const newRow = sessionRow(
          "agent:research:new-after-completion",
          "Research new after completion",
          pageSize + 5,
        );
        await gateway.setMethodResponse(
          "sessions.list",
          responseFor([newRow, ...researchInventory]),
        );
        const researchMatch = {
          agentId: "research",
          ...(filter === "All" ? { archived: "all" } : {}),
        };
        await refreshAfterEvent(newRow.key, "create", researchMatch);
        await ui.visible(rowFor(newRow.key));

        await loadMore.click();
        await waitForList({ agentId: "research", offset: pageSize });
        await ui.visible(rowFor(researchRows[2]!.key));

        await ui.switchAgent(sidebar, "Main");
        if (operation === "rename") {
          await ui.expectText(rowFor(original.key), "Renamed original");
        } else if (filter === "Active") {
          await ui.expectCount(rowFor(original.key), 0);
        } else {
          await ui.visible(rowFor(original.key));
        }
        // An older conversation discovered while away must extend even a retained page window.
        const olderRow = sessionRow("agent:research:older", "Research older conversation", 1);
        const returnedResearchRows = [newRow, ...researchInventory, olderRow];
        await gateway.setMethodResponse("sessions.list", responseFor(returnedResearchRows));
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: olderRow.key,
          agentId: "research",
          reason: "create",
        });
        const readsBeforeReturn = await countLists(researchMatch);
        await selectResearchAgent();
        const returnedList = await waitForList(researchMatch, readsBeforeReturn);
        expect(returnedList.params).toMatchObject({
          limit: filter === "All" ? pageSize : retainedLimit,
        });
        await ui.visible(rowFor(newRow.key));
        await ui.expectCount(rowFor(olderRow.key), 0);
        await loadMore.click();
        if (filter === "All" && operation === "rename") {
          await ui.visible(rowFor(researchRows[2]!.key));
          await ui.visible(rowFor(olderRow.key));

          const refresh = await refreshAfterEvent(newRow.key, "update", refreshMatch);
          expect(refresh.params).not.toHaveProperty("offset");
          expect(refresh.params).toMatchObject({ limit: retainedLimit + 1 });
          await ui.expectCount(
            sidebar.locator('.sidebar-session-pagination--roster > button[aria-busy="true"]'),
            0,
          );
        }
        await ui.visible(rowFor(researchRows[2]!.key));
        await ui.visible(rowFor(olderRow.key));
        if (filter === "All" && operation === "rename") {
          await ui.visible(rowFor(researchRows[1]!.key));
          await gateway.setMethodResponse(
            "sessions.list",
            responseFor(returnedResearchRows.filter((row) => row.key !== researchRows[1]!.key)),
          );
          const refresh = await refreshAfterEvent(newRow.key, "update", refreshMatch);
          expect(refresh.params).toMatchObject({ limit: retainedLimit + 1 });
          await rowFor(researchRows[1]!.key).waitFor({ state: "hidden" });
          await ui.visible(rowFor(researchRows[2]!.key));
          await ui.visible(rowFor(olderRow.key));
        }
      }),
  );
});
