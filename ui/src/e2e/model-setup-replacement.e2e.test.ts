import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installSetupGateway, openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Model Setup saved replacement activation",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("retries the saved sign-in and waits for explicit activation after verification", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        reducedMotion: "reduce",
        viewport: { width: 1280, height: 900 },
      },
      async ({ page }) => {
        const kind = "saved-auth:openai:replacement";
        const modelRef = "openai/gpt-5";
        const confirmation = {
          done: false,
          status: "running",
          step: {
            id: "activate-saved-sign-in",
            type: "confirm",
            message: "Connection verified. Activate this saved sign-in?",
            initialValue: false,
          },
        };
        const gateway = await installSetupGateway(page, {
          agentModel: modelRef,
          models: [{ id: "gpt-5", name: "GPT-5", provider: "openai", available: true }],
          featureMethods: [
            "openclaw.setup.detect",
            "openclaw.setup.activate.start",
            "openclaw.setup.auth.start",
            "wizard.next",
          ],
          methodResponses: {
            "config.get": {
              config: { agents: { defaults: { model: modelRef } } },
              sourceConfig: { agents: { defaults: { model: modelRef } } },
              hash: "saved-replacement",
              raw: JSON.stringify({ agents: { defaults: { model: modelRef } } }),
              valid: true,
              issues: [],
            },
            "openclaw.setup.detect": {
              candidates: [
                {
                  kind,
                  brandId: "openai",
                  label: "Saved OpenAI sign-in",
                  detail: "Saved but inactive. Test this sign-in again to activate it.",
                  modelRef,
                  recommended: false,
                  credentials: true,
                },
              ],
              manualProviders: [],
              configuredModel: modelRef,
              setupComplete: true,
              workspace: "/tmp/openclaw-e2e",
            },
            "openclaw.setup.activate.start": { done: false, status: "running" },
            "wizard.next": {
              done: true,
              status: "error",
              error: "Connection test failed. Your saved sign-in is inactive. Try again.",
              activationRejection: { disposition: "rejected-before-promotion", status: "auth" },
            },
          },
        });
        await openModelSetup(page, suite.server.baseUrl);
        const current = page
          .locator(".model-providers__defaults openclaw-select-picker")
          .first()
          .locator(".picker-select__trigger");
        await current.waitFor();
        await expect.poll(() => current.textContent()).toContain("GPT-5");
        const currentConnection = await current.textContent();
        expect(currentConnection).not.toContain("inactive");
        const retry = page
          .locator(`[data-candidate-kind="${kind}"]`)
          .getByRole("button", { name: "Test & use for this agent", exact: true });
        await retry.click();
        const dialog = page.locator("openclaw-modal-dialog");
        await dialog.getByText("Connection test failed.", { exact: false }).waitFor();
        expect(await page.locator(".model-setup-success").count()).toBe(0);
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        expect(await current.textContent()).toBe(currentConnection);

        await gateway.setMethodResponse("wizard.next", confirmation);
        await retry.click();
        await dialog.getByText(confirmation.step.message, { exact: true }).waitFor();
        expect(await page.locator(".model-setup-success").count()).toBe(0);
        expect(await current.textContent()).toBe(currentConnection);
        expect(await gateway.getRequests("wizard.next")).toHaveLength(2);
        await page.screenshot({ path: path.join(suite.artifactDir, "awaiting-activation.png") });

        await gateway.setMethodResponse("wizard.next", { done: true, status: "cancelled" });
        await dialog.getByRole("button", { name: "No", exact: true }).click();
        await dialog.getByRole("alert").waitFor();
        expect((await gateway.waitForRequest("wizard.next")).params).toMatchObject({
          answer: { stepId: confirmation.step.id, value: false },
        });
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        expect(await page.locator(".model-setup-success").count()).toBe(0);
        expect(await current.textContent()).toBe(currentConnection);

        await gateway.setMethodResponse("wizard.next", confirmation);
        await retry.click();
        await dialog.getByText(confirmation.step.message, { exact: true }).waitFor();
        await gateway.setMethodResponse("wizard.next", {
          done: true,
          status: "done",
          modelActivation: { modelRef },
        });
        await dialog.getByRole("button", { name: "Yes", exact: true }).click();
        await page.locator(".model-setup-success").waitFor();
        expect((await gateway.waitForRequest("wizard.next")).params).toMatchObject({
          answer: { stepId: confirmation.step.id, value: true },
        });
        const attempts = await gateway.getRequests("openclaw.setup.activate.start");
        expect(attempts).toHaveLength(3);
        for (const attempt of attempts) {
          expect(attempt.params).toEqual({
            kind,
            modelRef,
            agentId: "main",
            sessionId: expect.any(String),
          });
        }
        expect(await gateway.getRequests("openclaw.setup.auth.start")).toHaveLength(0);
        expect(await gateway.getRequests("models.authLogin")).toHaveLength(0);
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
        await page.screenshot({ path: path.join(suite.artifactDir, "activated.png") });
      },
    );
  });
});
