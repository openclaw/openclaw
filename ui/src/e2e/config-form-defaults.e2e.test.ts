// Control UI tests cover schema defaults and restoring inherited config values.

import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import {
  pageRunner,
  configSnapshot,
  objectSchema,
  configSchema,
  configProof,
  settingsRow,
  settingsPageOptions,
  revealControl,
  createConfigSuite,
} from "./config-composer-fixtures.test-support.ts";

const suite = createConfigSuite("Control UI config form defaults mocked Gateway E2E");

const proof = configProof("config-form-defaults");

function requestRaw(request: MockGatewayRequest): Record<string, unknown> {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected config.set params");
  }
  return JSON.parse(String((params as Record<string, unknown>).raw)) as Record<string, unknown>;
}

const withPage = pageRunner(suite, settingsPageOptions);

const capture = proof.capture;

suite.define(() => {
  it("shows node automatic updates as inherited enabled and restores omission after opting out", async () => {
    const { buildConfigSchemaCore } = await import("../../../src/config/schema.ts");
    const schema = buildConfigSchemaCore();
    const config = (enabled?: boolean) => ({
      nodeHost: {
        autoUpdate: enabled === undefined ? {} : { enabled },
        browserProxy: { enabled: false },
      },
    });
    await withPage(async ({ page }) => {
      const initial = config();
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": configSnapshot(initial, "node-auto-update-initial", true),
          "config.schema": schema,
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/infrastructure?section=nodeHost&advanced=1`);
      const control = page.locator('select[aria-label="Node Automatic Updates Enabled"]');

      await revealControl(control);
      expect((await control.locator("option:checked").textContent())?.trim()).toBe(
        "Default (enabled)",
      );
      expect(await gateway.getRequests("config.set")).toHaveLength(0);

      for (const [label, enabled] of [
        ["Off", false],
        ["Default (enabled)", undefined],
      ] as const) {
        const before = (await gateway.getRequests("config.set")).length;
        await gateway.deferNext("config.set");
        await control.selectOption({ label });
        const request = await gateway.waitForRequest("config.set", { after: before });
        expect(requestRaw(request)).toEqual(config(enabled));
        await gateway.resolveDeferred("config.set");
        await expect
          .poll(() => page.locator("openclaw-settings-save-indicator").textContent())
          .toContain("Saved");
        await page.reload();
        await revealControl(control);
        expect((await control.locator("option:checked").textContent())?.trim()).toBe(label);
      }
      await capture(
        page.locator("#config-section-nodeHost"),
        "03-node-automatic-updates-default.png",
      );
    });
  });

  it("shows defaults and removes cleared optional scalars from config.set", async () => {
    await withPage(async ({ page }) => {
      const config = {
        runtime: {
          enabled: false,
          keep: "preserved",
          mode: "custom",
          payload: { mode: "custom" },
          profile: { enabled: false, mode: "custom" },
          retries: 9,
          tags: ["custom"],
        },
      };
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": configSnapshot(config, "config-form-defaults-e2e"),
          "config.schema": configSchema(
            objectSchema("", {
              runtime: objectSchema("Runtime defaults", {
                enabled: {
                  type: "boolean",
                  title: "Enabled",
                  description: "Controls runtime processing.",
                  default: true,
                },
                keep: { type: "string", title: "Keep" },
                mode: {
                  type: "string",
                  title: "Mode",
                  default: "balanced",
                  enum: ["balanced", "fast", "careful", "safe", "strict", "custom"],
                },
                payload: {
                  title: "Payload",
                  anyOf: [{ type: "object" }, { type: "array" }],
                  default: { mode: "balanced" },
                },
                profile: objectSchema(
                  "Profile",
                  {
                    enabled: { type: "boolean", title: "Profile enabled" },
                    mode: { type: "string", title: "Profile mode" },
                  },
                  { default: { enabled: true, mode: "balanced" } },
                ),
                retries: { type: "integer", title: "Retries", default: 3 },
                tags: {
                  type: "array",
                  title: "Tags",
                  items: { type: "string" },
                  default: ["stable", "default"],
                },
              }),
            }),
            Object.fromEntries(
              Object.keys(config.runtime).map((key) => [`runtime.${key}`, { advanced: false }]),
            ),
          ),
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/advanced?section=runtime`);
      expect(response?.status()).toBe(200);

      const panel = page.locator("#config-section-panel");
      const enabledRow = settingsRow(page, "Enabled");
      const modeRow = settingsRow(page, "Mode");
      const payloadRow = settingsRow(page, "Payload");
      const profileBlock = panel.locator("details.cfg-object").filter({
        has: page.locator(".cfg-object__summary .settings-row__title").getByText("Profile", {
          exact: true,
        }),
      });
      const retriesRow = settingsRow(page, "Retries");
      const tagsBlock = panel.locator(".cfg-array").filter({ hasText: "Tags" });

      await expect
        .poll(() => enabledRow.textContent().then((text) => text?.replace(/\s+/gu, " ").trim()))
        .toContain("Controls runtime processing. Default: true");
      await expect.poll(() => modeRow.textContent()).toContain("Default: balanced");
      await expect.poll(() => modeRow.locator("select").inputValue()).not.toBe("__unset__");
      await expect.poll(() => payloadRow.textContent()).toContain('Default: {"mode":"balanced"}');
      await expect
        .poll(() => profileBlock.textContent())
        .not.toContain('{"enabled":true,"mode":"balanced"}');
      await expect.poll(() => retriesRow.getByRole("spinbutton").inputValue()).toBe("9");
      await expect.poll(() => tagsBlock.textContent()).toContain('Default: ["stable","default"]');

      await capture(panel, "01-explicit-overrides.png");

      await gateway.deferNext("config.set");
      await modeRow.locator("select").selectOption("__unset__");
      await retriesRow.getByRole("spinbutton").fill("");

      // Form mutations schedule config.set automatically; form mode has no manual Save control.
      const saved = requestRaw(await gateway.waitForRequest("config.set"));
      expect(saved).toEqual({
        runtime: {
          enabled: false,
          keep: "preserved",
          payload: { mode: "custom" },
          profile: { enabled: false, mode: "custom" },
          tags: ["custom"],
        },
      });
      await expect
        .poll(() => page.locator("openclaw-settings-save-indicator").textContent())
        .toContain("Saving");

      await expect.poll(() => modeRow.locator("select").inputValue()).toBe("__unset__");
      await expect.poll(() => retriesRow.getByRole("spinbutton").inputValue()).toBe("");
      await expect
        .poll(() => retriesRow.getByRole("spinbutton").getAttribute("placeholder"))
        .toBe("Default: 3");

      await gateway.resolveDeferred("config.set");
      await expect
        .poll(() => page.locator("openclaw-settings-save-indicator").textContent())
        .toContain("Saved");
      expect((await page.reload())?.status()).toBe(200);
      await gateway.waitForRequest("config.get");

      await expect.poll(() => modeRow.locator("select").inputValue()).toBe("__unset__");
      await expect.poll(() => retriesRow.getByRole("spinbutton").inputValue()).toBe("");

      await capture(panel, "02-inherited-defaults.png");
    });
  });
});
