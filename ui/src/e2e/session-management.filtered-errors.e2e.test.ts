import { expect, it } from "vitest";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { chooseSidebarMenuOption, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("searches Sessions through the Gateway, appends matches, and retires failed or replaced queries", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const rows = Array.from({ length: 51 }, (_, index) =>
        sessionRow(`agent:main:match-${index}`, `Match ${index}`, 1000 - index),
      );
      const latest = sessionRow("agent:main:latest", "Latest result", 2000);
      const matches = (offset: number, hasMore = false) =>
        sessionsListResponse(rows.slice(offset, offset + 50), {
          offset,
          hasMore,
          nextOffset: hasMore ? 50 : null,
          totalCount: rows.length,
        });
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.list": {
            cases: [
              { match: { search: "observatory", offset: 50 }, response: matches(50) },
              { match: { search: "observatory" }, response: matches(0, true) },
              { match: { search: "latest" }, response: sessionsListResponse([latest]) },
              {
                match: { search: "failed" },
                response: {
                  __mockError: { code: "UNAVAILABLE", message: "Metadata search unavailable" },
                },
              },
              { match: {}, response: sessionsListResponse([]) },
            ],
          },
        },
        sessionKey: "agent:main:main",
      });
      await page.goto(`${suite.server.baseUrl}sessions`);
      const roster = page.locator("openclaw-sessions-page");
      const filters = roster.getByRole("button", { name: "Filters", exact: true });
      const popover = roster.locator(".sessions-filter-popover");
      const openFilters = async () => {
        if ((await popover.getAttribute("data-phase")) === "closing") {
          await expect.poll(() => popover.getAttribute("data-phase")).toBe("hidden");
        }
        if ((await popover.getAttribute("data-phase")) === "hidden") {
          await filters.click();
        }
        await expect.poll(() => popover.getAttribute("data-phase")).toBe("open");
      };
      await openFilters();
      const search = popover.locator("input[type='text']");
      const flushSearch = async () => {
        await page.clock.runFor(201);
        await page.clock.resume();
      };
      const emptyState = roster.getByText("No sessions match your filters.", { exact: true });
      await page.clock.install();
      await pauseVirtualClock(page);
      await search.pressSequentially("observatory", { delay: 40 });
      // Slow runners must not dispatch an intermediate prefix between keystrokes.
      // Cross the search debounce and deliver its nested mock response timer.
      await flushSearch();
      await roster.getByRole("button", { name: "Load more sessions", exact: true }).click();
      await gateway.waitForRequest("sessions.list", {
        match: { search: "observatory", offset: 50, limit: 50 },
      });
      await roster.getByRole("button", { name: "Next", exact: true }).click();
      await roster.getByRole("button", { name: "Next", exact: true }).click();
      await roster.getByText("Match 50", { exact: true }).waitFor();
      const searches = (await gateway.getRequests("sessions.list")).filter(
        (request) => typeof requireRecord(request.params).search === "string",
      );
      expect(searches.map(({ params }) => params)).toMatchObject([
        { search: "observatory" },
        { search: "observatory", offset: 50 },
      ]);
      await gateway.deferNext("sessions.list", { search: "older" });
      await openFilters();
      await pauseVirtualClock(page);
      await search.fill("older");
      expect(await search.inputValue()).toBe("older");
      await flushSearch();
      await gateway.waitForRequest("sessions.list", { match: { search: "older" } });
      expect(await emptyState.count()).toBe(0);
      const beforeTyping = await gateway.getRequests("sessions.list");
      await search.fill("");
      await search.pressSequentially("superseded", { delay: 40 });
      await search.fill("");
      await search.pressSequentially("latest", { delay: 40 });
      await roster.locator('.sessions-view-segment input[value="archived"]').click();
      await roster.locator('.sessions-view-segment input[value="all"]').click();
      expect(await search.inputValue()).toBe("latest");
      expect(await gateway.getRequests("sessions.list")).toEqual(beforeTyping);
      await gateway.resolveDeferred(
        "sessions.list",
        sessionsListResponse([sessionRow("agent:main:older", "Retired result", 1)]),
      );
      await roster.getByText("Latest result", { exact: true }).waitFor();
      const dispatched = (await gateway.getRequests("sessions.list")).slice(beforeTyping.length);
      expect(dispatched.map(({ params }) => params)).toMatchObject([
        { search: "latest", archived: "all" },
      ]);
      expect(await roster.getByText("Retired result", { exact: true }).count()).toBe(0);
      await openFilters();
      await pauseVirtualClock(page);
      await search.fill("failed");
      await flushSearch();
      await roster.getByText("Metadata search unavailable", { exact: false }).waitFor();
      expect(await emptyState.count()).toBe(0);
    });
  });

  it.each(["Archived", "All"] as const)(
    "clears the visible %s sidebar error after its failed roster recovers or retires",
    async (statusFilter) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const updatedAt = Date.parse("2026-07-01T16:00:00.000Z");
        const main = sessionRow("agent:main:main", "Main", updatedAt);
        const archived = sessionRow("agent:main:archived", "Archived planning", updatedAt - 1, {
          archived: true,
        });
        const healthy = sessionsListResponse([main, archived]);
        const gateway = await installMockGateway(page, {
          methodResponses: { "sessions.list": healthy },
          sessionArchiveFiltering: true,
          sessionKey: main.key,
        });

        await page.clock.install();
        await page.goto(`${suite.server.baseUrl}chat`);
        const selectFilter = async (label: "Archived" | "All" | "Active") => {
          await page.getByRole("button", { name: /^Filter & sort · /, exact: true }).click();
          await chooseSidebarMenuOption(page, "Status", label);
          await closeSidebarMenu(page);
        };
        await selectFilter(statusFilter);
        await page.getByText("Archived planning", { exact: true }).first().waitFor();

        const failureMessage = "Session list temporarily unavailable";
        const failure = { __mockError: { code: "UNAVAILABLE", message: failureMessage } };
        const refresh = async () => {
          await pauseVirtualClock(page);
          await gateway.emitGatewayEvent("sessions.changed", {
            ...archived,
            agentId: "main",
            reason: "update",
            sessionKey: archived.key,
          });
          await page.clock.runFor(5_001);
          await page.clock.resume();
        };
        const alert = page.locator("[data-sidebar-session-error]");
        const failRefresh = async () => {
          await gateway.setMethodResponse("sessions.list", {
            cases: [
              {
                match: { archived: statusFilter === "Archived" ? true : "all" },
                response: failure,
              },
              { match: {}, response: healthy },
            ],
          });
          await refresh();
          await expect.poll(() => alert.textContent()).toContain(failureMessage);
        };

        await failRefresh();

        await gateway.setMethodResponse("sessions.list", healthy);
        await refresh();
        await expect.poll(() => alert.count()).toBe(0);
        await page.getByText("Archived planning", { exact: true }).first().waitFor();

        await failRefresh();

        await selectFilter("Active");
        await expect.poll(() => alert.count()).toBe(0);

        await gateway.setMethodResponse("sessions.list", failure);
        await refresh();
        await expect.poll(() => alert.textContent()).toContain(failureMessage);
        await gateway.setMethodResponse("sessions.list", healthy);
        await refresh();
        await expect.poll(() => alert.count()).toBe(0);
      });
    },
  );
});
