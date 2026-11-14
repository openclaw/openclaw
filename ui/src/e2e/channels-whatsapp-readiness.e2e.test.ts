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
  name: "WhatsApp status readiness",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("keeps unobserved WhatsApp connection facts unknown after a first status failure", async () => {
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
            whatsapp: { enabled: true, dmPolicy: "pairing" },
          },
        };
        const snapshot = sourceConfigSnapshot(config, "status-audit");
        const schema = configSchema(
          objectSchema("", {
            channels: objectSchema("", {
              whatsapp: objectSchema("WhatsApp", {
                enabled: { type: "boolean", title: "Enabled" },
              }),
            }),
          }),
          {},
        );
        const result = (configured: boolean) => ({
          ts: Date.now(),
          channelOrder: ["whatsapp"],
          channelLabels: { whatsapp: "WhatsApp" },
          channels: {
            whatsapp: {
              configured,
              linked: configured,
              running: configured,
              connected: configured,
            },
          },
          channelAccounts: {},
          channelDefaultAccountId: {},
          channelMeta: [{ id: "whatsapp", label: "WhatsApp" }],
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
        await page.locator(".channels-item__detail").filter({ hasText: "WhatsApp" }).click();
        const detail = page.locator(".channels-detail");
        await detail.waitFor();
        await detail.getByRole("button", { name: "Show QR", exact: true }).waitFor();
        const linked = detail
          .locator(".settings-row")
          .filter({ has: page.locator(".settings-row__title", { hasText: /^Linked$/ }) })
          .locator(".settings-row__desc");
        const details = detail.locator("summary", { hasText: "Details" });
        if (await details.isVisible()) {
          await details.click();
        }
        expect.soft(await details.isVisible()).toBe(false);
        const facts = () => detail.locator("dt").allTextContents();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const artifacts = createControlUiE2eArtifactDir("whatsapp-initial-status-audit");
          const frame = await takeControlUiScreenshotFrame(page, detail, [detail], {
            elements: [detail],
            animations: "disabled",
          });
          await writeFile(path.join(artifacts, "first-status-failure.png"), frame.png);
        }
        expect.soft(await linked.textContent()).toBe("");
        expect.soft(await facts()).not.toContain("Linked");
        const refresh = async () => {
          await detail.getByRole("button", { name: "Close", exact: true }).click();
          await page
            .locator(".settings-section")
            .filter({ has: page.getByRole("heading", { name: "Connected channels", exact: true }) })
            .getByRole("button", { name: "Refresh", exact: true })
            .click();
          await page
            .locator("button.channels-item, button.channels-item__detail")
            .filter({ hasText: "WhatsApp" })
            .first()
            .click();
        };
        await gateway.setMethodResponse("channels.status", result(true));
        const before = (await gateway.getRequests("channels.status")).length;
        await gateway.deferNext("channels.status");
        await refresh();
        await gateway.waitForRequest("channels.status", { after: before });
        expect.soft(await linked.textContent()).toBe("");
        expect.soft(await facts()).not.toContain("Linked");
        await gateway.resolveDeferred("channels.status");
        await expect.poll(() => linked.textContent()).toBe("Yes");
        await gateway.setMethodResponse("channels.status", result(false));
        await refresh();
        await expect.poll(() => linked.textContent()).toBe("No");
        await gateway.setMethodResponse("channels.status", {
          ...result(true),
          channels: {
            whatsapp: {
              configured: true,
              statusState: "unstable",
              running: false,
              connected: false,
            },
          },
        });
        await refresh();
        await expect.poll(() => linked.textContent()).toBe("");
        expect(await facts()).not.toContain("Linked");
        expect(await detail.getByRole("button", { name: "Show QR", exact: true }).isEnabled()).toBe(
          true,
        );
        expect(await gateway.getRequests("web.login.start")).toHaveLength(0);
        expect(await gateway.getRequests("channels.logout")).toHaveLength(0);
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        expect(await gateway.getRequests("wizard.start")).toHaveLength(0);
      },
    );
  });
});
