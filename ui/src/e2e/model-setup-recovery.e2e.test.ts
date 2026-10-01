// Control UI tests cover local-provider recovery against a mocked Gateway.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installSetupGateway, openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI local-provider recovery mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
let artifactDir: string | undefined;
beforeEach(() => {
  artifactDir = artifactRoot
    ? createControlUiE2eArtifactDir("model-setup-recovery", artifactRoot)
    : undefined;
});

suite.define(() => {
  it("verifies the current model connection and retries saved replacement credentials", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        ...(artifactDir
          ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
          : {}),
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const config = { agents: { defaults: { model: "openai/gpt-5" } } };
        const gateway = await installSetupGateway(page, {
          agentModel: "openai/gpt-5",
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "openclaw.setup.detect",
            "models.probe",
            "openclaw.setup.activate.start",
            "openclaw.setup.auth.start",
            "wizard.next",
          ],
          models: [{ id: "gpt-5", name: "GPT-5", provider: "openai", available: true }],
          methodResponses: {
            "config.get": {
              config,
              sourceConfig: config,
              raw: JSON.stringify(config),
              hash: "configured-provider",
              valid: true,
              issues: [],
            },
            "models.authStatus": {
              ts: 1,
              providerCapabilities: [],
              providers: [
                {
                  provider: "openai",
                  displayName: "OpenAI",
                  status: "static",
                  profiles: [{ profileId: "openai:existing", type: "api_key", status: "static" }],
                },
              ],
            },
            "openclaw.setup.detect": {
              candidates: [
                {
                  kind: "existing-model",
                  brandId: "openai",
                  label: "Current model",
                  detail: "openai/gpt-5 — already configured",
                  modelRef: "openai/gpt-5",
                  recommended: false,
                  credentials: true,
                },
                {
                  kind: "provider-auto:openai",
                  brandId: "openai",
                  label: "OpenAI",
                  detail: "Already configured",
                  modelRef: "openai/gpt-5",
                  recommended: false,
                  credentials: true,
                },
                {
                  kind: "saved-auth:openai:replacement",
                  brandId: "openai",
                  label: "Saved OpenAI credentials",
                  detail: "Saved for retry after a failed setup test",
                  modelRef: "openai/gpt-5",
                  recommended: false,
                  credentials: true,
                },
                {
                  kind: "claude-cli",
                  brandId: "claude",
                  label: "Claude Code",
                  detail: "logged in",
                  modelRef: "claude-cli/claude-opus-5",
                  recommended: false,
                  credentials: true,
                },
              ],
              manualProviders: [],
              workspace: "/tmp/openclaw-e2e",
              configuredModel: "openai/gpt-5",
              setupComplete: true,
            },
            "models.probe": {
              provider: "openai",
              status: "ok",
              latencyMs: 1234,
              results: [
                { label: "Configured credential · openai/gpt-5", status: "ok", latencyMs: 1234 },
              ],
            },
            "openclaw.setup.activate.start": { done: false, status: "running" },
            "wizard.next": {
              done: true,
              status: "done",
              modelActivation: { modelRef: "openai/gpt-5" },
            },
          },
        });

        const response = await openModelSetup(page, suite.server.baseUrl);
        expect(response?.status()).toBe(200);
        await expect
          .poll(() => page.locator('[data-candidate-kind="existing-model"]').count())
          .toBe(0);
        await expect.poll(() => page.locator('[data-candidate-kind="claude-cli"]').count()).toBe(1);
        expect(await page.locator('[data-candidate-kind="provider-auto:openai"]').count()).toBe(0);
        const savedCredentials = page.locator(
          '[data-candidate-kind="saved-auth:openai:replacement"]',
        );
        await savedCredentials.getByText("Saved OpenAI credentials", { exact: true }).waitFor();
        if (artifactDir) {
          await writeFile(
            path.join(artifactDir, "configured-route-dedup-desktop.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              page.locator('[data-candidate-kind="claude-cli"]'),
              savedCredentials,
            ]),
          );
          await page.setViewportSize({ height: 844, width: 390 });
          await expect
            .poll(() =>
              page
                .locator(".shell-nav.nav-drawer")
                .evaluate((element) => element.getAttribute("aria-hidden") !== "true"),
            )
            .toBe(false);
          await writeFile(
            path.join(artifactDir, "configured-route-dedup-mobile.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              page.locator('[data-candidate-kind="claude-cli"]'),
              savedCredentials,
            ]),
          );
          await page.setViewportSize({ height: 900, width: 1280 });
        }
        await page
          .locator(".model-setup-discovery")
          .getByRole("button", { name: "Close", exact: true })
          .click();
        const currentProvider = page.locator('[data-provider-id="openai"]');
        await currentProvider.getByRole("button", { name: "Test connection", exact: true }).click();
        const verify = await gateway.waitForRequest("models.probe");
        expect(verify.params).toEqual({ provider: "openai", agentId: "main" });
        await currentProvider
          .locator(".model-providers__probe-summary")
          .getByText("1234 ms", { exact: true })
          .waitFor();
        await currentProvider
          .locator(".model-providers__probe-summary")
          .getByText("Connected", { exact: true })
          .waitFor();
        const detectCountBeforeRefresh = (await gateway.getRequests("openclaw.setup.detect"))
          .length;
        const verifyCountBeforeRefresh = (await gateway.getRequests("models.probe")).length;
        await currentProvider.getByRole("button", { name: "Test connection", exact: true }).click();
        await expect
          .poll(async () => (await gateway.getRequests("models.probe")).length)
          .toBe(verifyCountBeforeRefresh + 1);
        expect((await gateway.getRequests("openclaw.setup.detect")).length).toBe(
          detectCountBeforeRefresh,
        );
        await currentProvider
          .getByRole("button", { name: "Test connection", exact: true })
          .waitFor();
        await currentProvider
          .locator(".model-providers__probe-summary")
          .getByText("1234 ms", { exact: true })
          .waitFor();
        await currentProvider
          .locator(".model-providers__probe-summary")
          .getByText("Connected", { exact: true })
          .waitFor();
        await openModelSetup(page);
        await savedCredentials
          .getByRole("button", { name: "Test & use for this agent", exact: true })
          .click();
        const activation = await gateway.waitForRequest("openclaw.setup.activate.start");
        expect(activation.params).toEqual({
          kind: "saved-auth:openai:replacement",
          modelRef: "openai/gpt-5",
          agentId: "main",
          sessionId: expect.any(String),
        });
        await page.locator(".model-setup-success").waitFor();
        expect(await gateway.getRequests("openclaw.setup.activate.start")).toHaveLength(1);
        expect(await gateway.getRequests("openclaw.setup.auth.start")).toHaveLength(0);
        if (artifactDir) {
          await writeFile(
            path.join(artifactDir, "saved-retry-request.json"),
            JSON.stringify(
              {
                activation,
                activations: await gateway.getRequests("openclaw.setup.activate.start"),
                signIns: await gateway.getRequests("openclaw.setup.auth.start"),
              },
              null,
              2,
            ),
          );
          await writeFile(
            path.join(artifactDir, "saved-retry-success-desktop.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              page.locator(".model-setup-success"),
            ]),
          );
        }
      },
    );
  });

  it.each(["rejected", "uncertain"] as const)(
    "preserves first-run recovery after a terminal %s activation outcome",
    async (outcome) => {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1280 },
          ...(artifactDir
            ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
            : {}),
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            featureMethods: ["openclaw.setup.detect", "openclaw.setup.auth.start", "wizard.next"],
            methodResponses: {
              "openclaw.setup.detect": {
                candidates: [],
                manualProviders: [],
                authOptions: [
                  { id: "provider-login", label: "Provider login", kind: "oauth", featured: true },
                ],
                workspace: "/tmp/openclaw-e2e",
                setupComplete: false,
              },
              "openclaw.setup.auth.start": { done: false, status: "running" },
              "wizard.next": {
                done: true,
                status: "error",
                error: "The model could not finish setup",
                ...(outcome === "rejected"
                  ? {
                      activationRejection: {
                        disposition: "rejected-before-promotion",
                        status: "timeout",
                      },
                    }
                  : {}),
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
          const signIn = page.locator('[data-auth-choice="provider-login"] button');
          await signIn.waitFor();
          if (artifactDir) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(artifactDir, `${outcome}-before.png`),
            });
          }
          await signIn.click();
          const dialog = page.locator("openclaw-modal-dialog");
          const alert = dialog.getByRole("alert");
          await alert.waitFor();
          expect((await alert.textContent())?.trim()).toBe(
            "Could not finish. Open Details to see what to do next.",
          );
          const details = dialog.locator("details");
          expect(await details.getAttribute("open")).toBeNull();
          const diagnostic = details.getByText("The model could not finish setup", { exact: true });
          expect(await diagnostic.isVisible()).toBe(false);
          await details.getByText("Details", { exact: true }).click();
          await diagnostic.waitFor();
          await dialog.getByRole("button", { name: "Close", exact: true }).click();
          await expect.poll(() => dialog.count()).toBe(0);
          await expect.poll(() => signIn.isDisabled()).toBe(outcome === "uncertain");
          const receiptKey = "openclaw.modelSetup.pendingActivation.v1";
          const receipt = await page.evaluate((key) => localStorage.getItem(key), receiptKey);
          expect(receipt === null).toBe(outcome === "rejected");
          expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
          expect(await gateway.getRequests("openclaw.setup.auth.start")).toHaveLength(1);
          expect(await gateway.getRequests("openclaw.setup.activate.start")).toHaveLength(0);
          if (outcome === "uncertain") {
            const recovery = page.locator(".model-setup__recovery");
            await recovery.getByRole("button", { name: "Check again", exact: true }).click();
            await page.getByText("may still be running", { exact: false }).waitFor();
            expect(await gateway.getRequests("openclaw.setup.auth.start")).toHaveLength(1);
            expect(await page.evaluate((key) => localStorage.getItem(key), receiptKey)).toBe(
              receipt,
            );
          } else {
            await signIn.click();
            await alert.waitFor();
            expect((await alert.textContent())?.trim()).toBe(
              "Could not finish. Open Details to see what to do next.",
            );
            expect(await details.getAttribute("open")).toBeNull();
            expect(await diagnostic.isVisible()).toBe(false);
            await details.getByText("Details", { exact: true }).click();
            await diagnostic.waitFor();
            expect(await gateway.getRequests("openclaw.setup.auth.start")).toHaveLength(2);
          }
          if (artifactDir) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(artifactDir, `${outcome}-after.png`),
            });
          }
        },
      );
    },
  );

  it("shows a failed configured LM Studio connection without implicit preparation", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const modelRef = "lmstudio/qwen3-8b-instruct";
        const config = {
          agents: { defaults: { model: modelRef } },
          // LM Studio persists this non-secret placeholder for local, unauthenticated access.
          models: {
            providers: {
              lmstudio: {
                baseUrl: "http://localhost:1234/v1",
                apiKey: "lmstudio-local",
                models: [{ id: "qwen3-8b-instruct", name: "qwen3-8b-instruct" }],
              },
            },
          },
        };
        const gateway = await installSetupGateway(page, {
          agentModel: modelRef,
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "openclaw.setup.detect",
            "models.probe",
            "openclaw.setup.prepare.start",
            "wizard.next",
          ],
          models: [
            {
              id: "qwen3-8b-instruct",
              name: "qwen3-8b-instruct",
              provider: "lmstudio",
              available: true,
            },
          ],
          methodResponses: {
            "config.get": {
              config,
              sourceConfig: config,
              raw: JSON.stringify(config),
              hash: "configured-provider",
              valid: true,
              issues: [],
            },
            "models.authStatus": {
              ts: 1,
              providerCapabilities: [],
              providers: [
                { provider: "lmstudio", displayName: "LM Studio", status: "static", profiles: [] },
              ],
            },
            "openclaw.setup.detect": {
              candidates: [
                {
                  kind: "provider-auto:lmstudio",
                  brandId: "lmstudio",
                  label: "LM Studio",
                  detail: "qwen3-8b-instruct at http://localhost:1234/v1",
                  modelRef,
                  recommended: false,
                  credentials: true,
                },
              ],
              manualProviders: [],
              prepareOptions: [
                {
                  id: "lmstudio",
                  brandId: "lmstudio",
                  label: "LM Studio",
                  hint: "Connect to a running LM Studio server and use an already loaded model",
                  actionLabel: "Connect server",
                },
              ],
              workspace: "/tmp/openclaw-e2e",
              configuredModel: modelRef,
              setupComplete: true,
            },
            // models.probe intentionally sanitizes raw connection errors.
            "models.probe": {
              provider: "lmstudio",
              status: "unknown",
              error: "The connection probe failed.",
              results: [
                {
                  label: "Configured credential · lmstudio/qwen3-8b-instruct",
                  status: "unknown",
                  error: "The connection probe failed.",
                },
              ],
            },
            "openclaw.setup.prepare.start": {
              sessionId: "lmstudio-recovery-session",
              done: false,
              status: "running",
            },
            "wizard.next": {
              done: false,
              status: "running",
              step: {
                id: "lmstudio-base-url",
                type: "text",
                message: "LM Studio base URL",
                initialValue: "http://localhost:1234/v1",
              },
            },
          },
        });

        const response = await page.goto(suite.server.baseUrl + "settings/model-providers");
        expect(response?.status()).toBe(200);
        const selectedModel = page.locator('[data-provider-id="lmstudio"]');
        await selectedModel.getByText("LM Studio", { exact: true }).waitFor();
        await expect
          .poll(() =>
            page.locator(".model-providers__defaults openclaw-select-picker").first().textContent(),
          )
          .toContain("qwen3-8b-instruct");
        await selectedModel.getByRole("button", { name: "Test connection", exact: true }).click();
        await selectedModel
          .locator(".model-providers__probe-summary")
          .getByText("Connection failed", { exact: true })
          .waitFor();
        await expect
          .poll(() => selectedModel.locator(".model-providers__probe").textContent())
          .toContain("The connection probe failed.");
        await selectedModel.getByRole("button", { name: "Test connection", exact: true }).waitFor();
        expect(await gateway.getRequests("openclaw.setup.prepare.start")).toHaveLength(0);
        expect(await gateway.getRequests("openclaw.setup.activate.start")).toHaveLength(0);

        if (artifactDir) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "local-provider-failure-desktop.png"),
          });
          await page.setViewportSize({ height: 844, width: 390 });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, "local-provider-failure-mobile.png"),
          });
        }

        const verify = await gateway.waitForRequest("models.probe");
        expect(verify.params).toEqual({ provider: "lmstudio", agentId: "main" });
        await openModelSetup(page);
        expect(await page.locator('[data-candidate-kind="provider-auto:lmstudio"]').count()).toBe(
          0,
        );
        expect(await page.locator('[data-prepare-choice="lmstudio"]').count()).toBe(0);
        expect(await gateway.getRequests("openclaw.setup.prepare.start")).toHaveLength(0);
        expect(await gateway.getRequests("openclaw.setup.activate.start")).toHaveLength(0);
      },
    );
  });
});
