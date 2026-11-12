import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  createKnowledgeFixture,
  installRemainingPluginMock,
} from "../../../scripts/lib/plugin-view-benchmark-fixtures.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import { installNativePluginMockGateway } from "../test-helpers/control-ui-plugin-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const pluginRoot = fileURLToPath(new URL("../../../extensions/knowledge/", import.meta.url));
const suite = createControlUiE2eSuite({ name: "Knowledge reading text" });

suite.define(() => {
  it("smooths page prose and claims for reading while chrome stays antialiased", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const fixture = createKnowledgeFixture(20, Date.now());
      await installNativePluginMockGateway(page, {
        nativePlugins: [
          { pluginId: "knowledge", rootDir: pluginRoot, source: "src/control-ui.ts" },
        ],
        featureMethods: [...defaultControlUiFeatureMethods, "plugins.sessionAction"],
        sessionKey: fixture.sessionKey,
        mainSessionKey: fixture.sessionKey,
        sessions: [fixture.session],
      });
      await page.addInitScript(installRemainingPluginMock, fixture);
      // Computed style is platform-neutral; macOS applies it as stem darkening for `auto`.
      const smoothing = (selector: string) =>
        page
          .locator(selector)
          .first()
          .evaluate((element) =>
            getComputedStyle(element).getPropertyValue("-webkit-font-smoothing"),
          );
      const knowledge = `${suite.server.baseUrl}plugin?plugin=knowledge&id=overview`;

      await page.goto(knowledge);
      await page.locator(".knowledge-source-claims .knowledge-claim-copy").first().waitFor();
      const claim = await smoothing(".knowledge-claim-copy");
      await page.goto(`${knowledge}&p.record=page-0`);
      await page.locator(".knowledge-markdown").getByText("Initial notes marker.").waitFor();
      expect({
        body: await smoothing("body"),
        chrome: await smoothing(".knowledge-header"),
        claim,
        prose: await smoothing(".knowledge-markdown"),
      }).toEqual({ body: "antialiased", chrome: "antialiased", claim: "auto", prose: "auto" });
    });
  });
});
