import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { emptyUsage } from "./model-catalog-fixtures.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "First provider billing audit",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("does not prescribe a replacement key for first-provider billing refusal", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
        colorScheme: "light",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const key = "synthetic-billing-key";
        const reason = "The account has no available credits.";
        const gateway = await installMockGateway(page, {
          models: [],
          featureMethods: [...defaultControlUiFeatureMethods, "openclaw.setup.activate"],
          methodResponses: {
            "config.get": sourceConfigSnapshot({}, "first-provider-billing"),
            "models.list": { models: [], pendingProviders: [], providerOutcomes: [] },
            "models.authStatus": {
              ts: 1,
              providers: [],
              providerCapabilities: [
                {
                  provider: "xai",
                  displayName: "xAI",
                  apiKeySupported: true,
                  quickApiKeySetup: true,
                },
              ],
            },
            "models.authSetApiKey": { provider: "xai", profileId: "xai:manual-api-key" },
            "openclaw.setup.activate": { ok: false, status: "billing", error: reason },
            ...emptyUsage(Date.now()),
          },
        });
        await page.goto(suite.server.baseUrl + "settings/model-providers");
        await page.locator('[data-models-catalog-provider="xai"] button').click();
        const form = page.getByRole("dialog", { name: "Add provider", exact: true });
        const input = form.getByRole("textbox", { name: "API key", exact: true });
        await input.fill(key);
        const save = form.getByRole("button", { name: "Save provider", exact: true });
        await save.click();
        await form.getByText(reason, { exact: false }).waitFor();
        const failure = await form.textContent();
        expect
          .soft(failure, "billing is not evidence the credential was refused")
          .not.toContain("provider didn’t accept it");
        expect
          .soft(failure, "replacement-key advice cannot repair an account balance")
          .not.toContain("Enter a different key");
        expect(await input.inputValue()).toBe(key);
        expect(await save.isEnabled()).toBe(true);
        expect(await form.getByRole("button", { name: /^Start a new chat with/ }).count()).toBe(0);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(page, form, [save], {
            animations: "disabled",
            scrollTo: form,
          });
          await writeFile(path.join(suite.artifactDir, "first-provider-billing.png"), frame.png);
        }
        await gateway.setMethodResponse("openclaw.setup.activate", {
          ok: true,
          modelRef: "xai/grok-test",
        });
        await save.click();
        await form
          .getByRole("button", { name: "Start a new chat with grok-test", exact: true })
          .waitFor();
        expect(await form.textContent()).toContain("is ready to chat.");
        expect(await form.textContent()).not.toContain(reason);
        expect(await gateway.getRequests("models.authSetApiKey")).toHaveLength(2);
        const activations = await gateway.getRequests("openclaw.setup.activate");
        expect(activations).toHaveLength(2);
        for (const request of activations) {
          expect(request.params).toEqual({
            kind: "saved-auth:xai:manual-api-key",
            agentId: "main",
          });
        }
        expect(await gateway.getRequests("models.probe")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      },
    );
  });
});
