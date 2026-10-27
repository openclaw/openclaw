// Control UI tests cover guided model setup against a mocked Gateway.
import { expect, it } from "vitest";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  activated,
  button,
  candidate,
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
            "config.get": sourceConfigSnapshot({}, "config-hash-1"),
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

        const signInLink = page.getByRole("link", { name: "Reopen browser tab" });
        await expect.poll(() => signInLink.getAttribute("href")).toBe(signInUrl);
        const wizardBody = page.locator(".model-setup-wizard__body");
        await expect
          .poll(() => wizardBody.evaluate((element) => element.scrollWidth <= element.clientWidth))
          .toBe(true);
        await page.setViewportSize({ height: 844, width: 390 });
        await expect
          .poll(() => wizardBody.evaluate((element) => element.scrollWidth <= element.clientWidth))
          .toBe(true);
        await page.getByRole("button", { name: "Cancel sign-in" }).waitFor();

        const detectCountBeforeCompletion = (await gateway.getRequests(rpc.detect)).length;
        await gateway.resolveDeferred(rpc.next);
        await page.getByRole("heading", { name: "Connection verified" }).waitFor();
        expect(await gateway.getRequests(rpc.detect)).toHaveLength(detectCountBeforeCompletion);
        await expectText(page.locator(".model-setup-success"), "provider/verified-model");
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
            "models.authStatus": { ts: 1, providers: [], providerCapabilities: [] },
            [rpc.detect]: makeDetection({
              prepareOptions,
              unavailableCandidates: [],
              manualProviders: [
                {
                  id: "qwen-cn",
                  brandId: "qwen",
                  groupLabel: "Qwen Cloud",
                  label: "Coding Plan API Key for China (subscription)",
                },
                { id: "zai-cn", brandId: "zai", groupLabel: "Z.AI", label: "Coding-Plan-CN" },
                {
                  id: "gemini-api-key",
                  brandId: "google",
                  groupLabel: "Google",
                  label: "Google AI Studio API key",
                },
              ],
              authOptions: [],
            }),
            [rpc.activate]: runningWizard("activation-session"),
            [rpc.next]: activated("qwen/qwen3-coder-plus"),
          },
        });

        await openModelSetup(page, suite.server.baseUrl);
        await page.getByRole("heading", { name: "On this Gateway", exact: true }).waitFor();
        const colors = await page
          .locator("[data-prepare-choice] [data-provider-icon]")
          .evaluateAll((icons) => icons.map((icon) => getComputedStyle(icon).color));
        expect(colors).toHaveLength(3);
        expect(new Set(colors).size).toBe(1);

        const providerPicker = page.locator(".model-setup-provider-select");
        const providerTrigger = providerPicker.locator(".model-setup-provider-select__trigger");
        const manualProviderMenuReady = () =>
          page
            .locator("[data-manual-provider]")
            .evaluateAll((options) => options.some((option) => option === document.activeElement));
        const waitForProviderHide = () =>
          expect
            .poll(() => providerPicker.locator('[role="menu"]').getAttribute("data-phase"))
            .toBe("hidden");
        const openProviderMenu = async () => {
          await providerTrigger.click();
          await expect.poll(manualProviderMenuReady).toBe(true);
        };
        const selectProvider = async (id: string) => {
          await page.locator(`[data-manual-provider="${id}"]`).click();
          await waitForProviderHide();
        };
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
        await openProviderMenu();
        await selectProvider("zai-cn");
        await expectText(providerTrigger, "Z.AI");
        await expectFocused(providerTrigger);

        await accessValue.fill("same-provider-secret");
        await openProviderMenu();
        await selectProvider("zai-cn");
        await expect.poll(() => accessValue.inputValue()).toBe("same-provider-secret");
        await expectFocused(providerTrigger);

        await openProviderMenu();
        await page.keyboard.press("Shift+Tab");
        await waitForProviderHide();
        await expectFocused(providerTrigger);

        await openProviderMenu();
        await page.keyboard.press("Tab");
        await expect.poll(() => providerTrigger.getAttribute("aria-expanded")).toBe("false");
        await expectFocused(accessValue);

        await accessValue.fill("sk-old-provider-secret");
        await openProviderMenu();
        await selectProvider("gemini-api-key");
        await expectText(providerTrigger, "Google");
        await expectText(providerTrigger, "AI Studio API key");
        await expect.poll(() => accessValue.inputValue()).toBe("");
        await expectFocused(providerTrigger);

        await providerTrigger.click();
        await selectProvider("qwen-cn");
        await expect.poll(() => providerTrigger.getAttribute("aria-expanded")).toBe("false");
        await expectText(providerTrigger, "Qwen Cloud");
        await accessValue.fill("qwen-test-secret");
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
        await openProviderMenu();
        await selectProvider("gemini-api-key");
        await expectText(providerTrigger, "Google");
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
