import { expect, it } from "vitest";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import * as setup from "./model-setup-fixtures.test-support.ts";
import { installSetupGateway, openModelSetup } from "./model-setup.test-support.ts";

const rpc = setup.setupRpc;
const suite = createControlUiE2eSuite({
  name: "Model Setup saved replacement activation",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("retries the saved sign-in and waits for explicit activation after verification", async () => {
    await suite.withPage(
      setup.setupContext({
        reducedMotion: "reduce",
        viewport: { width: 1280, height: 900 },
      }),
      async ({ page }) => {
        const kind = "saved-auth:openai:replacement";
        const modelRef = "openai/gpt-5";
        const step = setup.runningStep("use", "confirm", "Use saved sign-in?", {
          initialValue: false,
        });
        const gateway = await installSetupGateway(page, {
          agentModel: modelRef,
          models: [{ id: "gpt-5", name: "GPT-5", provider: "openai", available: true }],
          featureMethods: [rpc.detect, rpc.activate, rpc.auth, rpc.next],
          methodResponses: {
            "config.get": sourceConfigSnapshot(
              { agents: { defaults: { model: modelRef } } },
              "saved-replacement",
            ),
            [rpc.detect]: setup.makeDetection({
              candidates: [
                setup.candidate(kind, "Saved OpenAI sign-in", modelRef, {
                  brandId: "openai",
                  detail: "Saved but inactive. Test this sign-in again to activate it.",
                }),
              ],
              configuredModel: modelRef,
              setupComplete: true,
            }),
            [rpc.activate]: setup.runningWizard(),
            [rpc.next]: setup.activationFailure("Connection test failed.", "auth"),
          },
        });
        await openModelSetup(page, suite.server.baseUrl);
        const defaults = page.locator(".model-providers__defaults");
        const current = defaults.locator("openclaw-select-picker .picker-select__trigger").first();
        await current.waitFor();
        await expect.poll(() => current.textContent()).toContain("GPT-5");
        const currentConnection = await current.textContent();
        expect(currentConnection).not.toContain("inactive");
        const retry = page
          .locator(`[data-candidate-kind="${kind}"]`)
          .getByRole("button", { name: "Test & use for this agent", exact: true });
        await retry.click();
        const dialog = page.locator("openclaw-modal-dialog");
        const success = page.locator(".model-setup-success");
        await dialog.getByText("Connection test failed.", { exact: false }).waitFor();
        expect(await success.count()).toBe(0);
        await setup.button(dialog, "Close").click();
        expect(await current.textContent()).toBe(currentConnection);

        for (const activate of [false, true]) {
          await gateway.setMethodResponse(rpc.next, step);
          await retry.click();
          await dialog.getByText(step.step.message, { exact: true }).waitFor();
          if (!activate) {
            expect(await success.count()).toBe(0);
            expect(await current.textContent()).toBe(currentConnection);
            expect(await gateway.getRequests(rpc.next)).toHaveLength(2);
          }
          await gateway.setMethodResponse(
            rpc.next,
            activate ? setup.activated(modelRef) : { done: true, status: "cancelled" },
          );
          await setup.button(dialog, activate ? "Yes" : "No").click();
          await (activate ? success : dialog.getByRole("alert")).waitFor();
          expect((await gateway.waitForRequest(rpc.next)).params).toMatchObject({
            answer: { stepId: step.step.id, value: activate },
          });
          if (!activate) {
            await setup.button(dialog, "Close").click();
            expect(await success.count()).toBe(0);
            expect(await current.textContent()).toBe(currentConnection);
          }
        }
        const attempts = await gateway.getRequests(rpc.activate);
        expect(attempts).toHaveLength(3);
        for (const attempt of attempts) {
          expect(attempt.params).toEqual({
            kind,
            modelRef,
            agentId: "main",
            sessionId: expect.any(String),
          });
        }
        await setup.expectRequestCounts(gateway, {
          [rpc.auth]: 0,
          "models.authLogin": 0,
          "config.set": 0,
        });
      },
    );
  });
});
