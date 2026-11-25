import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import { emptyPairingSnapshot } from "../pages/channels/pairing.test-support.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { configSchema, objectSchema } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Channel initial status audit",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("does not claim a configured channel is unconfigured after its first status read fails", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        viewport: { width: 1280, height: 1000 },
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const config = {
          channels: {
            telegram: { enabled: true, dmPolicy: "pairing", botToken: "__OPENCLAW_REDACTED__" },
          },
        };
        const snapshot = sourceConfigSnapshot(config, "status-audit");
        const schema = configSchema(
          objectSchema("", {
            channels: objectSchema("", {
              telegram: objectSchema("Telegram", {
                enabled: { type: "boolean", title: "Enabled" },
                botToken: { type: "string", title: "Bot Token" },
              }),
            }),
          }),
          { "channels.telegram.botToken": { sensitive: true, advanced: false } },
        );
        const result = (configured: boolean) => ({
          ts: Date.now(),
          channelOrder: ["telegram"],
          channelLabels: { telegram: "Telegram" },
          channels: { telegram: { configured, running: configured, connected: configured } },
          channelAccounts: {},
          channelDefaultAccountId: {},
          channelMeta: [{ id: "telegram", label: "Telegram" }],
        });
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "channels.status", "config.get"],
          methodResponses: {
            "plugins.list": { plugins: [], diagnostics: [], mutationAllowed: true },
            "plugins.controlUi.list": { plugins: [], diagnostics: [], revision: "empty" },
            "channels.status": {
              __mockError: {
                code: "UNAVAILABLE",
                message: "Channel inventory temporarily unavailable",
                retryable: true,
              },
            },
            "channels.pairing.list": emptyPairingSnapshot(),
            "config.get": { ...snapshot, runtimeConfig: config },
            "config.schema": schema,
          },
        });
        await page.goto(suite.server.baseUrl + "settings/channels");
        await page
          .getByRole("alert")
          .filter({ hasText: "Channel inventory temporarily unavailable" })
          .waitFor();
        await page.locator(".channels-item__detail").filter({ hasText: "Telegram" }).click();
        const detail = page.locator(".channels-detail");
        await detail.waitFor();
        const state = detail.locator(".channels-detail__state");
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const artifacts = createControlUiE2eArtifactDir("channel-initial-status-audit");
          const frame = await takeControlUiScreenshotFrame(page, detail, [detail], {
            elements: [detail],
            animations: "disabled",
          });
          await writeFile(path.join(artifacts, "first-status-failure.png"), frame.png);
        }
        expect.soft(await state.textContent()).not.toContain("Not configured");
        await gateway.setMethodResponse("channels.status", result(true));
        const before = (await gateway.getRequests("channels.status")).length;
        await gateway.deferNext("channels.status");
        await detail.locator(".channels-detail__check").click();
        await gateway.waitForRequest("channels.status", { after: before });
        expect.soft(await state.textContent()).not.toContain("Not configured");
        await gateway.resolveDeferred("channels.status");
        await expect.poll(() => state.textContent()).toContain("Running");
        await gateway.setMethodResponse("channels.status", result(false));
        await detail.locator(".channels-detail__check").click();
        await expect.poll(() => state.textContent()).toContain("Not configured");
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        expect(await gateway.getRequests("wizard.start")).toHaveLength(0);
      },
    );
  });
});
