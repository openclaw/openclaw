import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { buildSkillLibraryMock } from "../test-helpers/skill-library-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({ name: "Skills library read recovery" });
const [own] = buildSkillLibraryMock();
const accepted = {
  entries: [own.entry],
  profileId: own.entry.ownerProfileId,
  multipleProfiles: true,
  defaultTarget: "personal",
  canManageWorkspace: false,
  defaultSelectionLimit: 64,
};
suite.define(() => {
  it("waits for personal library knowledge and preserves error and reload recovery", () =>
    suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        // This scenario observes the page while its initial library read is still pending.
        awaitInitialRoster: false,
        deferredMethods: ["skills.library.list", "skills.search"],
        methodResponses: {
          "skills.status": {
            workspaceDir: "/synthetic/workspace",
            managedSkillsDir: "/synthetic/skills",
            skills: [],
          },
          "skills.search": { results: [] },
          "skills.library.list": accepted,
        },
      });
      await page.goto(suite.server.baseUrl + "skills");
      await gateway.waitForRequest("skills.library.list");
      await page.getByRole("searchbox", { name: "Search skills", exact: true }).waitFor();
      await gateway.waitForRequest("skills.status");
      await gateway.waitForRequest("skills.search");
      const searching = page.getByRole("status", { name: "Searching…", exact: true });
      await searching.waitFor();
      await gateway.resolveDeferred("skills.search");
      await searching.waitFor({ state: "hidden" });
      const empty = page.getByText("No skills yet. Search ClawHub to add one.", { exact: true });
      expect
        .soft(await empty.count(), "pending library does not establish empty discovery")
        .toBe(0);
      await gateway.rejectDeferred("skills.library.list", {
        code: "UNAVAILABLE",
        message: "Synthetic personal library unavailable",
      });
      await page
        .getByRole("alert")
        .filter({ hasText: "Synthetic personal library unavailable" })
        .waitFor();
      expect.soft(await empty.count(), "failed library does not establish empty discovery").toBe(0);
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const file = suite.artifactDir + "/failed-personal-library.png";
        await page.screenshot({ path: file });
        console.log("Library failure capture: " + file);
      }
      expect(
        await page.getByRole("searchbox", { name: "Search skills", exact: true }).isEnabled(),
      ).toBe(true);
      await page.reload();
      await gateway.waitForRequest("skills.library.list");
      await gateway.waitForRequest("skills.search");
      await gateway.resolveDeferred("skills.search");
      await gateway.resolveDeferred("skills.library.list", accepted);
      await page.locator(".skill-installed-shelf").click();
      await page
        .getByRole("button", { name: "Open " + own.entry.slug + " details", exact: true })
        .waitFor();
      expect(await empty.count()).toBe(0);
      await page.reload();
      await gateway.waitForRequest("skills.library.list");
      await gateway.waitForRequest("skills.search");
      await gateway.resolveDeferred("skills.search");
      await gateway.resolveDeferred("skills.library.list", { ...accepted, entries: [] });
      await empty.waitFor();
      expect(await gateway.getRequests("skills.install")).toHaveLength(0);
      expect(await gateway.getRequests("skills.library.save")).toHaveLength(0);
    }));
});
