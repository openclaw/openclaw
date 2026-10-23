import type { Locator } from "playwright";
import { it, expect } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite();

const rosterMatch = { includeGlobal: true };

suite.define(() => {
  it.each([
    "refreshed",
    "failed refresh",
    "Undo without restore events",
    "Undo with failed refresh",
  ] as const)("reconciles batch archive acknowledgements with %s", (scenario) =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const failedRefresh = scenario.includes("failed refresh");
      const undo = scenario.startsWith("Undo");

      const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
      const batchKeys = ["agent:main:batch-a", "agent:main:batch-b", "agent:main:batch-c"] as const;
      const batchRows = [
        sessionRow(batchKeys[0], "Batch A", baseTime - 1_000, { pinned: true }),
        sessionRow(batchKeys[1], "Batch B", baseTime - 2_000, {
          hasActiveRun: true,
          status: "running",
        }),
        sessionRow(batchKeys[2], "Batch C", baseTime - 3_000),
      ];
      const gateway = await ui.installSessionRows(
        page,
        [sessionRow("agent:main:main", "Main", baseTime), ...batchRows],
        {
          deferredMethods: ["sessions.patchMany"],
          sessionArchiveFiltering: true,
          sessionKey: "agent:main:main",
        },
      );

      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      const rowFor = ui.sessionRows(sidebar);
      const eachRow = async (check: (row: Locator) => Promise<unknown>, offset = 0) => {
        for (const key of batchKeys.slice(offset)) {
          await check(rowFor(key));
        }
      };
      const sidebarError = page.locator("[data-sidebar-session-error]");
      const readPinnedSessionState = () =>
        evaluateControlUiContext(
          page,
          ({ sessions }, key) => {
            const found = sessions.presentation.result?.sessions.find((row) => row.key === key);
            return found
              ? { archived: found.archived, pinned: found.pinned, pinnedAt: found.pinnedAt }
              : null;
          },
          batchKeys[0],
        );
      const pinState = (archived: boolean, pinned = false) => ({
        archived,
        pinned,
        pinnedAt: pinned ? baseTime - 1_000 : undefined,
      });
      const failRefresh = async (message: string) => {
        const error = { code: "UNAVAILABLE", message };
        // Keep every roster reader unavailable, including the active chat's child roster.
        await gateway.setMethodResponse("sessions.list", { __mockError: error });
        await gateway.rejectDeferred("sessions.list", error);
      };
      await ui.visible(rowFor(batchKeys[0]), 10_000);
      await eachRow((row) => ui.visible(row), 1);
      expect(await readPinnedSessionState()).toEqual(pinState(false, true));
      // A legacy shared pin is not a personal navigation preference.
      expect(await ui.button(rowFor(batchKeys[0]), "Pin session").count()).toBe(1);
      const initialLists = await ui.requestCount(gateway, "sessions.list", rosterMatch);

      await eachRow((row) => row.click({ modifiers: ["Alt"] }));
      await rowFor(batchKeys[0]).click({ button: "right" });
      const batchMenu = page.locator("openclaw-session-menu");
      const archiveItem = ui.menuItem(batchMenu, `Archive ${batchKeys.length}`, false);
      await ui.visible(archiveItem, 10_000);
      const deleteItem = ui.menuItem(batchMenu, `Delete ${batchKeys.length}…`, false);
      expect([await archiveItem.isDisabled(), await deleteItem.isDisabled()]).toEqual([
        false,
        true,
      ]);

      await page.keyboard.press("A");
      let confirm = await support.waitForConfirmModal(page);
      await confirm.getByText("This selection contains active work.", { exact: false }).waitFor();

      expect(await gateway.getRequests("sessions.patchMany")).toEqual([]);
      if (scenario === "refreshed") {
        await ui.button(confirm, "Cancel").click();
        await eachRow((row) => ui.visible(row));
        expect(await gateway.getRequests("sessions.patchMany")).toEqual([]);
        await rowFor(batchKeys[0]).click({ button: "right" });
        await ui.menuItem(page.locator("openclaw-session-menu"), "Archive 3", false).click();
        confirm = await support.waitForConfirmModal(page);
      }
      await ui.button(confirm, "Archive 3").click();

      const patchMany = await gateway.waitForRequest("sessions.patchMany");
      await eachRow((row) => row.waitFor({ state: "detached" }));
      expect(await page.locator(".app-toast").count()).toBe(0);
      expect(await gateway.getRequests("sessions.patchMany")).toHaveLength(1);

      if (scenario !== "refreshed") {
        await gateway.deferNext("sessions.list", rosterMatch);
      }
      await gateway.resolveDeferred("sessions.patchMany");
      const patchManyParams = support.requireRecord(patchMany.params);
      expect({ patch: patchManyParams.patch, targets: patchManyParams.targets }).toEqual({
        patch: { archived: true },
        targets: batchKeys.map((key) => ({
          key,
          agentId: "main",
          expectedSessionId: `session:${key}`,
        })),
      });
      await ui.expectNoRequests(gateway, "sessions.patch", "sessions.abort", "agent.wait");
      await expect
        .poll(async () => await ui.requestCount(gateway, "sessions.list", rosterMatch), {
          timeout: 10_000,
        })
        .toBe(initialLists + 1);
      if (failedRefresh) {
        await failRefresh("Archive list refresh unavailable");
      } else if (scenario === "Undo without restore events") {
        // Eventless Undo must retire archive confirmations received while the rows were held.
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
      await ui.expectText(toast, "Archived 3 sessions");

      await eachRow((row) => ui.expectCount(row, 0));
      if (failedRefresh) {
        await ui.expectText(sidebarError, "Archive list refresh unavailable");
        expect(await readPinnedSessionState()).toEqual(pinState(true));
      } else {
        await ui.expectCount(sidebarError, 0);
      }

      if (scenario === "refreshed") {
        await page.waitForTimeout(500);
        expect(await ui.requestCount(gateway, "sessions.list", rosterMatch)).toBe(initialLists + 1);
      } else if (undo) {
        const listCountBeforeUndo = await ui.requestCount(gateway, "sessions.list", rosterMatch);
        await gateway.deferNext("sessions.patchMany");
        await gateway.deferNext("sessions.list", rosterMatch);
        await support.activateSelfRemovingControl(ui.button(toast, "Undo"));
        const restored = await gateway.waitForRequest("sessions.patchMany", { after: 1 });
        expect(support.requireRecord(restored.params)).toEqual({
          targets: patchManyParams.targets,
          patch: { archived: false },
        });
        // Eventless Undo restores archive state without re-pinning shared session metadata.
        await gateway.resolveDeferred("sessions.patchMany");
        expect(await gateway.getRequests("sessions.patchMany")).toHaveLength(2);
        if (failedRefresh) {
          expect(await readPinnedSessionState()).toEqual(pinState(false));
        }
        await gateway.waitForRequest("sessions.list", {
          after: listCountBeforeUndo,
          match: rosterMatch,
        });
        if (failedRefresh) {
          await failRefresh("Undo list refresh unavailable");
          await ui.expectText(sidebarError, "Undo list refresh unavailable");
        } else {
          await gateway.resolveDeferred("sessions.list");
        }

        await eachRow((row) => ui.expectCount(row, 1));
        await expect.poll(readPinnedSessionState).toMatchObject(pinState(false));
        expect(await ui.button(rowFor(batchKeys[0]), "Pin session").count()).toBe(1);
        expect(await gateway.getRequests("sessions.patchMany")).toHaveLength(2);
        expect(await gateway.getRequests("sessions.patch")).toEqual([]);
        expect(new URL(page.url()).pathname).toBe(support.controlUiSessionPath("agent:main:main"));
      }
    }),
  );
});
