import { once } from "node:events";
import { createServer } from "node:http";
import { text as readText } from "node:stream/consumers";
import { describeImageWithModel } from "openclaw/plugin-sdk/media-understanding";
import { expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

it("dispatches a newly discovered model and preserves an admitted turn when discovery withdraws it", async () => {
  const state = await createOpenClawTestState({
    label: "models-dispatch-catalog",
    env: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
  const provider = "opencode";
  const model = "live-only-model";
  const modelRef = `${provider}/${model}`;
  const inferenceStarted = createDeferred();
  const imageStarted = createDeferred();
  const releaseInference = createDeferred();
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
      response.end(
        `data: ${JSON.stringify({
          id: "chatcmpl-discovered-model",
          object: "chat.completion.chunk",
          created: 0,
          model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "CATALOG_DISPATCH_REPLY" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        })}\n\ndata: [DONE]\n\n`,
      );
    })();
    providerWork.push(work);
    void work.catch((error: unknown) => {
      inferenceStarted.reject(error);
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  try {
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    if (!address || typeof address === "string") {
      throw new Error("Dispatch fixture did not bind a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await state.writeJson("catalog-plugin/openclaw.plugin.json", {
      id: provider,
      providers: [provider],
      modelCatalog: { discovery: { [provider]: "refreshable" } },
      configSchema: { type: "object", additionalProperties: false },
    });
    const pluginPath = await state.writeText(
      "catalog-plugin/index.cjs",
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
                    ...row, reasoning: false, input: ["text", "image"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 32768, maxTokens: 1536,
                    headers: { "X-Catalog-Model": "discovered-generation" },
                    compat: { maxTokensField: "max_tokens" },
                  })),
                } };
              },
            },
          });
        },
      };`,
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
      agents: {
        defaults: {
          skipBootstrap: true,
          heartbeat: { every: "0m" },
          modelPolicy: { allow: [`${provider}/*`] },
        },
        list: [{ id: "main", workspace: state.workspaceDir }],
      },
      tools: { profile: "minimal" },
      plugins: {
        allow: [provider],
        load: { paths: [pluginPath] },
        slots: { memory: "none" },
      },
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
    const { client, server } = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: ["operator.admin"],
    });
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
      expect(discovered.models).toEqual(
        expect.arrayContaining([expect.objectContaining({ provider, id: model, available: true })]),
      );
      const session = await client.request<{ ok: boolean; key: string }>("sessions.create", {
        agentId: "main",
        key: "agent:main:catalog-dispatch",
        label: "Catalog dispatch",
        model: modelRef,
      });
      expect(session.ok).toBe(true);
      const started = await client.request<{ runId: string; status: string }>("chat.send", {
        sessionKey: session.key,
        message: "Reply with the catalog dispatch marker.",
        idempotencyKey: "catalog-dispatch-first-turn",
      });
      expect(started.status).toBe("started");
      await withTestTimeout(
        inferenceStarted.promise,
        30_000,
        "Discovered model did not reach the provider on its first turn",
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        authorization: "Bearer dispatch-account-key",
        catalogHeader: undefined,
        requestHeader: "configured-transport",
        body: { model: "live-only-model", max_tokens: 1536 },
      });

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
      await withTestTimeout(
        Promise.race([imageStarted.promise, image]),
        30_000,
        "Image utility did not use the published model",
      );
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({
        authorization: "Bearer image-account-key",
        catalogHeader: undefined,
        requestHeader: "configured-transport",
        body: { model: "live-only-model", max_tokens: 321 },
      });

      advertised = [];
      const withdrawn = await refresh();
      expect(withdrawn.refreshFailed).not.toBe(true);
      expect(withdrawn.models.filter((row) => row.provider === provider)).toEqual([]);
      releaseInference.resolve();
      await expect(image).resolves.toMatchObject({ text: "CATALOG_DISPATCH_REPLY" });
      const completed = await client.request<{ status: string }>(
        "agent.wait",
        { runId: started.runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      );
      expect(completed).toMatchObject({ status: "ok" });
      const history = await client.request<{ messages: unknown[] }>("chat.history", {
        sessionKey: session.key,
      });
      expect(history.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "text", text: "CATALOG_DISPATCH_REPLY" }),
            ]),
          }),
        ]),
      );

      const nextSession = await client.request<{ key: string }>("sessions.create", {
        agentId: "main",
        key: "agent:main:catalog-after-withdrawal",
        label: "After withdrawal",
        model: modelRef,
      });
      const nextTurn = await client.request<{ runId: string }>("chat.send", {
        sessionKey: nextSession.key,
        message: "Try the withdrawn model.",
        idempotencyKey: "catalog-dispatch-after-withdrawal",
      });
      const unavailable = await client.request<{ status: string; error?: string }>(
        "agent.wait",
        { runId: nextTurn.runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      );
      expect(unavailable).toMatchObject({ status: "error" });
      expect(unavailable.error).toContain("The configured model is unavailable from the provider");
      expect(requests).toHaveLength(2);
    } finally {
      releaseInference.resolve();
      await disconnectGatewayClient(client);
      await server.close();
    }
  } finally {
    releaseInference.resolve();
    endpoint.closeAllConnections();
    try {
      await new Promise<void>((resolve, reject) => {
        endpoint.close((error) => (error ? reject(error) : resolve()));
      });
      await Promise.all(providerWork);
    } finally {
      await state.cleanup();
    }
  }
}, 120_000);
