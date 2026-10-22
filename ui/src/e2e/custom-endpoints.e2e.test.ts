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
import { configSnapshot } from "./model-setup-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "custom-endpoints",
  startServer: startControlUiE2eServer,
});
suite.define(() => {
  it("creates, edits and deletes independent endpoints with separate credential outcomes", async () => {
    await suite.withPage(providerPageOptions(1200, 1125), async ({ page }) => {
      const config = { agents: { defaults: { model: "openai/official" } } };
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "config.get",
          "config.patch",
          "config.customEndpoint",
          "models.authSetApiKey",
          "models.probe",
        ],
        methodResponses: {
          "config.get": configSnapshot(config, "endpoint-base"),
          "models.list": { models: [catalogModel("openai", "official", "Official model")] },
          "models.authStatus": { ts: 1, providers: [], providerCapabilities: [] },
          "config.customEndpoint": { ok: true },
          "models.authSetApiKey": {
            __mockError: { code: "UNAVAILABLE", message: "Credential fixture rejected" },
          },
          ...emptyUsage(1),
        },
      });
      await page.goto(suite.server.baseUrl + "settings/model-providers");
      const section = page.locator("[data-custom-endpoints]");
      await section.getByRole("button", { name: "Add custom endpoint", exact: true }).click();
      const form = page.locator(".custom-endpoint-editor");
      await form.getByLabel("Provider ID", { exact: false }).fill("lab-inference");
      await form.getByLabel("API base URL", { exact: true }).fill("http://lab.lan:8000/v1");
      await form.getByLabel("Model ID", { exact: true }).fill("chat-small");
      await form.getByLabel("Display name", { exact: true }).fill("Lab Chat Small");
      await form.getByRole("button", { name: "Add model", exact: true }).click();
      await form.getByLabel("Model ID", { exact: true }).nth(1).fill("vision-large");
      await form.getByLabel("Display name", { exact: true }).nth(1).fill("Lab Vision Large");
      await form.getByLabel("Text input", { exact: true }).nth(0).check();
      await form.getByLabel("Text input", { exact: true }).nth(1).check();
      await form.getByLabel("Image input", { exact: true }).nth(1).check();
      expect(await form.getByLabel("Optional API key", { exact: true }).inputValue()).toBe("");
      await form.locator(".custom-endpoint-editor__body").evaluate((element) => {
        element.scrollTop = 0;
      });
      const frame = await takeControlUiScreenshotFrame(page, page.locator(".shell"), [form], {
        animations: "disabled",
      });
      await writeFile(path.join(suite.artifactDir, "after-editor.png"), frame.png);
      await form
        .getByLabel("Optional API key", { exact: true })
        .fill("synthetic-key-for-endpoint-test");
      await gateway.deferNext("config.customEndpoint");
      await form.getByRole("button", { name: "Save", exact: true }).click();
      const create = await gateway.waitForRequest("config.customEndpoint");
      expect(create.params).toMatchObject({
        action: "create",
        provider: "lab-inference",
        api: "openai-completions",
        baseHash: "endpoint-base",
        models: [
          { id: "chat-small", edits: { name: "Lab Chat Small", textInput: true } },
          {
            id: "vision-large",
            edits: { name: "Lab Vision Large", textInput: true, imageInput: true },
          },
        ],
      });
      expect(JSON.stringify(create.params)).not.toContain("synthetic-key");
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await gateway.resolveDeferred("config.customEndpoint", { ok: true });
      await gateway.waitForRequest("models.authSetApiKey");
      await expect.poll(() => form.textContent()).toContain("Endpoint configuration saved");
      await expect.poll(() => form.textContent()).toContain("Credential fixture rejected");
      expect(await form.getByLabel("Provider ID", { exact: false }).isDisabled()).toBe(true);
      expect(await form.getByLabel("Model ID", { exact: true }).count()).toBe(2);
      await form.getByLabel("Optional API key", { exact: true }).fill("");
      await gateway.deferNext("config.customEndpoint");
      await form.getByRole("button", { name: "Save", exact: true }).click();
      const edit = await gateway.waitForRequest("config.customEndpoint", { after: 1 });
      expect(edit.params).toMatchObject({ action: "edit", provider: "lab-inference" });
      await gateway.resolveDeferred("config.customEndpoint", { ok: true });
      await expect
        .poll(() => form.getByRole("button", { name: "Save", exact: true }).isEnabled())
        .toBe(true);
      await gateway.deferNext("config.customEndpoint");
      await form.getByRole("button", { name: "Delete endpoint", exact: true }).click();
      await page.getByRole("button", { name: "Delete endpoint", exact: true }).last().click();
      const removed = await gateway.waitForRequest("config.customEndpoint", { after: 2 });
      expect(removed.params).toEqual({
        action: "delete",
        provider: "lab-inference",
        baseHash: "endpoint-base",
      });
      await gateway.resolveDeferred("config.customEndpoint", { ok: true });
      await expect.poll(() => form.count()).toBe(0);
      expect(await gateway.getRequests("models.authLogout")).toHaveLength(0);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
    });
  });

  it.each([false, true])(
    "submits only explicit edits and retains modality identity (materialized: %s)",
    async (materialized) => {
      await suite.withPage(providerPageOptions(1280, 1000), async ({ page }) => {
        const provider = {
          baseUrl: "https://before.example/v1",
          api: "openai-completions",
          models: [
            {
              id: "minimal",
              name: "Minimal",
              ...(materialized
                ? {
                    input: ["text"],
                    reasoning: false,
                    contextWindow: 128000,
                    maxTokens: 8192,
                    cost: { input: 0, output: 0 },
                  }
                : {}),
            },
            {
              id: "audio",
              name: "Audio only",
              input: ["audio"],
              ...(materialized ? { reasoning: false, contextWindow: 256000, maxTokens: 4096 } : {}),
            },
            {
              id: "video",
              name: "Video only",
              input: ["video"],
              ...(materialized ? { reasoning: true, contextWindow: 64000, maxTokens: 2048 } : {}),
            },
          ],
        };
        const gateway = await installMockGateway(page, {
          featureMethods: ["config.get", "config.patch", "config.customEndpoint"],
          methodResponses: {
            "config.get": configSnapshot(
              { models: { providers: { "lab-existing": provider } } },
              "existing-base",
            ),
            "models.list": { models: [] },
            "models.authStatus": { ts: 1, providers: [] },
            "config.customEndpoint": { ok: true },
            ...emptyUsage(1),
          },
        });
        await page.goto(suite.server.baseUrl + "settings/model-providers");
        const section = page.locator("[data-custom-endpoints]");
        await section.getByRole("button", { name: "Edit endpoint", exact: true }).click();
        const form = page.locator(".custom-endpoint-editor");
        expect(await form.getByLabel("Context window", { exact: true }).first().inputValue()).toBe(
          materialized ? "128000" : "",
        );
        expect(await form.getByLabel("Text input", { exact: true }).nth(1).isChecked()).toBe(false);
        expect(await form.getByLabel("Text input", { exact: true }).nth(2).isChecked()).toBe(false);
        await form.getByLabel("API base URL", { exact: true }).fill("https://after.example/v1");
        if (!materialized) {
          await form.locator(".custom-endpoint-editor__body").evaluate((element) => {
            element.scrollTop = 0;
          });
          const frame = await takeControlUiScreenshotFrame(page, page.locator(".shell"), [form], {
            animations: "disabled",
          });
          await writeFile(path.join(suite.artifactDir, "after-existing-editor.png"), frame.png);
        }

        await form.getByRole("button", { name: "Save", exact: true }).click();
        const urlEdit = await gateway.waitForRequest("config.customEndpoint");
        expect(urlEdit.params).toEqual({
          action: "edit",
          provider: "lab-existing",
          baseHash: "existing-base",
          baseUrl: "https://after.example/v1",
          api: "openai-completions",
          noAuth: false,
          models: [
            { id: "minimal", existingId: "minimal", edits: {} },
            { id: "audio", existingId: "audio", edits: {} },
            { id: "video", existingId: "video", edits: {} },
          ],
        });
        await expect
          .poll(() => form.getByRole("button", { name: "Save", exact: true }).isEnabled())
          .toBe(true);
        await form.getByLabel("Model ID", { exact: true }).first().fill("renamed");
        await form.getByLabel("Output token limit", { exact: true }).first().fill("");
        await form.getByLabel("Context window", { exact: true }).first().fill("42000");
        await form.getByLabel("Image input", { exact: true }).first().check();
        expect(await form.getByLabel("Text input", { exact: true }).first().isChecked()).toBe(true);
        await form.getByLabel("Image input", { exact: true }).nth(1).check();
        await form.getByRole("button", { name: "Save", exact: true }).click();
        const metadataEdit = await gateway.waitForRequest("config.customEndpoint", { after: 1 });
        expect(metadataEdit.params).toMatchObject({
          models: [
            {
              id: "renamed",
              existingId: "minimal",
              edits: {
                contextWindow: 42000,
                imageInput: true,
                ...(materialized ? { maxTokens: null } : {}),
              },
            },
            { id: "audio", existingId: "audio", edits: { imageInput: true } },
            { id: "video", existingId: "video", edits: {} },
          ],
        });
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      });
    },
  );
  it("shows server refusal without remote config fallback, and imports multiple discovered IDs", async () => {
    await suite.withPage(
      providerPageOptions(1280, 1000, { colorScheme: "dark" }),
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["config.get", "config.patch", "config.customEndpoint"],
          methodResponses: {
            "config.get": configSnapshot({}, "base"),
            "models.list": { models: [] },
            "models.authStatus": { ts: 1, providers: [] },
            "config.customEndpoint": { ok: true },
            ...emptyUsage(1),
          },
        });
        await page.goto(suite.server.baseUrl + "settings/model-providers");
        await page
          .locator("[data-custom-endpoints]")
          .getByRole("button", { name: "Add custom endpoint", exact: true })
          .click();
        const form = page.locator(".custom-endpoint-editor");
        await form.getByLabel("Provider ID", { exact: false }).fill("lab-discovery");
        await form.getByLabel("API base URL", { exact: true }).fill("http://lab.lan/v1");
        await gateway.deferNext("config.customEndpoint");
        await form.getByRole("button", { name: "Discover models", exact: true }).click();
        expect((await gateway.waitForRequest("config.customEndpoint")).params).toMatchObject({
          action: "discover",
          api: "openai-completions",
        });
        await gateway.resolveDeferred("config.customEndpoint", {
          models: ["chat", "vision"],
          inferenceTested: false,
        });
        await form.getByLabel("chat", { exact: true }).check();
        await form.getByLabel("vision", { exact: true }).check();
        await form.getByRole("button", { name: "Add selected models", exact: true }).click();
        expect(await form.getByLabel("Model ID", { exact: true }).count()).toBe(2);
        await form.getByLabel("No authentication", { exact: false }).check();
        await form.getByLabel("API adapter", { exact: true }).selectOption("anthropic-messages");
        expect(await form.getByLabel("No authentication", { exact: false }).isChecked()).toBe(
          false,
        );
        expect(
          await form.getByRole("button", { name: "Discover models", exact: true }).isDisabled(),
        ).toBe(true);
        await gateway.setMethodResponse("config.customEndpoint", {
          __mockError: {
            code: "INVALID_REQUEST",
            message: "Remote custom setup is not supported.",
          },
        });
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await expect
          .poll(() => form.textContent())
          .toContain("Remote custom setup is not supported.");
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        await form.locator(".custom-endpoint-editor__body").evaluate((element) => {
          element.scrollTop = 0;
        });
        const frame = await takeControlUiScreenshotFrame(page, page.locator(".shell"), [form], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "after-remote-refusal.png"), frame.png);
        const mobile = await takeControlUiScreenshotFrame(page, page.locator(".shell"), [form], {
          animations: "disabled",
          viewport: { width: 390, height: 844 },
        });
        await writeFile(path.join(suite.artifactDir, "after-mobile.png"), mobile.png);
      },
    );
  });
});
