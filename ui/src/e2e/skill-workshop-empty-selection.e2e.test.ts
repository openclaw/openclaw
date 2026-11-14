import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkillsWorkshopListResult } from "@openclaw/gateway-protocol";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { configSnapshot } from "./config-composer-fixtures.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Workshop empty selection",
  startServerBeforeBrowser: true,
});
const list: SkillsWorkshopListResult = {
  agentId: "main",
  mode: "propose",
  root: "/tmp/synthetic-workshop",
  skills: [
    {
      name: "deploy-staging",
      description: "Deploy staging safely",
      files: ["SKILL.md"],
      sizeBytes: 30,
      updatedAtMs: Date.now(),
      useCount: 1,
    },
  ],
  archived: [],
  drafts: [],
};
suite.define(() => {
  it.each([
    { filter: "Archived", width: 1280 },
    { filter: "Drafts", width: 1280 },
    { filter: "Drafts", width: 390 },
  ])(
    "does not ask to select a skill from an empty $filter list at $width px",
    async ({ filter, width }) => {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width, height: 900 } },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "skills.workshop.list",
              "skills.workshop.changes",
              "skills.workshop.read",
            ],
            methodResponses: {
              "config.get": configSnapshot(
                {
                  plugins: {
                    entries: { "skill-workshop": { config: { autonomous: { mode: "propose" } } } },
                  },
                },
                "workshop-config",
              ),
              "skills.workshop.list": list,
              "skills.workshop.changes": { changes: [] },
              "skills.workshop.read": {
                name: "deploy-staging",
                filePath: "SKILL.md",
                content: "Run make deploy.",
                files: ["SKILL.md"],
              },
            },
          });
          await page.goto(new URL("/skills/workshop", suite.server.baseUrl).toString());
          await page.locator(".sw-detail").getByText("Run make deploy.", { exact: true }).waitFor();
          await page.getByRole("button", { name: filter + " 0", exact: true }).click();
          const empty = page
            .locator(".sw-list__rows")
            .getByText(filter === "Archived" ? "No archived skills yet." : /^No drafts yet./);
          await empty.waitFor();
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".sw-layout"),
            [empty],
            { animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, filter.toLowerCase() + ".png"), frame.png);
          expect(await page.getByText("Select a skill to view it.", { exact: true }).count()).toBe(
            0,
          );
          expect(await page.locator(".sw-detail").count()).toBe(0);
          const bounds = await page.locator(".sw-layout").evaluate((layout) => ({
            layout: layout.getBoundingClientRect().width,
            list: layout.querySelector(".sw-list")!.getBoundingClientRect().width,
          }));
          expect(bounds.list).toBeCloseTo(bounds.layout, 0);
          await page.getByRole("button", { name: "Active 1", exact: true }).click();
          await page.locator(".sw-detail").getByText("Run make deploy.", { exact: true }).waitFor();
          expect(await gateway.getRequests("skills.workshop.archive")).toHaveLength(0);
        },
      );
    },
  );
});
