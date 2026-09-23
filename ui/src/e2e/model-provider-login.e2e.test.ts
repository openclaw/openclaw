import assert from "node:assert/strict";
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
  it.each([
    { value: "all", label: "Show all Example models" },
    { value: "keep", label: "Keep current restrictions" },
  ])("keeps the default after $value model access", async (modelAccess) => {
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
        await captureProviderProof(`login-models-before-${modelAccess.value}.png`, primary);
        await page.locator("[data-models-connect]").click();
        expect(await gateway.getRequests("models.authLogin")).toHaveLength(0);
        await page.locator('[data-models-login-provider="example"]').click();
        const signIn = page.getByRole("button", { name: "Example device sign-in", exact: true });
        await signIn.waitFor();
        expect(await gateway.getRequests("models.authLogin")).toHaveLength(0);
        await captureProviderProof(`login-before-choice-${modelAccess.value}.png`, signIn);
        await signIn.click();
        const login = await gateway.waitForRequest("models.authLogin");
        const loginParams = login.params;
        assert(loginParams && typeof loginParams === "object" && "sessionId" in loginParams);
        expect(loginParams).toEqual({
          sessionId: expect.any(String),
          authChoice: "example-device",
          agentId: "main",
        });
        const dialog = page.locator("openclaw-modal-dialog");
        await dialog.getByText("TEST-1234", { exact: true }).waitFor();
        expect(
          await dialog
            .getByRole("link", { name: "Open sign-in", exact: true })
            .getAttribute("href"),
        ).toBe("https://example.invalid/device");
        await captureProviderProof(
          `login-device-code-${modelAccess.value}.png`,
          dialog.getByText("TEST-1234"),
        );
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
        await gateway.setMethodResponse("wizard.next", {
          done: false,
          status: "running",
          step: {
            id: "model-access",
            type: "select",
            message: "Credentials saved. Your current model restrictions may hide Example models.",
            initialValue: "keep",
            options: [
              { value: "all", label: "Show all Example models" },
              { value: "keep", label: "Keep current restrictions" },
            ],
          },
        });
        await dialog.getByRole("button", { name: "Continue", exact: true }).click();
        const keep = dialog.getByRole("button", { name: "Keep current restrictions", exact: true });
        await keep.waitFor();
        expect(await keep.isEnabled()).toBe(true);
        expect((await gateway.getRequests("wizard.next")).at(-1)?.params).toEqual({
          sessionId: loginParams.sessionId,
          answer: { stepId: "device" },
        });
        await captureProviderProof(`login-model-access-${modelAccess.value}.png`, dialog);
        await gateway.setMethodResponse("wizard.next", { done: true, status: "done" });
        await dialog.getByRole("button", { name: modelAccess.label, exact: true }).click();
        await expect
          .poll(async () => {
            const requests = await gateway.getRequests("wizard.next");
            return requests.at(-1)?.params;
          })
          .toEqual({
            sessionId: loginParams.sessionId,
            answer: { stepId: "model-access", value: modelAccess.value },
          });
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
        await captureProviderProof(`login-after-saved-${modelAccess.value}.png`, saved);
      },
    );
  });
  it("starts browser sign-in from two direct choices and opens a detached tab", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        reducedMotion: "reduce",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
      },
      async ({ page, context }) => {
        const signInUrl = "https://provider.example/sign-in";
        await context.route("https://provider.example/**", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<title>Provider sign-in</title>Provider sign-in",
          }),
        );
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "config.get",
            "config.patch",
            "models.authStatus",
            "models.authLogin",
            "wizard.next",
            "wizard.cancel",
          ],
          methodResponses: {
            "models.authStatus": {
              ts: 1,
              providers: [],
              providerCapabilities: [
                {
                  provider: "example",
                  apiKeySupported: false,
                  quickApiKeySetup: false,
                  loginOptions: [
                    {
                      id: "example-device",
                      brandId: "example",
                      label: "Device pairing",
                      kind: "device-code",
                      featured: true,
                    },
                    {
                      id: "example-browser",
                      brandId: "example",
                      label: "Browser sign-in",
                      kind: "oauth",
                      featured: false,
                    },
                  ],
                },
              ],
            },
            "models.authLogin": { done: false, status: "running" },
            "wizard.next": {
              sequence: [
                {
                  done: false,
                  status: "running",
                  step: {
                    id: "instructions",
                    type: "note",
                    executor: "client",
                    message: "Remote environment",
                    externalUrl: signInUrl,
                  },
                },
                {
                  done: false,
                  status: "running",
                  step: {
                    id: "browser",
                    type: "progress",
                    executor: "gateway",
                    externalUrl: signInUrl,
                    message: "Complete sign-in",
                  },
                },
                { done: true, status: "done" },
              ],
            },
          },
        });
        await page.goto(suite.server.baseUrl + "settings/model-providers");
        await page.locator("[data-models-connect]").click();
        await page.locator('[data-models-login-provider="example"]').click();
        const dialog = page.locator(".model-setup-wizard");
        await page.getByRole("button", { name: "Device pairing", exact: true }).waitFor();
        expect(await dialog.locator("select").count()).toBe(0);
        await captureProviderProof("login-browser-choices.png", dialog);
        await gateway.deferNext("wizard.next", { answer: { stepId: "instructions" } });
        const popupReady = page.waitForEvent("popup");
        await page.getByRole("button", { name: "Browser sign-in", exact: true }).click();
        const popup = await popupReady;
        await gateway.waitForRequest("wizard.next", {
          match: { answer: { stepId: "instructions" } },
        });
        await gateway.deferNext("wizard.next");
        await gateway.resolveDeferred("wizard.next");
        await page.getByRole("link", { name: "Open sign-in", exact: true }).waitFor();
        await expect.poll(() => popup.url()).toBe(signInUrl);
        expect(await popup.evaluate(() => window.opener)).toBeNull();
        await page.getByRole("button", { name: "Copy link", exact: true }).waitFor();
        expect(await dialog.textContent()).not.toContain(signInUrl);
        await captureProviderProof("login-browser-waiting.png", dialog);
        await gateway.resolveDeferred("wizard.next");
        await expect.poll(() => page.locator("openclaw-modal-dialog").count()).toBe(0);
        await popup.close();
      },
    );
  });
});
