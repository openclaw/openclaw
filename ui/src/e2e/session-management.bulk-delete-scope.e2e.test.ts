import { expect, it } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { revealSidebarTarget } from "../test-helpers/control-ui-sidebar-window.ts";
import * as ui from "./session-management.compact.test-support.ts";
import {
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForConfirmModal,
} from "./session-management.test-support.ts";
import { chooseSidebarMenuOption, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("keeps the selected archived sidebar subscribed after another agent's bulk deletion", async () => {
    await ui.withSessionPage(suite, async (page) => {
      const main = sessionRow("agent:main:main", "Main", 4);
      const targets = [
        sessionRow("agent:main:delete-a", "Archived A", 3, { archived: true }),
        sessionRow("agent:main:delete-b", "Archived B", 2, { archived: true }),
      ];
      const pageSize = SIDEBAR_SESSION_ROSTER_LIMIT;
      const research = Array.from({ length: pageSize + 1 }, (_, index) =>
        sessionRow(`agent:research:row-${index}`, `Research ${index + 1}`, pageSize + 1 - index, {
          archived: true,
        }),
      );
      const lastResearch = research[pageSize]!;
      const gateway = await installMockGateway(page, {
        sessions: [main, ...targets, ...research],
        sessionKey: main.key,
        sessionArchiveFiltering: true,
        methodResponses: {
          "agents.list": {
            agents: [
              { id: "main", name: "Main" },
              { id: "research", name: "Research" },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "sessions.delete": { ok: true, deleted: true },
          "sessions.list": {
            cases: [
              {
                match: { agentId: "research", offset: pageSize },
                response: sessionsListResponse(research.slice(pageSize), {
                  offset: pageSize,
                  totalCount: research.length,
                }),
              },
              {
                match: { agentId: "research", limit: research.length },
                response: sessionsListResponse(research),
              },
              {
                match: { agentId: "research" },
                response: sessionsListResponse(research.slice(0, pageSize), {
                  hasMore: true,
                  nextOffset: pageSize,
                  totalCount: research.length,
                }),
              },
              { response: sessionsListResponse([main, ...targets]) },
            ],
          },
        },
      });
      const sidebar = page.locator("openclaw-app-sidebar");
      const viewport = sidebar.locator(".sidebar-shell__body");
      const researchListQuery = {
        source: "sidebar",
        excludeDock: true,
        agentId: "research",
        archivedFilter: "archived",
        limit: pageSize,
        rowMode: "sidebar",
        includeDerivedTitles: true,
        includeLastMessage: true,
      } as const;
      const rowFor = (key: string) =>
        sidebar.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      const revealLastResearch = async () => {
        for (let remaining = research.length; remaining > 0; remaining -= 1) {
          if (await rowFor(lastResearch.key).count()) {
            break;
          }
          const showMore = ui.button(sidebar, "Show more");
          if (!(await showMore.count())) {
            break;
          }
          const before = await viewport.evaluate((element) => element.scrollHeight);
          await showMore.click();
          await expect
            .poll(() => viewport.evaluate((element) => element.scrollHeight))
            .toBeGreaterThan(before);
        }
        await revealSidebarTarget(viewport, rowFor(lastResearch.key));
      };
      const sidebarState = () =>
        evaluateControlUiContext(
          page,
          (application, query) => {
            const sessions = application.sessions;
            const filtered = sessions.listSnapshot(query);
            return {
              keys: filtered.result?.sessions.map((row) => row.key) ?? [],
              revision:
                sessions.state.agentId === "research" && !sessions.state.loading
                  ? sessions.canonicalListRevision
                  : -1,
            };
          },
          researchListQuery,
        );
      const filter = async (label: "Archived" | "All") => {
        await ui.button(sidebar, "Filter & sort").click();
        await chooseSidebarMenuOption(sidebar.page(), "Status", label);
        await closeSidebarMenu(page);
      };
      const pageKeys = async () => (await sidebarState()).keys;
      const settledResearchRevision = async () => (await sidebarState()).revision;
      await page.goto(`${suite.server.baseUrl}chat`);
      await filter("Archived");
      for (const target of targets) {
        await rowFor(target.key).waitFor({ state: "visible" });
        await rowFor(target.key).click({ modifiers: ["Alt"] });
      }
      await gateway.deferNext("sessions.delete", { key: targets[0]!.key });
      await rowFor(targets[0]!.key).click({ button: "right" });
      await ui.menuItem(page.locator("openclaw-session-menu"), "Delete 2…").click();
      const confirmation = await waitForConfirmModal(page);
      await ui.button(confirmation, "Delete").click();
      await gateway.waitForRequest("sessions.delete", { match: { key: targets[0]!.key } });
      await ui.button(sidebar, /Switch agent/, false).click();
      await ui.menuItem(sidebar.locator(".sidebar-agent-menu"), "Research").click();
      await revealSidebarTarget(viewport, rowFor(research[0]!.key));
      const loadMore = sidebar.locator(".sidebar-session-pagination--roster > button");
      await loadMore.waitFor({ state: "visible" });
      await expect.poll(settledResearchRevision).toBeGreaterThan(0);
      const revision = await settledResearchRevision();
      // Both deletes settle before the mutation owner reconciles the current
      // roster. Wait for its accepted publication before testing pagination.
      const researchQuery = { agentId: "research", includeGlobal: true };
      const previous = (await gateway.getRequests("sessions.list", researchQuery)).length;
      const filteredQuery = { agentId: "research", archived: true };
      const previousFiltered = (await gateway.getRequests("sessions.list", filteredQuery)).length;
      await gateway.deferNext("sessions.list", filteredQuery);
      await page.clock.install();
      await pauseVirtualClock(page);
      await gateway.resolveDeferred("sessions.delete");
      // Advance the managed-list refresh window and nested mock response timers.
      await page.clock.runFor(5_001);
      await page.clock.resume();
      await gateway.waitForRequest("sessions.delete", { match: { key: targets[1]!.key } });
      await gateway.waitForRequest("sessions.list", {
        after: previous,
        match: researchQuery,
      });
      await gateway.waitForRequest("sessions.list", {
        after: previousFiltered,
        match: filteredQuery,
      });
      await expect.poll(settledResearchRevision).toBeGreaterThan(revision);
      await expect.poll(() => loadMore.isDisabled()).toBe(true);
      expect((await gateway.getRequests("sessions.delete")).map(({ params }) => params)).toEqual(
        targets.map((target) =>
          expect.objectContaining({
            key: target.key,
            agentId: "main",
            expectedSessionId: target.sessionId,
            archivedOnly: true,
          }),
        ),
      );
      await loadMore.scrollIntoViewIfNeeded();
      const bounds = await loadMore.boundingBox();
      if (!bounds) {
        throw new Error("Expected the roster pagination button to be visible");
      }
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      expect(
        await gateway.getRequests("sessions.list", { agentId: "research", offset: pageSize }),
      ).toHaveLength(0);
      await ui.expectAttribute(loadMore, "aria-busy", "true");
      await ui.pollAttribute(loadMore, "aria-label").toContain("Loading");
      await gateway.resolveDeferred("sessions.list");
      await expect.poll(() => loadMore.isDisabled()).toBe(false);
      await ui.expectAttribute(loadMore, "aria-busy", "false");
      await ui.expectAttribute(loadMore, "aria-label", "Load more sessions");
      await loadMore.click();
      await expect
        .poll(() => gateway.getRequests("sessions.list", { agentId: "research", offset: pageSize }))
        .toHaveLength(1);
      await expect.poll(pageKeys).toContain(lastResearch.key);
      await revealLastResearch();
      await ui.expectCount(rowFor(lastResearch.key), 1);
      await filter("All");
      await revealSidebarTarget(viewport, rowFor(research[0]!.key));
      await filter("Archived");
      await revealSidebarTarget(viewport, rowFor(research[0]!.key));
      if (!(await pageKeys()).includes(lastResearch.key)) {
        await loadMore.click();
      }
      await expect.poll(pageKeys).toContain(lastResearch.key);
      await revealLastResearch();
    });
  });
});
