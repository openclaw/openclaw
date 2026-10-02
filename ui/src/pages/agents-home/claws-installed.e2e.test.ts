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
const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1366, height: 768 },
] as const;

const orphan = {
  agentId: "orphan-worker",
  name: "@openclaw/orphan-worker",
  version: "1.0.0",
  sourceKind: "package",
  status: "partial",
  agentState: "missing",
  bootstrapState: "missing",
  orphaned: true,
  addedAtMs: 1_000,
  updatedAtMs: 2_000,
  resources: [{ kind: "plugin", id: "audit@2.0.0", state: "missing" }],
};

const removePlan = {
  schemaVersion: "openclaw.clawsGatewayPlan.v1",
  operation: "remove",
  planIntegrity: "sha256:orphan-remove-plan",
  target: {
    agentId: orphan.agentId,
    name: orphan.name,
    currentVersion: orphan.version,
  },
  actions: [
    {
      kind: "packageRef",
      id: "plugin:audit@2.0.0",
      action: "release",
      blocked: false,
      effect: {
        type: "ownership",
        relationship: "managed",
        origin: "claw-introduced",
        independentOwner: false,
        affectedClawCount: 1,
      },
    },
  ],
  capabilities: [],
  blockers: [],
  pluginReviews: [],
  skillReviews: [],
  riskAcknowledgementRequired: false,
  scheduledJobs: { coverage: "package-declarations", jobs: [] },
};

let browser: Browser;
let server: ControlUiE2eServer;

describe.skipIf(!browserAvailable)("Installed Claws needing attention", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each(viewports)(
    "manages an orphan from an empty roster with Labs off at $name width",
    async (viewport) => {
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: viewport.width, height: viewport.height },
      });
      const page = await context.newPage();
      const config = { gateway: { controlUi: { experimental: { claws: false } } } };
      const gateway = await installMockGateway(page, {
        awaitInitialRoster: false,
        featureMethods: ["claws.status", "claws.remove.plan", "claws.remove.apply"],
        methodResponses: {
          "config.get": {
            config,
            sourceConfig: config,
            resolved: config,
            raw: JSON.stringify(config),
            hash: "orphan-claw-e2e-config",
            path: "/tmp/openclaw-orphan-claw-e2e.json",
            valid: true,
            issues: [],
          },
          "agents.list": { agents: [], defaultId: "main", mainKey: "main", scope: "per-sender" },
          "claws.status": { records: [orphan] },
          "claws.remove.plan": removePlan,
          "claws.remove.apply": {
            agentId: orphan.agentId,
            status: "complete",
            agentRemoved: false,
          },
        },
      });
      try {
        await page.goto(`${server.baseUrl}agents`);
        const row = page.locator('[data-claw-unrepresented="orphan-worker"]');
        await row.waitFor({ state: "visible", timeout: 60_000 });
        expect(await page.locator(".agents-home__card").count()).toBe(0);
        expect(await page.locator("[data-claws-explore]").count()).toBe(0);
        expect(await page.locator("[data-claws-open-catalog]").count()).toBe(0);
        expect(await row.locator("a[href*='chat']").count()).toBe(0);
        expect(await row.textContent()).toContain("Partial");
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          viewport.width,
        );
        const dir = capture ? createControlUiE2eArtifactDir(`claws-orphan-${viewport.name}`) : null;
        if (dir) {
          await page.screenshot({
            path: `${dir}/agents.png`,
            fullPage: true,
            animations: "disabled",
          });
        }

        await row.getByRole("button", { name: "Inspect" }).click();
        const panel = page.locator("openclaw-agent-claw-panel");
        await panel.getByText("audit@2.0.0").waitFor();
        expect(await panel.locator("[data-claw-update]").count()).toBe(0);
        if (dir) {
          await page.screenshot({
            path: `${dir}/inspect.png`,
            fullPage: true,
            animations: "disabled",
          });
        }

        await panel.locator(".settings-row .btn.danger").click();
        const confirm = page.locator("[data-claw-remove-confirm]");
        await confirm.waitFor({ state: "visible" });
        await page.getByText("plugin:audit@2.0.0").waitFor();
        expect(await confirm.isEnabled()).toBe(true);
        expect(await gateway.getRequests("claws.remove.apply")).toHaveLength(0);
        if (dir) {
          await page.screenshot({ path: `${dir}/review.png`, animations: "disabled" });
        }

        await gateway.setMethodResponse("claws.status", { records: [] });
        await confirm.click();
        await row.waitFor({ state: "detached" });
        await page.getByText("Claw removed").waitFor();
        expect(await gateway.getRequests("claws.remove.apply")).toHaveLength(1);
        expect(await page.getByText("Removal incomplete").count()).toBe(0);
        if (dir) {
          await page.screenshot({ path: `${dir}/removed.png`, animations: "disabled" });
        }
      } finally {
        await context.close();
      }
    },
  );
});
