import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function setupTempHome() {
  const home = tempDirs.make("openclaw-rpc-models-");
  const stateDir = path.join(home, ".openclaw");
  const workspace = path.join(home, "workspace");
  const bundledPlugins = path.join(home, "empty-bundled-plugins");
  await Promise.all(
    [stateDir, workspace, bundledPlugins].map((dir) => fs.mkdir(dir, { recursive: true })),
  );
  const values = {
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPlugins,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_CONFIG_PATH: undefined,
    OPENCLAW_SKIP_PROVIDERS: undefined,
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
  };
  return {
    configPath: path.join(stateDir, "openclaw.json"),
    env: values,
    workspace,
  };
}

it(
  "returns configured public model metadata without provider internals",
  { timeout: 30_000 },
  async () => {
    const temp = await setupTempHome();
    const token = `rpc-models-${process.pid}`;
    const modelRef = "fixture/catalog-model";
    let started: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

    await withEnvAsync(temp.env, async () => {
      try {
        started = await startGatewayWithClient({
          cfg: {
            agents: {
              defaults: {
                workspace: temp.workspace,
                model: { primary: modelRef },
                models: { [modelRef]: { alias: "Catalog Alias" } },
              },
            },
            gateway: { auth: { mode: "token", token } },
            models: {
              mode: "replace",
              providers: {
                fixture: {
                  apiKey: "rpc-model-secret",
                  baseUrl: "http://127.0.0.1:9/v1",
                  models: [
                    {
                      id: "catalog-model",
                      name: "Catalog Model",
                      contextWindow: 8192,
                      reasoning: true,
                      compat: { supportsTools: true },
                    },
                  ],
                },
              },
            },
          },
          configPath: temp.configPath,
          token,
          clientDisplayName: "rpc-models-reader",
        });

        const payload = (await started.client.request("models.list", {
          view: "configured",
        })) as {
          models: Array<Record<string, unknown>>;
        };
        expect(payload.models).toEqual([
          expect.objectContaining({
            alias: "Catalog Alias",
            contextWindow: 8192,
            id: "catalog-model",
            name: "Catalog Model",
            provider: "fixture",
            reasoning: true,
            supportsTools: true,
          }),
        ]);
        const model = payload.models[0] ?? {};
        expect(model).not.toHaveProperty("agentRuntime");
        expect(model).not.toHaveProperty("apiKey");
        expect(model).not.toHaveProperty("baseUrl");
        expect(JSON.stringify(payload)).not.toContain("rpc-model-secret");

        await expect(started.client.request("models.list", { unexpected: true })).rejects.toThrow(
          /invalid models\.list params/i,
        );
      } finally {
        if (started) {
          await disconnectGatewayClient(started.client).catch(() => undefined);
          await started.server.close({ reason: "gateway RPC model catalog proof complete" });
        }
      }
    });
  },
);
