import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import type { AppSidebarSessionNavigationElement } from "../components/app-sidebar-session-navigation.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForConfirmModal,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("keeps the selected archived sidebar subscribed after another agent's bulk deletion", async () => {
    const artifactDir = createControlUiE2eArtifactDir("sidebar-bulk-delete-scope");
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
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
    const rowFor = (key: string) =>
      sidebar.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
    const revealLastResearch = async () => {
      const rows = sidebar.locator(".sidebar-recent-session");
      for (let remaining = research.length; remaining > 0; remaining -= 1) {
        if (await rowFor(lastResearch.key).count()) {
          break;
        }
        const before = await rows.count();
        await sidebar.getByRole("button", { name: "Show more", exact: true }).click();
        await expect.poll(() => rows.count()).toBeGreaterThan(before);
      }
      await rowFor(lastResearch.key).scrollIntoViewIfNeeded();
      await rowFor(lastResearch.key).waitFor({ state: "visible" });
    };
    const sidebarState = () =>
      page.evaluate(() => {
        const sidebarElement =
          document.querySelector<AppSidebarSessionNavigationElement>("openclaw-app-sidebar");
        const data = sidebarElement?.sessionData;
        const sessions = data?.context?.sessions;
        const filtered =
          data && sessions ? sessions.listSnapshot(data.sessionListQuery("research")) : undefined;
        const button = sidebarElement?.querySelector<HTMLButtonElement>(
          ".sidebar-session-pagination--roster > button",
        );
        return {
          selectedAgentId: sidebarElement?.expandedAgentId() ?? null,
          canonicalAgentId: sessions?.state.agentId ?? null,
          canonicalLoading: sessions?.state.loading ?? null,
          canonicalRevision: sessions?.canonicalListRevision ?? null,
          filteredAgentId: filtered?.agentId ?? null,
          filteredLoading: filtered?.loading ?? null,
          filteredNextOffset: filtered?.result?.nextOffset ?? null,
          sidebarAgentId: data?.sessionsAgentId ?? null,
          sidebarLoading: data?.sessionsLoading ?? null,
          nextOffset: data?.sessionsResult?.nextOffset ?? null,
          hasMore: data?.sessionsResult?.hasMore ?? null,
          disabled: button?.disabled ?? null,
          ariaBusy: button?.getAttribute("aria-busy") ?? null,
        };
      });
    const observations: Array<{
      stage: string;
      visibleRows: string[];
      state: Awaited<ReturnType<typeof sidebarState>>;
      paginationRequests: number;
    }> = [];
    const capture = async (stage: string) => {
      observations.push({
        stage,
        visibleRows: await sidebar.locator(".sidebar-recent-session").allTextContents(),
        state: await sidebarState(),
        paginationRequests: (
          await gateway.getRequests("sessions.list", { agentId: "research", offset: pageSize })
        ).length,
      });
      await page.screenshot({ path: path.join(artifactDir, `${stage}.png`) });
    };
    const filter = async (label: "Archived" | "All") => {
      await sidebar.getByRole("button", { name: "Filter & sort" }).click();
      await sidebar
        .locator(".sidebar-session-sort-menu")
        .getByRole("menuitemradio", { name: label, exact: true })
        .click();
    };
    const pageKeys = () =>
      page.evaluate(() => {
        const data =
          document.querySelector<AppSidebarSessionNavigationElement>(
            "openclaw-app-sidebar",
          )?.sessionData;
        return (
          data?.context?.sessions
            .listSnapshot(data.sessionListQuery("research"))
            .result?.sessions.map((row) => row.key) ?? []
        );
      });
    const settledResearchRevision = () =>
      page.evaluate(() => {
        const sessions =
          document.querySelector<AppSidebarSessionNavigationElement>("openclaw-app-sidebar")
            ?.sessionData.context?.sessions;
        return sessions?.state.agentId === "research" && !sessions.state.loading
          ? sessions.canonicalListRevision
          : -1;
      });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await filter("Archived");
      for (const target of targets) {
        await rowFor(target.key).waitFor({ state: "visible" });
        await rowFor(target.key).click({ modifiers: ["Alt"] });
      }
      await gateway.deferNext("sessions.delete", { key: targets[0]!.key });
      await rowFor(targets[0]!.key).click({ button: "right" });
      await page
        .locator("openclaw-session-menu")
        .getByRole("menuitem", { name: "Delete 2…", exact: true })
        .click();
      const confirmation = await waitForConfirmModal(page);
      await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
      await gateway.waitForRequest("sessions.delete", { match: { key: targets[0]!.key } });
      await sidebar.getByRole("button", { name: /Switch agent/ }).click();
      await sidebar
        .locator("wa-dropdown.sidebar-agent-menu")
        .getByRole("menuitemradio", { name: "Research", exact: true })
        .click();
      await rowFor(research[0]!.key).waitFor({ state: "visible" });
      const loadMore = sidebar.getByRole("button", { name: "Load more sessions", exact: true });
      await loadMore.waitFor({ state: "visible" });
      await expect.poll(settledResearchRevision).toBeGreaterThan(0);
      const settledResearch = {
        selectedAgentId: "research",
        canonicalAgentId: "research",
        canonicalLoading: false,
        filteredAgentId: "research",
        filteredLoading: false,
        filteredNextOffset: pageSize,
        sidebarAgentId: "research",
        sidebarLoading: false,
        nextOffset: pageSize,
        hasMore: true,
      };
      await expect.poll(sidebarState).toMatchObject(settledResearch);
      const revision = await settledResearchRevision();
      await capture("before-delete-response");
      // Both deletes settle before the mutation owner reconciles the current
      // roster. Wait for its accepted publication before testing pagination.
      const researchQuery = { agentId: "research", includeGlobal: true };
      const previous = (await gateway.getRequests("sessions.list", researchQuery)).length;
      const filteredQuery = { agentId: "research", archived: true };
      const previousFiltered = (await gateway.getRequests("sessions.list", filteredQuery)).length;
      await gateway.deferNext("sessions.list", filteredQuery);
      await gateway.resolveDeferred("sessions.delete");
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
      await expect.poll(sidebarState).toMatchObject({
        ...settledResearch,
        filteredLoading: true,
        sidebarLoading: true,
      });
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
      await capture("after-delete-response");
      const bounds = await loadMore.boundingBox();
      if (!bounds) {
        throw new Error("Expected the roster pagination button to be visible");
      }
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await capture("during-filtered-refresh-click");
      expect(
        await gateway.getRequests("sessions.list", { agentId: "research", offset: pageSize }),
      ).toHaveLength(0);
      await expect.poll(() => loadMore.isDisabled()).toBe(true);
      await expect.poll(() => loadMore.getAttribute("aria-busy")).toBe("true");
      await gateway.resolveDeferred("sessions.list");
      await expect.poll(sidebarState).toMatchObject(settledResearch);
      await expect.poll(() => loadMore.isDisabled()).toBe(false);
      await expect.poll(() => loadMore.getAttribute("aria-busy")).toBe("false");
      await loadMore.click();
      // Preserve the original assertion failure after exercising the recovery control.
      let paginationFailure: Error | undefined;
      try {
        await expect
          .poll(() =>
            gateway.getRequests("sessions.list", { agentId: "research", offset: pageSize }),
          )
          .toHaveLength(1);
        await expect.poll(pageKeys).toContain(lastResearch.key);
        await revealLastResearch();
        await expect.poll(() => rowFor(lastResearch.key).count()).toBe(1);
      } catch (error) {
        paginationFailure = error instanceof Error ? error : new Error(String(error));
      }
      await capture("after-pagination");
      await filter("All");
      await rowFor(research[0]!.key).waitFor({ state: "visible" });
      await filter("Archived");
      await rowFor(research[0]!.key).waitFor({ state: "visible" });
      if (!(await pageKeys()).includes(lastResearch.key)) {
        await loadMore.click();
      }
      await expect.poll(pageKeys).toContain(lastResearch.key);
      await revealLastResearch();
      await capture("after-filter-recovery");
      if (paginationFailure) {
        throw paginationFailure;
      }
    } finally {
      await capture("final-state");
      await writeFile(
        path.join(artifactDir, "observations.json"),
        JSON.stringify(
          {
            url: page.url(),
            stages: observations,
            acceptedResearchRows: await pageKeys(),
            listRequests: (await gateway.getRequests("sessions.list")).map(({ params }) => params),
            deleteRequests: (await gateway.getRequests("sessions.delete")).map(
              ({ params }) => params,
            ),
          },
          null,
          2,
        ),
      );
      await context.close();
    }
  });
});
