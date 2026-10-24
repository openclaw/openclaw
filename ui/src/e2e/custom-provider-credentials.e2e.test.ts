import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  catalogModel,
  emptyUsage,
  providerPageOptions,
} from "./model-catalog-fixtures.test-support.ts";
import { expandProvider } from "./model-providers.test-support.ts";
import { configSnapshot } from "./model-setup-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "custom-provider-credentials",
  startServer: startControlUiE2eServer,
});
suite.define(() => {
  it.each(["google-generative-ai", "openai-completions"])(
    "keeps key replacement and removal independent of endpoint editing (%s)",
    async (api) => {
      await suite.withPage(providerPageOptions(1200, 1125), async ({ page }) => {
        const provider = "lab-custom";
        const endpoint = {
          name: "Lab Custom",
          baseUrl: "https://inference.example/v1",
          api,
          models: [{ id: "chat", name: "Lab Chat" }],
        };
        const config = (withKey: boolean) => ({
          agents: { defaults: { model: provider + "/chat" } },
          models: {
            providers: {
              [provider]: { ...endpoint, ...(withKey ? { apiKey: "synthetic-config-key" } : {}) },
            },
          },
        });
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.admin"],
          featureMethods: [
            "config.get",
            "config.patch",
            "config.customEndpoint",
            "models.authSetApiKey",
            "models.authLogout",
          ],
          methodResponses: {
            "config.get": configSnapshot(config(true), "before"),
            "models.list": { models: [catalogModel(provider, "chat", "Lab Chat")] },
            "models.authStatus": {
              ts: 1,
              providerCapabilities: [],
              providers: [
                {
                  provider,
                  displayName: provider,
                  status: "static",
                  profiles: [],
                  apiKey: { source: "config" },
                },
              ],
            },
            "config.customEndpoint": {
              __mockError: {
                code: "INVALID_REQUEST",
                message: "Remote custom setup is not supported.",
              },
            },
            "models.authSetApiKey": { provider, profileId: provider + ":manual-api-key" },
            "models.authLogout": { provider, removedProfiles: [], abortedRunIds: [] },
            ...emptyUsage(1),
          },
        });
        await page.goto(suite.server.baseUrl + "settings/model-providers");
        const row = await expandProvider(page, provider);
        const edit = row.getByRole("button", { name: "Edit endpoint", exact: true });
        if (api === "google-generative-ai") {
          expect(await edit.isDisabled()).toBe(true);
          expect(await edit.getAttribute("title")).toContain("not supported");
        } else {
          // The endpoint owner refuses this remote definition write. Credential-only
          // writes must still use their existing owner, not retry through this RPC.
          await edit.click();
          const form = page.locator(".custom-endpoint-editor");
          await form.getByRole("button", { name: "Save", exact: true }).click();
          await expect
            .poll(() => form.textContent())
            .toContain("Remote custom setup is not supported.");
          await form.getByRole("button", { name: "Close", exact: true }).click();
        }
        const definitionWrites = api === "google-generative-ai" ? 0 : 1;
        expect(await row.getByRole("button", { name: "Set API key", exact: true }).count()).toBe(1);
        expect(
          await row.getByRole("button", { name: "Remove provider", exact: true }).isEnabled(),
        ).toBe(true);
        if (api === "google-generative-ai") {
          const frame = await takeControlUiScreenshotFrame(page, page.locator(".shell"), [row], {
            animations: "disabled",
            scrollTo: row,
          });
          await writeFile(
            path.join(suite.artifactDir, "after-custom-credential-actions.png"),
            frame.png,
          );
        }
        await row.getByRole("button", { name: "Set API key", exact: true }).click();
        await row.getByLabel("API key", { exact: true }).fill("synthetic-replacement-key");
        await row.getByRole("button", { name: "Save", exact: true }).click();
        expect((await gateway.waitForRequest("models.authSetApiKey")).params).toEqual({
          provider,
          agentId: "main",
          apiKey: "synthetic-replacement-key",
        });
        await expect.poll(() => row.textContent()).toContain("Secret saved.");
        await gateway.setMethodResponse("config.get", configSnapshot(config(false), "removed"));
        await gateway.setMethodResponse("models.authStatus", {
          ts: 2,
          providers: [],
          providerCapabilities: [],
        });
        await row.getByRole("button", { name: "Remove provider", exact: true }).click();
        const confirmation = page.locator(".exec-approval-actions");
        await confirmation.getByRole("button", { name: "Remove provider", exact: true }).click();
        expect((await gateway.waitForRequest("models.authLogout")).params).toEqual({
          provider,
          agentId: "main",
          credentialType: "api_key",
        });
        await expect.poll(() => row.textContent()).not.toContain("API key set in config");
        expect(await page.locator('[data-provider-id="lab-custom"]').count()).toBe(1);
        expect(await gateway.getRequests("config.customEndpoint")).toHaveLength(definitionWrites);
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      });
    },
  );
});
