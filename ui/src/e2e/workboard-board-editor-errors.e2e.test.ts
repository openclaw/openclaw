import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installWorkboardPage } from "./workboard-page.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Workboard board-editor error recovery",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it.each([
    { kind: "cards", width: 1280, height: 1100 },
    { kind: "sessions", width: 1280, height: 1100 },
    { kind: "sessions", width: 390, height: 844 },
  ] as const)(
    "shows one actionable save rejection for a $kind board at $width pixels",
    async ({ kind, width, height }) => {
      await suite.withPage(
        { viewport: { width, height }, locale: "en-US", serviceWorkers: "block" },
        async ({ page }) => {
          const columns = [
            {
              id: "working",
              label: "Working",
              description: "Active work",
              match: { run: ["active"] },
            },
            { id: "done", label: "Done", description: "Completed work", fallback: true },
          ];
          const board = {
            id: "ops",
            name: "Operations",
            kind,
            createdAt: 1,
            updatedAt: 1,
            total: 0,
            active: 0,
            archived: 0,
            byStatus: {},
            ...(kind === "sessions" ? { sessions: { columns } } : {}),
          };
          const gateway = await installWorkboardPage(page, suite.server.baseUrl, "ops", {
            "workboard.boards.list": { boards: [board] },
            "workboard.cards.list": { boards: [board], cards: [] },
            "workboard.sessionsBoard.read": { board, columns, sessions: [], people: [] },
          });
          await page.goto(suite.server.baseUrl + "workboard/ops");
          await page.locator(".workboard-page-title", { hasText: "Operations" }).waitFor();
          await page.locator(".workboard-page-title").hover();
          await page.getByRole("button", { name: "Edit board", exact: true }).click();
          const form = page.locator(".workboard-board-draft");
          await form.waitFor();
          const name = form.locator(".workboard-board-draft__name input");
          await name.fill("Reserved name");
          const after = await gateway.deferNext("workboard.boards.upsert");
          await form.getByRole("button", { name: "Save", exact: true }).click();
          const request = await gateway.waitForRequest("workboard.boards.upsert", { after });
          expect(request.params).toMatchObject({ id: "ops", name: "Reserved name" });
          await gateway.rejectDeferred("workboard.boards.upsert", {
            code: "workboard_error",
            message: "Board name is reserved",
          });
          const errors = page.getByRole("alert").filter({ hasText: "Board name is reserved" });
          await errors.first().waitFor();
          expect(await name.inputValue()).toBe("Reserved name");
          expect(await form.getByRole("button", { name: "Save", exact: true }).isEnabled()).toBe(
            true,
          );
          expect
            .soft(await errors.count(), "one visible explanation for one rejected save")
            .toBe(1);
          const saved = { ...board, name: "Release planning", updatedAt: 2 };
          await gateway.setMethodResponse("workboard.boards.upsert", { board: saved });
          await gateway.setMethodResponse("workboard.boards.list", { boards: [saved] });
          await gateway.setMethodResponse("workboard.cards.list", { boards: [saved], cards: [] });
          await name.fill(saved.name);
          const save = form.getByRole("button", { name: "Save", exact: true });
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const dir = createControlUiE2eArtifactDir(
              "board-editor-feedback-" + kind + "-" + width,
            );
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.getByRole("dialog", { name: "Edit board", exact: true }),
              [errors.first(), save],
              { animations: "disabled", scrollTo: save },
            );
            await writeFile(path.join(dir, "rejected.png"), frame.png);
          }
          await save.click({ timeout: 1500 });
          await form.waitFor({ state: "detached" });
          await page.locator(".workboard-page-title", { hasText: saved.name }).waitFor();
          expect(await gateway.getRequests("workboard.boards.upsert")).toHaveLength(2);
        },
      );
    },
  );
});
