import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { buildSkillLibraryMock } from "../test-helpers/skill-library-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Skill repository import browser flow" });
const [own] = buildSkillLibraryMock();
const list = {
  entries: [own.entry],
  profileId: "profile-alice",
  multipleProfiles: true,
  defaultTarget: "personal",
  canManageWorkspace: false,
  defaultSelectionLimit: 64,
};
const url = "https://github.com/example/skills/tree/main/skills/release-notes";

async function openImport(page: Page) {
  await page.goto(`${suite.server.baseUrl}skills`);
  await page.getByRole("button", { name: "Skill settings", exact: true }).click();
  await page.getByRole("button", { name: "Import skill", exact: true }).click();
  await page.locator("openclaw-modal-dialog dialog").waitFor({ state: "visible" });
  return page.locator(".skill-library-dialog");
}

async function capture(page: Page, name: string) {
  if (!process.env.OPENCLAW_UI_E2E_CAPTURE) {
    return;
  }
  const dialog = page.locator(".skill-library-dialog");
  const surface = (await dialog.isVisible()) ? dialog : page.locator("main");
  const image = await takeControlUiViewportScreenshot(page, surface, [surface]);
  await writeFile(path.join(suite.artifactDir, `${name}.png`), image);
}

suite.define(() => {
  it("submits a GitHub source and retains the URL after an error before successful retry", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        methodResponses: {
          "skills.library.list": list,
          "skills.status": { agentId: "main", workspaceDir: "/workspace", skills: [] },
          "skills.library.import": {
            __mockError: {
              code: "INVALID_REQUEST",
              message: "Repository folder must contain SKILL.md.",
            },
          },
        },
      });
      const dialog = await openImport(page);
      await dialog.getByRole("button", { name: "GitHub URL", exact: true }).click();
      await dialog.getByLabel("Skill name", { exact: true }).fill("release-notes");
      await dialog.getByRole("textbox", { name: "Skill URL", exact: true }).fill(url);
      await capture(page, "after-github-url");
      await dialog.getByRole("button", { name: "Import skill", exact: true }).click();
      expect((await gateway.waitForRequest("skills.library.import")).params).toEqual({
        slug: "release-notes",
        source: { kind: "github", url },
      });
      await expect
        .poll(() => dialog.textContent())
        .toContain("Repository folder must contain SKILL.md.");
      expect(
        await dialog.getByRole("textbox", { name: "Skill URL", exact: true }).inputValue(),
      ).toBe(url);
      await capture(page, "after-github-error");
      await gateway.setMethodResponse("skills.library.import", {
        state: "published",
        target: "personal",
        entry: own.entry,
        sessionActivation: "new-sessions",
        nextAction: "Refresh the library.",
      });
      await dialog.getByRole("button", { name: "Import skill", exact: true }).click();
      await expect.poll(() => dialog.count()).toBe(0);
      await expect.poll(() => page.locator("main").textContent()).toContain("release-notes");
      await capture(page, "after-github-success");
    });
  });

  it("keeps file selection intact when switching between upload and GitHub sources", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        methodResponses: {
          "skills.library.list": list,
          "skills.status": { agentId: "main", workspaceDir: "/workspace", skills: [] },
        },
      });
      const dialog = await openImport(page);
      await dialog.getByLabel("Skill name", { exact: true }).fill("release-notes");
      await dialog.locator('input[name="library-import-files"]').setInputFiles({
        name: "SKILL.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(own.content),
      });
      await expect.poll(() => dialog.textContent()).toContain("SKILL.md");
      await dialog.getByRole("button", { name: "GitHub URL", exact: true }).click();
      await dialog.getByRole("textbox", { name: "Skill URL", exact: true }).fill(url);
      await dialog.getByRole("button", { name: "Upload files", exact: true }).click();
      await expect.poll(() => dialog.textContent()).toContain("SKILL.md");
      expect(await dialog.getByLabel("Skill name", { exact: true }).inputValue()).toBe(
        "release-notes",
      );
      expect(
        await dialog.getByRole("button", { name: "Import skill", exact: true }).isEnabled(),
      ).toBe(true);
      expect(await gateway.getRequests("skills.library.import")).toHaveLength(0);
      await capture(page, "after-upload-preserved");
    });
  });
});
