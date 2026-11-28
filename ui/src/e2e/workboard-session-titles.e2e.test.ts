import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkboardSessionsBoardRead } from "@openclaw/workboard-contract";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createControlUiE2eSuite, tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";
import { installWorkboardPage } from "./workboard-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Workboard session titles" });

suite.define(() => {
  it("uses scoped board titles rather than session keys, without extra reads", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const columns = [
          {
            id: "active",
            label: "Active",
            description: "Work in progress",
            match: { run: ["active" as const] },
          },
          { id: "inbox", label: "Inbox", description: "Other sessions", fallback: true },
        ];
        const board = {
          id: "ops",
          name: "Operations",
          kind: "sessions" as const,
          createdAt: 1,
          updatedAt: 1,
          sessions: { columns },
        };
        const key = "agent:main:dashboard:incident-review";
        const unnamedKey = "agent:main:dashboard:unnamed-review";
        const result: WorkboardSessionsBoardRead = {
          board,
          columns,
          sessions: [key, unnamedKey].map((sessionKey, index) => ({
            key: sessionKey,
            sessionId: `review-${index}`,
            agentId: "main",
            label: sessionKey,
            derivedTitle: index === 0 ? "Review the incident" : undefined,
            run: "idle",
            archived: false,
            pullRequests: [],
            lastActivityAt: 1795800000000,
            columnId: "inbox",
            source: "state",
            reason: "Default column",
          })),
          total: 2,
          people: [],
        };
        const boards = [{ ...board, total: 0, active: 0, archived: 0, byStatus: {} }];
        const gateway = await installWorkboardPage(page, suite.server.baseUrl, board.id, {
          "workboard.boards.list": { boards },
          "workboard.cards.list": { boards, cards: [] },
          "workboard.sessionsBoard.read": result,
        });
        await page.goto(suite.server.baseUrl + "new");
        await page
          .locator('[data-sidebar-entry="plugin:workboard/board-ops"]')
          .getByRole("link", { name: "Operations", exact: true })
          .click();
        await gateway.waitForRequest("workboard.sessionsBoard.read");
        const surface = page.locator(".workboard-sessions");
        const tiles = surface.locator(".workboard-session-tile");
        await tiles.nth(1).waitFor();
        await page.mouse.move(0, 0);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const dir = createControlUiE2eArtifactDir("workboard-session-titles");
          await writeFile(
            path.join(dir, "session-titles.png"),
            await surface.screenshot({ animations: "disabled" }),
          );
        }
        const named = tiles.and(page.locator(`[data-session-key="${key}"]`));
        const untitled = tiles.and(page.locator(`[data-session-key="${unnamedKey}"]`));
        expect.soft(await named.getByRole("button").textContent()).toBe("Review the incident");
        expect.soft(await untitled.getByRole("button").textContent()).toBe("Untitled session");
        expect.soft(await tooltipTitleText(named)).toContain("Review the incident");
        expect.soft(await tooltipTitleText(named)).not.toContain(key);
        const untitledTooltip = await tooltipTitleText(untitled);
        expect.soft(untitledTooltip).toContain("Untitled session");
        expect.soft(untitledTooltip).not.toContain(unnamedKey);
        expect(await gateway.getRequests("workboard.sessionsBoard.read")).toHaveLength(1);
        expect(await gateway.getRequests("sessions.describe")).toHaveLength(0);
        expect(
          (await gateway.getRequests("sessions.list")).filter(
            (request) => request.params?.search === key || request.params?.search === unnamedKey,
          ),
        ).toHaveLength(0);
      },
    );
  });
});
