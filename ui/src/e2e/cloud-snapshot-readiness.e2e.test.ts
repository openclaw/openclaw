import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import { snapshotListFixture } from "../pages/cloud-workers/cloud-worker-snapshots.test-support.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  defaultControlUiFeatureMethods,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Cloud snapshot readiness audit",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("keeps unknown snapshots distinct from ready images and confirmed cold repositories", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 1000 }, locale: "en-US", colorScheme: "light" },
      async ({ page }) => {
        const config = {
          cloudWorkers: {
            profiles: {
              "linux-build": {
                provider: "crabbox",
                install: "bundle",
                settings: { provider: "aws", class: "standard" },
              },
            },
            projectProfiles: { "github.com/acme/app": "linux-build" },
          },
        };
        const images = snapshotListFixture();
        images.images = [
          {
            ...images.images[0]!,
            held: false,
            retirement: undefined,
            projectRoot: "/projects/app",
          },
        ];
        const gateway = await installMockGateway(page, {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "environments.list",
            "crabbox.images.list",
            "environments.prepare",
          ],
          deferredMethods: ["crabbox.images.list"],
          methodResponses: {
            "config.get": sourceConfigSnapshot(config, "cloud-readiness"),
            "environments.list": { environments: [], profiles: [] },
            "crabbox.images.list": images,
          },
        });
        await page.goto(suite.server.baseUrl + "settings/cloud-workers");
        await gateway.waitForRequest("crabbox.images.list");
        const row = page
          .locator(".cloud-environments__row")
          .filter({ hasText: "github.com/acme/app" });
        await row.waitFor();
        const sheet = page.locator(".cloud-environments__sheet");
        await sheet.waitFor();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const artifacts = createControlUiE2eArtifactDir("cloud-snapshot-readiness");
          const frame = await takeControlUiScreenshotFrame(page, sheet, [row, sheet], {
            elements: [row, sheet],
            animations: "disabled",
          });
          await writeFile(path.join(artifacts, "pending-snapshot.png"), frame.png);
        }
        expect.soft(await row.textContent()).not.toContain("Cold only");
        expect.soft(await sheet.textContent()).not.toContain("Cold only");
        await gateway.setMethodResponse("crabbox.images.list", {
          __mockError: { code: "UNAVAILABLE", message: "Snapshot inventory unavailable" },
        });
        await gateway.rejectDeferred("crabbox.images.list", {
          code: "UNAVAILABLE",
          message: "Snapshot inventory unavailable",
        });
        await page
          .getByRole("alert")
          .filter({ hasText: "Snapshot inventory unavailable" })
          .waitFor();
        expect.soft(await row.textContent()).not.toContain("Cold only");
        expect.soft(await sheet.textContent()).not.toContain("Cold only");
        const reopen = async () => {
          await page.getByRole("link", { name: "Channels", exact: true }).first().click();
          await page.getByRole("link", { name: "Cloud environments", exact: true }).first().click();
          await sheet.waitFor();
        };
        await gateway.setMethodResponse("crabbox.images.list", images);
        await reopen();
        await expect.poll(() => row.textContent()).toContain("Ready");
        await sheet.getByText("01234567", { exact: true }).waitFor();
        await gateway.setMethodResponse("crabbox.images.list", { ...images, images: [] });
        await reopen();
        await expect.poll(() => row.textContent()).toContain("Cold only");
        await sheet.getByText("Cold only", { exact: true }).waitFor();
        expect(await gateway.getRequests("environments.prepare")).toHaveLength(0);
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      },
    );
  });
});
