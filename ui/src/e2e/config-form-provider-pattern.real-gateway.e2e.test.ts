import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { assertServedUi, pairFixture } from "./chat-lifecycle.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

let owner: OpenClawTestInstance;
const suite = createControlUiE2eSuite({
  name: "Provider-pattern models map in the built Control UI",
  startServerBeforeBrowser: true,
  async startServer() {
    owner = await createOpenClawTestInstance({
      name: "provider-pattern-models",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined, NODE_ENV: undefined },
      config: {
        gateway: { controlUi: { enabled: true } },
        cron: { enabled: false },
        agents: {
          defaults: { model: "fixture/unused", modelPolicy: { allow: ["fixture/unused"] } },
          entries: { main: { identity: { name: "Pattern fixture" } } },
        },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            fixture: {
              api: "openai-completions",
              apiKey: "synthetic-pattern-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [{ id: "unused", name: "Unused fixture model" }],
            },
          },
        },
      },
    });
    try {
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      await owner.cleanup();
      throw error;
    }
  },
});

suite.define(() => {
  it("edits a provider-pattern models map in the built Control UI and keeps it after reload", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        await pairFixture(page, owner);
        await assertServedUi(page, suite.server.baseUrl);

        await page.goto(`${suite.server.baseUrl}settings/ai-agents`);
        await waitForControlUiRoute(page, { routeId: "ai-agents" });
        await waitForControlUiGatewayReady(page);

        // The bundled vLLM plugin refines agents.defaults.models with patternProperties.
        // The map must render the editor, not the Raw-mode fallback notice.
        const modelsMap = page.locator(".cfg-map").first();
        await modelsMap.waitFor({ state: "visible" });
        await expect(page.getByText("Unsupported schema node")).toHaveCount(0);
        const editorShot = await takeControlUiScreenshotFrame(page, page.locator("body"), [], {
          animations: "disabled",
        });
        await writeFile(
          path.join(suite.artifactDir, "provider-pattern-models-editor.png"),
          editorShot.png,
        );

        // Add an entry, save, reload: the entry must persist.
        await modelsMap.getByRole("button", { name: "Add", exact: true }).click();
        const keyInput = modelsMap.locator("input").first();
        await keyInput.fill("vllm/proof-model");
        const aliasInput = modelsMap.locator("input").nth(1);
        await aliasInput.fill("proof-alias");
        await page.getByRole("button", { name: "Save", exact: true }).first().click();
        await page.waitForFunction(() => !document.querySelector("button[disabled]") || true);
        await page.waitForTimeout(1500);

        await page.reload();
        await waitForControlUiGatewayReady(page);
        await waitForControlUiRoute(page, { routeId: "ai-agents" });
        const persisted = page.locator(".cfg-map").first();
        await persisted.waitFor({ state: "visible" });
        await expect(persisted).toContainText("vllm/proof-model");
        const reloadedShot = await takeControlUiScreenshotFrame(page, page.locator("body"), [], {
          animations: "disabled",
        });
        await writeFile(
          path.join(suite.artifactDir, "provider-pattern-models-reloaded.png"),
          reloadedShot.png,
        );
      },
    );
  }, 180_000);
});
