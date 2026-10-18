// Control UI tests cover guided model setup against a mocked Gateway.
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  activated,
  button,
  candidate,
  configSnapshot,
  expectCount,
  expectFocused,
  expectText,
  localPrepareOptions,
  localSetupFeatures,
  makeDetection,
  runningStep,
  runningWizard,
  setupContext,
  setupRpc as rpc,
  pollRequestCount,
} from "./model-setup-fixtures.test-support.ts";
import { installSetupGateway, openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Model Setup mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const prepareOptions = localPrepareOptions();

suite.define(() => {
  it("refreshes detected authentication without retaining an account email for API-key access", async () => {
    await suite.withPage(
      setupContext({ viewport: { height: 900, width: 1280 } }),
      async ({ page }) => {
        const detectedCandidate = {
          kind: "codex-cli" as const,
          label: "Codex",
          modelRef: "openai/gpt-5.6-luna",
          recommended: false,
          credentials: true,
          brandId: "openai",
        };
        const gateway = await installSetupGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", rpc.detect],
          methodResponses: {
            [rpc.detect]: {
              sequence: [
                "logged in · ChatGPT account · alex@example.com",
                "logged in · API key (usage-billed)",
              ].map((detail) => makeDetection({ candidates: [{ ...detectedCandidate, detail }] })),
            },
          },
        });

        await openModelSetup(page, suite.server.baseUrl);
        const row = page.locator('[data-candidate-kind="codex-cli"]');
        await expectText(row, "ChatGPT account · alex@example.com");

        const detectionCount = (await gateway.getRequests(rpc.detect)).length;
        await page.getByRole("button", { name: "Check again" }).click();
        await pollRequestCount(gateway, rpc.detect).toBe(detectionCount + 1);
        await expectText(row, "API key (usage-billed)");
        expect(await row.textContent()).not.toContain("alex@example.com");
      },
    );
  });

  it("hands first-run model setup to the custodian in onboarding chrome", async () => {
    await suite.withPage(
      setupContext({ viewport: { height: 900, width: 1280 } }),
      async ({ page }) => {
        const gateway = await installSetupGateway(page, {
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            rpc.detect,
            rpc.activate,
            rpc.next,
            "openclaw.chat",
          ],
          methodResponses: {
            [rpc.detect]: makeDetection({
              candidates: [
                candidate("openai-api-key", "OpenAI API key", "openai/gpt-5", {
                  brandId: "openai",
                  detail: "Saved credentials are available",
                }),
              ],
              manualProviders: [{ id: "openai", label: "OpenAI" }],
            }),
            [rpc.activate]: runningWizard("activation-session"),
            [rpc.next]: activated("openai/gpt-5"),
            "openclaw.chat": {
              sessionId: "e2e-custodian",
              reply: "## Hi, I'm OpenClaw",
              action: "none",
              question: {
                id: "onboarding-next-step",
                header: "Next step",
                question: "What would you like to do first?",
                options: [
                  { label: "Talk to my agent", reply: "talk to agent", recommended: true },
                  { label: "Connect WhatsApp", reply: "connect whatsapp" },
                ],
                isOther: true,
                skipAction: "exit",
              },
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
        expect(response?.status()).toBe(200);

        const detect = await gateway.waitForRequest(rpc.detect);
        expect(detect.params).toEqual({ agentId: "main" });
        await page.locator('[data-candidate-kind="openai-api-key"] button').waitFor();
        expect(await gateway.getRequests(rpc.activate)).toHaveLength(0);
        await page.locator('[data-candidate-kind="openai-api-key"] button').click();
        const activate = await gateway.waitForRequest(rpc.activate);
        expect(activate.params).toEqual({
          sessionId: expect.any(String),
          kind: "openai-api-key",
          agentId: "main",
          modelRef: "openai/gpt-5",
        });

        await expect.poll(() => new URL(page.url()).pathname).toBe("/custodian");
        expect(new URL(page.url()).searchParams.get("onboarding")).toBe("1");
        // Onboarding chrome keeps only the header actions; no identity heading.
        await page.locator(".custodian__header--minimal").waitFor();
        await page.getByRole("button", { name: "Exit setup" }).waitFor();
        await expect
          .poll(() => page.locator(".shell").getAttribute("class"))
          .toContain("shell--onboarding");
        expect(await page.locator(".shell-nav").isVisible()).toBe(false);

        const chatRequest = await gateway.waitForRequest("openclaw.chat");
        expect(chatRequest.params).toMatchObject({
          sessionId: expect.stringMatching(/^control-ui-onboarding-/u),
          welcomeVariant: "onboarding",
        });
        await page.getByRole("button", { name: "Skip for now" }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/chat/main");
        await expect
          .poll(() => page.locator(".shell").getAttribute("class"))
          .not.toContain("shell--onboarding");
        const userTurns = (await gateway.getRequests("openclaw.chat")).filter((request) => {
          const params = request.params;
          return typeof params === "object" && params !== null && "message" in params;
        });
        expect(userTurns).toHaveLength(0);
      },
    );
  });

  it("completes device-code sign-in from its verified activation result", async () => {
    await suite.withPage(
      setupContext({ reducedMotion: "reduce", viewport: { height: 900, width: 1280 } }),
      async ({ page }) => {
        const signInUrl = `https://example.com/device?${new URLSearchParams({
          client_id: "device-code-client",
          redirect_uri: "http://localhost:1455/auth/callback",
          response_type: "code",
          scope: "openid profile email offline_access",
          state: "state-1".repeat(16),
        })}`;
        const initialDetection = makeDetection({
          authOptions: [
            {
              id: "provider-device-code",
              label: "Provider account",
              kind: "device-code",
              featured: true,
            },
          ],
        });
        const gateway = await installSetupGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", rpc.detect, rpc.auth, rpc.next],
          methodResponses: {
            "config.get": configSnapshot({}, "config-hash-1"),
            [rpc.detect]: initialDetection,
            [rpc.auth]: runningWizard("device-code-session"),
            [rpc.next]: {
              sequence: [
                runningStep("scope", "note", "Scope: System / agent", { executor: "client" }),
                runningStep(
                  "device-code",
                  "progress",
                  `Open this URL in your local browser:\n\n${signInUrl}`,
                  {
                    executor: "gateway",
                    title: "Authorize device",
                    externalUrl: signInUrl,
                    deviceCode: {
                      code: "ABCD-1234",
                      expiresInMinutes: 14,
                      message: "Enter this one-time code on the sign-in page.",
                    },
                  },
                ),
                activated("provider/verified-model"),
              ],
            },
          },
        });

        const response = await openModelSetup(page, suite.server.baseUrl);
        expect(response?.status()).toBe(200);
        await gateway.deferNext(rpc.next, { answer: { stepId: "scope" } });
        await button(
          page.locator('[data-auth-choice="provider-device-code"]'),
          "Set up & verify",
        ).click();
        const start = await gateway.waitForRequest(rpc.auth);
        expect(start.params).toMatchObject({ authChoice: "provider-device-code" });
        await gateway.waitForRequest(rpc.next, { match: { answer: { stepId: "scope" } } });
        await gateway.deferNext(rpc.next);
        await gateway.resolveDeferred(rpc.next);
        await page.getByText("ABCD-1234", { exact: true }).waitFor();
        await button(page, "Copy code").waitFor();
        expect(await button(page, "Continue").count()).toBe(0);
        expect(await page.locator(".model-setup-wizard__body").textContent()).not.toContain(
          signInUrl,
        );
        expect(await page.locator(".model-setup-wizard__body").textContent()).not.toContain(
          "Scope:",
        );

        await page.emulateMedia({ colorScheme: "dark" });
        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");

        const signInLink = page.getByRole("link", { name: "Open sign-in" });
        await expect.poll(() => signInLink.getAttribute("href")).toBe(signInUrl);
        const wizardBody = page.locator(".model-setup-wizard__body");
        await expect
          .poll(() => wizardBody.evaluate((element) => element.scrollWidth <= element.clientWidth))
          .toBe(true);
        await page.setViewportSize({ height: 844, width: 390 });
        await expect
          .poll(() => wizardBody.evaluate((element) => element.scrollWidth <= element.clientWidth))
          .toBe(true);
        await page.getByRole("button", { name: "Cancel" }).waitFor();

        const detectCountBeforeCompletion = (await gateway.getRequests(rpc.detect)).length;
        await gateway.resolveDeferred(rpc.next);
        await page.getByRole("heading", { name: "Connection verified" }).waitFor();
        expect(await gateway.getRequests(rpc.detect)).toHaveLength(detectCountBeforeCompletion);
        await expectText(page.locator(".model-setup-success"), "provider/verified-model");
      },
    );
  });

  it("recovers Ollama setup in place after the local server starts", async () => {
    await suite.withPage(
      setupContext({ colorScheme: "dark", viewport: { height: 900, width: 1280 } }),
      async ({ page }) => {
        const initialDetection = makeDetection({
          prepareOptions,
          recommendedInstalls: [
            {
              id: "ollama",
              brandId: "ollama",
              label: "Ollama",
              hint: "Run open models locally",
              website: "https://ollama.com/download",
              icon: "https://cdn.simpleicons.org/ollama",
            },
          ],
        });
        const gateway = await installSetupGateway(page, {
          featureMethods: localSetupFeatures,
          methodResponses: {
            [rpc.detect]: initialDetection,
            [rpc.prepare]: runningWizard("ollama-prepare-session"),
            [rpc.activate]: runningWizard("activation-session"),
            [rpc.next]: {
              sequence: [
                runningStep("ollama-mode", "select", "Ollama mode", {
                  options: [
                    {
                      value: "cloud-local",
                      label: "Cloud + Local",
                      hint: "Route cloud and local models through your Ollama host",
                    },
                    { value: "cloud-only", label: "Cloud only", hint: "Hosted Ollama models" },
                    { value: "local-only", label: "Local only", hint: "Local models only" },
                  ],
                }),
                runningStep("ollama-base-url", "text", "Ollama base URL", {
                  initialValue: "http://127.0.0.1:11434",
                }),
                runningStep(
                  "ollama-retry",
                  "note",
                  [
                    "Ollama could not be reached at http://127.0.0.1:11434.",
                    "Start or restart the Ollama server for this address.",
                    "If Ollama is not installed on that machine, download it at https://ollama.com/download",
                    "",
                    "Continue when it is running. OpenClaw will retry this address.",
                  ].join("\n"),
                  { title: "Ollama" },
                ),
                runningStep("ollama-retry-confirm", "confirm", "Retry this Ollama address now?", {
                  initialValue: true,
                }),
                { done: true, status: "done", preparedModelRef: "ollama/qwen3:0.6b" },
                activated("ollama/qwen3:0.6b"),
              ],
            },
          },
        });

        const response = await openModelSetup(page, suite.server.baseUrl);
        expect(response?.status()).toBe(200);
        const localProviderIcons = page.locator(
          [
            '[data-prepare-choice="ollama"] [data-provider-icon="ollama"]',
            '[data-prepare-choice="llama-cpp"] [data-provider-icon="llamacpp"]',
            '[data-prepare-choice="lmstudio"] [data-provider-icon="lmstudio"]',
          ].join(","),
        );
        await expectCount(localProviderIcons, 3);
        const localProviderIconColors = await localProviderIcons.evaluateAll((icons) =>
          icons.map((icon) => getComputedStyle(icon).color),
        );
        expect(localProviderIconColors).toHaveLength(3);
        expect(new Set(localProviderIconColors).size).toBe(1);
        await page
          .locator('[data-prepare-choice="ollama"]')
          .getByRole("button", { name: "Choose connection" })
          .click();

        const start = await gateway.waitForRequest(rpc.prepare);
        expect(start.params).toMatchObject({ authChoice: "ollama" });

        await button(page, "Ollama mode").click();
        await page.getByRole("option", { name: /Local only/u }).click();
        const baseUrl = page.getByLabel("Ollama base URL");
        await expect.poll(() => baseUrl.inputValue()).toBe("http://127.0.0.1:11434");

        await page.getByRole("button", { name: "Submit" }).click();
        await page.getByText("Ollama could not be reached at http://127.0.0.1:11434.").waitFor();
        await page
          .getByText("Continue when it is running. OpenClaw will retry this address.")
          .waitFor();

        await page.getByRole("button", { name: "Continue" }).click();
        await page.getByText("Retry this Ollama address now?").waitFor();

        await page.getByRole("button", { name: "Continue" }).click();
        await page.getByRole("heading", { name: "Connection verified" }).waitFor();
        await expectText(page.locator(".model-setup-success"), "ollama/qwen3:0.6b");
        await expectText(page.locator(".model-setup-success"), "Verified in", true);
        await expectCount(page.locator('.model-setup-success [data-provider-icon="ollama"]'), 1);

        const activate = await gateway.waitForRequest(rpc.activate);
        expect(activate.params).toEqual({
          sessionId: expect.any(String),
          kind: "provider-auto:ollama",
          agentId: "main",
          modelRef: "ollama/qwen3:0.6b",
        });

        await gateway.setMethodResponse(rpc.detect, {
          ...initialDetection,
          candidates: [],
          configuredModel: "ollama/qwen3:0.6b",
          recommendedInstalls: [],
          setupComplete: true,
        });
        await page.getByRole("button", { name: "Return to Models" }).click();
        await page.locator(".model-providers__defaults").waitFor();
        await expectCount(page.locator("openclaw-modal-dialog"), 0);
        expect(new URL(page.url()).pathname).toBe("/settings/model-providers");

        const wizardRequests = await gateway.getRequests(rpc.next);
        expect(wizardRequests).toHaveLength(6);
        expect(wizardRequests[2]?.params).toMatchObject({
          answer: { stepId: "ollama-base-url", value: "http://127.0.0.1:11434" },
        });
        expect(wizardRequests[3]?.params).toMatchObject({ answer: { stepId: "ollama-retry" } });
        expect(wizardRequests[4]?.params).toMatchObject({
          answer: { stepId: "ollama-retry-confirm", value: true },
        });
      },
    );
  });

  it("offers supported Google setup in an accessible provider picker", async () => {
    await suite.withPage(
      setupContext({ colorScheme: "dark", viewport: { height: 1000, width: 1440 } }),
      async ({ page }) => {
        const gateway = await installSetupGateway(page, {
          featureMethods: localSetupFeatures,
          methodResponses: {
            "models.authStatus": {
              ts: 1,
              providers: [],
              providerCapabilities: [
                {
                  provider: "qwen",
                  apiKeySupported: true,
                  quickApiKeySetup: false,
                  loginOptions: [
                    {
                      id: "qwen-oauth",
                      brandId: "qwen",
                      groupLabel: "Qwen Cloud",
                      label: "Qwen sign-in",
                      kind: "oauth",
                      featured: false,
                    },
                  ],
                },
              ],
            },
            [rpc.detect]: makeDetection({
              unavailableCandidates: [],
              manualProviders: [
                {
                  id: "qwen-cn",
                  brandId: "qwen",
                  groupLabel: "Qwen Cloud",
                  label: "Coding Plan API Key for China (subscription)",
                  hint: "Endpoint: coding.dashscope.aliyuncs.com",
                },
                {
                  id: "qwen-global",
                  brandId: "qwen",
                  groupLabel: "Qwen Cloud",
                  label: "Coding Plan API Key for Global/Intl (subscription)",
                  hint: "Endpoint: coding-intl.dashscope.aliyuncs.com",
                },
                { id: "zai-cn", brandId: "zai", groupLabel: "Z.AI", label: "Coding-Plan-CN" },
                {
                  id: "gemini-api-key",
                  brandId: "google",
                  groupLabel: "Google",
                  label: "Google AI Studio API key",
                  hint: "Supported API-key access from aistudio.google.com/apikey",
                },
              ],
              authOptions: [],
            }),
            [rpc.activate]: runningWizard("activation-session"),
            [rpc.next]: activated("qwen/qwen3-coder-plus"),
          },
        });

        const response = await openModelSetup(page, suite.server.baseUrl);
        expect(response?.status()).toBe(200);
        await page.getByRole("heading", { name: "On this Gateway", exact: true }).waitFor();
        await expectCount(page.getByText("Gemini CLI OAuth"), 0);

        const providerPicker = page.locator(".model-setup-provider-select");
        const providerTrigger = providerPicker.locator(".model-setup-provider-select__trigger");
        const manualProviderHasFocus = (providerId: string) =>
          page
            .locator(`[data-manual-provider="${providerId}"]`)
            .evaluate((element) => element === document.activeElement);
        const manualProviderMenuReady = () =>
          page
            .locator("[data-manual-provider]")
            .evaluateAll((options) => options.some((option) => option === document.activeElement));
        const waitForProviderHide = () =>
          expect
            .poll(() => providerPicker.locator('[role="menu"]').getAttribute("data-phase"))
            .toBe("hidden");
        const providerIds = await page
          .locator("[data-manual-provider]")
          .evaluateAll((options) =>
            options
              .map((option) =>
                option instanceof HTMLElement ? option.dataset.manualProvider : null,
              )
              .filter((value): value is string => Boolean(value)),
          );
        const firstProviderId = providerIds[0]!;
        const lastProviderId = providerIds.at(-1)!;
        await providerTrigger.click();
        await expect.poll(() => providerTrigger.getAttribute("aria-expanded")).toBe("true");
        await expect
          .poll(() => page.locator('[data-manual-provider="qwen-cn"]').getAttribute("aria-label"))
          .toContain("Qwen Cloud");
        await expect
          .poll(() => page.locator('[data-manual-provider="zai-cn"]').getAttribute("aria-label"))
          .toContain("Z.AI");
        await expectCount(
          page.locator('[data-manual-provider="qwen-cn"] [data-provider-icon="alibaba"]'),
          1,
        );

        const providerMenuWidth = () =>
          providerPicker
            .locator('[role="menu"]')
            .evaluate((menu) => Math.round(menu.getBoundingClientRect().width));
        await expect.poll(providerMenuWidth).toBe(620);

        await page.setViewportSize({ height: 844, width: 390 });
        await providerPicker.scrollIntoViewIfNeeded();
        await expect.poll(providerMenuWidth).toBe(358);

        await page.setViewportSize({ height: 1000, width: 1440 });
        await page.keyboard.press("Escape");
        await waitForProviderHide();
        await expect.poll(() => providerTrigger.getAttribute("aria-expanded")).toBe("false");

        const accessValue = page.locator('.model-setup__manual input[type="password"]');
        await expectFocused(providerTrigger);
        await page.keyboard.press("Enter");
        await expect.poll(() => providerTrigger.getAttribute("aria-expanded")).toBe("true");
        await expect.poll(manualProviderMenuReady).toBe(true);
        await page.keyboard.press("Home");
        await expect.poll(() => manualProviderHasFocus(firstProviderId)).toBe(true);
        await page.keyboard.press("End");
        await expect.poll(() => manualProviderHasFocus(lastProviderId)).toBe(true);
        await page.keyboard.press("Home");
        await expect.poll(() => manualProviderHasFocus(firstProviderId)).toBe(true);
        const zaiIndex = providerIds.indexOf("zai-cn");
        expect(zaiIndex).toBeGreaterThan(0);
        for (let index = 0; index < zaiIndex; index += 1) {
          await page.keyboard.press("ArrowDown");
        }
        await expect.poll(() => manualProviderHasFocus("zai-cn")).toBe(true);
        await page.keyboard.press("Enter");
        await waitForProviderHide();
        await expectText(providerTrigger, "Z.AI");
        await expectFocused(providerTrigger);

        await accessValue.fill("same-provider-secret");
        await providerTrigger.click();
        await expect.poll(manualProviderMenuReady).toBe(true);
        await page.locator('[data-manual-provider="zai-cn"]').click();
        await waitForProviderHide();
        await expect.poll(() => accessValue.inputValue()).toBe("same-provider-secret");
        await expectFocused(providerTrigger);

        await providerTrigger.click();
        await expect.poll(manualProviderMenuReady).toBe(true);
        await page.keyboard.press("Shift+Tab");
        await waitForProviderHide();
        await expectFocused(providerTrigger);

        await providerTrigger.click();
        await expect.poll(manualProviderMenuReady).toBe(true);
        await page.keyboard.press("Tab");
        await expect.poll(() => providerTrigger.getAttribute("aria-expanded")).toBe("false");
        await expectFocused(accessValue);

        await accessValue.fill("sk-old-provider-secret");
        await providerTrigger.click();
        await expect.poll(manualProviderMenuReady).toBe(true);
        await page.locator('[data-manual-provider="gemini-api-key"]').click();
        await waitForProviderHide();
        await expectText(providerTrigger, "Google");
        await expectText(providerTrigger, "AI Studio API key");
        await expect.poll(() => accessValue.inputValue()).toBe("");
        await expectFocused(providerTrigger);

        await providerTrigger.click();
        await page.locator('[data-manual-provider="qwen-cn"]').click();
        await waitForProviderHide();
        await expect.poll(() => providerTrigger.getAttribute("aria-expanded")).toBe("false");
        await expectText(providerTrigger, "Qwen Cloud");
        await accessValue.fill("qwen-test-secret");
        await expect.poll(() => accessValue.inputValue()).toBe("qwen-test-secret");
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        await page.getByRole("button", { name: "Connect & use for this agent" }).click();
        const activate = await gateway.waitForRequest(rpc.activate);
        expect(activate.params).toEqual({
          sessionId: expect.any(String),
          kind: "api-key",
          agentId: "main",
          authChoice: "qwen-cn",
          apiKey: "qwen-test-secret",
        });
        await page.getByRole("heading", { name: "Connection verified" }).waitFor();
        await page.getByText("qwen/qwen3-coder-plus", { exact: true }).waitFor();

        await page.setViewportSize({ height: 844, width: 390 });
        await expect
          .poll(() =>
            page
              .locator(".shell-nav.nav-drawer")
              .evaluate((element) => element.getAttribute("aria-hidden") !== "true"),
          )
          .toBe(false);
        await page.setViewportSize({ height: 1000, width: 1440 });
        await expectText(page.locator(".model-setup-success"), "Verified in", true);

        const detectCountBeforeDismiss = (await gateway.getRequests(rpc.detect)).length;
        await page.getByRole("button", { name: "Return to Models" }).click();
        await page.locator("[data-models-connect]").click();
        await page.locator("[data-models-login-discover]").click();
        await pollRequestCount(gateway, rpc.detect).toBe(detectCountBeforeDismiss + 1);
        await providerTrigger.click();
        await expect.poll(manualProviderMenuReady).toBe(true);
        await page.locator('[data-manual-provider="gemini-api-key"]').click();
        await waitForProviderHide();
        await expectText(providerTrigger, "Google");
        await expectCount(page.getByText("Gemini CLI OAuth"), 0);
      },
    );
  });
  it("keeps the Close action inside a dense discovery panel before any scrolling", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installSetupGateway(page, {
        featureMethods: [rpc.detect],
        methodResponses: {
          [rpc.detect]: {
            candidates: Array.from({ length: 8 }, (_, index) =>
              candidate("saved-auth:fixture", "Saved provider " + index, "fixture/model-" + index, {
                detail: "An existing connection available for this agent",
              }),
            ),
            manualProviders: [],
            prepareOptions,
            workspace: "/workspace/demo",
            setupComplete: false,
          },
        },
      });
      await openModelSetup(page, suite.server.baseUrl);
      const panel = page.locator(".model-setup-discovery");
      const close = button(panel, "Close");
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expect
          .poll(async () => {
            const panelBox = await panel.boundingBox();
            const closeBox = await close.boundingBox();
            return Boolean(
              panelBox &&
              closeBox &&
              closeBox.y >= panelBox.y &&
              closeBox.y + closeBox.height <= panelBox.y + panelBox.height,
            );
          })
          .toBe(true);
        const body = panel.locator(":scope > .model-setup-wizard__body");
        expect(await body.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
        expect(await body.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      }
      await close.click();
      await expectCount(page.locator("openclaw-modal-dialog"), 0);
    });
  });
});
