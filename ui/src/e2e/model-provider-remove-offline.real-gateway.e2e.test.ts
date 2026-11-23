import fs from "node:fs/promises";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.js";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.js";
import { createProviderProofCapture, expandProvider } from "./model-providers.test-support.ts";

let instance: OpenClawTestInstance;
const suite = createControlUiE2eSuite({
  name: "Remove an offline configured provider",
  startServerBeforeBrowser: true,
  async startServer() {
    instance = await createOpenClawTestInstance({
      name: "model-provider-remove-offline",
      reserveIdlePort: false,
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        VITEST: undefined,
        NODE_ENV: undefined,
        ...Object.fromEntries(
          Object.keys(process.env)
            .filter((key) => key.endsWith("_API_KEY"))
            .map((key) => [key, undefined]),
        ),
        OLLAMA_HOST: undefined,
      },
      config: {
        gateway: { controlUi: { enabled: true, root: "dist/control-ui" } },
        agents: { entries: { main: {} }, defaults: { model: "fixture/current" } },
        models: {
          providers: {
            minimax: {
              api: "openai-completions",
              apiKey: "synthetic-minimax-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [{ id: "global", name: "Global" }],
            },
            "minimax-cn": {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [{ id: "regional", name: "Regional" }],
            },
            fixture: {
              api: "openai-completions",
              apiKey: "synthetic-fixture-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [{ id: "current", name: "Fixture model" }],
            },
            ollama: {
              api: "ollama",
              apiKey: "ollama-local",
              baseUrl: "http://127.0.0.1:9",
              models: [
                { id: "local-one", name: "Local One" },
                { id: "local-two", name: "Local Two" },
              ],
            },
          },
        },
        plugins: { allow: ["ollama"] },
      },
    });
    try {
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close: () => instance.cleanup() };
    } catch (error) {
      await instance.cleanup();
      throw error;
    }
  },
});

async function persistedConfig(): Promise<OpenClawConfig> {
  return JSON.parse(await fs.readFile(instance.configPath, "utf8"));
}

suite.define(() => {
  it("removes only the confirmed offline or grouped entry and preserves the default after reload", async () => {
    const handoff = await instance.cli(["dashboard", "--json"]);
    expect(handoff.code, handoff.stderr).toBe(0);
    const { browserUrl }: { browserUrl: string } = JSON.parse(handoff.stdout);
    const url = new URL("settings/model-providers", browserUrl);
    url.hash = new URL(browserUrl).hash;
    const artifacts = createControlUiE2eArtifactDir("model-provider-remove-offline");
    const capture = createProviderProofCapture(() => artifacts);
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await page.goto(url.href);
        await waitForControlUiGatewayReady(page);
        const card = await expandProvider(page, "ollama");
        const before = await persistedConfig();
        const { ollama, ...siblings } = before.models!.providers!;
        expect(ollama?.models).toHaveLength(2);
        await capture("before-click.png", card);

        await card.getByRole("button", { name: "Remove provider: Ollama", exact: true }).click();
        const dialog = page.locator("openclaw-modal-dialog");
        const confirm = dialog.getByRole("button", { name: "Remove provider", exact: true });
        await confirm.click();
        await expect
          .poll(async () => (await persistedConfig()).models?.providers?.ollama, {
            timeout: 20_000,
          })
          .toBeUndefined();

        await page.reload();
        await waitForControlUiGatewayReady(page);
        const fixture = await expandProvider(page, "fixture");
        await capture("after-reload.png", fixture);
        await expect.poll(() => card.count()).toBe(0);
        const after = await persistedConfig();
        expect(after.models?.providers).toEqual(siblings);
        expect(after.agents?.defaults?.model).toBe("fixture/current");

        const grouped = await expandProvider(page, "minimax");
        await grouped.locator(".provider-row__footer").scrollIntoViewIfNeeded();
        await capture("grouped-entries.png", grouped);
        const regional = grouped.getByRole("button", {
          name: "Remove provider: minimax-cn",
          exact: true,
        });
        expect(await regional.count()).toBe(1);
        await regional.click();
        expect(await dialog.textContent()).toContain("minimax-cn");
        await confirm.click();
        await expect
          .poll(async () => (await persistedConfig()).models?.providers?.["minimax-cn"])
          .toBeUndefined();
        await page.reload();
        await waitForControlUiGatewayReady(page);
        const remaining = await expandProvider(page, "minimax");
        expect(await remaining.getByRole("button", { name: /^Remove provider:/ }).count()).toBe(1);
        const final = await persistedConfig();
        expect(final.models?.providers).toEqual({
          fixture: siblings.fixture,
          minimax: siblings.minimax,
        });
        expect(final.agents?.defaults?.model).toBe("fixture/current");
      },
    );
  });
});
