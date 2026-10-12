// Control UI E2E coverage for operator-facing Skills, Nodes, and exec approvals administration.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI operator administration",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("operator-admin");
  }
});
const viewport = { height: 960, width: 1440 };

const agentRoster = [
  { id: "main", identity: { name: "Main" }, name: "Main" },
  { id: "reviewer", identity: { name: "Reviewer" }, name: "Reviewer" },
];

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
      {
        name: "Deploy Helper",
        description: "Prepare reviewed deployments.",
        source: "openclaw-bundled",
        bundled: true,
        filePath: "/tmp/openclaw-e2e/skills/deploy-helper/SKILL.md",
        baseDir: "/tmp/openclaw-e2e/skills/deploy-helper",
        skillKey: "deploy-helper",
        always: false,
        disabled: false,
        blockedByAllowlist: false,
        blockedByAgentFilter: false,
        eligible,
        platformIncompatible: false,
        modelVisible: eligible,
        userInvocable: true,
        commandVisible: eligible,
        requirements: {
          bins: ["deploy-helper"],
          anyBins: [],
          env: [],
          config: [],
          os: [],
        },
        missing: {
          bins: eligible ? [] : ["deploy-helper"],
          anyBins: [],
          env: [],
          config: [],
          os: [],
        },
        configChecks: [],
        install: [
          {
            id: "node-deploy-helper",
            kind: "node",
            label: "Install Deploy Helper",
            bins: ["deploy-helper"],
          },
        ],
      },
    ],
  };
}

function configResponse(config: Record<string, unknown> = operatorConfig) {
  const raw = JSON.stringify(config);
  return {
    config,
    sourceConfig: config,
    hash: "config-hash-1",
    issues: [],
    raw,
    valid: true,
  };
}

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
    return {};
  }
  return request.params as Record<string, unknown>;
}

async function waitForRequest(
  gateway: MockGatewayControls,
  method: string,
  predicate: (params: Record<string, unknown>) => boolean,
) {
  await expect
    .poll(async () =>
      (await gateway.getRequests(method)).some((request) => predicate(requestParams(request))),
    )
    .toBe(true);
}

async function createContext(): Promise<BrowserContext> {
  return suite.browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
    ...(captureUiProof ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
  });
}

async function selectAgentOnAgentsPage(page: Page, name: string) {
  const select = page.locator(".settings-sidebar__agent openclaw-agent-select");
  await select.locator(".agent-select__trigger").click();
  await select.locator("wa-dropdown-item[data-agent-option]").filter({ hasText: name }).click();
  await expect
    .poll(async () => (await select.locator(".agent-select__label").textContent())?.trim())
    .toBe(name);
}

async function screenshot(
  page: Page,
  name: string,
  content: Locator,
  surface = page.locator(".shell"),
) {
  if (!captureUiProof) {
    return;
  }
  await writeFile(
    path.join(proofDir, name),
    await takeControlUiViewportScreenshot(page, surface, [content]),
  );
}

suite.define(() => {
  it("administers agent-scoped Skills and inspects the connected Nodes inventory", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "agents.list",
        "chat.metadata",
        "chat.startup",
        "config.get",
        "device.pair.list",
        "exec.approvals.get",
        "node.list",
        "skills.install",
        "skills.status",
        "skills.update",
        "skills.workshop.archive",
        "skills.workshop.changes",
        "skills.workshop.list",
        "skills.workshop.read",
        "skills.workshop.restore",
      ],
      methodResponses: {
        "agents.list": {
          agents: agentRoster,
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "config.get": configResponse(),
        "device.pair.list": { paired: [], pending: [] },
        "exec.approvals.get": {
          path: "/tmp/openclaw-e2e/exec-approvals.json",
          exists: true,
          hash: "approval-hash-1",
          file: {
            defaults: {
              security: "deny",
              ask: "on-miss",
              askFallback: "deny",
              autoAllowSkills: false,
            },
            agents: {},
          },
        },
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

    try {
      const response = await page.goto(`${suite.server.baseUrl}skills`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("skills.status");

      const skillCard = page.locator(".skill-discovery .plugin-catalog-card", {
        hasText: "Deploy Helper",
      });
      await expect.poll(() => skillCard.getByRole("img", { name: "Ready" }).isVisible()).toBe(true);
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.getByRole("button", { name: /Switch agent/ }).click();
      await sidebar
        .locator("wa-dropdown.sidebar-agent-menu")
        .getByRole("menuitem", { name: "Reviewer" })
        .click();
      await waitForRequest(gateway, "skills.status", (params) => params.agentId === "reviewer");
      expect(new URL(page.url()).pathname).toBe("/skills");
      await expect
        .poll(() => skillCard.getByRole("img", { name: /Needs Setup.*deploy-helper/ }).isVisible())
        .toBe(true);

      await page.getByRole("button", { name: "Skill settings", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/skills");
      const agentSelect = page.locator(".settings-sidebar__agent openclaw-agent-select");
      await expect
        .poll(async () => (await agentSelect.locator(".agent-select__label").textContent())?.trim())
        .toBe("Reviewer");

      await page.getByRole("button", { name: "Open Deploy Helper details" }).click();
      const dialog = page.locator("openclaw-modal-dialog", { hasText: "Deploy Helper" });
      await expect
        .poll(() => dialog.getByRole("button", { name: "Install Deploy Helper" }).isVisible())
        .toBe(true);
      await gateway.setMethodResponse("skills.status", skillStatus(true));
      await dialog.getByRole("button", { name: "Install Deploy Helper" }).click();
      const installRequest = await gateway.waitForRequest("skills.install");
      expect(installRequest.params).toMatchObject({
        agentId: "reviewer",
        name: "Deploy Helper",
        installId: "node-deploy-helper",
        dangerouslyForceUnsafeInstall: false,
      });
      await expect.poll(() => dialog.getByText("Installed Deploy Helper").isVisible()).toBe(true);
      await screenshot(
        page,
        "01-reviewer-skill-installed.png",
        dialog.getByText("Installed Deploy Helper"),
        dialog.locator("dialog"),
      );

      await page.goto(`${suite.server.baseUrl}nodes`);
      await Promise.all([
        gateway.waitForRequest("node.list"),
        gateway.waitForRequest("device.pair.list"),
        gateway.waitForRequest("exec.approvals.get"),
      ]);
      await expect.poll(() => page.getByText("Build Node", { exact: true }).isVisible()).toBe(true);
      // The connected node row carries a status pill and capability chips; an
      // unknown capability keeps its raw name as a generic chip.
      await expect.poll(() => page.getByText("connected", { exact: true }).count()).toBe(1);
      const chips = page.locator(".device-capability");
      await expect.poll(() => chips.filter({ hasText: "Browser" }).count()).toBe(1);
      await expect.poll(() => chips.filter({ hasText: "filesystem" }).count()).toBe(1);
      await page.getByText("Details", { exact: true }).click();
      await expect
        .poll(() =>
          page
            .locator(".device-entry__facts dd")
            .filter({ hasText: "system.run, system.execApprovals.get, system.execApprovals.set" })
            .isVisible(),
        )
        .toBe(true);
      await screenshot(
        page,
        "02-connected-node-inventory.png",
        page.locator(".device-entry__facts"),
      );
    } finally {
      await context.close();
    }
  });

  it("keeps read-only administration pages visible without dispatching mutations", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const learnedAtMs = Date.parse("2026-08-04T08:00:00.000Z");
    const readOnlyConfig = {
      ...operatorConfig,
      skills: { workshop: { autonomous: { mode: "auto" } } },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "agents.files.get",
        "agents.files.list",
        "agents.files.set",
        "agents.list",
        "agents.update",
        "chat.metadata",
        "chat.startup",
        "config.get",
        "config.patch",
        "config.set",
        "skills.install",
        "sessions.create",
        "skills.status",
        "skills.update",
        "skills.workshop.archive",
        "skills.workshop.changes",
        "skills.workshop.list",
        "skills.workshop.read",
        "skills.workshop.restore",
      ],
      operatorScopes: ["operator.read"],
      methodResponses: {
        "agents.list": {
          agents: agentRoster,
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "agents.files.get": {
          agentId: "main",
          workspace: "/tmp/openclaw-e2e/workspace",
          file: {
            name: "AGENTS.md",
            path: "/tmp/openclaw-e2e/workspace/AGENTS.md",
            content: "# Main agent\n",
            missing: false,
          },
        },
        "agents.files.list": {
          agentId: "main",
          files: [
            {
              name: "AGENTS.md",
              path: "/tmp/openclaw-e2e/workspace/AGENTS.md",
              missing: false,
            },
          ],
          workspace: "/tmp/openclaw-e2e/workspace",
        },
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

    try {
      await page.goto(`${suite.server.baseUrl}settings/agents`);
      await gateway.waitForRequest("agents.list");
      await selectAgentOnAgentsPage(page, "Reviewer");
      await page.locator("#agents-tab-overview").click();
      const setDefault = page.locator(".agents-toolbar-actions button").nth(1);
      await expect.poll(() => setDefault.isDisabled()).toBe(true);
      const identitySave = page
        .locator(".agent-identity-editor__actions")
        .getByRole("button", { name: "Save", exact: true });
      await expect.poll(async () => (await identitySave.textContent())?.trim()).toBe("Save");
      await expect.poll(() => identitySave.isDisabled()).toBe(true);
      await setDefault.click({ force: true });
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
      await screenshot(page, "05-read-only-agents.png", setDefault);

      await page.goto(`${suite.server.baseUrl}settings/agents/main/files`);
      await waitForRequest(
        gateway,
        "agents.files.get",
        (params) => params.agentId === "main" && params.name === "AGENTS.md",
      );
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
      await waitForRequest(gateway, "skills.status", (params) => params.agentId === "main");
      const agentSkillsActions = page.locator(".settings-section", { hasText: "Skills" });
      const disableAll = agentSkillsActions.getByRole("button", { name: "Disable All" });
      await expect.poll(() => disableAll.isDisabled()).toBe(true);
      await disableAll.click({ force: true });
      expect(await gateway.getRequests("config.set")).toHaveLength(0);

      await page.goto(`${suite.server.baseUrl}skills`);
      await gateway.waitForRequest("skills.status");
      const skillCard = page.locator(".skill-discovery .plugin-catalog-card", {
        hasText: "Deploy Helper",
      });
      await expect
        .poll(() => skillCard.getByRole("img", { name: /Needs Setup.*deploy-helper/ }).isVisible())
        .toBe(true);
      expect(await page.locator(".skill-discovery").getByRole("switch").count()).toBe(0);
      await page.getByRole("button", { name: "Skill settings", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/skills");
      await page.getByRole("button", { name: "Open Deploy Helper details" }).click();
      const skillDialog = page.locator("openclaw-modal-dialog", { hasText: "Deploy Helper" });
      const globalSkillToggle = skillDialog.getByRole("switch");
      await expect.poll(() => globalSkillToggle.isDisabled()).toBe(true);
      await globalSkillToggle.click({ force: true });
      expect(await gateway.getRequests("skills.update")).toHaveLength(0);
      const install = skillDialog.getByRole("button", { name: "Install Deploy Helper" });
      await expect.poll(() => install.isDisabled()).toBe(true);
      await install.click({ force: true });
      expect(await gateway.getRequests("skills.install")).toHaveLength(0);
      await screenshot(page, "06-read-only-skills.png", install, skillDialog.locator("dialog"));

      await page.goto(`${suite.server.baseUrl}skills/workshop`);
      await gateway.waitForRequest("skills.workshop.list");
      await page.getByText("tightened the review step").waitFor();
      expect(await page.getByRole("button", { name: "Undo", exact: true }).count()).toBe(0);
      await page.getByRole("button", { name: "read-only-skill" }).first().click();
      await gateway.waitForRequest("skills.workshop.read");
      expect(await page.getByRole("button", { name: "Archive", exact: true }).count()).toBe(0);
      const learningOff = page.getByRole("button", { name: "Off", exact: true });
      await expect.poll(() => learningOff.isDisabled()).toBe(true);
      await learningOff.click({ force: true });
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      expect(await gateway.getRequests("skills.workshop.restore")).toHaveLength(0);
      expect(await gateway.getRequests("skills.workshop.archive")).toHaveLength(0);
      const learn = page.getByRole("button", { name: "Learn from history" });
      await expect.poll(() => learn.isDisabled()).toBe(true);
      const creates = (await gateway.getRequests("sessions.create")).length;
      await learn.click({ force: true });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(creates);
      await screenshot(page, "07-read-only-workshop.png", learn);
    } finally {
      await context.close();
    }
  });

  it("disables admin mutations when the Gateway omits required method metadata", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      omitFeatureMethods: true,
      methodResponses: {
        "agents.list": {
          agents: agentRoster,
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "config.get": configResponse(),
        "skills.install": { message: "Installed Deploy Helper" },
        "skills.status": skillStatus(false),
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}settings/agents`);
      await gateway.waitForRequest("agents.list");
      await selectAgentOnAgentsPage(page, "Reviewer");
      const setDefault = page.locator(".agents-toolbar-actions button").nth(1);
      await expect.poll(() => setDefault.isDisabled()).toBe(true);
      await setDefault.click({ force: true });
      expect(await gateway.getRequests("config.set")).toHaveLength(0);

      await page.goto(`${suite.server.baseUrl}skills`);
      await gateway.waitForRequest("skills.status");
      await page.getByRole("button", { name: "Open Deploy Helper details" }).click();
      const install = page
        .locator("openclaw-modal-dialog", { hasText: "Deploy Helper" })
        .getByRole("button", { name: "Install Deploy Helper" });
      await expect.poll(() => install.isDisabled()).toBe(true);
      await install.click({ force: true });
      expect(await gateway.getRequests("skills.install")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("edits, saves, and reapplies reviewer-scoped exec approvals", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const initialApprovals = {
      path: "/tmp/openclaw-e2e/exec-approvals.json",
      exists: true,
      hash: "approval-hash-1",
      file: {
        defaults: {
          security: "deny",
          ask: "on-miss",
          askFallback: "deny",
          autoAllowSkills: false,
        },
        agents: {
          reviewer: {
            security: "allowlist",
            ask: "on-miss",
            askFallback: "deny",
            autoAllowSkills: false,
            allowlist: [{ pattern: "/usr/bin/git" }],
          },
        },
      },
    };
    const appliedApprovals = {
      ...initialApprovals,
      hash: "approval-hash-2",
      file: {
        ...initialApprovals.file,
        agents: {
          reviewer: {
            security: "full",
            ask: "always",
            askFallback: "allowlist",
            autoAllowSkills: true,
            allowlist: [{ pattern: "/usr/bin/gh" }],
          },
        },
      },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "agents.list",
        "chat.metadata",
        "chat.startup",
        "config.get",
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

    try {
      const response = await page.goto(`${suite.server.baseUrl}nodes`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("exec.approvals.get");

      const scopeSelect = page.locator("openclaw-agent-select.agent-select--settings");
      await scopeSelect.locator(".agent-select__trigger").click();
      await scopeSelect
        .locator("wa-dropdown-item[data-agent-option]")
        .filter({ hasText: "Reviewer (reviewer)" })
        .click();
      await expect
        .poll(async () => (await scopeSelect.locator(".agent-select__label").textContent())?.trim())
        .toBe("Reviewer (reviewer)");

      const modeSelects = page.getByRole("combobox", { name: "Mode" });
      await modeSelects.nth(0).selectOption("full");
      await modeSelects.nth(1).selectOption("always");
      await page.getByRole("combobox", { name: "Fallback" }).selectOption("allowlist");
      const autoAllowSwitch = page
        .locator(".settings-row", { hasText: "Auto-allow skill CLIs" })
        .getByRole("switch");
      await autoAllowSwitch.click();
      await page.getByRole("textbox", { name: "Pattern" }).fill("/usr/bin/gh");
      await screenshot(
        page,
        "03-reviewer-approval-edits.png",
        page.getByRole("textbox", { name: "Pattern" }),
      );

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
      await expect.poll(() => modeSelects.nth(0).inputValue()).toBe("full");
      await expect.poll(() => modeSelects.nth(1).inputValue()).toBe("always");
      await expect
        .poll(() => page.getByRole("combobox", { name: "Fallback" }).inputValue())
        .toBe("allowlist");
      await expect.poll(() => autoAllowSwitch.isChecked()).toBe(true);
      await expect
        .poll(() => page.getByRole("textbox", { name: "Pattern" }).inputValue())
        .toBe("/usr/bin/gh");
      await expect.poll(() => saveButton.isDisabled()).toBe(true);
      expect(await page.getByRole("alert").count()).toBe(0);
      await screenshot(page, "04-reviewer-approval-applied.png", saveButton);
    } finally {
      await context.close();
    }
  });
});
