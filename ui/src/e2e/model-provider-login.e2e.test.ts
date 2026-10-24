import assert from "node:assert/strict";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatModelPicker } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expandProvider } from "./model-providers.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI model provider login mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("loads provider styles and hands first-run API keys to the selected setup method", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        reducedMotion: "reduce",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "openclaw.setup.detect",
            "openclaw.setup.activate.start",
            "wizard.next",
          ],
          methodResponses: {
            "openclaw.setup.detect": {
              candidates: [],
              manualProviders: [
                {
                  id: "setup-token",
                  brandId: "anthropic",
                  groupLabel: "Anthropic",
                  label: "Anthropic setup-token",
                },
                {
                  id: "apiKey",
                  brandId: "anthropic",
                  groupLabel: "Anthropic",
                  label: "Anthropic API key",
                },
                {
                  id: "github-copilot",
                  brandId: "github-copilot",
                  groupLabel: "Copilot",
                  label: "GitHub Copilot",
                  hint: "Device login with your GitHub account",
                },
              ],
              workspace: "/tmp/openclaw-e2e",
              setupComplete: false,
            },
            "models.authStatus": {
              ts: 1,
              providers: [],
              providerCapabilities: [
                { provider: "anthropic", apiKeySupported: true, quickApiKeySetup: true },
                {
                  provider: "openai",
                  apiKeySupported: true,
                  quickApiKeySetup: true,
                  loginOptions: [
                    {
                      id: "openai-login",
                      brandId: "openai",
                      label: "Sign in with ChatGPT (Beta)",
                      kind: "oauth",
                      featured: true,
                    },
                  ],
                },
                {
                  provider: "github-copilot",
                  apiKeySupported: false,
                  quickApiKeySetup: false,
                  loginOptions: [
                    {
                      id: "github-copilot/github-copilot",
                      brandId: "github-copilot",
                      groupLabel: "Copilot",
                      label: "GitHub Copilot",
                      hint: "Device login with your GitHub account",
                      kind: "device-code",
                      featured: false,
                    },
                  ],
                },
              ],
            },
            "openclaw.setup.activate.start": { done: false, status: "running" },
            "wizard.next": { done: true, status: "cancelled" },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
        await page.locator(".model-setup__manual").waitFor();
        await page.locator("[data-models-connect]").click();
        const dialog = page.locator(".model-provider-login");
        await dialog.locator('[data-models-login-provider="openai"]').waitFor();
        expect((await dialog.locator(".model-setup-wizard__body > p").textContent())?.trim()).toBe(
          "Choose how to connect. Verifying an API key or token can also set this agent's active model.",
        );
        expect(
          await dialog.locator("ul").evaluate((element) => getComputedStyle(element).listStyleType),
        ).toBe("none");
        expect(await dialog.locator('[data-models-login-provider="anthropic"]').isVisible()).toBe(
          true,
        );
        expect(
          await dialog
            .locator('[data-models-login-provider="anthropic"] .provider-brand-icon')
            .evaluate((element) => element.getBoundingClientRect().width),
        ).toBeGreaterThan(0);
        await dialog.locator('[data-models-login-provider="github-copilot"]').click();
        const copilotMethods = dialog.locator("[data-models-login-choice] button");
        expect(await copilotMethods.locator("strong").allTextContents()).toEqual([
          "GitHub Copilot",
          "GitHub Copilot API key or token",
        ]);
        expect(await copilotMethods.nth(1).textContent()).toContain("Paste an API key or token");
        await dialog.locator("[data-models-login-back]").click();
        await dialog.locator('[data-models-login-provider="anthropic"]').click();
        expect(
          await dialog
            .getByRole("button", { name: "Anthropic setup-token", exact: true })
            .isVisible(),
        ).toBe(true);
        await dialog.getByRole("button", { name: "Anthropic API key", exact: true }).click();
        const keyInput = page.locator('.model-setup__manual input[type="password"]');
        await expect
          .poll(() => keyInput.evaluate((element) => document.activeElement === element))
          .toBe(true);
        expect(await page.locator(".model-setup-provider-select__trigger").textContent()).toContain(
          "Anthropic API key",
        );
        expect(await gateway.getRequests("openclaw.setup.activate.start")).toHaveLength(0);

        await keyInput.fill("synthetic-anthropic-api-key");
        await page.locator(".model-setup__manual button.primary").click();
        const activation = await gateway.waitForRequest("openclaw.setup.activate.start");
        expect(activation.params).toEqual({
          sessionId: expect.any(String),
          agentId: "main",
          kind: "api-key",
          authChoice: "apiKey",
          apiKey: "synthetic-anthropic-api-key",
        });
        expect(await gateway.getRequests("models.authLogin")).toHaveLength(0);
        expect(await gateway.getRequests("models.authSetApiKey")).toHaveLength(0);
      },
    );
  });
  it.each(["chat", "new"])(
    "opens existing provider settings from %s without starting a connection",
    async (origin) => {
      await suite.withPage(
        {
          locale: "en-US",
          reducedMotion: "reduce",
          serviceWorkers: "block",
          viewport: { width: 1280, height: 900 },
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            assistantAgentId: "main",
            defaultAgentId: "main",
            sessionKey: "agent:writer:main",
            models: [
              { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
              {
                id: "claude-sonnet-4-6",
                name: "Claude Sonnet 4.6",
                provider: "anthropic",
                available: true,
              },
            ],
            methodResponses: {
              "agents.list": {
                defaultId: "main",
                mainKey: "main",
                scope: "per-sender",
                agents: [
                  { id: "main", name: "Main" },
                  { id: "writer", name: "Writer" },
                ],
              },
              "models.authStatus": {
                ts: 1,
                providers: [
                  {
                    provider: "openai",
                    displayName: "OpenAI",
                    status: "ok",
                    profiles: [
                      {
                        profileId: "openai:saved",
                        type: "oauth",
                        status: "ok",
                        source: "saved",
                        email: "alex@example.invalid",
                        displayName: "Sign in with ChatGPT",
                      },
                    ],
                  },
                  { provider: "anthropic", status: "ok", profiles: [] },
                ],
                providerCapabilities: [
                  { provider: "openai", apiKeySupported: true, quickApiKeySetup: true },
                  { provider: "anthropic", apiKeySupported: true, quickApiKeySetup: true },
                ],
              },
            },
          });
          const query = origin === "chat" ? "session=agent:writer:main" : "agent=writer";
          await page.goto(`${suite.server.baseUrl}${origin}?${query}`);
          await openChatModelPicker(page);
          await page
            .locator('[data-chat-model-provider="openai"] [data-chat-model-provider-settings]')
            .click();
          await page.waitForURL("**/settings/model-providers*");
          const search = new URL(page.url()).searchParams;
          expect(search.get("provider")).toBe("openai");
          expect(search.has("connect")).toBe(false);
          await gateway.waitForRequest("models.authStatus", { match: { agentId: "writer" } });
          const card = await expandProvider(page, "openai");
          await card.getByText("alex@example.invalid", { exact: true }).waitFor();
          expect(await page.locator('[data-provider-id="anthropic"]').count()).toBe(0);
          expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);

          await page.locator("[data-models-connect]").click();
          const dialog = page.locator("openclaw-modal-dialog");
          await dialog.getByRole("heading", { name: "Connect a provider", exact: true }).waitFor();
          await dialog.locator('[data-models-login-provider="openai"]').waitFor();
          expect(await gateway.getRequests("models.authLogin")).toHaveLength(0);
        },
      );
    },
  );

  it("keeps browser sign-in available while an OAuth callback is pending", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
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
        expect(
          (
            await page.locator(".model-provider-login .model-setup-wizard__body > p").textContent()
          )?.trim(),
        ).toBe("Save credentials for this agent. Choose the active model separately.");
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

        const openSignIn = dialog.getByRole("link", { name: "Reopen browser tab", exact: true });
        await openSignIn.waitFor();
        expect(await openSignIn.getAttribute("href")).toBe("https://provider.example/sign-in");
        expect(
          await dialog.getByRole("button", { name: "Copy sign-in link", exact: true }).isEnabled(),
        ).toBe(true);
        expect(
          await dialog.getByRole("button", { name: "Cancel sign-in", exact: true }).isEnabled(),
        ).toBe(true);
        await dialog.getByRole("status").filter({ hasText: "Waiting for" }).waitFor();
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

        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        await page.locator('[data-provider-id="example"]').waitFor();
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
                      hint: "Use a browser code when OpenClaw runs on a remote VM",
                      kind: "device-code",
                      featured: true,
                      docsUrl: "https://docs.openclaw.ai/providers/openai/authentication",
                    },
                    {
                      id: "openai",
                      brandId: "openai",
                      label: "Codex login (browser)",
                      hint: "Sign in to Codex locally with your ChatGPT account",
                      kind: "oauth",
                      featured: false,
                    },
                    {
                      id: "openai-token-sharing",
                      brandId: "openai",
                      label: "Sign in with ChatGPT (Beta)",
                      hint: "Authorize OpenClaw for eligible Responses models using your Codex allowance",
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
        expect(await dialog.locator("[data-models-login-choice] strong").allTextContents()).toEqual(
          ["Codex login (device code)", "Codex login (browser)", "Sign in with ChatGPT (Beta)"],
        );
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

        await gateway.deferNext("wizard.next", { answer: { stepId: "instructions" } });
        const popupReady = page.waitForEvent("popup");
        await connectionMethod("Sign in with ChatGPT (Beta)").click();
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
        await page.getByRole("link", { name: "Reopen browser tab", exact: true }).waitFor();
        await expect.poll(() => popup.url()).toBe(signInUrl);
        expect(await popup.evaluate(() => window.opener)).toBeNull();
        await page.getByRole("button", { name: "Copy sign-in link", exact: true }).waitFor();
        expect(await dialog.textContent()).not.toContain(signInUrl);

        await gateway.resolveDeferred("wizard.next");
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await expect.poll(() => page.locator("openclaw-modal-dialog").count()).toBe(0);
        await popup.close();
      },
    );
  });
});
