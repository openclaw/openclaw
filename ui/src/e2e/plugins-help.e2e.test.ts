import assert from "node:assert/strict";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  named,
  objectSchema,
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
const refreshLabel = "Refresh interval (minutes)";
const refreshDraft = `Explain ${refreshLabel}\n\nCurrent value: 15`;
const chatResponses = {
  "openclaw.chat": { sessionId, reply: "Ready to help.", action: "none" },
  "openclaw.chat.history": {
    turns: [{ role: "assistant", text: "Existing conversation.", at: 1700000000000 }],
  },
};

async function installHelpGateway(
  page: Page,
  responses: Record<string, unknown> = {},
  methods: string[] = [],
) {
  const gateway = await installMockGateway(page, {
    featureMethods: [...featureMethods, ...methods],
    methodResponses: { ...pluginResponses(), ...chatResponses, ...responses },
    operatorScopes: ["operator.read", "operator.admin"],
  });
  const panel = page.locator("openclaw-assistant-panel .assistant-panel");
  return {
    gateway,
    panel,
    composer: panel.locator("textarea"),
    userRequests: async () =>
      (await gateway.getRequests("openclaw.chat")).filter(
        (request) => asRecord(request.params).message,
      ),
  };
}

function extraSettings(values: Record<string, unknown>, properties: Record<string, unknown>) {
  const saved = structuredClone(config);
  Object.assign(saved.plugins.entries.workboard.config, values);
  const schema = structuredClone(configMocks["config.schema"]);
  Object.assign(
    schema.schema.properties.plugins.properties.entries.properties.workboard.properties.config
      .properties,
    properties,
  );
  return {
    "config.get": { ...configMocks["config.get"], config: saved, raw: JSON.stringify(saved) },
    "config.schema": schema,
  };
}

function expectSettingRequest(
  params: unknown,
  setting: string | { label: string },
  message?: string,
  identity: Record<string, unknown> = {},
) {
  const details =
    typeof setting === "string"
      ? { path: ["plugins", "entries", "workboard", "config"].concat(setting.split(".")) }
      : setting;
  expect(params).toMatchObject({
    sessionId,
    context: { plugin: { id: "workboard", ...identity, setting: details } },
    ...(message === undefined ? {} : { message }),
  });
}

async function expectDockedEditor(page: Page) {
  await expect
    .poll(async () => {
      const editor = await page.locator(".plugin-editor").boundingBox();
      const panel = await page.locator("openclaw-assistant-panel .assistant-panel").boundingBox();
      return Boolean(editor && panel && editor.x + editor.width <= panel.x);
    })
    .toBe(true);
}

suite.define(() => {
  it.each([390, 1440])(
    "keeps setting help editable after startup failure and sends only after retry at %s pixels",
    (width) =>
      suite.withPage({ viewport: { width, height: 1000 } }, async ({ page }) => {
        const { gateway, panel, composer, userRequests } = await installHelpGateway(page);
        await page.goto(`${suite.server.baseUrl}settings/plugins/workboard?view=settings`);
        const row = page.locator('[data-setting="refreshMinutes"]');
        await named(row, "button", "Actions for Refresh interval (minutes)").click();
        await gateway.deferNext("openclaw.chat");
        await named(row, "menuitem", "Ask OpenClaw").click();
        await gateway.waitForRequest("openclaw.chat");
        await gateway.rejectDeferred("openclaw.chat", {
          code: "UNAVAILABLE",
          message: "Fixture inference unavailable",
        });
        await panel
          .getByRole("alert")
          .filter({ hasText: "Fixture inference unavailable" })
          .waitFor();

        expect(await composer.inputValue()).toBe(refreshDraft);
        expect(await composer.getAttribute("placeholder")).toBe("Ask OpenClaw about Workboard");
        expect(await composer.isEnabled()).toBe(true);
        expect(await panel.locator(".custodian__plugin-reference").count()).toBe(0);
        expect(await panel.locator(".chat-send-btn").isEnabled()).toBe(false);
        await composer.fill(`${await composer.inputValue()}\nKeep the answer brief.`);
        const draft = await composer.inputValue();
        await composer.press("Enter");
        expect(await gateway.getRequests("openclaw.chat")).toHaveLength(1);
        await named(panel, "button", "Retry").click();
        await expect.poll(() => panel.locator(".chat-send-btn").isEnabled()).toBe(true);
        expect(await composer.inputValue()).toBe(draft);
        expect(await userRequests()).toHaveLength(0);

        await named(panel, "button", "Send").click();
        await expect.poll(async () => (await gateway.getRequests("openclaw.chat")).length).toBe(3);
        const sent = (await gateway.getRequests("openclaw.chat"))[2];
        assert.ok(sent);
        expectSettingRequest(sent.params, { label: refreshLabel }, draft);
      }),
  );

  it.each([390, 1440])(
    "keeps credentials in a rejected URL edit out of Ask and Send at %s pixels",
    (width) =>
      suite.withPage({ viewport: { width, height: 1000 } }, async ({ page }) => {
        const { gateway, panel, composer, userRequests } = await installHelpGateway(
          page,
          extraSettings(
            { baseUrl: "https://example.invalid/" },
            { baseUrl: { type: "string", title: "Base URL" } },
          ),
        );
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

        await named(row, "button", "Actions for Base URL").click();
        await named(row, "menuitem", "Ask OpenClaw").click();
        await expect.poll(() => composer.inputValue()).toContain("Explain Base URL");
        const draft = await composer.inputValue();

        expect(await userRequests()).toHaveLength(0);
        await composer.press("Enter");
        await expect.poll(async () => (await userRequests()).length).toBe(1);
        const [sent] = await userRequests();
        assert.ok(sent);
        expect(draft).toContain("Current value: <redacted>");
        expect(JSON.stringify(sent.params)).not.toContain("fixture-password");
        expect(JSON.stringify(sent.params)).not.toContain("fixture-token");
        expectSettingRequest(sent.params, "baseUrl", draft);
        if (width === 390) {
          await named(panel, "button", "Close assistant sidebar").click();
        }
        expect(await input.inputValue()).toBe(editedUrl);
        expect(await gateway.getRequests("config.set")).toHaveLength(1);
      }),
  );

  it("keeps the transcript flexible through protected setup answers and change history", () =>
    suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      const { gateway, panel, composer } = await installHelpGateway(
        page,
        {
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
        ["openclaw.changes.list"],
      );
      const expectTranscriptSpace = async (surface: Locator, phase: string) => {
        if (await page.locator(".plugin-editor").count()) {
          await expectDockedEditor(page);
        }
        const bounds = await surface.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const box = (selector: string) =>
            element.querySelector(selector)!.getBoundingClientRect();
          return {
            roomy: box(".custodian__messages").height > rect.height * 0.4,
            docked: box(".agent-chat__composer-shell").bottom <= rect.bottom + 1,
          };
        });
        expect(bounds, phase).toEqual({ roomy: true, docked: true });
        expect(await surface.locator(".custodian__plugin-reference").count()).toBe(0);
      };
      await page.goto(`${suite.server.baseUrl}settings/plugins/workboard?view=settings`);
      await named(page, "button", "Actions for Refresh interval (minutes)").click();
      const setting = page.locator('[data-setting="refreshMinutes"]');
      await named(setting, "menuitem", "Ask OpenClaw").click();
      await panel.getByText("Existing conversation.", { exact: true }).waitFor();
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
      await named(page, "button", "Actions for Refresh interval (minutes)").click();
      await named(setting, "menuitem", "Ask OpenClaw").click();
      expect(await password.inputValue()).toBe("");
      await expectTranscriptSpace(surface, "pending");
      await gateway.setMethodResponse("openclaw.chat", chatResponses["openclaw.chat"]);
      await password.fill("fixture-answer");
      await password.press("Enter");
      await expect.poll(() => composer.isEnabled()).toBe(true);
      await expect.poll(() => composer.inputValue()).toBe(refreshDraft);
      await expectTranscriptSpace(surface, "ready");

      await page.goto(`${suite.server.baseUrl}custodian`);
      const pageSurface = page.locator("openclaw-custodian-page .custodian-surface");
      await pageSurface.getByText("Existing conversation.", { exact: true }).waitFor();
      await expectTranscriptSpace(pageSurface, "no-plugin");
      await page.locator(".custodian__history-toggle").click();
      await pageSurface.getByText("Updated plugin settings", { exact: true }).waitFor();
      await expectTranscriptSpace(pageSurface, "history");
    }));

  it("opens installed help once, preserves the draft, redacts setting values, and clears departed context", () =>
    suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      const { gateway, panel, composer, userRequests } = await installHelpGateway(page);
      await page.goto(`${suite.server.baseUrl}settings/plugins/workboard`);
      const expectReadyEditor = async () => {
        await expect.poll(() => panel.locator(".chat-send-btn").isEnabled()).toBe(true);
        await expectDockedEditor(page);
      };
      await panel.getByText("Existing conversation.", { exact: true }).waitFor();
      await expect.poll(() => composer.isEnabled()).toBe(true);
      expect(await userRequests()).toHaveLength(0);
      await composer.fill("Keep my existing draft.");
      await named(panel, "button", "Close assistant sidebar").click();
      await named(page.locator(".plugin-catalog-detail__actions"), "link", "Settings").click();
      await named(page.locator(".plugin-editor"), "searchbox", "Search settings").waitFor();
      expect(await panel.isVisible()).toBe(false);
      await named(page, "button", "Actions for Refresh interval (minutes)").click();
      const setting = page.locator('[data-setting="refreshMinutes"]');
      expect(
        (await setting.getByRole("menuitem").allTextContents()).map((label) => label.trim()),
      ).toEqual(["Reset value", "Ask OpenClaw"]);
      await named(setting, "menuitem", "Ask OpenClaw").click();
      await expect
        .poll(() => composer.inputValue())
        .toBe(`Keep my existing draft.\n\n${refreshDraft}`);
      expect(await userRequests()).toHaveLength(0);
      await expect
        .poll(() => composer.evaluate((element) => element.clientHeight))
        .toBeGreaterThan(80);
      await expectReadyEditor();

      await composer.press("Enter");
      await expect.poll(async () => (await userRequests()).length).toBe(1);
      const [settingRequest] = await userRequests();
      assert.ok(settingRequest);
      expectSettingRequest(settingRequest.params, "refreshMinutes", undefined, {
        name: "Workboard",
        installed: true,
      });

      const secretResponses = extraSettings(
        { connection: { apiKey: "synthetic-should-never-enter-chat" } },
        {
          connection: objectSchema(
            { apiKey: { type: "string", title: "API key" } },
            { title: "Connection", additionalProperties: false },
          ),
        },
      );
      await gateway.setMethodResponse("config.get", secretResponses["config.get"]);
      await gateway.setMethodResponse("config.schema", secretResponses["config.schema"]);
      await page.reload();
      const secretRow = page.locator('[data-setting="connection.apiKey"]');
      await named(secretRow, "button", "Actions for Connection: API key").click();
      await named(secretRow, "menuitem", "Ask OpenClaw").click();
      await expect.poll(() => composer.inputValue()).toContain("Current value: <redacted>");
      expect(await composer.inputValue()).not.toContain("synthetic-should-never-enter-chat");
      await expectReadyEditor();

      expect(await userRequests()).toHaveLength(0);
      await composer.press("Enter");
      await expect.poll(async () => (await userRequests()).length).toBe(1);
      expect(JSON.stringify(await userRequests())).not.toContain(
        "synthetic-should-never-enter-chat",
      );
      const [secretRequest] = await userRequests();
      assert.ok(secretRequest);
      expectSettingRequest(secretRequest.params, "connection.apiKey");

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
    }));

  it.each([
    { width: 900, catalog: false },
    { width: 1440, catalog: true },
  ])("opens help only explicitly for $width pixels and catalog=$catalog", ({ width, catalog }) =>
    suite.withPage({ viewport: { width, height: 1000 } }, async ({ page }) => {
      const catalogResult = structuredClone(inspection.catalog);
      catalogResult.plugin.id = "ch_uninstalled";
      Object.assign(catalogResult.plugin.local, {
        present: false,
        installed: false,
        enabled: false,
        state: "not-installed",
        action: "install",
      });
      const { gateway, panel, userRequests } = await installHelpGateway(page, {
        "plugins.catalog.get": catalogResult,
        "plugins.list": catalog ? { ...inventory, plugins: [] } : inventory,
      });
      await page.goto(
        `${suite.server.baseUrl}${catalog ? "plugins/ch_uninstalled" : "settings/plugins/workboard"}`,
      );
      const ask = named(page.locator(".plugin-catalog-detail__actions"), "button", "Ask OpenClaw");
      await ask.waitFor();
      expect(await panel.isVisible()).toBe(false);
      expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
      await ask.click();
      await panel.getByText("Existing conversation.", { exact: true }).waitFor();
      expect(await userRequests()).toHaveLength(0);
      await named(panel, "button", "Close assistant sidebar").click();
      await page.setViewportSize({ width: 1440, height: 1000 });
      expect(await panel.isVisible()).toBe(false);
    }),
  );
});
