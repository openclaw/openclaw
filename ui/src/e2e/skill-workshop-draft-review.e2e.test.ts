import { writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  SkillsWorkshopListResult,
  SkillsWorkshopReadResult,
} from "@openclaw/gateway-protocol";
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
  name: "Workshop multi-file draft review",
  startServerBeforeBrowser: true,
});
const name = "deploy-staging";
const draftId = "deploy-staging-proposal-1";
const content =
  "---\nname: deploy-staging\ndescription: Deploy the staging service\n---\n\nRun make deploy.\n";
const live: SkillsWorkshopReadResult = { name, filePath: "SKILL.md", content, files: ["SKILL.md"] };
const draft: SkillsWorkshopReadResult = { ...live, files: ["SKILL.md", "references/rollback.md"] };
const list: SkillsWorkshopListResult = {
  agentId: "main",
  mode: "propose",
  root: "/tmp/synthetic-workshop",
  skills: [
    {
      name,
      description: "Deploy the staging service",
      files: ["SKILL.md"],
      sizeBytes: content.length,
      updatedAtMs: Date.now(),
      useCount: 1,
    },
  ],
  archived: [],
  drafts: [
    {
      id: draftId,
      skillName: name,
      summary: "Adds a rollback reference without changing the instructions.",
      createdAtMs: Date.now(),
    },
  ],
};
suite.define(() => {
  it("does not recommend discarding a whole draft from its unchanged instructions", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          "skills.workshop.list",
          "skills.workshop.changes",
          "skills.workshop.read",
          "skills.workshop.applyDraft",
          "skills.workshop.discardDraft",
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
          "skills.workshop.read": live,
        },
      });
      await page.goto(new URL("/skills/workshop", suite.server.baseUrl).toString());
      await page.locator(".sw-detail").getByText("Run make deploy.", { exact: true }).waitFor();
      const reads = await gateway.deferNext("skills.workshop.read", { draftId });
      await page.getByRole("button", { name: "Drafts 1", exact: true }).click();
      await gateway.waitForRequest("skills.workshop.read", { after: reads, match: { draftId } });
      await gateway.resolveDeferred("skills.workshop.read", draft, { match: { draftId } });
      const detail = page.locator(".sw-detail");
      await detail.locator(".sw-diff__same").waitFor();
      const frame = await takeControlUiScreenshotFrame(
        page,
        detail,
        [detail.locator(".sw-diff__same")],
        { animations: "disabled" },
      );
      await writeFile(path.join(suite.artifactDir, "unchanged-instructions.png"), frame.png);
      expect(
        await detail
          .getByText("This draft already matches the live skill. Discard it.", { exact: true })
          .count(),
      ).toBe(0);
      await expect
        .poll(() => detail.locator(".sw-diff__same").textContent())
        .toBe("This version matches today’s instructions.");
      const fileReads = await gateway.deferNext("skills.workshop.read", {
        draftId,
        filePath: "references/rollback.md",
      });
      await detail.getByRole("button", { name: "references/rollback.md", exact: true }).click();
      await gateway.waitForRequest("skills.workshop.read", {
        after: fileReads,
        match: { draftId, filePath: "references/rollback.md" },
      });
      await gateway.resolveDeferred(
        "skills.workshop.read",
        { ...draft, filePath: "references/rollback.md", content: "Roll back with make undo." },
        { match: { draftId, filePath: "references/rollback.md" } },
      );
      await detail.getByText("Roll back with make undo.", { exact: true }).waitFor();
      expect(await detail.getByRole("button", { name: "Apply", exact: true }).isEnabled()).toBe(
        true,
      );
      expect(await detail.getByRole("button", { name: "Discard", exact: true }).isEnabled()).toBe(
        true,
      );
      expect(await gateway.getRequests("skills.workshop.applyDraft")).toHaveLength(0);
      expect(await gateway.getRequests("skills.workshop.discardDraft")).toHaveLength(0);
    });
  });
});
