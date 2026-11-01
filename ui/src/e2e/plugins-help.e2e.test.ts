import assert from "node:assert/strict";
import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { config, configMocks, pluginResponses } from "./plugins-settings-admin.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Plugin Ask OpenClaw integration" });
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const featureMethods = [
  "config.get",
  "config.schema",
  "config.set",
  "plugins.list",
  "plugins.inspect",
  "plugins.catalog.get",
  "openclaw.chat",
  "openclaw.chat.history",
];
const sessionId = "plugin-help-existing-session";
const chatResponses = {
  "openclaw.chat": { sessionId, reply: "Ready to help.", action: "none" },
  "openclaw.chat.history": {
    turns: [{ role: "assistant", text: "Existing conversation.", at: 1700000000000 }],
  },
};

suite.define(() => {
  it.each([390, 1440])(
    "keeps credentials in a rejected URL edit out of Ask and Send at %s pixels",
    async (width) => {
      await suite.withPage({ viewport: { width, height: 1000 } }, async ({ page }) => {
        const savedConfig = structuredClone(config);
        Object.assign(savedConfig.plugins.entries.workboard.config, {
          baseUrl: "https://example.invalid/",
        });
        const schema = structuredClone(configMocks["config.schema"]);
        Object.assign(
          schema.schema.properties.plugins.properties.entries.properties.workboard.properties.config
            .properties,
          { baseUrl: { type: "string", title: "Base URL" } },
        );
        const gateway = await installMockGateway(page, {
          featureMethods,
          methodResponses: {
            ...pluginResponses(),
            ...chatResponses,
            "config.get": {
              ...configMocks["config.get"],
              config: savedConfig,
              raw: JSON.stringify(savedConfig),
            },
            "config.schema": schema,
          },
          operatorScopes: ["operator.read", "operator.admin"],
        });
        await page.goto(`${suite.server.baseUrl}settings/plugins/workboard?view=settings`);
        const row = page.locator('[data-setting="baseUrl"]');
        const input = row.getByRole("textbox");
        const editedUrl =
          "https://fixture-user:fixture-password@example.invalid/?token=fixture-token";
        await input.fill(editedUrl);
        await gateway.deferNext("config.set");
        await input.press("Tab");
        const save = await gateway.waitForRequest("config.set");
        expect(asRecord(save.params).raw).toContain(editedUrl);
        await gateway.rejectDeferred("config.set", {
          code: "INVALID_REQUEST",
          message: "Fixture URL write rejected",
        });
        await page.getByRole("alert").filter({ hasText: "Fixture URL write rejected" }).waitFor();
        expect(await input.inputValue()).toBe(editedUrl);

        await row.getByRole("button", { name: "Actions for Base URL", exact: true }).click();
        await row.getByRole("menuitem", { name: "Ask OpenClaw", exact: true }).click();
        const panel = page.locator("openclaw-assistant-panel .assistant-panel");
        const composer = panel.locator("textarea");
        await expect.poll(() => composer.inputValue()).toContain("Explain Base URL");
        const draft = await composer.inputValue();
        if (captureUiProof) {
          await page.screenshot({
            path: path.join(suite.artifactDir, `url-help-draft-${width}.png`),
          });
        }
        const userRequests = async () =>
          (await gateway.getRequests("openclaw.chat")).filter(
            (request) => asRecord(request.params).message,
          );
        expect(await userRequests()).toHaveLength(0);
        await composer.press("Enter");
        await expect.poll(async () => (await userRequests()).length).toBe(1);
        const [sent] = await userRequests();
        assert.ok(sent);
        expect(asRecord(sent.params).message).toBe(draft);
        expect(draft).toContain("Current value: <redacted>");
        expect(JSON.stringify(sent.params)).not.toContain("fixture-password");
        expect(JSON.stringify(sent.params)).not.toContain("fixture-token");
        expect(asRecord(sent.params)).toMatchObject({
          sessionId,
          context: {
            plugin: {
              id: "workboard",
              setting: { path: ["plugins", "entries", "workboard", "config", "baseUrl"] },
            },
          },
        });
        if (width === 390) {
          await panel.getByRole("button", { name: "Close assistant sidebar", exact: true }).click();
        }
        expect(await input.inputValue()).toBe(editedUrl);
        expect(await gateway.getRequests("config.set")).toHaveLength(1);
      });
    },
  );

  it("keeps the transcript flexible through protected setup answers and change history", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...featureMethods, "openclaw.changes.list"],
        methodResponses: {
          ...pluginResponses(),
          ...chatResponses,
          "openclaw.changes.list": {
            entries: [
              {
                id: "config-audit:1",
                at: 1700000000000,
                kind: "config-write",
                source: "config-rpc",
                summary: "Updated plugin settings",
              },
            ],
          },
        },
        operatorScopes: ["operator.read", "operator.admin"],
      });
      const expectTranscriptSpace = async (surface: Locator, phase: string) => {
        if (await page.locator(".plugin-editor").count()) {
          await expect
            .poll(async () => {
              const editor = await page.locator(".plugin-editor").boundingBox();
              const panel = await page
                .locator("openclaw-assistant-panel .assistant-panel")
                .boundingBox();
              return Boolean(editor && panel && editor.x + editor.width <= panel.x);
            })
            .toBe(true);
        }
        const bounds = await surface.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const messages = element.querySelector(".custodian__messages")!.getBoundingClientRect();
          const composer = element
            .querySelector(".agent-chat__composer-shell")!
            .getBoundingClientRect();
          return {
            height: rect.height,
            messages: messages.height,
            composerBottom: composer.bottom,
            bottom: rect.bottom,
          };
        });
        if (captureUiProof) {
          await page.screenshot({ path: path.join(suite.artifactDir, `transcript-${phase}.png`) });
        }
        expect(bounds.messages, phase).toBeGreaterThan(bounds.height * 0.4);
        expect(bounds.composerBottom, phase).toBeLessThanOrEqual(bounds.bottom + 1);
        expect(await surface.locator(".custodian__plugin-reference").count()).toBe(0);
      };
      await page.goto(`${suite.server.baseUrl}settings/plugins/workboard?view=settings`);
      const panel = page.locator("openclaw-assistant-panel .assistant-panel");
      await page
        .getByRole("button", { name: "Actions for Refresh interval (minutes)", exact: true })
        .click();
      const setting = page.locator('[data-setting="refreshMinutes"]');
      await setting.getByRole("menuitem", { name: "Ask OpenClaw", exact: true }).click();
      await panel.getByText("Existing conversation.", { exact: true }).waitFor();
      const composer = panel.locator("textarea");
      await expect.poll(() => composer.isEnabled()).toBe(true);
      const surface = panel.locator(".custodian-surface");
      await expectTranscriptSpace(surface, "plugin");
      await gateway.setMethodResponse("openclaw.chat", {
        ...chatResponses["openclaw.chat"],
        reply: "Complete this setup step.",
        sensitive: true,
      });
      const requests = (await gateway.getRequests("openclaw.chat")).length;
      await composer.press("Enter");
      await gateway.waitForRequest("openclaw.chat", { after: requests });
      const password = panel.locator('input[type="password"]');
      await password.waitFor();
      await page
        .getByRole("button", { name: "Actions for Refresh interval (minutes)", exact: true })
        .click();
      await setting.getByRole("menuitem", { name: "Ask OpenClaw", exact: true }).click();
      expect(await password.inputValue()).toBe("");
      await expectTranscriptSpace(surface, "pending");
      await gateway.setMethodResponse("openclaw.chat", chatResponses["openclaw.chat"]);
      await password.fill("fixture-answer");
      await password.press("Enter");
      await expect.poll(() => composer.isEnabled()).toBe(true);
      await expect
        .poll(() => composer.inputValue())
        .toBe("Explain Refresh interval (minutes)\n\nCurrent value: 15");
      await expectTranscriptSpace(surface, "ready");

      await page.goto(`${suite.server.baseUrl}custodian`);
      const pageSurface = page.locator("openclaw-custodian-page .custodian-surface");
      await pageSurface.getByText("Existing conversation.", { exact: true }).waitFor();
      await expectTranscriptSpace(pageSurface, "no-plugin");
      await page.locator(".custodian__history-toggle").click();
      await pageSurface.getByText("Updated plugin settings", { exact: true }).waitFor();
      await expectTranscriptSpace(pageSurface, "history");
    });
  });
});
