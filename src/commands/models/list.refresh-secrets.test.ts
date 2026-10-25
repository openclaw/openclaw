import fs from "node:fs/promises";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { unregisterResolvedAgentDir } from "../../agents/agent-dir-registry.js";
import { usePreparedCatalogWorkerFixtures } from "../../agents/test-helpers/prepared-model-catalog-worker-fixture.js";
import * as runtimeConfig from "../../config/runtime-snapshot.js";
import * as gateway from "../../gateway/call.js";
import { clearSecretsRuntimeSnapshot } from "../../secrets/runtime.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createNonExitingRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { modelsListCommand } from "./list.list-command.js";

const provider = "offline-secret-fixture";
const credential = "synthetic-offline-catalog-key";
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;

afterEach(async () => {
  vi.restoreAllMocks();
  runtimeConfig.clearRuntimeConfigSnapshot();
  clearSecretsRuntimeSnapshot();
  await state.cleanup();
});
// afterEach hooks unwind in reverse order, so workers settle before state is removed.
const { retireAfterTest } = usePreparedCatalogWorkerFixtures();

it.each(["provider", "profile"] as const)(
  "refreshes the offline model catalog with a file SecretRef from the %s",
  async (owner) => {
    state = await createOpenClawTestState({
      label: `models-refresh-${owner}-secret`,
      layout: "split",
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_GATEWAY_PORT: undefined,
      },
    });
    retireAfterTest(() => {
      unregisterResolvedAgentDir({ agentId: "main", agentDir: state.agentDir(), env: state.env });
    });
    const requests: Array<{ path: string | undefined; authorized: boolean }> = [];
    const server = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          requests.push({
            path: request.url,
            authorized: request.headers.authorization === `Bearer ${credential}`,
          });
          response.setHeader("content-type", "application/json");
          response.end('{"data":[{"id":"discovered-model","name":"Discovered model"}]}');
        }),
    });
    retireAfterTest(async () => {
      server.listener.closeAllConnections();
      await server.releaseListener();
      await server.claim.release();
    });
    const baseUrl = `http://127.0.0.1:${server.claim.port}/v1`;
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
      gateway: { mode: "local" },
      agents: {
        ownership: "explicit",
        entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
      },
      plugins: {
        allow: [provider],
        load: { paths: [pluginFile] },
        slots: { memory: "none" },
        entries: { [provider]: { enabled: true } },
      },
      models: {
        providers: {
          [provider]: {
            baseUrl,
            api: "openai-completions",
            models: [],
            ...(owner === "provider" ? { apiKey: ref } : {}),
          },
        },
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

    await modelsListCommand({ provider, refresh: true, json: true }, runtime);

    expect(requests).toEqual([{ path: "/v1/models", authorized: true }]);
    expect(runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        models: [
          expect.objectContaining({
            key: `${provider}/discovered-model`,
            name: "Discovered model",
          }),
        ],
      }),
      2,
    );
  },
);
