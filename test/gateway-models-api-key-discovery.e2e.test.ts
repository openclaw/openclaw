import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { ModelsAuthSetApiKeyResult } from "../packages/gateway-protocol/src/index.js";
import type { ModelsListResult } from "../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

it(
  "discovers bundled models with the credential saved through models.authSetApiKey",
  { timeout: 120_000 },
  async ({ signal }) => {
    const providers = ["vllm", "sglang"] as const;
    const modelIds = ["proof-alpha", "proof-beta", "proof-gamma"];
    const apiKey = "dummy-model-proof-key";
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
    const endpoint = await reserveTestPortListener({
      offsets: [0],
      signal,
      createListener: () =>
        createServer((request, response) => {
          requests.push({ url: request.url, authorization: request.headers.authorization });
          response.setHeader("Content-Type", "application/json");
          if (!providers.some((provider) => request.url === `/${provider}/v1/models`)) {
            response.writeHead(404).end();
            return;
          }
          if (request.headers.authorization !== `Bearer ${apiKey}`) {
            response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
            return;
          }
          response.end(JSON.stringify({ data: modelIds.map((id) => ({ id, name: id })) }));
        }),
    });
    await runQaGatewayFixture(
      async () => {
        const instance = await createOpenClawTestInstance({
          name: "models-api-key-discovery",
          signal,
          config: {
            agents: { defaults: { modelPolicy: { allow: providers.map((id) => `${id}/*`) } } },
            plugins: {
              allow: [...providers],
              entries: Object.fromEntries(
                providers.map((provider) => [provider, { enabled: true }]),
              ),
              slots: { memory: "none" },
            },
            models: {
              catalogRefresh: { enabled: false },
              providers: Object.fromEntries(
                providers.map((provider) => [
                  provider,
                  {
                    baseUrl: `http://127.0.0.1:${endpoint.claim.port}/${provider}/v1`,
                    api: "openai-completions",
                    models: [],
                  },
                ]),
              ),
            },
            gateway: { mode: "local", reload: { mode: "hybrid" } },
          },
          env: {
            // Self-hosted discovery intentionally skips HTTP in test mode.
            VITEST: undefined,
            NODE_ENV: undefined,
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            OPENCLAW_SKIP_PROVIDERS: undefined,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
            OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
            OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
            VLLM_API_KEY: undefined,
            SGLANG_API_KEY: undefined,
          },
        });
        await runQaGatewayFixture(
          async () => {
            await instance.startGateway();
            const client = await connectGatewayClient({
              url: instance.url,
              token: instance.gatewayToken,
              scopes: ["operator.admin", "operator.read", "operator.write"],
            });
            await runQaGatewayFixture(
              async () => {
                for (const provider of providers) {
                  const saved = await client.request<ModelsAuthSetApiKeyResult>(
                    "models.authSetApiKey",
                    { provider, apiKey, agentId: "main" },
                  );
                  expect(saved.profileId).toBe(`${provider}:manual`);
                  const persisted = JSON.parse(await readFile(instance.configPath, "utf8"));
                  expect(persisted).toMatchObject({
                    models: { providers: { [provider]: { apiKey: saved.profileId } } },
                  });
                  await client.request("models.list", { agentId: "main", view: "all" });

                  await expect
                    .poll(
                      () => requests.filter((request) => request.url === `/${provider}/v1/models`),
                      { timeout: 15_000, message: `${provider} must request its model catalog` },
                    )
                    .toContainEqual({
                      url: `/${provider}/v1/models`,
                      authorization: `Bearer ${apiKey}`,
                    });
                  expect(
                    requests
                      .filter((request) => request.url === `/${provider}/v1/models`)
                      .map((request) => request.authorization),
                  ).not.toContain(`Bearer ${saved.profileId}`);

                  await expect
                    .poll(
                      async () => {
                        const catalog = await client.request<ModelsListResult>("models.list", {
                          agentId: "main",
                          view: "all",
                        });
                        return catalog.models
                          .filter((model) => model.provider === provider)
                          .map((model) => model.id)
                          .toSorted();
                      },
                      { timeout: 15_000, message: `${provider} must publish discovered models` },
                    )
                    .toEqual(modelIds);
                }
              },
              () => disconnectGatewayClient(client),
            );
          },
          () => instance.cleanup(),
        ).catch((error: unknown) => {
          throw new Error(
            `API-key discovery failed: ${JSON.stringify(requests)}\n${instance.logs()}`,
            {
              cause: error,
            },
          );
        });
      },
      () => {
        endpoint.listener.closeAllConnections();
        return endpoint.releaseListener();
      },
      () => endpoint.claim.release(),
    );
  },
);
