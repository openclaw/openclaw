import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { unregisterResolvedAgentDir } from "../../agents/agent-dir-registry.js";
import { loadPersistedPluginModelCatalogsReadOnly } from "../../agents/plugin-model-catalog.js";
import { usePreparedCatalogWorkerFixtures } from "../../agents/test-helpers/prepared-model-catalog-worker-fixture.js";
import { writeTempPlugin } from "../../agents/test-helpers/temp-plugin-extension-fixtures.js";
import * as runtimeConfig from "../../config/config.js";
import * as gateway from "../../gateway/call.js";
import * as gatewayLock from "../../infra/gateway-lock.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createNonExitingRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";
import { modelsListCommand } from "./list.list-command.js";

const providerId = "refresh-completion-fixture";
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
afterEach(() => {
  vi.restoreAllMocks();
  runtimeConfig.clearRuntimeConfigSnapshot();
  return state.cleanup();
});
// Workers retire before the state fixture they use.
const { retireAfterTest } = usePreparedCatalogWorkerFixtures();

it("persists a slow offline models list refresh once before printing its discovered rows", async () => {
  state = await createOpenClawTestState({
    label: "models-list-refresh",
    layout: "split",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_GATEWAY_PORT: undefined },
  });
  const agentDir = state.agentDir();
  const marker = state.path("discovery-started");
  const hold = await state.writeText("discovery-hold", "");
  const provider = {
    api: "openai-completions" as const,
    baseUrl: "https://refresh-completion.invalid/v1",
  };
  const pluginFile = writeTempPlugin({
    dir: state.root,
    id: providerId,
    filename: "index.cjs",
    manifest: { providers: [providerId], modelCatalog: { discovery: { [providerId]: "runtime" } } },
    body: `const fs = require("node:fs");
module.exports = {
  id: ${JSON.stringify(providerId)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(providerId)},
      label: "Refresh completion fixture",
      auth: [],
      catalog: {
        async run() {
          fs.appendFileSync(${JSON.stringify(marker)}, "started\\n");
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
          return { provider: { ...${JSON.stringify(provider)},
            models: [{ id: "discovered-model", name: "Discovered model" }],
          } };
        },
      },
    });
  },
};
`,
  });
  await state.writeConfig({
    agents: {
      ownership: "explicit",
      defaults: { model: `${providerId}/discovered-model` },
      entries: { main: { workspace: state.workspaceDir, agentDir } },
    },
    models: {
      providers: {
        [providerId]: {
          ...provider,
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
  });
  retireAfterTest(() => {
    unregisterResolvedAgentDir({ agentId: "main", agentDir, env: state.env });
  });
  vi.spyOn(gateway, "isImplicitLocalGatewayTarget").mockResolvedValue(true);
  vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockResolvedValue(undefined);
  const runtime = createNonExitingRuntimeEnv();
  // Preserve the full refresh budget, including time beyond normal generation preparation.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
    await vi.advanceTimersByTimeAsync(125_100);
    expect(completed).toBe(false);
    expect(runtime.writeJson).not.toHaveBeenCalled();
  } finally {
    try {
      fs.rmSync(hold, { force: true });
      await command;
    } finally {
      vi.useRealTimers();
    }
  }
  expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      count: 1,
      models: [
        expect.objectContaining({
          key: `${providerId}/discovered-model`,
          name: "Discovered model",
        }),
      ],
    }),
    2,
  );
  expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
    "Gateway is not running. Refreshing the local model catalog.",
  );
  expect(fs.readFileSync(marker, "utf8")).toBe("started\n");
  const persisted = loadPersistedPluginModelCatalogsReadOnly(agentDir).find(
    (entry) => entry.pluginId === providerId,
  );
  expect(persisted).toMatchObject({ pluginId: providerId, contents: expect.any(String) });
  expect(JSON.parse(persisted!.contents)).toMatchObject({
    providers: { [providerId]: { models: [{ id: "discovered-model", name: "Discovered model" }] } },
  });
});
