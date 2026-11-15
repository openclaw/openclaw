import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { makeBoard, makeCard } from "../pages/workboard/workboard.e2e.test-support.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  takeControlUiScreenshotFrame,
  waitForControlUiProofSurface,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installNativePluginMockGateway } from "../test-helpers/control-ui-plugin-e2e.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Workboard card inventory readiness",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it.each([1280, 390])(
    "keeps unknown inventory separate from empty results at %s pixels",
    async (width) => {
      await suite.withPage(
        { viewport: { width, height: 900 }, locale: "en-US", serviceWorkers: "block" },
        async ({ page }) => {
          const directory =
            process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
              ? createControlUiE2eArtifactDir("workboard-readiness-" + width)
              : null;
          const board = makeBoard("ops", {
            name: "Operations",
            total: 1,
            active: 1,
            byStatus: { todo: 1 },
          });
          const card = makeCard({
            id: "review",
            title: "Review release",
            agentId: "main",
            metadata: { automation: { boardId: "ops" } },
          });
          const response = { boards: [board], cards: [card], statuses: ["todo", "done"] };
          const gateway = await installNativePluginMockGateway(page, {
            ...workboardUi,
            heldMethods: ["workboard.cards.list"],
            methodResponses: {
              "workboard.boards.list": { boards: [board] },
              "workboard.cards.list": response,
            },
          });
          await page.goto(suite.server.baseUrl + "workboard/ops");
          await gateway.waitForRequest("workboard.cards.list");
          const heading = page.locator(".workboard-page-title", { hasText: "Operations" });
          await waitForControlUiProofSurface(page.locator(".workboard-main"), [heading]);
          await expect
            .poll(() => page.locator(".workboard-refresh").getAttribute("aria-busy"))
            .toBe("true");
          const empty = page.getByText("No cards match this view", { exact: true });
          const capture = async (name: string) => {
            if (!directory) {
              return;
            }
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator(".workboard-main"),
              [heading],
              { animations: "disabled" },
            );
            await writeFile(path.join(directory, name + ".png"), frame.png);
          };
          await capture("pending");
          expect.soft(await empty.isVisible(), "pending inventory").toBe(false);
          await page.locator(".workboard-filter-trigger").click();
          await page.locator(".workboard-filter-popover__panel").waitFor();
          expect
            .soft(await page.locator(".workboard-filter-option__count:visible").count())
            .toBe(0);
          await page
            .getByRole("dialog", { name: "Filters", exact: true })
            .getByRole("button", { name: "Close", exact: true })
            .click();
          if (width === 390) {
            await page.locator(".workboard-mobile-status__trigger").click();
            await page.locator(".workboard-status-popover").waitFor();
            expect
              .soft(await page.locator(".workboard-mobile-status__count:visible").count())
              .toBe(0);
            await page.keyboard.press("Escape");
          }
          await gateway.rejectDeferred("workboard.cards.list", {
            code: "UNAVAILABLE",
            message: "Card inventory unavailable",
          });
          await page.getByText("Card inventory unavailable", { exact: true }).waitFor();
          await capture("failed");
          expect.soft(await empty.isVisible(), "failed first inventory").toBe(false);
          const after = await gateway.deferNext("workboard.cards.list");
          await page.locator(".workboard-refresh").click();
          await gateway.waitForRequest("workboard.cards.list", { after });
          expect.soft(await empty.isVisible(), "pending retry").toBe(false);
          await gateway.resolveDeferred("workboard.cards.list", response);
          const tile = page.locator(".workboard-card", { hasText: card.title });
          await tile.waitFor();
          expect(await empty.count()).toBe(0);
          const retained = await tile.elementHandle();
          expect(retained).not.toBeNull();
          const refresh = await gateway.deferNext("workboard.cards.list");
          await page.locator(".workboard-refresh").click();
          await gateway.waitForRequest("workboard.cards.list", { after: refresh });
          await gateway.rejectDeferred("workboard.cards.list", {
            code: "UNAVAILABLE",
            message: "Later refresh unavailable",
          });
          await page.getByText("Later refresh unavailable", { exact: true }).waitFor();
          expect(await retained!.evaluate((element) => element.isConnected)).toBe(true);
          const reads = (await gateway.getRequests("workboard.cards.list")).length;
          await gateway.setMethodResponse("workboard.cards.list", {
            ...response,
            cards: [],
            boards: [makeBoard("ops", { name: "Operations" })],
          });
          await page.locator(".workboard-refresh").click();
          await gateway.waitForRequest("workboard.cards.list", { after: reads });
          await empty.waitFor();
          await page.locator(".workboard-filter-trigger").click();
          await expect
            .poll(() =>
              page.locator(".workboard-filter-option__count:visible").first().textContent(),
            )
            .toBe("0");
          for (const method of [
            "workboard.cards.create",
            "workboard.cards.update",
            "workboard.cards.delete",
            "workboard.dispatch",
          ]) {
            expect(await gateway.getRequests(method)).toHaveLength(0);
          }
        },
      );
    },
  );
});
