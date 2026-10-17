import fs from "node:fs/promises";
import { createServer } from "node:http";
import { text as readText } from "node:stream/consumers";
import { describeImageWithModel } from "openclaw/plugin-sdk/media-understanding";
import { expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { disconnectGatewayClient } from "../test-helpers.e2e.js";
import {
  catalogReply,
  catalogAgents,
  catalogSessionRpc,
  catalogModelDefaults,
  closeCatalogServer,
  createCatalogState,
  expectAssistantReply,
  listenCatalogServer,
  startCatalogGateway,
  writeCatalogPlugin,
} from "./models-catalog-fixture.test-support.js";

it("dispatches a discovered model outside the agent workspace and preserves it after withdrawal", async () => {
  const state = await createCatalogState("models-dispatch-catalog");
  const provider = "opencode";
  const model = "live-only-model";
  const modelRef = `${provider}/${model}`;
  const inferenceStarted = createDeferred();
  const imageStarted = createDeferred();
  const releaseInference = createDeferred();
  const waitFor = (promise: Promise<unknown>, message: string) =>
    withTestTimeout(promise, 30_000, message);
  const requests: Array<{
    authorization: string | undefined;
    catalogHeader: string | string[] | undefined;
    requestHeader: string | string[] | undefined;
    body: { model: string; max_tokens: number; messages: unknown[] };
  }> = [];
  const providerWork: Promise<void>[] = [];
  let advertised: Array<{ id: string; name: string }> = [];
  const endpoint = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: advertised }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const work = (async () => {
      requests.push({
        authorization: request.headers.authorization,
        catalogHeader: request.headers["x-catalog-model"],
        requestHeader: request.headers["x-dispatch-request"],
        body: JSON.parse(await readText(request)),
      });
      inferenceStarted.resolve();
      if (requests.length === 2) {
        imageStarted.resolve();
      }
      await releaseInference.promise;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(catalogReply("chatcmpl-discovered-model", model, "CATALOG_DISPATCH_REPLY"));
    })();
    providerWork.push(work);
    void work.catch((error: unknown) => {
      inferenceStarted.reject(error);
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  try {
    const baseUrl = `${await listenCatalogServer(endpoint)}/v1`;
    const pluginPath = await writeCatalogPlugin(
      state,
      provider,
      `module.exports = {
        id: ${JSON.stringify(provider)},
        register(api) {
          api.registerProvider({
            id: ${JSON.stringify(provider)}, label: "Dispatch fixture", auth: [],
            catalog: {
              order: "profile",
              async run(ctx) {
                const auth = ctx.resolveProviderAuth(${JSON.stringify(provider)});
                if (!auth.discoveryApiKey) return null;
                const response = await fetch(${JSON.stringify(`${baseUrl}/models`)}, {
                  headers: { Authorization: "Bearer " + auth.discoveryApiKey },
                });
                if (!response.ok) throw new Error("Fixture discovery failed");
                const { data: rows } = await response.json();
                return { provider: {
                  baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions",
                  models: rows.map((row) => ({
                    ...row, ...${JSON.stringify(catalogModelDefaults())}, input: ["text", "image"], maxTokens: 1536,
                    headers: { "X-Catalog-Model": "discovered-generation" },
                    compat: { maxTokensField: "max_tokens" },
                  })),
                } };
              },
            },
          });
        },
      };`,
      { modelCatalog: { discovery: { [provider]: "refreshable" } } },
    );
    const token = "catalog-dispatch-gateway-token";
    const cfg = {
      models: {
        providers: {
          [provider]: {
            baseUrl: "",
            models: [],
            request: {
              allowPrivateNetwork: true,
              headers: { "X-Dispatch-Request": "configured-transport" },
            },
          },
        },
      },
      agents: catalogAgents(state, {
        skipBootstrap: true,
        heartbeat: { every: "0m" },
        modelPolicy: { allow: [`${provider}/*`] },
      }),
      tools: { profile: "minimal" },
      plugins: { allow: [provider], load: { paths: [pluginPath] }, slots: { memory: "none" } },
      gateway: { mode: "local", auth: { mode: "token", token } },
    } satisfies OpenClawConfig;
    await state.writeConfig(cfg);
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        [`${provider}:default`]: { type: "api_key", provider, key: "dispatch-account-key" },
        [`${provider}:alternate`]: { type: "api_key", provider, key: "image-account-key" },
      },
      order: { [provider]: [`${provider}:default`, `${provider}:alternate`] },
    });
    const { client, server } = await startCatalogGateway(state, cfg, token);
    const rpc = catalogSessionRpc(client);
    try {
      await server.startupSettled;
      const refresh = () =>
        client.request<ModelsListResult>("models.list", {
          agentId: "main",
          provider,
          view: "all",
          refresh: true,
        });
      expect((await refresh()).models.filter((row) => row.provider === provider)).toEqual([]);
      advertised = [{ id: model, name: "Live-only model" }];
      const discovered = await refresh();
      expect(discovered.refreshFailed).not.toBe(true);
      expect(discovered.models).toContainEqual(
        expect.objectContaining({ provider, id: model, available: true }),
      );
      const outsideCwd = state.path("outside-workspace");
      await fs.mkdir(outsideCwd, { recursive: true });
      const session = await rpc.create(modelRef, "agent:main:catalog-dispatch", {
        cwd: outsideCwd,
      });
      expect(session).toMatchObject({ ok: true, entry: { spawnedCwd: outsideCwd } });
      const started = await rpc.send(
        session.key,
        "Reply with the catalog dispatch marker.",
        "catalog-dispatch-first-turn",
      );
      expect(started.status).toBe("started");
      await waitFor(inferenceStarted.promise, "First turn did not reach provider");
      expect(requests).toHaveLength(1);
      const expectRequest = (index: number, key: string, maxTokens: number) =>
        expect(requests[index]).toMatchObject({
          authorization: `Bearer ${key}`,
          catalogHeader: undefined,
          requestHeader: "configured-transport",
          body: { model, max_tokens: maxTokens },
        });
      expectRequest(0, "dispatch-account-key", 1536);

      const image = describeImageWithModel({
        provider,
        model,
        cfg,
        agentId: "main",
        agentDir: state.agentDir("main"),
        workspaceDir: state.workspaceDir,
        profile: `${provider}:alternate`,
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aX8AAAAASUVORK5CYII=",
          "base64",
        ),
        fileName: "pixel.png",
        mime: "image/png",
        prompt: "Describe the pixel.",
        maxTokens: 321,
        timeoutMs: 30_000,
      });
      await waitFor(
        Promise.race([imageStarted.promise, image]),
        "Image utility did not use the published model",
      );
      expect(requests).toHaveLength(2);
      expectRequest(1, "image-account-key", 321);

      advertised = [];
      const withdrawn = await refresh();
      expect(withdrawn.refreshFailed).not.toBe(true);
      expect(withdrawn.models.filter((row) => row.provider === provider)).toEqual([]);
      releaseInference.resolve();
      await expect(image).resolves.toMatchObject({ text: "CATALOG_DISPATCH_REPLY" });
      expect(await rpc.wait(started.runId)).toMatchObject({ status: "ok" });
      expectAssistantReply((await rpc.history(session.key)).messages, "CATALOG_DISPATCH_REPLY");

      const nextSession = await rpc.create(modelRef, "agent:main:catalog-after-withdrawal");
      const nextTurn = await rpc.send(
        nextSession.key,
        "Try the withdrawn model.",
        "catalog-dispatch-after-withdrawal",
      );
      const unavailable = await rpc.wait(nextTurn.runId);
      expect(unavailable).toMatchObject({
        status: "error",
        error: expect.stringContaining("This model was not found"),
      });
      expect(unavailable.error).toContain("Choose another model");
      expect(requests).toHaveLength(2);
    } finally {
      releaseInference.resolve();
      await disconnectGatewayClient(client);
      await server.close();
    }
  } finally {
    releaseInference.resolve();
    try {
      await closeCatalogServer(endpoint, true);
      await Promise.all(providerWork);
    } finally {
      await state.cleanup();
    }
  }
}, 120_000);
