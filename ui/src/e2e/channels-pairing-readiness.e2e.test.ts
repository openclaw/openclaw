import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import { emptyPairingSnapshot, pairingSnapshot } from "../pages/channels/pairing.test-support.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Pairing inventory readiness",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("does not report no pairing accounts after a failed first inventory", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        viewport: { width: 1280, height: 1000 },
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const config = { channels: { telegram: { enabled: true, dmPolicy: "pairing" } } };
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "channels.pairing.list"],
          methodResponses: {
            "config.get": sourceConfigSnapshot(config, "pairing-readiness"),
            "plugins.list": { plugins: [], diagnostics: [], mutationAllowed: true },
            "plugins.controlUi.list": { plugins: [], diagnostics: [], revision: "empty" },
            "channels.status": {
              ts: Date.now(),
              channelOrder: ["telegram"],
              channelLabels: { telegram: "Telegram" },
              channels: { telegram: { configured: true, running: true } },
              channelAccounts: {},
              channelDefaultAccountId: {},
            },
            "channels.pairing.list": {
              __mockError: {
                code: "UNAVAILABLE",
                message: "DM access inventory temporarily unavailable",
                retryable: true,
              },
            },
          },
        });
        await page.goto(suite.server.baseUrl + "settings/channels");
        const queue = page.locator("#channels-pairing-requests");
        await queue
          .getByRole("alert")
          .filter({ hasText: "DM access inventory temporarily unavailable" })
          .waitFor();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const artifacts = createControlUiE2eArtifactDir("pairing-inventory-readiness");
          const frame = await takeControlUiScreenshotFrame(page, queue, [queue], {
            elements: [queue],
            animations: "disabled",
            scrollTo: queue,
          });
          await writeFile(path.join(artifacts, "first-pairing-failure.png"), frame.png);
        }
        const empty = queue.getByText("No channel accounts use DM access requests yet.", {
          exact: true,
        });
        expect.soft(await empty.count()).toBe(0);
        const refresh = queue.getByRole("button", { name: "Refresh", exact: true });
        const before = (await gateway.getRequests("channels.pairing.list")).length;
        await gateway.setMethodResponse("channels.pairing.list", emptyPairingSnapshot());
        await gateway.deferNext("channels.pairing.list");
        await refresh.click();
        await gateway.waitForRequest("channels.pairing.list", { after: before });
        await queue.locator(".settings-loading-skeleton").waitFor();
        expect(await empty.count()).toBe(0);
        await gateway.resolveDeferred("channels.pairing.list");
        await empty.waitFor();
        await gateway.setMethodResponse(
          "channels.pairing.list",
          pairingSnapshot({
            accounts: [
              {
                channel: "telegram",
                channelLabel: "Telegram",
                accountId: "default",
                accountLabel: "Garden bot",
                notifySupported: true,
              },
            ],
            requests: [],
            commandOwnerConfigured: true,
          }),
        );
        await refresh.click();
        await queue.getByText("No DM access requests yet.", { exact: true }).waitFor();
        expect(await empty.count()).toBe(0);
        await gateway.setMethodResponse("channels.pairing.list", {
          __mockError: { code: "UNAVAILABLE", message: "Later DM access read failed" },
        });
        await refresh.click();
        await queue.getByRole("alert").filter({ hasText: "Later DM access read failed" }).waitFor();
        expect(
          await queue.getByText("No DM access requests yet.", { exact: true }).isVisible(),
        ).toBe(true);
        expect(await empty.count()).toBe(0);
        expect(await gateway.getRequests("channels.pairing.approve")).toHaveLength(0);
        expect(await gateway.getRequests("channels.pairing.dismiss")).toHaveLength(0);
      },
    );
  });
});
