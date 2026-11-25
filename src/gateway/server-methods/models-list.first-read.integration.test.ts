import { createServer, type ServerResponse } from "node:http";
import { expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { waitForCatalogPublication } from "./models-auth-catalog.test-support.js";
import {
  catalogDiscoverySource,
  catalogModelIds,
  createCatalogAuthProfiles,
  createCatalogModel,
  writeCatalogPlugin,
} from "./models-catalog-fixture.test-support.js";
import {
  createModelsTestState,
  serveModelsEndpoint,
  startModelsGateway,
} from "./models-integration.test-support.js";

it("models.list never lists a refreshable provider's manifest rows before its listing exists", async ({
  signal,
}) => {
  await using state = await createModelsTestState("first-read", { layout: "state-only" });
  const provider = "first-read-fixture";
  // The account listing omits "manifest-only"; the response stays held until the first read is done.
  const listingStarted = createDeferred<ServerResponse>();
  const releaseListing = createDeferred();
  const endpoint = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url !== "/models") {
      response.writeHead(404).end("{}");
      return;
    }
    listingStarted.resolve(response);
    void releaseListing.promise.then(() =>
      response.end(JSON.stringify([{ id: "listed", name: "Listed" }])),
    );
  });
  await using listener = await serveModelsEndpoint(endpoint);
  const { baseUrl } = listener;
  const pluginPath = await writeCatalogPlugin(
    state,
    provider,
    `module.exports = { id: ${JSON.stringify(provider)}, register(api) { api.registerProvider({
      id: ${JSON.stringify(provider)}, label: "First read fixture", auth: [],
      ${catalogDiscoverySource(provider, baseUrl, { error: "Fixture listing failed" })},
    }); } };`,
    {
      modelCatalog: {
        discovery: { [provider]: "refreshable" },
        providers: {
          [provider]: {
            baseUrl,
            api: "openai-completions",
            models: [createCatalogModel("manifest-only", "Manifest only")],
          },
        },
      },
    },
  );
  const token = "first-read-gateway-token";
  const cfg = {
    agents: { entries: { main: { workspace: state.workspaceDir } } },
    models: { catalogRefresh: { enabled: false } },
    plugins: { allow: [provider], load: { paths: [pluginPath] }, slots: { memory: "none" } },
    gateway: { mode: "local", auth: { mode: "token", token } },
  };
  await state.writeConfig(cfg);
  await state.writeAuthProfiles(createCatalogAuthProfiles({ [provider]: "first-read-key" }));
  await using gateway = await startModelsGateway(state, cfg, token);
  const list = () =>
    gateway.client.request<ModelsListResult>("models.list", { agentId: "main" }, { signal });
  try {
    await gateway.server.startupSettled;
    const first = await list();
    await withinTest(listingStarted.promise, signal);
    const held = await list();
    for (const read of [first, held]) {
      expect(catalogModelIds(read, provider)).toEqual([]);
    }
    expect(held.pendingProviders).toContain(provider);
    releaseListing.resolve();
    const published = await waitForCatalogPublication({
      signal,
      read: list,
      ready: (result) => !result.pendingProviders?.includes(provider),
    });
    expect(catalogModelIds(published, provider)).toEqual(["listed"]);
  } finally {
    releaseListing.resolve();
  }
});
