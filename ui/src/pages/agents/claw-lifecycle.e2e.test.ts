import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const browserAvailable = canRunPlaywrightChromium(executablePath);
const capture = process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1";
const pluginIntegrity = `sha256-${"A".repeat(43)}=`;
const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1366, height: 768 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

let browser: Browser;
let server: ControlUiE2eServer;

describe.skipIf(!browserAvailable)("Claw lifecycle on agent Overview", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each(viewports)(
    "shows Labs-off status and a bounded Remove review at $name width",
    async (viewport) => {
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: viewport.width, height: viewport.height },
      });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        defaultAgentId: "workflow",
        assistantAgentId: "workflow",
        assistantName: "Workflow Operator",
        featureMethods: ["claws.status", "claws.remove.plan", "claws.remove.apply"],
        methodResponses: {
          "claws.status": {
            schemaVersion: "openclaw.clawsGatewayStatus.v1",
            records: [
              {
                agentId: "workflow",
                name: "@openclaw/workflow-operator",
                version: "1.2.0",
                sourceKind: "package",
                status: "complete",
                agentState: "present",
                bootstrapState: "complete",
                orphaned: false,
                addedAtMs: 1_000,
                updatedAtMs: 2_000,
                resources: [
                  { kind: "agent", id: "workflow", state: "present", relationship: "managed" },
                  {
                    kind: "plugin",
                    id: "workflow-tools",
                    state: "present",
                    relationship: "referenced",
                    origin: "pre-existing",
                    independentOwner: true,
                  },
                ],
              },
            ],
            summary: { claws: 1, healthy: 1, attention: 0, managed: 1, referenced: 1 },
          },
          "claws.remove.plan": {
            schemaVersion: "openclaw.clawsGatewayPlan.v1",
            operation: "remove",
            planIntegrity: "sha256:remove-plan",
            target: {
              agentId: "workflow",
              name: "@openclaw/workflow-operator",
              currentVersion: "1.2.0",
            },
            actions: [
              { kind: "agent", id: "workflow", action: "delete", blocked: false },
              {
                kind: "plugin",
                id: "workflow-tools",
                action: "retain",
                blocked: false,
                reason: "Referenced by another agent",
              },
            ],
            capabilities: [],
            blockers: [],
            pluginReviews: [],
            skillReviews: [],
            riskAcknowledgementRequired: false,
            scheduledJobs: { coverage: "package-declarations", jobs: [] },
          },
        },
      });
      try {
        await page.goto(`${server.baseUrl}settings/agents/workflow`);
        await page.getByText("@openclaw/workflow-operator", { exact: true }).waitFor();
        expect((await gateway.waitForRequest("claws.status")).params).toEqual({
          target: "workflow",
        });
        await page.getByText("workflow-tools", { exact: true }).waitFor();
        const resourceRow = page
          .locator("openclaw-agent-claw-panel .settings-row")
          .filter({ hasText: "workflow-tools" });
        expect(await resourceRow.textContent()).toContain("Shared");
        const remove = page.getByRole("button", { name: "Remove Claw" }).first();
        expect(await remove.isEnabled()).toBe(true);
        if (capture) {
          const dir = createControlUiE2eArtifactDir(`claw-lifecycle-${viewport.name}`);
          await remove.scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${dir}/overview.png`, animations: "disabled" });
        }

        await remove.click();
        const dialog = page.locator(".claw-lifecycle-dialog");
        await dialog.getByText("Referenced by another agent").waitFor();
        await dialog.getByText("Kept").waitFor();
        expect((await gateway.waitForRequest("claws.remove.plan")).params).toEqual({
          agentId: "workflow",
        });
        const bounds = await dialog.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
        const confirm = dialog.getByRole("button", { name: "Remove Claw" });
        await confirm.scrollIntoViewIfNeeded();
        expect(await confirm.isEnabled()).toBe(true);
        const confirmBounds = await confirm.boundingBox();
        expect(confirmBounds).not.toBeNull();
        expect(confirmBounds!.y).toBeGreaterThanOrEqual(0);
        expect(confirmBounds!.y + confirmBounds!.height).toBeLessThanOrEqual(viewport.height);
        if (capture) {
          const dir = createControlUiE2eArtifactDir(`claw-lifecycle-${viewport.name}`);
          await page.screenshot({ path: `${dir}/remove-review.png`, animations: "disabled" });
        }
      } finally {
        await context.close();
      }
    },
  );

  it.each(viewports)("reviews and applies an official Update at $name width", async (viewport) => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: viewport.width, height: viewport.height },
    });
    const page = await context.newPage();
    const config = { gateway: { controlUi: { experimental: { claws: true } } } };
    const capabilityGrants = {
      hooks: {
        allowPromptInjection: { effective: false },
        allowConversationAccess: { effective: true },
      },
    };
    const gateway = await installMockGateway(page, {
      defaultAgentId: "workflow",
      assistantAgentId: "workflow",
      assistantName: "Workflow Operator",
      featureMethods: [
        "claws.status",
        "claws.catalog.search",
        "claws.catalog.detail",
        "claws.update.plan",
        "claws.update.apply",
      ],
      methodResponses: {
        "config.get": {
          config,
          sourceConfig: config,
          resolved: config,
          raw: JSON.stringify(config),
          hash: "claws-update-e2e-config",
          path: "/tmp/openclaw-claws-update-e2e.json",
          valid: true,
          issues: [],
        },
        "claws.status": {
          schemaVersion: "openclaw.clawsGatewayStatus.v1",
          records: [
            {
              agentId: "workflow",
              name: "@openclaw/workflow-operator",
              version: "1.2.0",
              sourceKind: "package",
              status: "complete",
              agentState: "present",
              bootstrapState: "complete",
              orphaned: false,
              addedAtMs: 1_000,
              updatedAtMs: 2_000,
              resources: [{ kind: "agent", id: "workflow", state: "present" }],
            },
          ],
          summary: { claws: 1, healthy: 1, attention: 0, managed: 1, referenced: 0 },
        },
        "claws.catalog.search": {
          entries: [
            {
              packageName: "@openclaw/workflow-operator",
              displayName: "Workflow Operator",
              latestVersion: "1.3.0",
              channel: "official",
              official: true,
              downloads: 14,
              updatedAtMs: 3_000,
            },
          ],
        },
        "claws.catalog.detail": {
          detail: {
            packageName: "@openclaw/workflow-operator",
            displayName: "Workflow Operator",
            latestVersion: "1.3.0",
            version: "1.3.0",
            channel: "official",
            official: true,
            downloads: 14,
            updatedAtMs: 3_000,
            agentName: "Workflow Operator",
            workspaceFiles: 1,
            skills: 0,
            plugins: 1,
            mcpServers: 0,
            scheduledJobs: 0,
          },
        },
        "claws.update.plan": {
          schemaVersion: "openclaw.clawsGatewayPlan.v1",
          operation: "update",
          planIntegrity: "sha256:update-plan",
          target: {
            agentId: "workflow",
            name: "@openclaw/workflow-operator",
            currentVersion: "1.2.0",
            targetVersion: "1.3.0",
          },
          actions: [
            {
              kind: "plugin",
              id: "workflow-tools",
              action: "install",
              blocked: false,
              details: ["Installs workflow-tools@1.3.0"],
            },
          ],
          capabilities: [
            {
              kind: "plugin",
              id: "workflow-tools",
              action: "grant",
              reason: "Start approved workflows",
            },
          ],
          pluginReviews: [
            {
              actionId: "package:workflow-tools",
              pluginId: "workflow-tools",
              ref: "@openclaw/workflow-tools",
              version: "1.3.0",
              ownerAction: "install",
              integrity: pluginIntegrity,
              declaredCapabilities: {
                channels: [],
                providers: [],
                tools: ["workflow.start"],
                contracts: [],
                hooks: [],
                mcpServers: [],
                cliCommands: [],
                cliBackends: [],
                skills: [],
                dangerousConfigFlags: [],
              },
              capabilityGrants,
              reviewToken: "review-workflow-tools-1.3.0",
            },
          ],
          skillReviews: [],
          blockers: [],
          riskAcknowledgementRequired: false,
          configuredAccess: {
            coverage: "configuration-only",
            current: {
              tools: {
                allowed: ["read"],
                excluded: ["exec"],
                explicitAllow: ["read"],
                explicitDeny: [],
              },
              sandbox: {
                mode: "non-main",
                scope: "agent",
                workspaceAccess: "ro",
                backend: "docker",
              },
              filesystem: { workspaceOnly: true },
              heartbeat: { enabled: false, intervalMs: null },
              memorySearch: { state: "disabled" },
              subagentTargets: {
                allowedAgentIds: ["workflow"],
                allowAnyConfiguredAgent: false,
                implicitSelfAllowed: true,
                requireAgentId: false,
              },
            },
            desired: {
              tools: {
                allowed: ["read", "workflow.start"],
                excluded: ["exec"],
                explicitAllow: ["read", "workflow.start"],
                explicitDeny: [],
              },
              sandbox: {
                mode: "non-main",
                scope: "agent",
                workspaceAccess: "ro",
                backend: "docker",
              },
              filesystem: { workspaceOnly: true },
              heartbeat: { enabled: false, intervalMs: null },
              memorySearch: { state: "disabled" },
              subagentTargets: {
                allowedAgentIds: ["workflow"],
                allowAnyConfiguredAgent: false,
                implicitSelfAllowed: true,
                requireAgentId: false,
              },
            },
            unresolved: ["runtime-tools", "sandbox-runtime", "memory-runtime", "scheduler-runtime"],
          },
          scheduledJobs: { coverage: "package-declarations", jobs: [] },
          readiness: { ready: true, requirements: [] },
        },
        "claws.update.apply": {
          agentId: "workflow",
          status: "complete",
          readiness: { ready: true },
        },
      },
    });
    try {
      await page.goto(`${server.baseUrl}settings/agents/workflow`);
      const update = page.getByRole("button", { name: "Check for update" });
      await update.waitFor();
      await update.click();
      const dialog = page.locator(".claw-lifecycle-dialog");
      await dialog.getByText("workflow.start", { exact: true }).waitFor();
      await dialog.getByText(pluginIntegrity, { exact: true }).waitFor();
      expect((await gateway.waitForRequest("claws.catalog.search")).params).toEqual({
        query: "@openclaw/workflow-operator",
        limit: 100,
      });
      expect((await gateway.waitForRequest("claws.catalog.detail")).params).toEqual({
        packageName: "@openclaw/workflow-operator",
        version: "1.3.0",
      });
      expect((await gateway.waitForRequest("claws.update.plan")).params).toEqual({
        agentId: "workflow",
        source: { packageName: "@openclaw/workflow-operator", version: "1.3.0" },
      });
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      const confirm = dialog.getByRole("button", { name: "Update Claw" });
      await confirm.scrollIntoViewIfNeeded();
      expect(await confirm.isEnabled()).toBe(true);
      if (capture) {
        await dialog.getByText(pluginIntegrity, { exact: true }).scrollIntoViewIfNeeded();
        const dir = createControlUiE2eArtifactDir(`claw-update-${viewport.name}`);
        await page.screenshot({ path: `${dir}/review.png`, animations: "disabled" });
      }
      await confirm.click();
      expect((await gateway.waitForRequest("claws.update.apply")).params).toEqual({
        agentId: "workflow",
        source: { packageName: "@openclaw/workflow-operator", version: "1.3.0" },
        planIntegrity: "sha256:update-plan",
        acknowledgeCapabilities: [
          {
            actionId: "package:workflow-tools",
            pluginId: "workflow-tools",
            reviewToken: "review-workflow-tools-1.3.0",
            capabilityGrants,
          },
        ],
      });
      await dialog.getByText("Claw updated").waitFor();
    } finally {
      await context.close();
    }
  });
});
