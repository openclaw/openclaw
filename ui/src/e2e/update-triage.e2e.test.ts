import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI update failure triage E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const FAILURE = {
  kind: "update",
  status: "error",
  ts: 1_700_000_000_000,
  stats: {
    handoffId: "update-triage-attempt",
    mode: "npm",
    reason: "global-install-failed",
    before: { version: "1.0.0" },
    after: { version: "1.0.0" },
    steps: [
      { name: "install", log: { exitCode: 1, stderrTail: "ENOSPC: no space left on device" } },
    ],
  },
};
const SCHEDULE = {
  channel: "stable",
  autoEnabled: true,
  install: { kind: "package" },
  target: { kind: "package", version: "2.0.0" },
} as const;
async function recordUpdateTraffic(page: Page): Promise<MockGatewayRequest[]> {
  const traffic: MockGatewayRequest[] = [];
  await page.exposeFunction("recordUpdateTraffic", (request: MockGatewayRequest) => {
    traffic.push(request);
  });
  await page.addInitScript(() => {
    // Mock request logs belong to one document; keep the proof across both
    // stale-chunk recovery and the explicit reload that tests non-replay.
    window.addEventListener("DOMContentLoaded", () => {
      const gatewayWindow = window as unknown as {
        openclawControlUiE2eGateway: { requests: MockGatewayRequest[] };
        recordUpdateTraffic: (request: MockGatewayRequest) => Promise<void>;
      };
      const requests = gatewayWindow.openclawControlUiE2eGateway.requests;
      const record = (request: MockGatewayRequest) => {
        if (request.method === "update.run" || request.method === "openclaw.chat") {
          void gatewayWindow.recordUpdateTraffic(request);
        }
      };
      requests.forEach(record);
      const append = requests.push.bind(requests);
      requests.push = (...added) => {
        added.forEach(record);
        return append(...added);
      };
    });
  });
  return traffic;
}

suite.define(() => {
  it("retains failure guidance without retrying when the requested triage module is missing", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      const traffic = await recordUpdateTraffic(page);
      await page.route(
        controlUiE2eBuiltModuleRequest("ui/src/app/update-triage.runtime.ts"),
        (route) => route.abort("failed"),
      );
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "openclaw.chat"],
        methodResponses: { "update.status": { sentinel: FAILURE, schedule: SCHEDULE } },
      });
      await page.goto(`${suite.server.baseUrl}settings/updates`);
      await gateway.waitForRequest("update.status");
      const diagnose = page.getByRole("button", { name: "Diagnose update", exact: true });
      await diagnose.waitFor();
      expect(await diagnose.isEnabled()).toBe(true);
      expect(traffic).toEqual([]);
      const replacementDocument = page.waitForEvent("domcontentloaded");
      await diagnose.click();
      await replacementDocument;
      await gateway.waitForRequest("update.status");
      const status = page.locator("#config-section-update .settings-status");
      await status.getByText("openclaw triage", { exact: false }).waitFor();
      expect(await status.textContent()).toContain("ENOSPC");
      expect(await page.locator(".custodian__alert-card").count()).toBe(0);
      expect(traffic).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
});
