import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { catalog, pluginId } from "./native-plugin-ui.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native plugin UI Unicode boundary" });

suite.define(() => {
  it("reports activation failures without splitting Unicode in a real browser", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const revision = "unicode-boundary";
        const fullError = `${"x".repeat(511)}😀tail`;
        const gateway = await installMockGateway(page, {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ],
          methodResponses: {
            "plugins.controlUi.list": catalog(revision),
            "plugins.controlUi.report": { ok: true },
          },
        });
        await page.route("**/__openclaw__/plugins/control-ui/ui-fixture/*/index.js", (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/javascript",
            body: `export default { id: ${JSON.stringify(pluginId)}, activate() { throw new Error(${JSON.stringify(fullError)}); } };`,
          }),
        );

        await page.goto(`${suite.server.baseUrl}plugin?plugin=${pluginId}&id=proof`);
        const report = await gateway.waitForRequest("plugins.controlUi.report");
        const params = report.params as {
          pluginId: string;
          revision: string;
          status: string;
          error: string;
        };
        expect(params).toEqual({
          pluginId,
          revision,
          status: "failed",
          error: "x".repeat(511),
        });
        console.info("native plugin Unicode-boundary proof", {
          status: params.status,
          errorCodeUnits: params.error.length,
          containsSurrogate: /\p{Surrogate}/u.test(params.error),
        });
      },
    );
  });
});
