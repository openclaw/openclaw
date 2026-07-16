// Control UI tests cover Quick Settings Automations inventory via mocked Gateway.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "quick-automation-counts",
);

function emptyConfigResponse() {
  const config = {};
  return {
    config,
    hash: "hash-automation-1",
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

describeControlUiE2e("Control UI Quick Automations inventory mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("loads real Cron and Skills counts once on Simple settings entry", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: uiProofArtifactDir, size: { width: 1280, height: 900 } }
        : undefined,
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "config.get",
        "cron.list",
        "skills.status",
        "system.info",
      ],
      methodResponses: {
        "config.get": emptyConfigResponse(),
        "cron.list": {
          jobs: [{ id: "job-a" }, { id: "job-b" }, { id: "job-c" }],
          total: 3,
        },
        "skills.status": {
          skills: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }, { name: "e" }],
        },
        "system.info": {
          platform: "e2e",
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}config`);
      expect(response?.status()).toBe(200);

      const automations = page.locator("#settings-general-automations");
      await automations.waitFor();
      await expect
        .poll(async () => automations.getByText("3 scheduled tasks", { exact: true }).count())
        .toBe(1);
      await expect
        .poll(async () => automations.getByText("5 skills installed", { exact: true }).count())
        .toBe(1);

      await gateway.waitForRequest("cron.list");
      await gateway.waitForRequest("skills.status");
      const entryCronCalls = await gateway.getRequests("cron.list");
      const entrySkillCalls = await gateway.getRequests("skills.status");
      expect(entryCronCalls.length).toBe(1);
      expect(entrySkillCalls.length).toBe(1);

      // Cron change event refreshes only the cron total; Skills stays snapshot.
      await gateway.setMethodResponse("cron.list", {
        jobs: [{ id: "job-a" }, { id: "job-b" }, { id: "job-c" }, { id: "job-d" }],
        total: 4,
      });
      await gateway.emitGatewayEvent("cron", { reason: "job-changed" });
      await expect
        .poll(async () => automations.getByText("4 scheduled tasks", { exact: true }).count())
        .toBe(1);
      await expect
        .poll(async () => automations.getByText("5 skills installed", { exact: true }).count())
        .toBe(1);

      const afterCronEventSkillCalls = await gateway.getRequests("skills.status");
      const afterCronEventCronCalls = await gateway.getRequests("cron.list");
      expect(afterCronEventSkillCalls.length).toBe(1);
      expect(afterCronEventCronCalls.length).toBeGreaterThan(1);

      if (captureUiProofEnabled) {
        await mkdir(uiProofArtifactDir, { recursive: true });
        await automations.screenshot({
          animations: "disabled",
          path: path.join(uiProofArtifactDir, "01-automations-nonzero-counts.png"),
        });
        await page.screenshot({
          animations: "disabled",
          path: path.join(uiProofArtifactDir, "02-simple-settings-full.png"),
          fullPage: true,
        });
      }
    } finally {
      await context.close();
    }
  });

  it("renders Unavailable when the Gateway omits inventory methods", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "config.get"],
      methodResponses: {
        "config.get": emptyConfigResponse(),
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}config`);
      expect(response?.status()).toBe(200);
      const automations = page.locator("#settings-general-automations");
      await automations.waitFor();
      await expect
        .poll(async () => automations.getByText("Unavailable", { exact: true }).count())
        .toBeGreaterThanOrEqual(2);
    } finally {
      await context.close();
    }
  });
});
