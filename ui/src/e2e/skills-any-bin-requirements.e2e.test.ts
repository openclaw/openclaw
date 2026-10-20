import type { Page } from "playwright";
import { expect, it } from "vitest";
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
  return {
    name: "Coding Agent",
    description: "Delegate coding work to an available coding CLI.",
    source: "openclaw-bundled",
    bundled: true,
    filePath: "/tmp/openclaw-e2e/skills/coding-agent/SKILL.md",
    baseDir: "/tmp/openclaw-e2e/skills/coding-agent",
    skillKey: "coding-agent",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
    eligible: missingAnyBins.length === 0,
    platformIncompatible: false,
    modelVisible: missingAnyBins.length === 0,
    userInvocable: true,
    commandVisible: missingAnyBins.length === 0,
    requirements: { ...emptyRequirements, anyBins: ["claude", "codex", "opencode"] },
    missing: { ...emptyRequirements, anyBins: missingAnyBins },
    configChecks: [],
    install: [
      {
        id: "node-codex",
        kind: "node",
        label: "Install Codex CLI (npm)",
        bins: ["codex"],
      },
    ],
  };
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
  it("explains alternative missing binaries and installs one through the Gateway", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { gateway, dialog } = await openSkill(page, ["claude", "codex", "opencode"], true);
      expect(await dialog.textContent()).toContain("bin:any of (claude, codex, opencode)");
      await dialog.getByRole("button", { name: "Install Codex CLI (npm)" }).click();

      const request = await gateway.waitForRequest("skills.install");
      expect(request.params).toMatchObject({
        name: "Coding Agent",
        installId: "node-codex",
        dangerouslyForceUnsafeInstall: false,
      });
    });
  });

  it("does not show missing alternatives or an installer for an eligible skill", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { dialog } = await openSkill(page, []);
      expect(await dialog.getByText("bin:any of", { exact: false }).count()).toBe(0);
      expect(await dialog.getByRole("button", { name: "Install Codex CLI (npm)" }).count()).toBe(0);
    });
  });
});
