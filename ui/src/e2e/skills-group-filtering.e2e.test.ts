import { expect, it } from "vitest";
import { createSkill } from "../pages/skills/view.test-support.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Skills group filtering" });
const methodResponses = {
  "skills.library.list": {
    entries: [],
    profileId: null,
    multipleProfiles: false,
    defaultTarget: "workspace",
    canManageWorkspace: true,
    defaultSelectionLimit: 64,
  },
  "skills.status": {
    workspaceDir: "/tmp/skills-filtering/workspace",
    managedSkillsDir: "/tmp/skills-filtering/managed",
    skills: [
      createSkill({
        name: "Team Notes",
        skillKey: "team-notes",
        source: "openclaw-workspace",
        disabled: true,
      }),
      createSkill({
        name: "Weather",
        skillKey: "weather",
        source: "openclaw-bundled",
        bundled: true,
      }),
      createSkill({
        name: "Team Guide",
        skillKey: "team-guide",
        source: "openclaw-managed",
      }),
    ],
  },
};

suite.define(() => {
  for (const width of [1440, 390]) {
    it.each([true, false])(
      `keeps the retained group's open=%s state through search and recovery at ${width}px`,
      async (open) => {
        await suite.withPage(
          { ...createControlUiE2eContextOptions(), viewport: { width, height: 900 } },
          async ({ page }) => {
            const gateway = await installMockGateway(page, { methodResponses });
            await page.goto(`${suite.server.baseUrl}settings/skills`);
            const groups = page.locator("details.skills-group");
            await groups.nth(2).waitFor();
            const workspace = groups.filter({ hasText: "Workspace Skills" });
            const builtin = groups.filter({ hasText: "Built-in Skills" });
            await (open ? workspace : builtin).locator("summary").click();
            const retainedGroup = await builtin.elementHandle();
            const row = await builtin.locator(".settings-row").elementHandle();
            const search = page.locator('input[name="skills-filter"]');
            const input = await search.elementHandle();
            const reads = await gateway.getRequests("skills.status");

            await search.fill("weather");
            await expect.poll(() => groups.count()).toBe(1);
            expect(await builtin.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(
              open,
            );
            expect(await builtin.locator(".settings-row").isVisible()).toBe(open);
            expect(await retainedGroup!.evaluate((element) => element.isConnected)).toBe(true);
            expect(await row!.evaluate((element) => element.isConnected)).toBe(true);
            expect(await input!.evaluate((element) => document.activeElement === element)).toBe(
              true,
            );
            expect(await search.inputValue()).toBe("weather");
            expect(await gateway.getRequests("skills.status")).toEqual(reads);

            await search.fill("");
            await expect.poll(() => groups.count()).toBe(3);
            expect(
              await workspace.evaluate((element) => (element as HTMLDetailsElement).open),
            ).toBe(true);
            expect(await builtin.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(
              open,
            );
            expect(await retainedGroup!.evaluate((element) => element.isConnected)).toBe(true);
            expect(await row!.evaluate((element) => element.isConnected)).toBe(true);

            await search.fill("no-matching-skill");
            await expect.poll(() => groups.count()).toBe(0);
            await search.fill("");
            await expect.poll(() => groups.count()).toBe(3);
            expect(
              await groups.evaluateAll((elements) =>
                elements.every((element) => (element as HTMLDetailsElement).open),
              ),
            ).toBe(true);
          },
        );
      },
    );
  }

  it("keeps a retained successor's state when filtering removes the first or middle group", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installMockGateway(page, { methodResponses });
      await page.goto(`${suite.server.baseUrl}settings/skills`);
      const groups = page.locator("details.skills-group");
      await groups.nth(2).waitFor();
      const workspace = groups.filter({ hasText: "Workspace Skills" });
      const builtin = groups.filter({ hasText: "Built-in Skills" });
      const installed = groups.filter({ hasText: "Installed Skills" });
      await workspace.locator("summary").click();
      await page.locator('wa-radio[value="ready"]').click();
      await expect.poll(() => groups.count()).toBe(2);
      expect(await builtin.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
      expect(await installed.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(
        true,
      );

      await page.locator('wa-radio[value="all"]').click();
      await expect.poll(() => groups.count()).toBe(3);
      await builtin.locator("summary").click();
      const retained = await installed.elementHandle();
      await page.locator('input[name="skills-filter"]').fill("team");
      await expect.poll(() => groups.count()).toBe(2);
      expect(await installed.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(
        true,
      );
      expect(await installed.locator(".settings-row").isVisible()).toBe(true);
      expect(await retained!.evaluate((element) => element.isConnected)).toBe(true);
    });
  });
});
