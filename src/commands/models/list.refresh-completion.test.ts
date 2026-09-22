import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unregisterResolvedAgentDir } from "../../agents/agent-dir-registry.js";
import { replaceRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/runtime-snapshots.js";
import { usePreparedCatalogWorkerFixtures } from "../../agents/test-helpers/prepared-model-catalog-worker-fixture.js";
import * as runtimeConfig from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as gateway from "../../gateway/call.js";
import * as gatewayLock from "../../infra/gateway-lock.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { modelsListCommand } from "./list.list-command.js";
import * as configLoader from "./load-config.js";

const providerId = "refresh-completion-fixture";
const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

afterEach(() => vi.restoreAllMocks());

describe("standalone models list refresh", () => {
  it("waits for discovery beyond the Gateway foreground window before printing rows", async () => {
    const root = makeTempDir("openclaw-models-list-refresh-");
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const workspaceDir = path.join(root, "workspace");
    const pluginDir = path.join(root, "plugin");
    const marker = path.join(root, "discovery-started");
    const hold = path.join(root, "discovery-hold");
    for (const directory of [agentDir, workspaceDir, pluginDir]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(hold, "");
    const pluginFile = path.join(pluginDir, "index.cjs");
    fs.writeFileSync(
      pluginFile,
      `const fs = require("node:fs");
module.exports = {
  id: ${JSON.stringify(providerId)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(providerId)},
      label: "Refresh completion fixture",
      auth: [],
      catalog: {
        async run() {
          fs.writeFileSync(${JSON.stringify(marker)}, "started");
          await new Promise((resolve) => {
            const check = () => {
              if (!fs.existsSync(${JSON.stringify(hold)})) {
                fs.unwatchFile(${JSON.stringify(hold)}, check);
                resolve();
              }
            };
            fs.watchFile(${JSON.stringify(hold)}, { interval: 10 }, check);
            check();
          });
          return { provider: {
            api: "openai-completions",
            baseUrl: "https://refresh-completion.invalid/v1",
            models: [{ id: "discovered-model", name: "Discovered model" }],
          } };
        },
      },
    });
  },
};
`,
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: providerId,
        providers: [providerId],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        modelCatalog: { discovery: { [providerId]: "runtime" } },
      }),
    );
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { model: `${providerId}/discovered-model` },
        entries: { main: { workspace: workspaceDir, agentDir } },
      },
      models: {
        providers: {
          [providerId]: {
            api: "openai-completions",
            baseUrl: "https://refresh-completion.invalid/v1",
            apiKey: "refresh-completion-key-not-real",
            models: [],
          },
        },
      },
      plugins: {
        allow: [providerId],
        load: { paths: [pluginFile] },
        entries: { [providerId]: { enabled: true } },
      },
    };
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_GATEWAY_PORT: undefined,
    };
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: { version: 1, profiles: {} } }]);
    retireAfterTest(() => {
      unregisterResolvedAgentDir({ agentId: "main", agentDir, env });
    });
    vi.spyOn(runtimeConfig, "getRuntimeConfig").mockReturnValue(config);
    vi.spyOn(configLoader, "loadModelsConfigWithSource").mockResolvedValue({
      sourceConfig: config,
      resolvedConfig: config,
      diagnostics: [],
    });
    vi.spyOn(gateway, "isImplicitLocalGatewayTarget").mockResolvedValue(true);
    vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockResolvedValue(undefined);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      writeJson: vi.fn(),
      writeStdout: vi.fn(),
    };
    await withEnvAsync(env, async () => {
      let completed = false;
      const command = modelsListCommand(
        { agent: "main", provider: providerId, refresh: true, json: true },
        runtime,
      ).finally(() => {
        completed = true;
      });
      void command.catch(() => {});
      try {
        await expect.poll(() => fs.existsSync(marker) || completed, { timeout: 30_000 }).toBe(true);
        expect(completed).toBe(false);
        expect(fs.existsSync(marker)).toBe(true);
        // A live worker cannot use fake timers. Keep discovery held beyond the old five-second race.
        await delay(5_100);
        expect(completed).toBe(false);
        expect(runtime.writeJson).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(hold, { force: true });
        await command;
      }
      expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith(
        {
          count: 1,
          models: [
            expect.objectContaining({
              key: `${providerId}/discovered-model`,
              name: "Discovered model",
            }),
          ],
        },
        2,
      );
      expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
        "Gateway is not running. Refreshing the local model catalog.",
      );
    });
  });
});
