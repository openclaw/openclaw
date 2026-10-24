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
  it("hands first-run API keys to the selected setup method", async () => {
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
              ],
              workspace: "/tmp/openclaw-e2e",
              setupComplete: false,
            },
            "models.authStatus": {
              ts: 1,
              providers: [],
              providerCapabilities: [
                { provider: "anthropic", apiKeySupported: true, quickApiKeySetup: true },
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

  it.each([false, true])("keeps browser sign-in usable (popup blocked: %s)", async (blocked) => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page, context }) => {
        // Embedded browsers can refuse automatic windows; the explicit link must still work.
        if (blocked) {
          await page.addInitScript(() => {
            window.open = () => null;
          });
        }
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
        expect(await gateway.getRequests("models.authLogin")).toHaveLength(0);
        expect(await gateway.getRequests("models.authSetApiKey")).toHaveLength(0);
        const popupReady = blocked ? undefined : page.waitForEvent("popup");
        await page.getByRole("button", { name: "Example browser sign-in", exact: true }).click();
        const login = await gateway.waitForRequest("models.authLogin");
        const loginParams = login.params;
        expect(loginParams).toEqual({
          sessionId: expect.any(String),
          agentId: "main",
          authChoice: "example-browser",
        });
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
        const signInPage = popupReady
          ? await popupReady
          : (await Promise.all([context.waitForEvent("page"), openSignIn.click()]))[0];
        await expect.poll(() => signInPage.url()).toBe("https://provider.example/sign-in");
        expect(await signInPage.evaluate(() => window.opener)).toBeNull();
        expect(await dialog.textContent()).not.toContain("https://provider.example/sign-in");
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
});
