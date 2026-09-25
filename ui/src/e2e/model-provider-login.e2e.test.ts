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
  it("keeps browser sign-in available while an OAuth callback is pending", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
        ...(recordVisuals
          ? { recordVideo: { dir: suite.artifactDir, size: { height: 1000, width: 1440 } } }
          : {}),
      },
      async ({ page, context }) => {
        // Embedded browsers can refuse automatic windows; the explicit link must still work.
        await page.addInitScript(() => {
          window.open = () => null;
        });
        await context.route("https://provider.example/sign-in", (route) =>
          route.fulfill({ contentType: "text/html", body: "<h1>Example sign-in</h1>" }),
        );
        const providerCapabilities = [
          {
            provider: "example",
            apiKeySupported: false,
            quickApiKeySetup: false,
            loginOptions: [
              {
                id: "example-browser",
                brandId: "example",
                label: "Example browser sign-in",
                kind: "oauth",
                featured: true,
              },
            ],
          },
        ];
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "models.authLogin", "wizard.next"],
          heldMethods: ["wizard.next"],
          methodResponses: {
            "models.authStatus": { ts: 1, providers: [], providerCapabilities },
            "models.authLogin": { done: false, status: "running" },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await page.locator("[data-models-connect]").click();
        await page.locator('[data-models-login-provider="example"]').click();
        await page.getByRole("button", { name: "Example browser sign-in", exact: true }).click();
        const login = await gateway.waitForRequest("models.authLogin");
        const loginParams = login.params;
        assert(loginParams && typeof loginParams === "object" && "sessionId" in loginParams);
        await gateway.waitForRequest("wizard.next");
        await gateway.deferNext("wizard.next", { answer: { stepId: "browser-note" } });
        await gateway.resolveDeferred("wizard.next", {
          done: false,
          status: "running",
          step: {
            id: "browser-note",
            type: "note",
            executor: "client",
            title: "Sign in to Example",
            message: "Finish signing in in your browser.",
            externalUrl: "https://provider.example/sign-in",
          },
        });
        await expect.poll(async () => (await gateway.getRequests("wizard.next")).length).toBe(2);
        expect((await gateway.getRequests("wizard.next")).at(-1)?.params).toEqual({
          sessionId: loginParams.sessionId,
          answer: { stepId: "browser-note" },
        });
        const dialog = page.locator("openclaw-modal-dialog");
        await captureProviderProof("login-browser-callback-pending.png", dialog);
        const openSignIn = dialog.getByRole("link", { name: "Open sign-in", exact: true });
        await openSignIn.waitFor();
        expect(await openSignIn.getAttribute("href")).toBe("https://provider.example/sign-in");
        expect(
          await dialog.getByRole("button", { name: "Copy link", exact: true }).isEnabled(),
        ).toBe(true);
        expect(await dialog.getByRole("button", { name: "Cancel", exact: true }).isEnabled()).toBe(
          true,
        );
        await dialog.getByRole("status").filter({ hasText: "Waiting for sign-in" }).waitFor();
        expect(await dialog.getByRole("button", { name: "Continue", exact: true }).count()).toBe(0);
        expect(await dialog.locator('input[name="wizard-text"]').count()).toBe(0);
        const [signInPage] = await Promise.all([context.waitForEvent("page"), openSignIn.click()]);
        await signInPage.getByRole("heading", { name: "Example sign-in" }).waitFor();
        await signInPage.close();
        expect(await gateway.getRequests("models.authLogin")).toHaveLength(1);
        expect(await gateway.getRequests("wizard.next")).toHaveLength(2);
        await gateway.setMethodResponse("models.authStatus", {
          ts: 2,
          providerCapabilities,
          providers: [
            {
              provider: "example",
              displayName: "Example",
              status: "ok",
              profiles: [{ profileId: "example:new", type: "oauth", status: "ok" }],
            },
          ],
        });
        await gateway.resolveDeferred("wizard.next", { done: true, status: "done" });
        const saved = page.getByRole("status").filter({ hasText: "Provider credentials saved." });
        await saved.waitFor();
        await dialog.waitFor({ state: "detached" });
        await page.locator('[data-provider-id="example"]').waitFor();
        await captureProviderProof("login-browser-callback-completed.png", saved);
      },
    );
  });
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
  it("shows a provider's accounts and every connection method before browser sign-in", async () => {
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
            "models.authSetApiKey",
            "models.authLogin",
            "wizard.next",
            "wizard.cancel",
          ],
          methodResponses: {
            "models.authStatus": {
              ts: 1,
              providers: [
                {
                  provider: "openai",
                  displayName: "OpenAI",
                  status: "ok",
                  profiles: [
                    {
                      profileId: "openai:codex",
                      type: "oauth",
                      status: "ok",
                      source: "external",
                      email: "alex@example.invalid",
                      displayName: "Codex CLI",
                    },
                    {
                      profileId: "openai:siwc",
                      type: "oauth",
                      status: "expiring",
                      source: "saved",
                      email: "alex@example.invalid",
                      displayName: "Sign in with ChatGPT",
                    },
                  ],
                },
              ],
              providerCapabilities: [
                {
                  provider: "openai",
                  apiKeySupported: true,
                  quickApiKeySetup: true,
                  loginOptions: [
                    {
                      id: "openai-device-code",
                      brandId: "openai",
                      groupLabel: "OpenAI",
                      label: "Codex login (device code)",
                      hint: "Approve Codex access using a code in your browser",
                      kind: "device-code",
                      featured: true,
                      docsUrl: "https://docs.openclaw.ai/providers/openai/authentication",
                    },
                    {
                      id: "openai",
                      brandId: "openai",
                      label: "Codex login (browser)",
                      hint: "Sign in to Codex with your ChatGPT account",
                      kind: "oauth",
                      featured: false,
                    },
                    {
                      id: "openai-token-sharing",
                      brandId: "openai",
                      label: "Sign in with ChatGPT",
                      hint: "Use your ChatGPT allowance through the Responses API",
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
        await page.locator('[data-models-login-provider="openai"]').click();
        const dialog = page.locator(".model-setup-wizard");
        await dialog.getByText("Accounts available to this agent", { exact: true }).waitFor();
        const profiles = dialog.locator("[data-profile-id]");
        expect(await profiles.count()).toBe(2);
        expect(await profiles.first().textContent()).toContain("alex@example.invalid");
        expect(await profiles.first().textContent()).toContain("Codex CLI");
        expect(await profiles.last().textContent()).toContain("alex@example.invalid");
        expect(await profiles.last().textContent()).toContain("Expiring");
        const connectionMethod = (label: string) =>
          dialog.getByRole("button").filter({
            has: page.locator("strong").filter({ hasText: label }),
          });
        for (const method of [
          "Codex login (device code)",
          "Codex login (browser)",
          "Sign in with ChatGPT",
        ]) {
          await connectionMethod(method).waitFor();
        }
        expect(await dialog.locator("[data-models-login-api-key]").isVisible()).toBe(true);
        expect(await dialog.locator("select, openclaw-select-picker").count()).toBe(0);
        await dialog
          .locator('a[href="https://docs.openclaw.ai/providers/openai/authentication"]')
          .waitFor();
        expect(await gateway.getRequests("models.authLogin")).toHaveLength(0);
        expect(await gateway.getRequests("models.authSetApiKey")).toHaveLength(0);
        const footerFits = () =>
          dialog.evaluate((element) => {
            const footer = element.querySelector(".model-setup-wizard__footer")!;
            return footer.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom;
          });
        expect(await footerFits()).toBe(true);
        await captureProviderProof("login-provider-accounts-and-methods.png", dialog);
        if (recordVisuals) {
          await page.setViewportSize({ width: 390, height: 844 });
          expect(await footerFits()).toBe(true);
          await captureProviderProof("login-provider-accounts-and-methods-narrow.png", dialog);
          await page.setViewportSize({ width: 1280, height: 900 });
        }
        await gateway.deferNext("wizard.next", { answer: { stepId: "instructions" } });
        const popupReady = page.waitForEvent("popup");
        await connectionMethod("Sign in with ChatGPT").click();
        const login = await gateway.waitForRequest("models.authLogin");
        expect(login.params).toEqual({
          sessionId: expect.any(String),
          agentId: "main",
          authChoice: "openai-token-sharing",
        });
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
