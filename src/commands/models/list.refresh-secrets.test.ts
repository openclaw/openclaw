import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { unregisterResolvedAgentDir } from "../../agents/agent-dir-registry.js";
import { loadPersistedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import { loadPersistedPluginModelCatalogsReadOnly } from "../../agents/plugin-model-catalog.js";
import { usePreparedCatalogWorkerFixtures } from "../../agents/test-helpers/prepared-model-catalog-worker-fixture.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as gateway from "../../gateway/call.js";
import { clearSecretsRuntimeSnapshot } from "../../secrets/runtime.js";
import { writeSecretStoreEntry } from "../../secrets/store/secret-store.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createNonExitingRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { createTestModelDefinition } from "../test-runtime-config-helpers.js";
import { modelsListCommand } from "./list.list-command.js";
import { runAuthProbes } from "./list.probe.js";

const provider = "offline-secret-fixture";
const credential = "synthetic-offline-catalog-key";
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let server: Awaited<ReturnType<typeof reserveTestPortListener<Server>>>;
let requests: boolean[];
let release: ReturnType<typeof createDeferredCore<void>>;
let baseUrl: string;

beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "model-secrets",
    layout: "split",
    env: {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_GATEWAY_PORT: undefined,
      PROBE_ACCOUNT_KEY: credential,
      PROBE_ACCOUNT_MISSING: undefined,
    },
  });
  requests = [];
  release = createDeferredCore();
  server = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        requests.push(request.headers.authorization === `Bearer ${credential}`);
        request.resume();
        if (request.url === "/v1/models") {
          void release.promise.then(() => {
            response.setHeader("content-type", "application/json");
            response.end('{"data":[{"id":"discovered-model","name":"Discovered model"}]}');
          });
        } else if (request.url === "/v1/chat/completions") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            [
              'data: {"id":"probe-response","object":"chat.completion.chunk","created":1,"model":"probe-model","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
              'data: {"id":"probe-response","object":"chat.completion.chunk","created":1,"model":"probe-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
              "data: [DONE]\n\n",
            ].join("\n\n"),
          );
        } else {
          response.writeHead(404).end();
        }
      }),
  });
  baseUrl = `http://127.0.0.1:${server.claim.port}/v1`;
  retireAfterTest(() => {
    unregisterResolvedAgentDir({ agentId: "main", agentDir: state.agentDir(), env: state.env });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearSecretsRuntimeSnapshot();
  server.listener.closeAllConnections();
  await server.releaseListener();
  await server.claim.release();
  await state.cleanup();
});
// afterEach hooks unwind in reverse order, so workers settle before state is removed.
const { retireAfterTest } = usePreparedCatalogWorkerFixtures();

function config(
  models: ModelDefinitionConfig[] = [],
  apiKey?: ModelProviderConfig["apiKey"],
): OpenClawConfig {
  return {
    gateway: { mode: "local" },
    agents: {
      ownership: "explicit",
      entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
    },
    models: { providers: { [provider]: { baseUrl, api: "openai-completions", models, apiKey } } },
  };
}

it.each(["provider", "profile"] as const)(
  "waits for and persists offline catalog refresh with a %s file SecretRef",
  async (owner) => {
    const secretPath = await state.writeText("catalog-key", credential);
    await fs.chmod(secretPath, 0o600);
    const pluginFile = await state.writeText(
      "catalog-plugin/index.cjs",
      `module.exports = {
  id: ${JSON.stringify(provider)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(provider)}, label: "Offline secret fixture", auth: [],
      catalog: { async run(context) {
        const auth = context.resolveProviderApiKey(${JSON.stringify(provider)});
        if (!auth.discoveryApiKey) return null;
        const response = await fetch(${JSON.stringify(baseUrl)} + "/models", {
          headers: { authorization: "Bearer " + auth.discoveryApiKey },
        });
        const body = await response.json();
        return { provider: {
          baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions",
          apiKey: auth.apiKey, models: body.data,
        } };
      } },
    });
  },
};
`,
    );
    await state.writeJson("catalog-plugin/openclaw.plugin.json", {
      id: provider,
      activation: { onStartup: false },
      providers: [provider],
      providerCatalogEntry: "./index.cjs",
      modelCatalog: { discovery: { [provider]: "runtime" } },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    });
    const ref = { source: "file", provider: "catalog", id: "value" } as const;
    await state.writeConfig({
      ...config([], owner === "provider" ? ref : undefined),
      plugins: {
        allow: [provider],
        load: { paths: [pluginFile] },
        slots: { memory: "none" },
        entries: { [provider]: { enabled: true } },
      },
      secrets: {
        providers: { catalog: { source: "file", path: secretPath, mode: "singleValue" } },
      },
    });
    if (owner === "profile") {
      await state.writeAuthProfiles({
        version: 1,
        profiles: { [`${provider}:default`]: { type: "api_key", provider, keyRef: ref } },
      });
    }
    // Only the absent Gateway transport is replaced; config, SecretRefs, and discovery stay real.
    vi.spyOn(gateway, "callGateway").mockRejectedValue(new Error("Gateway is not running"));
    const runtime = createNonExitingRuntimeEnv();
    // A refresh must wait beyond the ordinary preparation budget, without printing partial rows.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let completed = false;
    const command = modelsListCommand({ provider, refresh: true, json: true }, runtime).finally(
      () => {
        completed = true;
      },
    );
    void command.catch(() => {});
    try {
      await expect.poll(() => requests.length > 0 || completed, { timeout: 30_000 }).toBe(true);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(125_100);
      expect(completed).toBe(false);
      expect(runtime.writeJson).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      try {
        await command;
      } finally {
        vi.useRealTimers();
      }
    }

    expect(requests).toEqual([true]);
    expect(vi.mocked(runtime.error).mock.calls.flat().join(" ")).toMatch(
      /Refreshing the local model catalog/,
    );
    expect(runtime.writeJson).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runtime.writeJson).mock.calls[0]?.[0]).toMatchObject({
      count: 1,
      models: [{ key: `${provider}/discovered-model`, name: "Discovered model" }],
    });
    const persisted = loadPersistedPluginModelCatalogsReadOnly(state.agentDir()).find(
      (entry) => entry.pluginId === provider,
    );
    expect(JSON.parse(persisted!.contents)).toMatchObject({
      providers: { [provider]: { models: [{ id: "discovered-model", name: "Discovered model" }] } },
    });
  },
);

it("probes account SecretRefs without persisting credentials or sending unresolved refs", async () => {
  release.resolve();
  const cfg = config([
    createTestModelDefinition("probe-model", { name: "Probe model", maxTokens: 64 }),
  ]);
  await state.writeConfig(cfg);
  await writeSecretStoreEntry({
    scope: { kind: "team" },
    name: "PROBE_ACCOUNT_STORED",
    value: credential,
    kind: "secret",
    updatedBy: "test",
    database: { env: state.env },
  });
  await state.writeAuthProfiles({
    version: 1,
    profiles: Object.fromEntries(
      Object.entries({
        inline: { key: credential },
        env: { keyRef: { source: "env", provider: "default", id: "PROBE_ACCOUNT_KEY" } },
        store: { keyRef: { source: "store", provider: "default", id: "PROBE_ACCOUNT_STORED" } },
        missing: { keyRef: { source: "env", provider: "default", id: "PROBE_ACCOUNT_MISSING" } },
      } as const).map(([id, value]) => [
        `${provider}:${id}`,
        { type: "api_key", provider, ...value },
      ]),
    ),
  });
  const before = loadPersistedAuthProfileStore(state.agentDir());
  const result = await runAuthProbes({
    cfg,
    agentId: "main",
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    providers: [provider],
    modelCandidates: [`${provider}/probe-model`],
    options: { timeoutMs: 10_000, concurrency: 1, maxTokens: 8 },
    stateOwnership: { mode: "exclusive" },
  });
  expect(Object.fromEntries(result.results.map((row) => [row.profileId, row.status]))).toEqual({
    [`${provider}:inline`]: "ok",
    [`${provider}:env`]: "ok",
    [`${provider}:store`]: "ok",
    [`${provider}:missing`]: "unknown",
  });
  expect(result.results.find((row) => row.profileId === `${provider}:missing`)).toMatchObject({
    reasonCode: "unresolved_ref",
  });
  expect(requests).toEqual([true, true, true]);
  expect(loadPersistedAuthProfileStore(state.agentDir())).toEqual(before);
});
