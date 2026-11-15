import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkboardSessionsBoardRead } from "@openclaw/workboard-contract";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installWorkboardPage } from "./workboard-page.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Sessions board result readiness",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("does not count unread sessions as empty before the first result or a changed people view", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const dir =
          process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
            ? createControlUiE2eArtifactDir("sessions-board-readiness")
            : null;
        const result: WorkboardSessionsBoardRead = {
          board: {
            id: "sessions",
            name: "Team sessions",
            kind: "sessions",
            createdAt: 1,
            updatedAt: 1,
            sessions: {
              columns: [
                {
                  id: "working",
                  label: "Working",
                  description: "Active work",
                  match: { run: ["active"] },
                },
                { id: "done", label: "Done", description: "Completed work", fallback: true },
              ],
            },
          },
          columns: [],
          sessions: [
            {
              key: "agent:main:review",
              sessionId: "review",
              agentId: "main",
              label: "Review release",
              run: "active",
              pullRequests: [],
              archived: false,
              lastActivityAt: 1,
              columnId: "working",
              source: "state",
              reason: "Active run",
            },
          ],
          total: 1,
          people: [],
        };
        result.columns = result.board.sessions.columns;
        const board = { ...result.board, total: 0, active: 0, archived: 0, byStatus: {} };
        const gateway = await installWorkboardPage(page, suite.server.baseUrl, "sessions", {
          "workboard.boards.list": { boards: [board] },
          "workboard.cards.list": { boards: [board], cards: [] },
          "workboard.sessionsBoard.read": {
            ...result,
            revision: { epoch: "audit", revision: 1, boardId: "sessions", scope: "everyone" },
          },
        });
        await page.goto(suite.server.baseUrl + "new");
        const boardLink = page
          .locator('[data-sidebar-entry="plugin:workboard/board-sessions"]')
          .getByRole("link", { name: "Team sessions", exact: true });
        await boardLink.waitFor();
        let after = await gateway.deferNext("workboard.sessionsBoard.read");
        await boardLink.click();
        await gateway.waitForRequest("workboard.sessionsBoard.read", { after });
        const surface = page.locator(".workboard-sessions");
        const empty = surface.locator(".workboard-sessions__empty");
        const counts = surface.locator(".workboard-column__count");
        await surface.getByText("Loading sessions…", { exact: true }).waitFor();
        expect.soft(await empty.count(), "initial pending must not imply empty").toBe(0);
        expect.soft(await counts.count(), "initial pending counts").toBe(0);
        await gateway.rejectDeferred("workboard.sessionsBoard.read", {
          code: "UNAVAILABLE",
          message: "Session board unavailable",
        });
        await surface.getByRole("alert").waitFor();
        if (dir) {
          const frame = await takeControlUiScreenshotFrame(
            page,
            surface,
            [surface.getByRole("alert")],
            { animations: "disabled" },
          );
          await writeFile(path.join(dir, "first-failure.png"), frame.png);
        }
        expect.soft(await empty.count(), "first failure must not imply empty").toBe(0);
        after = (await gateway.getRequests("workboard.sessionsBoard.read")).length;
        await page.locator('[data-sidebar-entry="route:sessions"] a').click();
        await surface.waitFor({ state: "hidden" });
        await boardLink.click();
        await gateway.waitForRequest("workboard.sessionsBoard.read", { after });
        await surface.getByRole("button", { name: "Review release", exact: true }).waitFor();
        after = await gateway.deferNext("workboard.sessionsBoard.read");
        await surface.locator(".workboard-people-filter .picker-select__trigger").click();
        await surface.getByRole("option", { name: "Involving me", exact: true }).click();
        const changed = await gateway.waitForRequest("workboard.sessionsBoard.read", { after });
        expect(changed.params).toMatchObject({ view: { involvingMe: true } });
        expect
          .soft(await empty.count(), "changed people view pending must not imply empty")
          .toBe(0);
        await gateway.rejectDeferred("workboard.sessionsBoard.read", {
          code: "UNAVAILABLE",
          message: "People view unavailable",
        });
        await surface.getByRole("alert").filter({ hasText: "People view unavailable" }).waitFor();
        if (dir) {
          const frame = await takeControlUiScreenshotFrame(
            page,
            surface,
            [surface.getByRole("alert")],
            {
              animations: "disabled",
            },
          );
          await writeFile(path.join(dir, "people-failure.png"), frame.png);
        }
        expect.soft(await empty.count(), "failed people view must not imply empty").toBe(0);
        await gateway.setMethodResponse("workboard.sessionsBoard.read", {
          ...result,
          sessions: [],
          total: 0,
          revision: { epoch: "audit", revision: 2, boardId: "sessions", scope: "everyone" },
        });
        await surface.locator(".workboard-people-filter .picker-select__trigger").click();
        await surface.getByRole("option", { name: "Everyone", exact: true }).click();
        await expect.poll(() => empty.count()).toBe(2);
        await expect.poll(() => surface.getByRole("alert").count()).toBe(0);
        for (const method of [
          "workboard.sessionsBoard.move",
          "workboard.sessionsBoard.update",
          "sessions.create",
        ]) {
          expect(await gateway.getRequests(method)).toHaveLength(0);
        }
      },
    );
  });
});
