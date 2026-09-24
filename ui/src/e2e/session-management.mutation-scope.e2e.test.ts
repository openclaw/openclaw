import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import type { SessionDataController } from "../components/session-data-controller.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  installMutationScopeDiagnostics,
  logMutationScopeRequests,
} from "./session-management.mutation-scope.test-support.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each([
    { operation: "rename", filter: "Active" },
    { operation: "batch archive", filter: "Active" },
    { operation: "rename", filter: "All" },
    { operation: "batch archive", filter: "All" },
  ] as const)(
    "keeps $filter rows, pagination, and updates after another agent's $operation settles",
    async ({ operation, filter }) => {
      const artifactDir = createControlUiE2eArtifactDir("session-mutation-scope");
      const context = await suite.browser.newContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      await page.clock.install();
      await installMutationScopeDiagnostics(page, { operation, filter });
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
      const researchInventory = [
        researchRows[0]!,
        researchRows[1]!,
        ...scheduledRows,
        researchRows[2]!,
      ];
      const retainedLimit = researchInventory.length + 1;
      const pageResponse = (rows: typeof researchRows, offset: number, limit: number) => {
        const pageRows = rows.slice(offset, offset + limit);
        const nextOffset = offset + pageRows.length;
        const hasMore = nextOffset < rows.length;
        return {
          ...sessionsListResponse(pageRows, {
            offset,
            totalCount: rows.length,
            hasMore,
            nextOffset: hasMore ? nextOffset : null,
          }),
          limitApplied: limit,
        };
      };
      const responseFor = (rows: typeof researchRows) => ({
        cases: [
          ...[pageSize, retainedLimit].map((offset) => ({
            match: { agentId: "research", offset },
            response: pageResponse(rows, offset, pageSize),
          })),
          ...[retainedLimit, retainedLimit + 1].map((limit) => ({
            match: { agentId: "research", limit },
            response: pageResponse(rows, 0, limit),
          })),
          {
            match: { agentId: "research" },
            response: pageResponse(rows, 0, pageSize),
          },
          { response: sessionsListResponse(mainRows) },
        ],
      });
      const gateway = await installMockGateway(page, {
        sessions: [...mainRows, ...researchInventory],
        sessionKey: original.key,
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
          "sessions.list": responseFor(researchInventory),
        },
      });
      const sidebar = page.locator("openclaw-app-sidebar");
      const rowFor = (key: string) =>
        sidebar.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      const capture = (stage: string) =>
        page.screenshot({ path: path.join(artifactDir, `${stage}.png`) });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, original.key));
        await rowFor(original.key).waitFor({ state: "visible" });
        if (filter === "All") {
          await sidebar.getByRole("button", { name: "Filter & sort" }).click();
          await page
            .locator(".sidebar-session-sort-menu")
            .getByRole("menuitemradio", { name: filter, exact: true })
            .click();
          await gateway.waitForRequest("sessions.list", {
            match: { agentId: "main", archived: "all" },
          });
        }
        const method = operation === "rename" ? "sessions.patch" : "sessions.patchMany";
        await gateway.deferNext(method);
        if (operation === "rename") {
          if (filter === "All") {
            await rowFor(original.key).click({ button: "right" });
            await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
          } else {
            await page.locator(".chat-pane__session-title-button").click();
          }
          const input = page.locator(
            filter === "All"
              ? 'openclaw-modal-dialog[label="Rename session"] input'
              : ".chat-pane__session-title-input",
          );
          await input.fill("Renamed original");
          await input.press("Enter");
          const request = await waitForPatch(
            gateway,
            (params) => params.label === "Renamed original",
          );
          expect(request.params).toMatchObject({
            key: original.key,
            expectedSessionId: original.sessionId,
          });
        } else {
          for (const row of batch) {
            await rowFor(row.key).click({ modifiers: ["Alt"] });
          }
          await rowFor(original.key).click({ button: "right" });
          await page
            .locator("openclaw-session-menu")
            .getByRole("menuitem", { name: "Archive 2", exact: true })
            .waitFor({ state: "visible" });
          await page.keyboard.press("A");
          const request = await gateway.waitForRequest(method);
          expect(request.params).toMatchObject({
            patch: { archived: true },
            targets: batch.map((row) => ({
              key: row.key,
              agentId: "main",
              expectedSessionId: row.sessionId,
            })),
          });
        }
        await sidebar.getByRole("button", { name: /Switch agent/ }).click();
        await sidebar
          .locator("wa-dropdown.sidebar-agent-menu")
          .getByRole("menuitemradio", { name: "Research", exact: true })
          .click();
        await rowFor(researchRows[1]!.key).waitFor({ state: "visible" });
        await sidebar
          .getByRole("button", { name: "Load more sessions", exact: true })
          .waitFor({ state: "visible" });
        await capture("before-mutation-response");
        const listsBefore = (
          await gateway.getRequests("sessions.list", { agentId: "main", includeGlobal: true })
        ).length;
        await gateway.deferNext("sessions.list", { agentId: "main", includeGlobal: true });
        const filteredMatch = { agentId: "research", archived: "all" };
        const refreshMatch = {
          ...filteredMatch,
          includeDerivedTitles: true,
          includeLastMessage: true,
        };
        const filteredReadsBefore = (await gateway.getRequests("sessions.list", filteredMatch))
          .length;
        await gateway.resolveDeferred(method);
        await gateway.waitForRequest("sessions.list", {
          after: listsBefore,
          match: { agentId: "main", includeGlobal: true },
        });
        await gateway.resolveDeferred("sessions.list");
        if (operation === "batch archive") {
          await expect
            .poll(() => page.locator(".app-toast").textContent())
            .toContain("Archived 2 sessions");
        }
        await capture("after-mutation-response");
        if (filter === "All") {
          expect(await gateway.getRequests("sessions.list", filteredMatch)).toHaveLength(
            filteredReadsBefore,
          );
        }
        await rowFor(researchRows[1]!.key).waitFor({ state: "visible" });
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
        const readsBeforeEvent = (await gateway.getRequests("sessions.list", researchMatch)).length;
        await pauseVirtualClock(page);
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: newRow.key,
          agentId: "research",
          reason: "create",
        });
        await page.clock.fastForward(5_001);
        await page.clock.resume();
        await gateway.waitForRequest("sessions.list", {
          match: researchMatch,
          after: readsBeforeEvent,
        });
        await rowFor(newRow.key).waitFor({ state: "visible" });
        await capture("after-selected-agent-update");
        await sidebar.getByRole("button", { name: "Load more sessions", exact: true }).click();
        await gateway.waitForRequest("sessions.list", {
          match: { agentId: "research", offset: pageSize },
        });
        await rowFor(researchRows[2]!.key).waitFor({ state: "visible" });
        await capture("after-pagination");
        await sidebar.getByRole("button", { name: /Switch agent/ }).click();
        await sidebar
          .locator("wa-dropdown.sidebar-agent-menu")
          .getByRole("menuitemradio", { name: "Main", exact: true })
          .click();
        if (operation === "rename") {
          await expect.poll(() => rowFor(original.key).textContent()).toContain("Renamed original");
        } else if (filter === "Active") {
          await expect.poll(() => rowFor(original.key).count()).toBe(0);
        } else {
          await rowFor(original.key).waitFor({ state: "visible" });
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
        const readsBeforeReturn = (await gateway.getRequests("sessions.list", researchMatch))
          .length;
        await sidebar.getByRole("button", { name: /Switch agent/ }).click();
        await sidebar
          .locator("wa-dropdown.sidebar-agent-menu")
          .getByRole("menuitemradio", { name: "Research", exact: true })
          .click();
        const returnedList = await gateway.waitForRequest("sessions.list", {
          match: researchMatch,
          after: readsBeforeReturn,
        });
        expect(returnedList.params).toMatchObject({
          limit: filter === "All" ? pageSize : retainedLimit,
        });
        await rowFor(newRow.key).waitFor({ state: "visible" });
        await expect.poll(() => rowFor(olderRow.key).count()).toBe(0);
        await sidebar.getByRole("button", { name: "Load more sessions", exact: true }).click();
        if (filter === "All" && operation === "rename") {
          await rowFor(researchRows[2]!.key).waitFor({ state: "visible" });
          await rowFor(olderRow.key).waitFor({ state: "visible" });
          await capture("retained-before-invalidation");
          const readsBeforeInvalidation = (await gateway.getRequests("sessions.list", refreshMatch))
            .length;
          await pauseVirtualClock(page);
          await gateway.emitGatewayEvent("sessions.changed", {
            sessionKey: newRow.key,
            agentId: "research",
            reason: "update",
          });
          await page.clock.fastForward(5_001);
          await page.clock.resume();
          const refresh = await gateway.waitForRequest("sessions.list", {
            match: refreshMatch,
            after: readsBeforeInvalidation,
          });
          expect(refresh.params).not.toHaveProperty("offset");
          expect(refresh.params).toMatchObject({ limit: retainedLimit + 1 });
          await expect
            .poll(() =>
              sidebar.evaluate(
                (element) =>
                  (element as HTMLElement & { sessionData: SessionDataController }).sessionData
                    .sessionsLoading,
              ),
            )
            .toBe(false);
          await capture("retained-after-invalidation");
        }
        await rowFor(researchRows[2]!.key).waitFor({ state: "visible" });
        await rowFor(olderRow.key).waitFor({ state: "visible" });
        if (filter === "All" && operation === "rename") {
          await rowFor(researchRows[1]!.key).waitFor({ state: "visible" });
          const readsBeforeRemoval = (await gateway.getRequests("sessions.list", refreshMatch))
            .length;
          await gateway.setMethodResponse(
            "sessions.list",
            responseFor(returnedResearchRows.filter((row) => row.key !== researchRows[1]!.key)),
          );
          await pauseVirtualClock(page);
          await gateway.emitGatewayEvent("sessions.changed", {
            sessionKey: newRow.key,
            agentId: "research",
            reason: "update",
          });
          await page.clock.fastForward(5_001);
          await page.clock.resume();
          const refresh = await gateway.waitForRequest("sessions.list", {
            match: refreshMatch,
            after: readsBeforeRemoval,
          });
          expect(refresh.params).toMatchObject({ limit: retainedLimit + 1 });
          await rowFor(researchRows[1]!.key).waitFor({ state: "hidden" });
          await rowFor(researchRows[2]!.key).waitFor({ state: "visible" });
          await rowFor(olderRow.key).waitFor({ state: "visible" });
          await capture("retained-after-membership-removal");
        }
      } finally {
        await capture("final-state");
        const listRequests = await gateway.getRequests("sessions.list");
        logMutationScopeRequests(listRequests, { operation, filter });
        await writeFile(
          path.join(artifactDir, "observations.json"),
          JSON.stringify(
            {
              url: page.url(),
              rows: await sidebar.locator(".sidebar-recent-session").allTextContents(),
              listRequests: listRequests.map(({ params }) => params),
              patchRequests: (await gateway.getRequests("sessions.patch")).map(
                ({ params }) => params,
              ),
              batchRequests: (await gateway.getRequests("sessions.patchMany")).map(
                ({ params }) => params,
              ),
            },
            null,
            2,
          ),
        );
        await context.close();
      }
    },
  );
});
