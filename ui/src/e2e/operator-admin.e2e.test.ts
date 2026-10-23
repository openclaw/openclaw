// Control UI E2E coverage for operator-facing Skills, Nodes, and exec approvals administration.
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { SkillsWorkshopReadResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.ts";
import { createSkill } from "../pages/skills/view.test-support.ts";
import { installMockGateway, type MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { configSnapshot } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI operator administration",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const viewport = { height: 960, width: 1440 };

const agentRoster = [
  { id: "main", identity: { name: "Main" }, name: "Main" },
  { id: "reviewer", identity: { name: "Reviewer" }, name: "Reviewer" },
];
const agentsResponse = { agents: agentRoster, defaultId: "main", mainKey: "main", scope: "agent" };
const approvalDefaults = {
  security: "deny",
  ask: "on-miss",
  askFallback: "deny",
  autoAllowSkills: false,
};
const emptyRequirements = { anyBins: [], env: [], config: [], os: [] };
const bootMethods = ["agents.list", "chat.metadata", "chat.startup", "config.get"];
const workshopMethods = [
  "skills.workshop.archive",
  "skills.workshop.changes",
  "skills.workshop.list",
  "skills.workshop.read",
  "skills.workshop.restore",
];
const approvalSnapshot = {
  path: "/tmp/openclaw-e2e/exec-approvals.json",
  exists: true,
  hash: "approval-hash-1",
  file: { defaults: approvalDefaults, agents: {} },
};

const operatorConfig = {
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "main" } },
    entries: {
      main: { name: "Main" },
      reviewer: { name: "Reviewer" },
    },
  },
};

function skillStatus(eligible: boolean) {
  return {
    workspaceDir: "/tmp/openclaw-e2e/workspace",
    managedSkillsDir: "/tmp/openclaw-e2e/skills",
    skills: [
      createSkill({
        name: "Deploy Helper",
        description: "Prepare reviewed deployments.",
        source: "openclaw-bundled",
        bundled: true,
        filePath: "/tmp/openclaw-e2e/skills/deploy-helper/SKILL.md",
        baseDir: "/tmp/openclaw-e2e/skills/deploy-helper",
        skillKey: "deploy-helper",
        eligible,
        modelVisible: eligible,
        commandVisible: eligible,
        primaryEnv: undefined,
        homepage: undefined,
        requirements: { ...emptyRequirements, bins: ["deploy-helper"] },
        missing: { ...emptyRequirements, bins: eligible ? [] : ["deploy-helper"] },
        install: [
          {
            id: "node-deploy-helper",
            kind: "node",
            label: "Install Deploy Helper",
            bins: ["deploy-helper"],
          },
        ],
      }),
    ],
  };
}

function configResponse(config: Record<string, unknown> = operatorConfig) {
  return { ...configSnapshot(config, "config-hash-1"), sourceConfig: config };
}

function reviewerApprovals(
  hash: string,
  reviewer: typeof approvalDefaults & { allowlist: Array<{ pattern: string }> },
) {
  return { ...approvalSnapshot, hash, file: { defaults: approvalDefaults, agents: { reviewer } } };
}

function withPage(run: (page: Page) => Promise<void>) {
  return suite.withPage({ locale: "en-US", serviceWorkers: "block", viewport }, ({ page }) =>
    run(page),
  );
}

async function selectAgent(select: Locator, name: string) {
  await select.locator(".agent-select__trigger").click();
  await select
    .locator(".agent-select__option[data-agent-option]")
    .filter({ hasText: name })
    .click();
  await expect
    .poll(async () => (await select.locator(".agent-select__label").textContent())?.trim())
    .toBe(name);
}

const expectVisible = (control: Locator) => expect.poll(() => control.isVisible()).toBe(true);

async function expectDenied(control: Locator, gateway: MockGatewayControls, method: string) {
  await expect.poll(() => control.isDisabled()).toBe(true);
  await control.click({ force: true });
  expect(await gateway.getRequests(method)).toHaveLength(0);
}

async function expectAgentCreationDenied(page: Page, gateway: MockGatewayControls) {
  const createAgent = page.getByRole("button", { name: "New agent", exact: true });
  await expect.poll(() => createAgent.isDisabled()).toBe(true);
  expect(await createAgent.getAttribute("title")).toContain("openclaw.chat");
  expect(await createAgent.getAttribute("title")).toContain("operator.admin");
  const url = page.url();
  await createAgent.click({ force: true });
  expect(page.url()).toBe(url);
  expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
}

suite.define(() => {
  it("administers agent-scoped Skills and inspects the connected Nodes inventory", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [
          ...bootMethods,
          "device.pair.list",
          "exec.approvals.get",
          "node.list",
          "skills.install",
          "skills.status",
          "skills.update",
          ...workshopMethods,
        ],
        methodResponses: {
          "agents.list": agentsResponse,
          "config.get": configResponse(),
          "device.pair.list": { paired: [], pending: [] },
          "exec.approvals.get": approvalSnapshot,
          "node.list": {
            nodes: [
              {
                nodeId: "build-node",
                displayName: "Build Node",
                platform: "linux",
                version: "2026.8.3",
                caps: ["browser", "filesystem"],
                commands: ["system.run", "system.execApprovals.get", "system.execApprovals.set"],
                connected: true,
                paired: true,
              },
            ],
          },
          "skills.install": { message: "Installed Deploy Helper" },
          "skills.status": {
            cases: [
              { match: { agentId: "reviewer" }, response: skillStatus(false) },
              { response: skillStatus(true) },
            ],
          },
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}skills`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("skills.status");

      const skillCard = page.locator(".skill-discovery .plugin-catalog-card", {
        hasText: "Deploy Helper",
      });
      await expectVisible(skillCard.getByRole("img", { name: "Ready" }));
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.getByRole("button", { name: /Switch agent/ }).click();
      await sidebar
        .locator(".sidebar-agent-menu")
        .getByRole("menuitem", { name: "Reviewer" })
        .click();
      await gateway.waitForRequest("skills.status", { match: { agentId: "reviewer" } });
      expect(new URL(page.url()).pathname).toBe("/skills");
      await expectVisible(skillCard.getByRole("img", { name: /Needs Setup.*deploy-helper/ }));

      await page.getByRole("button", { name: "Skill settings", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/skills");
      const agentSelect = page.locator(".settings-sidebar__agent openclaw-agent-select");
      await expect
        .poll(async () => (await agentSelect.locator(".agent-select__label").textContent())?.trim())
        .toBe("Reviewer");

      await page.getByRole("button", { name: "Open Deploy Helper details" }).click();
      const dialog = page.locator("openclaw-modal-dialog", { hasText: "Deploy Helper" });
      await expectVisible(dialog.getByRole("button", { name: "Install Deploy Helper" }));
      await gateway.setMethodResponse("skills.status", skillStatus(true));
      await dialog.getByRole("button", { name: "Install Deploy Helper" }).click();
      const installRequest = await gateway.waitForRequest("skills.install");
      expect(installRequest.params).toMatchObject({
        agentId: "reviewer",
        name: "Deploy Helper",
        installId: "node-deploy-helper",
        dangerouslyForceUnsafeInstall: false,
      });
      await expectVisible(dialog.getByText("Installed Deploy Helper"));

      await page.goto(`${suite.server.baseUrl}nodes`);
      await Promise.all([
        gateway.waitForRequest("node.list"),
        gateway.waitForRequest("device.pair.list"),
        gateway.waitForRequest("exec.approvals.get"),
      ]);
      await expectVisible(page.getByText("Build Node", { exact: true }));
      await expect.poll(() => page.getByText("connected", { exact: true }).count()).toBe(1);
      const chips = page.locator(".device-capability");
      await expect.poll(() => chips.filter({ hasText: "Browser" }).count()).toBe(1);
      await expect.poll(() => chips.filter({ hasText: "filesystem" }).count()).toBe(1);
      await page.getByText("Details", { exact: true }).click();
      await expectVisible(
        page.locator(".device-entry__facts dd").filter({
          hasText: "system.run, system.execApprovals.get, system.execApprovals.set",
        }),
      );
    });
  });

  it("keeps read-only administration pages visible without dispatching mutations", async () => {
    await withPage(async (page) => {
      const learnedAtMs = Date.parse("2026-08-04T08:00:00.000Z");
      const workspace = "/tmp/openclaw-e2e/workspace";
      const agentFile = { name: "AGENTS.md", path: `${workspace}/AGENTS.md`, missing: false };
      const filesResponse = { agentId: "main", workspace };
      const readOnlyConfig = {
        ...operatorConfig,
        skills: { workshop: { autonomous: { mode: "auto" } } },
      };
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "agents.files.get",
          "agents.files.list",
          "agents.files.set",
          ...bootMethods,
          "agents.update",
          "config.patch",
          "config.set",
          "skills.install",
          "sessions.create",
          "skills.status",
          "skills.update",
          ...workshopMethods,
        ],
        operatorScopes: ["operator.read"],
        methodResponses: {
          "agents.list": agentsResponse,
          "agents.files.get": {
            ...filesResponse,
            file: { ...agentFile, content: "# Main agent\n" },
          },
          "agents.files.list": { ...filesResponse, files: [agentFile] },
          "config.get": configResponse(readOnlyConfig),
          "skills.workshop.list": {
            agentId: "main",
            mode: "auto",
            root: "/tmp/openclaw-e2e/agents/main/workshop-skills",
            skills: [
              {
                name: "read-only-skill",
                description: "Review without mutation access.",
                updatedAtMs: learnedAtMs,
                sizeBytes: 120,
                files: ["SKILL.md"],
              },
            ],
            archived: [
              {
                name: "read-only-skill",
                live: true,
                versions: [
                  { id: "20260804T080000000Z-patch", action: "patch", createdAtMs: learnedAtMs },
                ],
              },
            ],
          },
          "skills.workshop.read": {
            name: "read-only-skill",
            filePath: "SKILL.md",
            content: "# Read-only skill\n\nReview without mutation access.\n",
            files: ["SKILL.md"],
          } satisfies SkillsWorkshopReadResult,
          "skills.workshop.changes": {
            changes: [
              {
                id: "change-read-only",
                agentId: "main",
                skillName: "read-only-skill",
                action: "patch",
                actor: "review",
                summary: "tightened the review step",
                versionId: "20260804T080000000Z-patch",
                createdAtMs: learnedAtMs,
              },
            ],
          },
          "skills.status": skillStatus(false),
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/agents`);
      await gateway.waitForRequest("agents.list");
      await selectAgent(page.locator(".settings-sidebar__agent openclaw-agent-select"), "Reviewer");
      await page.locator("#agents-tab-overview").click();
      const setDefault = page.getByRole("button", { name: "Set Default", exact: true });
      await expect.poll(() => setDefault.isDisabled()).toBe(true);
      await expectAgentCreationDenied(page, gateway);

      const identityName = page.locator(".agent-identity-editor__fields input").first();
      await expect.poll(() => identityName.isDisabled()).toBe(true);
      await setDefault.click({ force: true });
      expect(await gateway.getRequests("config.set")).toHaveLength(0);

      await page.goto(`${suite.server.baseUrl}settings/agents/main/files`);
      await gateway.waitForRequest("agents.files.get", {
        match: { agentId: "main", name: "AGENTS.md" },
      });
      const fileEditor = page.locator(".agent-file-textarea");
      await expect.poll(() => fileEditor.inputValue()).toBe("# Main agent\n");
      await expect.poll(() => fileEditor.isDisabled()).toBe(true);
      // Bypass only the DOM disabled state to exercise the owner's permission guard.
      await fileEditor.evaluate((element: HTMLTextAreaElement) => {
        element.disabled = false;
        element.value = "# Mutated\n";
        element.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page
        .locator(".agent-file-actions")
        .getByRole("button", { name: "Preview", exact: true })
        .click();
      await expect
        .poll(() => page.locator(".md-preview-dialog__reader").textContent())
        .toContain("Mutated");
      await page.getByRole("button", { name: "Close preview", exact: true }).click();
      const fileSave = page.locator(".agent-file-actions button").filter({ hasText: "Save" });
      await expect.poll(() => fileSave.isDisabled()).toBe(true);
      await fileSave.evaluate((element: HTMLButtonElement) => {
        element.disabled = false;
      });
      await fileSave.click();
      expect(await gateway.getRequests("agents.files.set")).toHaveLength(0);

      await page.goto(`${suite.server.baseUrl}settings/agents/main/skills`);
      await gateway.waitForRequest("skills.status", { match: { agentId: "main" } });
      const agentSkillsActions = page.locator(".settings-section", { hasText: "Skills" });
      const disableAll = agentSkillsActions.getByRole("button", { name: "Disable All" });
      await expectDenied(disableAll, gateway, "config.set");

      await page.goto(`${suite.server.baseUrl}skills`);
      await gateway.waitForRequest("skills.status");
      const skillCard = page.locator(".skill-discovery .plugin-catalog-card", {
        hasText: "Deploy Helper",
      });
      await expectVisible(skillCard.getByRole("img", { name: /Needs Setup.*deploy-helper/ }));
      expect(await page.locator(".skill-discovery").getByRole("switch").count()).toBe(0);
      await page.getByRole("button", { name: "Skill settings", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/skills");
      await page.getByRole("button", { name: "Open Deploy Helper details" }).click();
      const skillDialog = page.locator("openclaw-modal-dialog", { hasText: "Deploy Helper" });
      const globalSkillToggle = skillDialog.getByRole("switch");
      await expectDenied(globalSkillToggle, gateway, "skills.update");
      const install = skillDialog.getByRole("button", { name: "Install Deploy Helper" });
      await expectDenied(install, gateway, "skills.install");

      await page.goto(`${suite.server.baseUrl}skills/workshop`);
      await gateway.waitForRequest("skills.workshop.list");
      await page.getByText("tightened the review step").waitFor();
      expect(await page.getByRole("button", { name: "Undo", exact: true }).count()).toBe(0);
      await page.getByRole("button", { name: "read-only-skill" }).first().click();
      await gateway.waitForRequest("skills.workshop.read");
      await expect
        .poll(() => page.locator(".sw-markdown").textContent())
        .toContain("Review without mutation access.");
      expect(await page.getByRole("button", { name: "Archive", exact: true }).count()).toBe(0);
      const learningOff = page.getByRole("button", { name: "Off", exact: true });
      await expectDenied(learningOff, gateway, "config.patch");
      expect(await gateway.getRequests("skills.workshop.restore")).toHaveLength(0);
      expect(await gateway.getRequests("skills.workshop.archive")).toHaveLength(0);
      const learn = page.getByRole("button", { name: "Learn from history" });
      await expect.poll(() => learn.isDisabled()).toBe(true);
      const creates = (await gateway.getRequests("sessions.create")).length;
      await learn.click({ force: true });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(creates);
    });
  });

  it("disables admin mutations when the Gateway omits required method metadata", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        omitFeatureMethods: true,
        methodResponses: {
          "agents.list": agentsResponse,
          "config.get": configResponse(),
          "skills.install": { message: "Installed Deploy Helper" },
          "skills.status": skillStatus(false),
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/agents`);
      await gateway.waitForRequest("agents.list");
      await selectAgent(page.locator(".settings-sidebar__agent openclaw-agent-select"), "Reviewer");
      const setDefault = page.getByRole("button", { name: "Set Default", exact: true });
      await expect.poll(() => setDefault.isDisabled()).toBe(true);
      await expectAgentCreationDenied(page, gateway);

      await setDefault.click({ force: true });
      expect(await gateway.getRequests("config.set")).toHaveLength(0);

      await page.goto(`${suite.server.baseUrl}skills`);
      await gateway.waitForRequest("skills.status");
      await page.getByRole("button", { name: "Open Deploy Helper details" }).click();
      const install = page
        .locator("openclaw-modal-dialog", { hasText: "Deploy Helper" })
        .getByRole("button", { name: "Install Deploy Helper" });
      await expectDenied(install, gateway, "skills.install");
    });
  });

  it("edits, saves, and reapplies reviewer-scoped exec approvals", async () => {
    await withPage(async (page) => {
      const initialApprovals = reviewerApprovals("approval-hash-1", {
        ...approvalDefaults,
        security: "allowlist",
        allowlist: [{ pattern: "/usr/bin/git" }],
      });
      const appliedApprovals = reviewerApprovals("approval-hash-2", {
        security: "full",
        ask: "always",
        askFallback: "allowlist",
        autoAllowSkills: true,
        allowlist: [{ pattern: "/usr/bin/gh" }],
      });
      const gateway = await installMockGateway(page, {
        featureMethods: [
          ...bootMethods,
          "device.pair.list",
          "exec.approvals.get",
          "exec.approvals.set",
          "node.list",
        ],
        methodResponses: {
          "config.get": configResponse(),
          "device.pair.list": { paired: [], pending: [] },
          "exec.approvals.get": initialApprovals,
          "exec.approvals.set": { ok: true },
          "node.list": { nodes: [] },
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}nodes`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("exec.approvals.get");

      const scopeSelect = page.locator("openclaw-agent-select.agent-select--settings");
      await selectAgent(scopeSelect, "Reviewer (reviewer)");

      const modeSelects = page.getByRole("combobox", { name: "Mode" });
      await modeSelects.nth(0).selectOption("full");
      await modeSelects.nth(1).selectOption("always");
      await page.getByRole("combobox", { name: "Fallback" }).selectOption("allowlist");
      const autoAllowSwitch = page
        .locator(".settings-row", { hasText: "Auto-allow skill CLIs" })
        .getByRole("switch");
      await autoAllowSwitch.click();
      await page.getByRole("textbox", { name: "Pattern" }).fill("/usr/bin/gh");

      await gateway.setMethodResponse("exec.approvals.get", appliedApprovals);
      const getRequestsBeforeSave = (await gateway.getRequests("exec.approvals.get")).length;
      const approvalsSection = page.locator(".settings-section", { hasText: "Exec approvals" });
      const saveButton = approvalsSection.getByRole("button", { name: "Save", exact: true });
      await saveButton.click();
      const saveRequest = await gateway.waitForRequest("exec.approvals.set");
      expect(saveRequest.params).toEqual({
        baseHash: "approval-hash-1",
        file: appliedApprovals.file,
      });

      await expect
        .poll(async () => (await gateway.getRequests("exec.approvals.get")).length)
        .toBeGreaterThan(getRequestsBeforeSave);
      for (const [control, value] of [
        [modeSelects.nth(0), "full"],
        [modeSelects.nth(1), "always"],
        [page.getByRole("combobox", { name: "Fallback" }), "allowlist"],
        [page.getByRole("textbox", { name: "Pattern" }), "/usr/bin/gh"],
      ] as const) {
        await expect.poll(() => control.inputValue()).toBe(value);
      }
      await expect.poll(() => autoAllowSwitch.isChecked()).toBe(true);
      await expect.poll(() => saveButton.isDisabled()).toBe(true);
      expect(await page.getByRole("alert").count()).toBe(0);
    });
  });
});
