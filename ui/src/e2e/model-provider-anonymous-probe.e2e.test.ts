import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Anonymous custom endpoint shared probe",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("tests an anonymous custom endpoint without catalog models and renders the shared result", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        reducedMotion: "reduce",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 1000 },
      },
      async ({ page }) => {
        const config = {
          models: {
            providers: {
              "local-endpoint": {
                baseUrl: "http://127.0.0.1:11434/v1",
                api: "openai-completions",
                models: [],
              },
            },
          },
        };
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "models.probe"],
          models: [],
          methodResponses: {
            "config.get": {
              config,
              sourceConfig: config,
              hash: "anonymous-probe",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
            "models.authStatus": { ts: 1, providers: [], providerCapabilities: [] },
            "models.probe": {
              ts: 1,
              provider: "local-endpoint",
              status: "ok",
              results: [{ label: "Anonymous endpoint", status: "ok", latencyMs: 42 }],
            },
            "usage.status": { providers: [] },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`, {
          waitUntil: "networkidle",
        });
        await gateway.waitForRequest("models.authStatus");
        const row = page.locator("[data-provider-id=local-endpoint]");
        await row.waitFor();
        await row.scrollIntoViewIfNeeded();
        await expect.poll(() => row.getAttribute("class")).toContain("provider-row--quiet");
        if (process.env.OPENCLAW_UI_E2E_RECORD === "1") {
          await writeFile(
            path.join(suite.artifactDir, "anonymous-endpoint-row.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [row]),
          );
        }
        const probe = row.getByRole("button", { name: /^Test(?: |$)/ });
        await probe.click({ timeout: 1500 });
        const request = await gateway.waitForRequest("models.probe");
        expect(request.params).toMatchObject({ provider: "local-endpoint" });
        await expect
          .poll(() => row.locator(".model-providers__probe-summary").textContent())
          .toBe("Access verified");
        await expect.poll(() => row.textContent()).toContain("Anonymous endpoint");
        if (process.env.OPENCLAW_UI_E2E_RECORD === "1") {
          await writeFile(
            path.join(suite.artifactDir, "anonymous-endpoint-result.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [row]),
          );
        }
      },
    );
  });
});
