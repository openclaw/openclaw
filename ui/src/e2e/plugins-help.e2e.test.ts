import assert from "node:assert/strict";
import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  config,
  configMocks,
  inspection,
  inventory,
  pluginResponses,
} from "./plugins-settings-admin.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Plugin Ask OpenClaw integration" });
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
    "keeps setting help editable after startup failure and sends only after retry at %s pixels",
    async (width) => {
      await suite.withPage({ viewport: { width, height: 1000 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods,
          methodResponses: { ...pluginResponses(), ...chatResponses },
          operatorScopes: ["operator.read", "operator.admin"],
        });
        await page.goto(`${suite.server.baseUrl}settings/plugins/workboard?view=settings`);
        const row = page.locator('[data-setting="refreshMinutes"]');
        await row
          .getByRole("button", { name: "Actions for Refresh interval (minutes)", exact: true })
          .click();
        await gateway.deferNext("openclaw.chat");
        await row.locator('wa-dropdown-item[value="ask"]').click();
        await gateway.waitForRequest("openclaw.chat");
        await gateway.rejectDeferred("openclaw.chat", {
          code: "UNAVAILABLE",
          message: "Fixture inference unavailable",
        });
        const panel = page.locator("openclaw-assistant-panel .assistant-panel");
        const composer = panel.locator("textarea");
        await panel
          .getByRole("alert")
          .filter({ hasText: "Fixture inference unavailable" })
          .waitFor();
        await page.screenshot({
          path: path.join(suite.artifactDir, `startup-help-${width}.png`),
          animations: "disabled",
        });
        expect(await composer.inputValue()).toBe(
          "Explain Refresh interval (minutes)\n\nCurrent value: 15",
        );
        expect(await composer.getAttribute("placeholder")).toBe("Ask OpenClaw about Workboard");
        expect(await composer.isEnabled()).toBe(true);
        expect(await panel.locator(".custodian__plugin-reference").count()).toBe(0);
        expect(await panel.locator(".chat-send-btn").isEnabled()).toBe(false);
        await composer.fill(`${await composer.inputValue()}\nKeep the answer brief.`);
        const draft = await composer.inputValue();
        await composer.press("Enter");
        expect(await gateway.getRequests("openclaw.chat")).toHaveLength(1);
        await panel.getByRole("button", { name: "Retry", exact: true }).click();
        await expect.poll(() => panel.locator(".chat-send-btn").isEnabled()).toBe(true);
        expect(await composer.inputValue()).toBe(draft);
        expect(
          (await gateway.getRequests("openclaw.chat")).every(
            (request) => !asRecord(request.params).message,
          ),
        ).toBe(true);
        await page.screenshot({
          path: path.join(suite.artifactDir, `editable-help-${width}.png`),
          animations: "disabled",
        });
        await panel.getByRole("button", { name: "Send", exact: true }).click();
        await expect.poll(async () => (await gateway.getRequests("openclaw.chat")).length).toBe(3);
        const sent = (await gateway.getRequests("openclaw.chat"))[2];
        assert.ok(sent);
        expect(asRecord(sent.params)).toMatchObject({
          sessionId,
          message: draft,
          context: {
            plugin: { id: "workboard", setting: { label: "Refresh interval (minutes)" } },
          },
        });
      });
    },
  );

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
        await row.locator('wa-dropdown-item[value="ask"]').click();
        const panel = page.locator("openclaw-assistant-panel .assistant-panel");
        const composer = panel.locator("textarea");
        await expect.poll(() => composer.inputValue()).toContain("Explain Base URL");
        const draft = await composer.inputValue();
        await page.screenshot({
          path: path.join(suite.artifactDir, `url-help-draft-${width}.png`),
        });
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
        await page.screenshot({ path: path.join(suite.artifactDir, `transcript-${phase}.png`) });
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
      await setting.locator('wa-dropdown-item[value="ask"]').click();
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
      await setting.locator('wa-dropdown-item[value="ask"]').click();
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

  it("opens installed help once, preserves the draft, redacts setting values, and clears departed context", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods,
        methodResponses: { ...pluginResponses(), ...chatResponses },
        operatorScopes: ["operator.read", "operator.admin"],
      });
      await page.goto(`${suite.server.baseUrl}settings/plugins/workboard`);
      const panel = page.locator("openclaw-assistant-panel .assistant-panel");
      const composer = panel.locator("textarea");
      const expectDockedEditor = async () => {
        await expect.poll(() => panel.locator(".chat-send-btn").isEnabled()).toBe(true);
        await expect
          .poll(async () => {
            const editorBounds = await page.locator(".plugin-editor").boundingBox();
            const panelBounds = await panel.boundingBox();
            return Boolean(
              editorBounds && panelBounds && editorBounds.x + editorBounds.width <= panelBounds.x,
            );
          })
          .toBe(true);
      };
      await panel.getByText("Existing conversation.", { exact: true }).waitFor();
      await expect.poll(() => composer.isEnabled()).toBe(true);
      const userRequests = async () =>
        (await gateway.getRequests("openclaw.chat")).filter((request) =>
          Boolean(asRecord(request.params).message),
        );
      expect(await userRequests()).toHaveLength(0);
      await composer.fill("Keep my existing draft.");
      await panel.getByRole("button", { name: "Close assistant sidebar", exact: true }).click();
      await page
        .locator(".plugin-catalog-detail__actions")
        .getByRole("link", { name: "Settings", exact: true })
        .click();
      await page
        .locator(".plugin-editor")
        .getByRole("searchbox", { name: "Search settings", exact: true })
        .waitFor();
      expect(await panel.isVisible()).toBe(false);
      await page
        .getByRole("button", { name: "Actions for Refresh interval (minutes)", exact: true })
        .click();
      const setting = page.locator('[data-setting="refreshMinutes"]');
      expect(await setting.locator("wa-dropdown-item").allTextContents()).toEqual([
        "Reset value",
        "Ask OpenClaw",
      ]);
      await setting.locator('wa-dropdown-item[value="ask"]').click();
      await expect
        .poll(() => composer.inputValue())
        .toBe("Keep my existing draft.\n\nExplain Refresh interval (minutes)\n\nCurrent value: 15");
      expect(await userRequests()).toHaveLength(0);
      await expect
        .poll(() => composer.evaluate((element) => element.clientHeight))
        .toBeGreaterThan(80);
      await expectDockedEditor();
      await page.screenshot({ path: path.join(suite.artifactDir, "setting-unsent-draft.png") });
      await composer.press("Enter");
      await expect.poll(async () => (await userRequests()).length).toBe(1);
      const [settingRequest] = await userRequests();
      assert.ok(settingRequest);
      expect(asRecord(settingRequest.params)).toMatchObject({
        sessionId,
        context: {
          plugin: {
            id: "workboard",
            name: "Workboard",
            installed: true,
            setting: { path: ["plugins", "entries", "workboard", "config", "refreshMinutes"] },
          },
        },
      });

      const secretConfig = structuredClone(config);
      Object.assign(secretConfig.plugins.entries.workboard.config, {
        connection: { apiKey: "synthetic-should-never-enter-chat" },
      });
      const schema = structuredClone(configMocks["config.schema"]);
      Object.assign(
        schema.schema.properties.plugins.properties.entries.properties.workboard.properties.config
          .properties,
        {
          connection: {
            type: "object",
            title: "Connection",
            additionalProperties: false,
            properties: { apiKey: { type: "string", title: "API key" } },
          },
        },
      );
      await gateway.setMethodResponse("config.get", {
        ...configMocks["config.get"],
        config: secretConfig,
        raw: JSON.stringify(secretConfig),
      });
      await gateway.setMethodResponse("config.schema", schema);
      await page.reload();
      const secretRow = page.locator('[data-setting="connection.apiKey"]');
      await secretRow
        .getByRole("button", { name: "Actions for Connection: API key", exact: true })
        .click();
      await secretRow.locator('wa-dropdown-item[value="ask"]').click();
      await expect.poll(() => composer.inputValue()).toContain("Current value: <redacted>");
      expect(await composer.inputValue()).not.toContain("synthetic-should-never-enter-chat");
      await expectDockedEditor();
      await page.screenshot({ path: path.join(suite.artifactDir, "setting-redacted-draft.png") });
      expect(await userRequests()).toHaveLength(0);
      await composer.press("Enter");
      await expect.poll(async () => (await userRequests()).length).toBe(1);
      expect(JSON.stringify(await userRequests())).not.toContain(
        "synthetic-should-never-enter-chat",
      );
      const [secretRequest] = await userRequests();
      assert.ok(secretRequest);
      expect(
        asRecord(asRecord(asRecord(secretRequest.params).context).plugin).setting,
      ).toMatchObject({
        path: ["plugins", "entries", "workboard", "config", "connection", "apiKey"],
      });

      await page.locator(".plugin-editor .plugins-settings-breadcrumb__parent").click();
      await page.locator(".plugin-catalog-detail .plugins-settings-breadcrumb__parent").click();
      await page.getByRole("heading", { level: 1, name: "Plugins", exact: true }).waitFor();
      await expect.poll(() => composer.getAttribute("placeholder")).toBe("Message OpenClaw…");
      await composer.fill("What is next?");
      await composer.press("Enter");
      await expect.poll(async () => (await userRequests()).length).toBe(2);
      const departedRequest = (await userRequests())[1];
      assert.ok(departedRequest);
      expect(asRecord(asRecord(departedRequest.params).context).plugin).toBeUndefined();
    });
  });

  it.each([
    { width: 900, catalog: false },
    { width: 1440, catalog: true },
  ])(
    "opens help only explicitly for $width pixels and catalog=$catalog",
    async ({ width, catalog }) => {
      await suite.withPage({ viewport: { width, height: 1000 } }, async ({ page }) => {
        const catalogResult = structuredClone(inspection.catalog);
        catalogResult.plugin.id = "ch_uninstalled";
        Object.assign(catalogResult.plugin.local, {
          present: false,
          installed: false,
          enabled: false,
          state: "not-installed",
          action: "install",
        });
        const gateway = await installMockGateway(page, {
          featureMethods,
          methodResponses: {
            ...pluginResponses(),
            ...chatResponses,
            "plugins.catalog.get": catalogResult,
            "plugins.list": catalog ? { ...inventory, plugins: [] } : inventory,
          },
          operatorScopes: ["operator.read", "operator.admin"],
        });
        await page.goto(
          `${suite.server.baseUrl}${catalog ? "plugins/ch_uninstalled" : "settings/plugins/workboard"}`,
        );
        const ask = page
          .locator(".plugin-catalog-detail__actions")
          .getByRole("button", { name: "Ask OpenClaw", exact: true });
        await ask.waitFor();
        const panel = page.locator("openclaw-assistant-panel .assistant-panel");
        expect(await panel.isVisible()).toBe(false);
        expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
        await ask.click();
        await panel.getByText("Existing conversation.", { exact: true }).waitFor();
        expect(
          (await gateway.getRequests("openclaw.chat")).every(
            (request) => !asRecord(request.params).message,
          ),
        ).toBe(true);
        await panel.getByRole("button", { name: "Close assistant sidebar", exact: true }).click();
        await page.setViewportSize({ width: 1440, height: 1000 });
        expect(await panel.isVisible()).toBe(false);
      });
    },
  );
});
