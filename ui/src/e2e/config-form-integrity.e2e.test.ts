// Control UI tests cover schema-backed form constraints, draft recovery, and accessible names.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  configSnapshot,
  objectSchema,
  configSchema,
  pageRunner,
  configProof,
  settingsPageOptions,
  revealControl,
  createConfigSuite,
} from "./config-composer-fixtures.test-support.ts";

const suite = createConfigSuite("Control UI config form integrity mocked Gateway E2E");

const proof = configProof(
  "config-form-integrity",
  process.env.OPENCLAW_UI_PROOF_VARIANT ?? "after",
);

function configFormIntegrityMocks() {
  const config = {
    laboratory: {
      endpoint: "local-api",
      metadata: { mode: "safe" },
      retryBudget: 4,
      weights: [2],
      codes: [],
    },
  };
  return {
    "config.get": configSnapshot(config, "config-form-integrity-e2e", true),
    "config.schema": configSchema(
      objectSchema("", {
        laboratory: objectSchema(
          "Form Integrity",
          {
            endpoint: {
              type: "string",
              title: "Endpoint slug",
              description: "Lowercase letters and hyphens only.",
              minLength: 3,
              maxLength: 16,
              pattern: "[a-z-]+",
            },
            retryBudget: {
              type: "integer",
              title: "Retry budget",
              description: "Even values from two through eight.",
              minimum: 2,
              maximum: 8,
              multipleOf: 2,
            },
            weights: {
              type: "array",
              title: "Weights",
              items: { type: "integer", minimum: 2, maximum: 8, multipleOf: 2 },
            },
            codes: {
              type: "array",
              title: "Codes",
              items: { type: "string", minLength: 3, pattern: "^[0-9]+$" },
            },
          },
          { additionalProperties: true },
        ),
      }),
    ),
  };
}

const withPage = pageRunner(suite, settingsPageOptions);

const capture = proof.capture;

suite.define(() => {
  it("round-trips Agent List model overrides through the complete Gateway schema", async () => {
    const { buildConfigSchemaCore } = await import("../../../src/config/schema.ts");
    const schema = buildConfigSchemaCore();
    const config = (codeMode?: boolean) => ({
      agents: {
        entries: {
          main: {
            name: "Form proof",
            models: {
              "openai/gpt-5.6-sol": {
                alias: "coding",
                params: { temperature: 0.5 },
                agentRuntime: { id: "openclaw" },
                streaming: false,
                ...(codeMode === undefined ? {} : { codeMode }),
              },
            },
            tools: { codeMode: { enabled: "auto", maxOutputBytes: 4096 } },
          },
        },
      },
      tools: { codeMode: false },
    });
    await withPage(async ({ page }) => {
      const initial = config();
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": configSnapshot(initial, "agent-list-initial", true),
          "config.schema": schema,
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/agents`);
      await page
        .getByRole("button", {
          name: "Agent defaults Defaults every agent inherits unless overridden.",
        })
        .click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/ai-agents");
      await page.goto(`${suite.server.baseUrl}settings/ai-agents?section=agents&advanced=1`);

      const mode = page.locator('select[aria-label="Code Mode"]');
      await revealControl(mode);
      expect((await mode.locator("option").allTextContents()).map((label) => label.trim())).toEqual(
        ["Default", "On", "Off"],
      );
      expect((await mode.locator("option:checked").textContent())?.trim()).toBe("Default");
      const rawOnly = page.locator(".settings-row").filter({
        has: page.locator(".settings-row__title").getByText("Agent Code Mode", { exact: true }),
      });
      expect(await rawOnly.textContent()).toContain("Unsupported schema node. Use Raw mode.");
      expect(await rawOnly.locator("input,select,textarea").count()).toBe(0);

      const agentKey = page.locator('input[aria-label="Key: main"]').first();
      await revealControl(agentKey);
      await agentKey.fill("bad/agent");
      await agentKey.blur();
      await expect.poll(() => agentKey.inputValue()).toBe("main");

      for (const [label, value] of [
        ["On", true],
        ["Off", false],
        ["Default", undefined],
      ] as const) {
        const before = (await gateway.getRequests("config.set")).length;
        await gateway.deferNext("config.set");
        await mode.selectOption({ label });
        const request = await gateway.waitForRequest("config.set", { after: before });
        const params = request.params as { raw?: string };
        expect(JSON.parse(String(params.raw))).toEqual(config(value));
        await gateway.resolveDeferred("config.set");
        await expect.poll(() => mode.isEnabled()).toBe(true);
        expect(await gateway.getRequests("config.set")).toHaveLength(before + 1);
        await page.reload();
        await revealControl(mode);
        expect((await mode.locator("option:checked").textContent())?.trim()).toBe(label);
      }
      await capture(page, "04-agent-list-model-overrides.png", true);
    });
  });

  it("keeps invalid drafts visible and exposes schema constraints to the browser", async () => {
    await withPage(async ({ page }) => {
      await installMockGateway(page, { methodResponses: configFormIntegrityMocks() });

      const response = await page.goto(
        `${suite.server.baseUrl}settings/advanced?section=laboratory`,
      );
      expect(response?.status()).toBe(200);

      const endpoint = page.getByRole("textbox", { name: "Endpoint slug" });
      const retryBudget = page.getByRole("spinbutton", { name: "Retry budget" });
      const weights = page.locator(".cfg-array").filter({ hasText: "Weights" });
      const addWeight = weights.getByRole("button", { name: "Add" });
      await addWeight.click();

      const metadataEditor = page.locator(".cfg-map textarea");
      await metadataEditor.fill('{"mode":');
      await metadataEditor.blur();

      await capture(page.locator("#config-section-panel"), "01-invalid-json-draft.png");

      await expect.poll(() => endpoint.getAttribute("minlength")).toBeNull();
      await expect.poll(() => endpoint.getAttribute("maxlength")).toBeNull();
      await expect.poll(() => endpoint.getAttribute("pattern")).toBeNull();
      await expect.poll(() => endpoint.getAttribute("aria-describedby")).not.toBeNull();
      await expect.poll(() => retryBudget.getAttribute("min")).toBe("2");
      await expect.poll(() => retryBudget.getAttribute("max")).toBe("8");
      await expect.poll(() => retryBudget.getAttribute("step")).toBe("2");
      await expect
        .poll(() => page.locator(".cfg-array input[type='number']").last().inputValue())
        .toBe("2");
      await expect.poll(() => metadataEditor.inputValue()).toBe('{"mode":');
      await expect.poll(() => metadataEditor.getAttribute("aria-invalid")).toBe("true");
      await expect.poll(() => page.getByRole("alert").textContent()).toContain("valid JSON");

      const codes = page.locator(".cfg-array").filter({ hasText: "Codes" });
      await codes.getByRole("button", { name: "Add" }).click();
      const codeDraft = codes.locator(".cfg-collection-draft");
      await expect.poll(() => codeDraft.isVisible()).toBe(true);
      const codeValue = codeDraft.getByRole("textbox", { name: "Add: Codes" });
      await codeValue.fill("abc");
      await codeDraft.getByRole("button", { name: "Add" }).click();
      await expect.poll(() => codeValue.getAttribute("aria-invalid")).toBe("true");
      await expect.poll(() => codes.locator("input[aria-label='Codes']").count()).toBe(0);

      await capture(page.locator("#config-section-panel"), "02-pattern-collection-draft.png");

      await codeValue.fill("123");
      await codeDraft.getByRole("button", { name: "Add" }).click();
      await expect
        .poll(() => codes.locator("input[aria-label='Codes']").last().inputValue())
        .toBe("123");
    });
  });

  it("explains rejected Settings-save errors and discards the draft", async () => {
    await withPage(async ({ page }) => {
      const providerId = "z.ai";
      const config = {
        models: {
          providers: {
            [providerId]: {
              models: [{ name: "First" }, { name: "Second" }, { name: "Third" }, {}],
            },
          },
        },
      };
      const issue = {
        path: `models.providers.${providerId}.models.3.name`,
        message: "Invalid model name",
      };
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": configSnapshot(config, "model-row-e2e", true),
          "config.schema": configSchema(
            objectSchema("", {
              models: objectSchema("Models", {
                providers: {
                  type: "object",
                  title: "Providers",
                  additionalProperties: objectSchema("", {
                    models: {
                      type: "array",
                      title: "Configured models",
                      items: objectSchema("", { name: { type: "string", title: "Model name" } }),
                    },
                  }),
                },
              }),
            }),
          ),
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/advanced?section=models`);
      expect(response?.status()).toBe(200);
      const panel = page.locator("#config-section-panel");
      const fourthRow = panel.locator(".settings-row__title").getByText("#4", { exact: true });
      await expect.poll(() => fourthRow.isVisible()).toBe(true);

      await gateway.deferNext("config.set");
      await panel.getByRole("textbox", { name: "Model name" }).nth(3).fill("Broken");
      const request = await gateway.waitForRequest("config.set");
      const params = request.params as { baseHash?: string; raw?: string };
      const submitted = JSON.parse(String(params.raw)) as {
        models: { providers: Record<string, { models: Array<{ name: string }> }> };
      };
      expect(submitted.models.providers[providerId]?.models[3]?.name).toBe("Broken");
      expect(params.baseHash).toBe("model-row-e2e");

      const rejection = {
        code: "INVALID_REQUEST",
        message: `invalid config: ${issue.path}: ${issue.message}`,
        details: { issues: [issue] },
      };
      await gateway.rejectDeferred("config.set", rejection);

      const status = page.locator("openclaw-settings-save-indicator").getByRole("status");
      await expect.poll(() => status.textContent()).toContain("Settings not applied");
      // Opening the reason blurs the edited field without resubmitting its rejected value.
      await status.getByText("Show reason", { exact: true }).click();
      await status
        .getByText(
          `invalid config: models.providers.${providerId}.models.#4.name: Invalid model name`,
          { exact: true },
        )
        .waitFor();
      expect(await gateway.getRequests("config.set")).toHaveLength(1);
      expect(await status.ariaSnapshot()).toContain(
        `models.providers.${providerId}.models.#4.name`,
      );

      if (proof.enabled) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(proof.directory(), "03-model-row-rejection.png"),
        });
        await writeFile(
          path.join(proof.directory(), "03-model-row-rejection-accessibility.yml"),
          await status.ariaSnapshot(),
        );
      }

      await status.getByRole("button", { name: "Discard draft and reload", exact: true }).click();
      await status.waitFor({ state: "hidden" });
      expect(await panel.getByRole("textbox", { name: "Model name" }).nth(3).inputValue()).toBe("");
      await page.getByRole("button", { name: "Raw", exact: true }).click();
      const restored = await page.locator(".config-raw-field textarea").inputValue();
      expect(JSON.parse(restored)).toEqual(config);
      expect(await gateway.getRequests("config.set")).toHaveLength(1);
    });
  });
});
