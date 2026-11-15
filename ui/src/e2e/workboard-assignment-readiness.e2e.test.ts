import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installWorkboardPage } from "./workboard-page.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Workboard assignment roster readiness",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("keeps an assigned agent neutral until its roster answers", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const board = {
        id: "ops",
        name: "Operations",
        total: 1,
        active: 1,
        archived: 0,
        byStatus: { todo: 1 },
      };
      const card = {
        id: "release",
        title: "Review release",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        agentId: "writer",
        metadata: { automation: { boardId: "ops" } },
      };
      const roster = {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Main" },
          { id: "writer", name: "Writer" },
        ],
      };
      const gateway = await installWorkboardPage(page, suite.server.baseUrl, "ops", {
        "agents.list": {
          __mockError: { code: "UNAVAILABLE", message: "Agent roster unavailable" },
        },
        "workboard.boards.list": { boards: [board] },
        "workboard.cards.list": { cards: [card], boards: [board], statuses: ["todo", "done"] },
      });
      await page.goto(suite.server.baseUrl + "workboard/ops");
      const scope = page.locator(".workboard-scope openclaw-agent-select");
      await scope.locator(".agent-select__trigger:visible").click();
      await page.getByRole("option", { name: "All agents", exact: true }).click();
      const tile = page.locator(".workboard-card", { hasText: card.title });
      await tile.waitFor();
      await tile.click();
      const detail = page.locator(".workboard-detail");
      const trigger = detail.locator(".workboard-detail__agent-picker .agent-select__trigger");
      await trigger.waitFor();
      expect
        .soft(await trigger.textContent(), "failed first roster is not an absent agent")
        .not.toContain("not configured");
      await trigger.click();
      const option = page.locator('.agent-select__option[value="writer"]');
      await option.waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const dir = createControlUiE2eArtifactDir("workboard-assignment-roster");
        const frame = await takeControlUiScreenshotFrame(page, detail, [trigger, option], {
          animations: "disabled",
        });
        await writeFile(path.join(dir, "first-failure.png"), frame.png);
      }

      expect
        .soft(await option.textContent(), "current assignment row must stay neutral")
        .not.toContain("not configured");
      await page.keyboard.press("Escape");
      await detail.locator(".workboard-detail__close").click();
      await gateway.setMethodResponse("agents.list", roster);
      const after = await gateway.deferNext("agents.list");
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await gateway.waitForRequest("agents.list", { after });
      await tile.click();
      await trigger.waitFor();
      expect
        .soft(await trigger.textContent(), "pending first accepted roster is not absent")
        .not.toContain("not configured");
      await gateway.resolveDeferred("agents.list", roster);
      await expect.poll(() => trigger.textContent()).toContain("Writer");
      expect(await trigger.textContent()).not.toContain("not configured");
      await detail.locator(".workboard-detail__close").click();
      await gateway.setMethodResponse("agents.list", { ...roster, agents: [roster.agents[0]] });
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await tile.click();
      await expect.poll(() => trigger.textContent()).toContain("not configured");
      expect(await gateway.getRequests("workboard.cards.update")).toHaveLength(0);
    });
  });
});
