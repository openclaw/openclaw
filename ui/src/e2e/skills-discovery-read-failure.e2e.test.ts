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
  it("keeps the search while opening, going back, and reloading a skill document", () =>
    suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
      const skill = createSkill({
        name: "Calendar Helper",
        skillKey: "calendar",
        filePath: "/work/calendar/SKILL.md",
      });
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "skills.status": { ...empty, skills: [skill] },
          "skills.search": { results: [] },
          "skills.files.get": {
            name: skill.name,
            path: skill.filePath,
            content: "# Using the calendar\n\nLook up the **next meeting**.",
          },
        },
      });
      await page.goto(suite.server.baseUrl + "skills");
      const search = page.getByRole("searchbox", { name: "Search skills" });
      await search.fill("calendar");
      await gateway.waitForRequest("skills.search", { match: { query: "calendar" } });
      await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("calendar");
      const link = page.getByRole("link", { name: "Open Calendar Helper details" });
      expect(
        new URL((await link.getAttribute("href")) ?? "", page.url()).searchParams.get("skill"),
      ).toBe("calendar");
      await link.click();
      const body = page.locator(".plugin-catalog-detail__main");
      await body.getByRole("heading", { name: "Using the calendar" }).waitFor();
      expect(await body.locator("strong").textContent()).toBe("next meeting");
      expect(await body.getByRole("button").count()).toBe(0);
      expect(await page.getByRole("dialog").count()).toBe(0);
      const detail = page.url();
      await page.goBack();
      await search.waitFor();
      expect(await search.inputValue()).toBe("calendar");
      expect(new URL(page.url()).searchParams.has("skill")).toBe(false);
      await page.goto(detail);
      await body.getByRole("heading", { name: "Using the calendar" }).waitFor();
      await page
        .locator(".plugins-settings-breadcrumb")
        .getByRole("link", { name: "Skills", exact: true })
        .click();
      await search.waitFor();
      expect(await search.inputValue()).toBe("calendar");
    }));
  it("does not claim empty discovery after the installed inventory fails", () =>
    suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["skills.status"],
        methodResponses: { "skills.status": empty, "skills.search": { results: [] } },
      });
      await page.goto(suite.server.baseUrl + "skills");
      await gateway.waitForRequest("skills.status");
      await page.getByRole("searchbox", { name: "Search skills", exact: true }).waitFor();
      await gateway.waitForRequest("skills.search");
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
      await expect
        .poll(() => page.locator(".skill-discovery .plugin-catalog-grid").getAttribute("aria-busy"))
        .toBe("false");
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
      await gateway.resolveDeferred("skills.status", {
        ...empty,
        skills: [createSkill({ name: "Recovered Skill", skillKey: "recovered" })],
      });
      await page.getByRole("link", { name: "Open Recovered Skill details", exact: true }).waitFor();
      expect(await emptyClaim.count()).toBe(0);
      await page.reload();
      await gateway.waitForRequest("skills.status");
      await gateway.resolveDeferred("skills.status", empty);
      await emptyClaim.waitFor();
      expect(await gateway.getRequests("skills.install")).toHaveLength(0);
      expect(await gateway.getRequests("skills.update")).toHaveLength(0);
    }));
});
