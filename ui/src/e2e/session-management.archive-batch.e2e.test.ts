import { expect, it } from "vitest";
import type { AppSidebarSessionNavigationElement } from "../components/app-sidebar-session-navigation.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  activateSelfRemovingControl,
  captureUiProof,
  controlUiSessionPath,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const rosterMatch = { includeGlobal: true };

suite.define(() => {
  it.each([
    "refreshed",
    "failed refresh",
    "Undo without restore events",
    "Undo with failed refresh",
  ] as const)("reconciles batch archive acknowledgements with %s", async (scenario) => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const batchKeys = ["agent:main:batch-a", "agent:main:batch-b", "agent:main:batch-c"] as const;
    const batchRows = [
      sessionRow(batchKeys[0], "Batch A", baseTime - 1_000, {
        pinned: true,
        pinnedAt: baseTime - 1_000,
      }),
      sessionRow(batchKeys[1], "Batch B", baseTime - 2_000, {
        hasActiveRun: true,
        status: "running",
      }),
      sessionRow(batchKeys[2], "Batch C", baseTime - 3_000),
    ];
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.patchMany"],
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", baseTime),
          ...batchRows,
        ]),
      },
      sessionArchiveFiltering: true,
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      const rowFor = (key: string) =>
        sidebar.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      const readPinnedSessionState = () =>
        page.evaluate((key) => {
          const row = document
            .querySelector<AppSidebarSessionNavigationElement>("openclaw-app-sidebar")
            ?.sessionData.sessionsResult?.sessions.find((session) => session.key === key);
          return row
            ? { archived: row.archived, pinned: row.pinned, pinnedAt: row.pinnedAt }
            : null;
        }, batchKeys[0]);
      await rowFor(batchKeys[0]).waitFor({ state: "visible", timeout: 10_000 });
      for (const key of batchKeys.slice(1)) {
        await rowFor(key).waitFor({ state: "visible" });
      }
      expect(await readPinnedSessionState()).toEqual({
        archived: false,
        pinned: true,
        pinnedAt: baseTime - 1_000,
      });
      expect(
        await rowFor(batchKeys[0])
          .getByRole("button", { name: "Unpin session", exact: true })
          .count(),
      ).toBe(1);
      const listCountBeforeBatch = (await gateway.getRequests("sessions.list", rosterMatch)).length;

      for (const key of batchKeys) {
        await rowFor(key).click({ modifiers: ["Alt"] });
      }
      await rowFor(batchKeys[0]).click({ button: "right" });
      const batchMenu = page.locator("openclaw-session-menu");
      const archiveItem = batchMenu.getByRole("menuitem", {
        name: `Archive ${batchKeys.length}`,
      });
      await archiveItem.waitFor({ state: "visible", timeout: 10_000 });
      expect(await archiveItem.isDisabled()).toBe(false);
      expect(
        await batchMenu.getByRole("menuitem", { name: `Delete ${batchKeys.length}…` }).isDisabled(),
      ).toBe(true);
      await captureUiProof(suite, page, "sidebar-multi-select-archive-menu.png");
      await page.keyboard.press("A");

      const patchMany = await gateway.waitForRequest("sessions.patchMany");
      for (const key of batchKeys) {
        await rowFor(key).waitFor({ state: "detached" });
      }
      expect(await page.locator(".app-toast").count()).toBe(0);
      expect(await gateway.getRequests("sessions.patchMany")).toHaveLength(1);
      await captureUiProof(suite, page, "sidebar-multi-select-archive-pending.png");
      if (scenario !== "refreshed") {
        await gateway.deferNext("sessions.list", rosterMatch);
      }
      await gateway.resolveDeferred("sessions.patchMany");
      const patchManyParams = requireRecord(patchMany.params);
      expect(patchManyParams.patch).toEqual({ archived: true });
      expect(patchManyParams.targets).toEqual(
        batchKeys.map((key) => ({
          key,
          agentId: "main",
          expectedSessionId: `session:${key}`,
        })),
      );
      expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      expect(await gateway.getRequests("sessions.abort")).toEqual([]);
      expect(await gateway.getRequests("agent.wait")).toEqual([]);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list", rosterMatch)).length, {
          timeout: 10_000,
        })
        .toBe(listCountBeforeBatch + 1);
      if (scenario === "failed refresh" || scenario === "Undo with failed refresh") {
        const error = {
          code: "UNAVAILABLE",
          message: "Archive list refresh unavailable",
        };
        // All roster readers must stay unavailable, including the active chat's child roster.
        await gateway.setMethodResponse("sessions.list", { __mockError: error });
        await gateway.rejectDeferred("sessions.list", error);
      } else if (scenario === "Undo without restore events") {
        // These committed events arrive while the original rows are still held.
        // Undo must retire their confirmation even if its own events are dropped.
        const archivedAt = Date.now();
        for (const row of batchRows) {
          await gateway.emitGatewayEvent("sessions.changed", {
            ...row,
            archived: true,
            archivedAt,
            pinned: false,
            pinnedAt: undefined,
            updatedAt: archivedAt,
            sessionKey: row.key,
            reason: "patch",
          });
        }
        await gateway.resolveDeferred("sessions.list");
      }
      const toast = page.locator(".app-toast");
      await expect.poll(() => toast.textContent()).toContain("Archived 3 sessions");
      if (scenario === "failed refresh" || scenario === "Undo with failed refresh") {
        await captureUiProof(suite, page, "batch-archive-failed-readback.png");
      }
      for (const key of batchKeys) {
        await expect.poll(() => rowFor(key).count()).toBe(0);
      }
      if (scenario === "failed refresh" || scenario === "Undo with failed refresh") {
        await expect
          .poll(() => page.locator("[data-sidebar-session-error]").textContent())
          .toContain("Archive list refresh unavailable");
        expect(await readPinnedSessionState()).toEqual({
          archived: true,
          pinned: false,
          pinnedAt: undefined,
        });
      } else {
        await expect.poll(() => page.locator("[data-sidebar-session-error]").count()).toBe(0);
      }
      await captureUiProof(suite, page, "sidebar-multi-select-archive-settled.png");
      if (scenario === "refreshed") {
        await page.waitForTimeout(500);
        expect((await gateway.getRequests("sessions.list", rosterMatch)).length).toBe(
          listCountBeforeBatch + 1,
        );
      } else if (
        scenario === "Undo without restore events" ||
        scenario === "Undo with failed refresh"
      ) {
        const listCountBeforeUndo = (await gateway.getRequests("sessions.list", rosterMatch))
          .length;
        await gateway.deferNext("sessions.patchMany");
        await gateway.deferNext("sessions.list", rosterMatch);
        await activateSelfRemovingControl(toast.getByRole("button", { name: "Undo", exact: true }));
        const undo = await gateway.waitForRequest("sessions.patchMany", { after: 1 });
        expect(requireRecord(undo.params)).toEqual({
          targets: patchManyParams.targets,
          patch: { archived: false },
        });
        await gateway.deferNext("sessions.patchMany");
        // Generated replies commit the canonical fixture without emitting session events.
        await gateway.resolveDeferred("sessions.patchMany");
        const repin = await gateway.waitForRequest("sessions.patchMany", { after: 2 });
        expect(requireRecord(repin.params)).toEqual({
          targets: [
            {
              key: batchKeys[0],
              agentId: "main",
              expectedSessionId: `session:${batchKeys[0]}`,
            },
          ],
          patch: { pinned: true },
        });
        if (scenario === "Undo with failed refresh") {
          expect(await readPinnedSessionState()).toEqual({
            archived: false,
            pinned: false,
            pinnedAt: undefined,
          });
        }
        await gateway.resolveDeferred("sessions.patchMany");
        await gateway.waitForRequest("sessions.list", {
          after: listCountBeforeUndo,
          match: rosterMatch,
        });
        if (scenario === "Undo with failed refresh") {
          const error = {
            code: "UNAVAILABLE",
            message: "Undo list refresh unavailable",
          };
          // All roster readers must stay unavailable, including the active chat's child roster.
          await gateway.setMethodResponse("sessions.list", { __mockError: error });
          await gateway.rejectDeferred("sessions.list", error);
          await expect
            .poll(() => page.locator("[data-sidebar-session-error]").textContent())
            .toContain("Undo list refresh unavailable");
        } else {
          await gateway.resolveDeferred("sessions.list");
        }
        try {
          for (const key of batchKeys) {
            await expect.poll(() => rowFor(key).count()).toBe(1);
          }
          await expect.poll(readPinnedSessionState).toMatchObject({
            archived: false,
            pinned: true,
            ...(scenario === "Undo with failed refresh" ? { pinnedAt: undefined } : {}),
          });
          expect(
            await rowFor(batchKeys[0])
              .getByRole("button", { name: "Unpin session", exact: true })
              .count(),
          ).toBe(1);
          expect(new URL(page.url()).pathname).toBe(controlUiSessionPath("agent:main:main"));
        } finally {
          await captureUiProof(suite, page, "batch-archive-undo-without-events.png");
        }
      }
    } finally {
      await context.close();
    }
  });
});
