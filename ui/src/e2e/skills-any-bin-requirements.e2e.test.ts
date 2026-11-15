import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createSkill } from "../pages/skills/view.test-support.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI alternative skill binary requirements",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

function codingAgentSkill(missingAnyBins: string[]) {
  return createSkill({
    name: "Coding Agent",
    source: "openclaw-bundled",
    bundled: true,
    skillKey: "coding-agent",
    primaryEnv: undefined,
    homepage: undefined,
    eligible: missingAnyBins.length === 0,
    modelVisible: missingAnyBins.length === 0,
    commandVisible: missingAnyBins.length === 0,
    requirements: { ...emptyRequirements, anyBins: ["claude", "codex", "opencode"] },
    missing: { ...emptyRequirements, anyBins: missingAnyBins },
    install: [
      {
        id: "node-codex",
        kind: "node",
        label: "Install Codex CLI (npm)",
        bins: ["codex"],
      },
    ],
  });
}

const emptyRequirements = { bins: [], env: [], config: [], os: [] };
async function openSkill(page: Page, missing: string[], install = false) {
  const gateway = await installMockGateway(page, {
    ...(install ? { featureMethods: ["chat.metadata", "chat.startup", "skills.install"] } : {}),
    methodResponses: {
      "skills.status": {
        workspaceDir: "/tmp/openclaw-e2e/workspace",
        managedSkillsDir: "/tmp/openclaw-e2e/skills",
        skills: [codingAgentSkill(missing)],
      },
      ...(install ? { "skills.install": { message: "Installed Codex CLI" } } : {}),
    },
  });
  expect((await page.goto(`${suite.server.baseUrl}skills`))?.status()).toBe(200);
  await page.getByRole("button", { name: "Open Coding Agent details" }).click();
  const dialog = page.locator("openclaw-modal-dialog", { hasText: "Coding Agent" });
  await expect.poll(() => dialog.count()).toBe(1);
  return { gateway, dialog };
}

suite.define(() => {
  it.each([true, false])("shows alternative binary installation only when missing: %s", (missing) =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { gateway, dialog } = await openSkill(
        page,
        missing ? ["claude", "codex", "opencode"] : [],
        missing,
      );
      const installer = dialog.getByRole("button", { name: "Install Codex CLI (npm)" });
      if (missing) {
        expect(await dialog.textContent()).toContain("bin:any of (claude, codex, opencode)");
        await installer.click();
        expect((await gateway.waitForRequest("skills.install")).params).toMatchObject({
          name: "Coding Agent",
          installId: "node-codex",
          dangerouslyForceUnsafeInstall: false,
        });
      } else {
        expect(await dialog.getByText("bin:any of", { exact: false }).count()).toBe(0);
        expect(await installer.count()).toBe(0);
      }
    }),
  );
});
