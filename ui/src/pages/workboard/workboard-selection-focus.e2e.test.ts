import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import {
  createControlUiMockSameOriginGatewayScript,
  installMockGateway,
  startControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";
import { configSnapshot, makeBoard, makeCard } from "./workboard.e2e.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Workboard selection focus",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});
suite.define(() => {
  it("returns keyboard focus to the selected card after clearing selection", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        await page.addInitScript(createControlUiMockSameOriginGatewayScript());
        const board = makeBoard("default", { total: 1, active: 1 });
        const card = makeCard({ id: "focus-card", title: "Review release notes" });
        await installMockGateway(page, {
          ...workboardUi,
          methodResponses: {
            "config.get": configSnapshot("selection-focus"),
            "workboard.boards.list": { boards: [board] },
            "workboard.cards.list": { boards: [board], cards: [card], statuses: ["todo", "done"] },
          },
        });
        await page.goto(suite.server.baseUrl + "workboard");
        const tile = page.locator("article.workboard-card");
        await tile.waitFor();
        await tile.focus();
        await page.keyboard.press("Shift+Enter");
        const clear = page.getByRole("button", { name: "Clear selection", exact: true });
        await clear.waitFor();
        await clear.focus();
        await page.keyboard.press("Enter");
        await clear.waitFor({ state: "hidden" });
        await expect
          .poll(() => tile.getAttribute("class"))
          .not.toContain("workboard-card--selected");
        await page.screenshot({
          path: suite.artifactDir + "/selection-cleared.png",
          animations: "disabled",
        });
        await expect
          .poll(() => tile.evaluate((element) => element === document.activeElement))
          .toBe(true);
      },
    );
  });
});
