// Control UI tests cover schema defaults and restoring inherited config values.
import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI config form defaults mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let uiProofArtifactDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    uiProofArtifactDir = createControlUiE2eArtifactDir("config-form-defaults");
  }
});

function requestRaw(request: MockGatewayRequest): Record<string, unknown> {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected config.set params");
  }
  return JSON.parse(String((params as Record<string, unknown>).raw)) as Record<string, unknown>;
}

function settingsRow(page: Page, title: string): Locator {
  return page.locator(".settings-row").filter({
    has: page.locator(".settings-row__title").getByText(title, { exact: true }),
  });
}

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
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const initial = config();
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              appliedConfigHash: "node-auto-update-initial",
              config: initial,
              configRevisionHash: "node-auto-update-initial",
              hash: "node-auto-update-initial",
              issues: [],
              raw: JSON.stringify(initial),
              valid: true,
            },
            "config.schema": schema,
          },
        });
        await page.goto(
          `${suite.server.baseUrl}settings/infrastructure?section=nodeHost&advanced=1`,
        );
        const control = page.locator('select[aria-label="Node Automatic Updates Enabled"]');
        const reveal = async () => {
          await expect.poll(() => control.count()).toBe(1);
          for (const details of await control.locator("xpath=ancestor::details").all()) {
            if ((await details.getAttribute("open")) === null) {
              await details.locator(":scope > summary").click();
            }
          }
          await expect.poll(() => control.isVisible()).toBe(true);
        };
        await reveal();
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
          await reveal();
          expect((await control.locator("option:checked").textContent())?.trim()).toBe(label);
        }
        if (captureUiProofEnabled) {
          await page.locator("#config-section-nodeHost").screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "03-node-automatic-updates-default.png"),
          });
        }
      },
    );
  });

  it("shows defaults and removes cleared optional scalars from config.set", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
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
            "config.get": {
              config,
              hash: "config-form-defaults-e2e",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
            "config.schema": {
              generatedAt: "2026-07-31T00:00:00.000Z",
              schema: {
                type: "object",
                properties: {
                  runtime: {
                    type: "object",
                    title: "Runtime defaults",
                    properties: {
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
                      profile: {
                        type: "object",
                        title: "Profile",
                        default: { enabled: true, mode: "balanced" },
                        properties: {
                          enabled: { type: "boolean", title: "Profile enabled" },
                          mode: { type: "string", title: "Profile mode" },
                        },
                      },
                      retries: { type: "integer", title: "Retries", default: 3 },
                      tags: {
                        type: "array",
                        title: "Tags",
                        items: { type: "string" },
                        default: ["stable", "default"],
                      },
                    },
                  },
                },
              },
              uiHints: {
                "runtime.enabled": { advanced: false },
                "runtime.keep": { advanced: false },
                "runtime.mode": { advanced: false },
                "runtime.payload": { advanced: false },
                "runtime.profile": { advanced: false },
                "runtime.retries": { advanced: false },
                "runtime.tags": { advanced: false },
              },
              version: "e2e",
            },
          },
        });

        const response = await page.goto(
          `${suite.server.baseUrl}settings/advanced?section=runtime`,
        );
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

        await expect.poll(() => enabledRow.textContent()).toContain("Default: true");
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

        if (captureUiProofEnabled) {
          await panel.screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "01-explicit-overrides.png"),
          });
        }

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

        const reloadedPanel = page.locator("#config-section-panel");
        const reloadedModeRow = settingsRow(page, "Mode");
        const reloadedRetriesRow = settingsRow(page, "Retries");
        await expect.poll(() => reloadedModeRow.locator("select").inputValue()).toBe("__unset__");
        await expect.poll(() => reloadedRetriesRow.getByRole("spinbutton").inputValue()).toBe("");

        if (captureUiProofEnabled) {
          await reloadedPanel.screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "02-inherited-defaults.png"),
          });
        }
      },
    );
  });
});
