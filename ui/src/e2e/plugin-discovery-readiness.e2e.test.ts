import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  discoveryCategories,
  discoveryResult,
  localOnlyDiscoveryPlugin,
  matrixDiscoveryPlugin,
} from "../test-helpers/plugins-e2e-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Plugin discovery failed search readiness",
  startServerBeforeBrowser: true,
});
const remoteError =
  "ClawHub is unavailable: service unavailable. Installed plugins remain available.";
suite.define(() => {
  it("does not call a failed remote search empty and retains partial local matches", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 1000 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.list",
            "plugins.catalog.browse",
            "plugins.catalog.categories",
          ],
          methodResponses: {
            "plugins.list": {
              plugins: [
                {
                  id: "local-calendar",
                  name: "Local Calendar",
                  origin: "bundled",
                  installed: false,
                  enabled: false,
                  state: "not-installed",
                  category: "tool",
                  removable: false,
                },
              ],
              diagnostics: [],
              mutationAllowed: true,
            },
            "plugins.catalog.browse": discoveryResult,
            "plugins.catalog.categories": discoveryCategories,
          },
        });
        await page.goto(suite.server.baseUrl + "plugins");
        const results = page.locator(".plugin-catalog-results");
        await results.getByRole("heading", { name: "Matrix", exact: true }).first().waitFor();
        const query = page.getByRole("searchbox", { name: "Search plugins", exact: true });
        await gateway.setMethodResponse("plugins.catalog.browse", { items: [], remoteError });
        await query.fill("matrix");
        await gateway.waitForRequest("plugins.catalog.browse", { match: { query: "matrix" } });
        const error = results.getByRole("status").filter({ hasText: remoteError });
        await error.waitFor();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const artifacts = createControlUiE2eArtifactDir("plugin-discovery-readiness");
          const frame = await takeControlUiScreenshotFrame(page, results, [query, error], {
            elements: [results],
            animations: "disabled",
            scrollTo: query,
          });
          await writeFile(path.join(artifacts, "failed-search.png"), frame.png);
        }
        expect(
          await results.getByText("No plugins match your search.", { exact: true }).count(),
        ).toBe(0);
        expect(await query.inputValue()).toBe("matrix");
        await gateway.setMethodResponse("plugins.catalog.browse", {
          items: [matrixDiscoveryPlugin],
        });
        await error.getByRole("button", { name: "Try again", exact: true }).click();
        await results.getByRole("heading", { name: "Matrix", exact: true }).waitFor();
        expect(await error.count()).toBe(0);
        await gateway.setMethodResponse("plugins.catalog.browse", {
          items: [localOnlyDiscoveryPlugin],
          remoteError,
        });
        await query.fill("calendar");
        await error.waitFor();
        await results.getByRole("heading", { name: "Local Calendar", exact: true }).waitFor();
        expect(
          await results.getByText("No plugins match your search.", { exact: true }).count(),
        ).toBe(0);
        await gateway.setMethodResponse("plugins.catalog.browse", { items: [] });
        await query.fill("no-such-plugin");
        await results.getByText("No plugins match your search.", { exact: true }).waitFor();
        expect(await error.count()).toBe(0);
        expect(await gateway.getRequests("plugins.install")).toHaveLength(0);
      },
    );
  });
});
