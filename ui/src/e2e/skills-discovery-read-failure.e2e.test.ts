import { expect, it } from "vitest";
import { createSkill } from "../pages/skills/view.test-support.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({ name: "Skills discovery read recovery" });
const empty = {
  workspaceDir: "/synthetic/workspace",
  managedSkillsDir: "/synthetic/skills",
  skills: [],
};
suite.define(() => {
  it("does not claim empty discovery after the installed inventory fails", () =>
    suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        // This scenario observes the page while its initial inventory is still pending.
        awaitInitialRoster: false,
        deferredMethods: ["skills.status", "skills.search"],
        methodResponses: { "skills.status": empty, "skills.search": { results: [] } },
      });
      await page.goto(suite.server.baseUrl + "skills");
      await gateway.waitForRequest("skills.status");
      await page.getByRole("searchbox", { name: "Search skills", exact: true }).waitFor();
      await gateway.waitForRequest("skills.search");
      const searching = page.getByRole("status", { name: "Searching…", exact: true });
      await searching.waitFor();
      await gateway.resolveDeferred("skills.search");
      await searching.waitFor({ state: "hidden" });
      const emptyClaim = page.getByText("No skills yet. Search ClawHub to add one.", {
        exact: true,
      });
      expect(await emptyClaim.count()).toBe(0);
      await gateway.rejectDeferred("skills.status", {
        code: "UNAVAILABLE",
        message: "Synthetic installed inventory unavailable",
      });
      await page
        .getByRole("alert")
        .filter({ hasText: "Synthetic installed inventory unavailable" })
        .waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const file = `${suite.artifactDir}/failed-installed-status.png`;
        await page.screenshot({ path: file });
        console.log(`Skills inventory failure capture: ${file}`);
      }
      expect
        .soft(await emptyClaim.count(), "failed installed read is not accepted empty inventory")
        .toBe(0);
      expect(
        await page.getByRole("searchbox", { name: "Search skills", exact: true }).isEnabled(),
      ).toBe(true);
      await page.reload();
      await gateway.waitForRequest("skills.status");
      await gateway.waitForRequest("skills.search");
      await gateway.resolveDeferred("skills.search");
      await gateway.resolveDeferred("skills.status", {
        ...empty,
        skills: [createSkill({ name: "Recovered Skill", skillKey: "recovered" })],
      });
      await page.locator(".skill-installed-shelf").click();
      await page
        .getByRole("button", { name: "Open Recovered Skill details", exact: true })
        .waitFor();
      expect(await emptyClaim.count()).toBe(0);
      await page.reload();
      await gateway.waitForRequest("skills.status");
      await gateway.waitForRequest("skills.search");
      await gateway.resolveDeferred("skills.search");
      await gateway.resolveDeferred("skills.status", empty);
      await emptyClaim.waitFor();
      expect(await gateway.getRequests("skills.install")).toHaveLength(0);
      expect(await gateway.getRequests("skills.update")).toHaveLength(0);
    }));
});
