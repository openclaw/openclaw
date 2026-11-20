import { writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeEmbed } from "./native-nav.test-support.ts";
import { makeDetection } from "./model-setup-fixtures.test-support.ts";
import { config, configMocks, pluginResponses } from "./plugins-settings-admin.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Plugin help in ordinary Home" });
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const methods = [
  ...defaultControlUiFeatureMethods,
  "plugins.list",
  "plugins.inspect",
  "plugins.catalog.get",
  "openclaw.chat.history",
  "openclaw.changes.list",
];

suite.define(() => {
  it.each([true, false])("routes legacy new-agent links by readiness without creating an agent (ready=%s)", async (ready) => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...methods, "openclaw.setup.detect"],
        agentModel: ready ? "openai/gpt-5.5" : null,
        methodResponses: { "openclaw.setup.detect": makeDetection() },
      });
      await page.goto(suite.server.baseUrl + "custodian?intent=new-agent");
      await expect.poll(() => new URL(page.url()).pathname).toBe(ready ? "/chat/main" : "/settings/model-setup");
      expect(await gateway.getRequests("agents.create")).toHaveLength(0);
      expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });
  it.each([390, 1440])(
    "keeps rejected credential edits redacted and existing Home drafts unsent at %s pixels",
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
          featureMethods: methods,
          methodResponses: {
            ...pluginResponses(),
            "config.get": {
              ...configMocks["config.get"],
              config: savedConfig,
              raw: JSON.stringify(savedConfig),
            },
            "config.schema": schema,
          },
          operatorScopes: ["operator.read", "operator.admin"],
        });
        await page.goto(suite.server.baseUrl + "settings/plugins/workboard?view=settings");
        const row = page.locator('[data-setting="baseUrl"]');
        const input = row.getByRole("textbox");
        const editedUrl =
          "https://fixture-user:fixture-password@example.invalid/?token=fixture-token";
        await input.fill(editedUrl);
        await gateway.deferNext("config.set");
        await input.press("Tab");
        await gateway.waitForRequest("config.set");
        await gateway.rejectDeferred("config.set", {
          code: "INVALID_REQUEST",
          message: "Fixture URL write rejected",
        });
        await page.getByRole("alert").filter({ hasText: "Fixture URL write rejected" }).waitFor();
        const ask = async () => {
          await row.getByRole("button", { name: "Actions for Base URL", exact: true }).click();
          await row.getByRole("menuitem", { name: "Ask your agent", exact: true }).click();
        };
        await ask();
        const panel = page.locator("openclaw-assistant-panel .assistant-panel");
        const composer = panel.locator(".agent-chat__composer-combobox textarea");
        await expect.poll(() => composer.inputValue()).toContain("Explain Base URL");
        await composer.fill("Keep my existing question.");
        if (width === 390) {
          await panel.getByRole("button", { name: "Close assistant sidebar", exact: true }).click();
        }
        await ask();
        await expect
          .poll(() => composer.inputValue())
          .toContain("Keep my existing question.\n\nExplain Base URL");
        const draft = await composer.inputValue();
        expect(draft).toContain("Current value: <redacted>");
        expect(draft).toContain('"id":"workboard"');
        expect(draft).not.toMatch(/fixture-password|fixture-token/);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
        if (capture) {
          const frame = await takeControlUiScreenshotFrame(page, panel, [composer], {
            elements: [panel, composer],
            animations: "disabled",
          });
          await writeFile(
            path.join(suite.artifactDir, "home-help-after-" + width + ".png"),
            frame.png,
          );
        }
        await composer.press("Enter");
        const sent = await gateway.waitForRequest("chat.send");
        expect(asRecord(sent.params)).toMatchObject({
          sessionKey: "agent:main:main",
          message: draft,
        });
        expect(await gateway.getRequests("config.set")).toHaveLength(1);
        expect(await gateway.getRequests("openclaw.chat.history")).toHaveLength(0);
      });
    },
  );

  it.each(["ios", "android"] as const)(
    "opens visible ordinary chat from embedded %s Settings",
    async (platform) => {
      await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
        await installNativeEmbed(page, { platform, formFactor: "phone" });
        const gateway = await installMockGateway(page, {
          featureMethods: methods,
          methodResponses: pluginResponses(),
          operatorScopes: ["operator.admin"],
        });
        await page.goto(suite.server.baseUrl + "settings/plugins/workboard?view=settings");
        const row = page.locator('[data-setting="refreshMinutes"]');
        await row
          .getByRole("button", { name: "Actions for Refresh interval (minutes)", exact: true })
          .click();
        await row.getByRole("menuitem", { name: "Ask your agent", exact: true }).click();
        const composer = page.locator("openclaw-chat-page .agent-chat__composer-combobox textarea");
        await expect.poll(() => composer.inputValue()).toContain("Explain Refresh interval");
        expect(await composer.isVisible()).toBe(true);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
      });
    },
  );

  it.each([true, false])(
    "keeps machine-wide history independent and admin gated (admin=%s)",
    async (admin) => {
      await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: methods,
          operatorScopes: [admin ? "operator.admin" : "operator.read"],
          methodResponses: {
            "openclaw.changes.list": {
              entries: [
                {
                  id: "change-1",
                  at: 1700000000000,
                  kind: "config-write",
                  source: "config-rpc",
                  summary: "Updated plugin settings",
                },
              ],
            },
            "openclaw.chat.history": {
              turns: [
                { role: "assistant", text: "Earlier setup conversation.", at: 1700000000000 },
              ],
            },
          },
        });
        await page.goto(suite.server.baseUrl + "settings/system-history");
        if (admin) {
          await page.getByText("Updated plugin settings", { exact: true }).waitFor();
          await page.getByText("Earlier setup conversation.", { exact: true }).waitFor();
          if (capture) {
            const surface = page.locator(".settings-page");
            const frame = await takeControlUiScreenshotFrame(
              page,
              surface,
              [page.getByText("Earlier setup conversation.", { exact: true })],
              { animations: "disabled" },
            );
            await writeFile(path.join(suite.artifactDir, "system-history-after.png"), frame.png);
          }
        } else {
          await page
            .getByText("Connect with administrator access to read system history.", { exact: true })
            .waitFor();
          expect(await gateway.getRequests("openclaw.changes.list")).toHaveLength(0);
          expect(await gateway.getRequests("openclaw.chat.history")).toHaveLength(0);
        }
        expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      });
    },
  );
});
