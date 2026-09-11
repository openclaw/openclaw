import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { pickerValue as modelPickerValue } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI model provider login mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";

async function captureProviderProof(fileName: string, content: Locator): Promise<void> {
  if (!recordVisuals) {
    return;
  }
  const page = content.page();
  await writeFile(
    path.join(suite.artifactDir, fileName),
    await takeControlUiViewportScreenshot(page, page.locator(".shell"), [content]),
  );
}

suite.define(() => {
  it("connects provider credentials without changing the selected model", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const now = Date.now();
        const config = { agents: { defaults: { model: "example/existing" } } };
        const providerCapabilities = [
          {
            provider: "example",
            apiKeySupported: false,
            quickApiKeySetup: false,
            loginOptions: [
              {
                id: "example-device",
                brandId: "example",
                label: "Example device sign-in",
                kind: "device-code",
                featured: true,
              },
            ],
          },
        ];
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "models.authLogin", "wizard.next"],
          models: [
            { id: "existing", name: "Existing model", provider: "example", available: true },
          ],
          methodResponses: {
            "config.get": {
              config,
              sourceConfig: config,
              hash: "models-login",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
            "models.authStatus": { ts: now, providers: [], providerCapabilities },
            "models.authLogin": { done: false, status: "running" },
            "wizard.next": {
              done: false,
              status: "running",
              step: {
                id: "device",
                type: "action",
                title: "Sign in to Example",
                message: "Enter this code on the sign-in page, then continue.",
                externalUrl: "https://example.invalid/device",
                deviceCode: { code: "TEST-1234" },
              },
            },
            "usage.status": { updatedAt: now, providers: [] },
            "sessions.usage": { aggregates: { byProvider: [] } },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        const primary = page.locator(".model-providers__defaults openclaw-select-picker").first();
        await expect.poll(() => modelPickerValue(primary)).toBe("example/existing");
        await captureProviderProof("login-models-before.png", primary);
        await page.locator("[data-models-connect]").click();
        const picker = page.locator("[data-models-login-choice]");
        await picker.waitFor();
        expect(await gateway.getRequests("models.authLogin")).toHaveLength(0);
        await captureProviderProof("login-before-choice.png", picker);
        await picker.selectOption("example-device");
        await page.locator("[data-models-login-start]").click();
        const login = await gateway.waitForRequest("models.authLogin");
        expect(login.params).toEqual({
          sessionId: expect.any(String),
          authChoice: "example-device",
          agentId: "main",
        });
        const dialog = page.locator("openclaw-modal-dialog");
        await dialog.getByText("TEST-1234", { exact: true }).waitFor();
        expect(
          await dialog.getByRole("link", { name: "Open sign-in page" }).getAttribute("href"),
        ).toBe("https://example.invalid/device");
        await captureProviderProof("login-device-code.png", dialog.getByText("TEST-1234"));
        const authReads = (await gateway.getRequests("models.authStatus")).length;
        await gateway.setMethodResponse("models.authStatus", {
          ts: now,
          providerCapabilities,
          providers: [
            {
              provider: "example",
              displayName: "Example",
              status: "ok",
              profiles: [
                {
                  profileId: "example:new",
                  email: "signed-in@example.invalid",
                  type: "oauth",
                  status: "ok",
                },
              ],
            },
          ],
        });
        await gateway.setMethodResponse("wizard.next", { done: true, status: "done" });
        await dialog.getByRole("button", { name: "Continue", exact: true }).click();
        const saved = page.getByRole("status").filter({ hasText: "Provider credentials saved." });
        await saved.waitFor();
        await page.getByText("signed-in@example.invalid", { exact: true }).waitFor();
        await expect
          .poll(async () => (await gateway.getRequests("models.authStatus")).length)
          .toBeGreaterThan(authReads);
        await expect.poll(() => modelPickerValue(primary)).toBe("example/existing");
        expect(new URL(page.url()).pathname).toBe("/settings/model-providers");
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        expect(await gateway.getRequests("openclaw.setup.activate.start")).toHaveLength(0);
        await captureProviderProof("login-after-saved.png", saved);
      },
    );
  });
});
