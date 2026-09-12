import { once } from "node:events";
import { createServer } from "node:http";
import { text as readText } from "node:stream/consumers";
import { expect, it, vi } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

type DispatchRequest = {
  authorization: string | undefined;
  requestHeader: string | string[] | undefined;
  body: { model: string; max_tokens: number; messages: unknown[] };
};

async function withDispatchLifecycle(
  run: (fixture: {
    client: Awaited<ReturnType<typeof startGatewayWithClient>>["client"];
    requests: DispatchRequest[];
    advertised: Map<string, string[]>;
    setDiscoveryAvailable: (available: boolean) => void;
    holdDiscovery: () => { started: Promise<void>; release: () => void };
    saveAccount: (key: string) => Promise<void>;
    restart: () => Promise<void>;
    list: (refresh?: boolean, view?: "all" | "default") => Promise<ModelsListResult>;
    send: (model: string, name: string) => Promise<{ status: string; error?: string }>;
  }) => Promise<void>,
) {
  const state = await createOpenClawTestState({
    label: "models-dispatch-lifecycle",
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
  const requests: DispatchRequest[] = [];
  const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
  const advertised = new Map([
    ["account-a-key", ["account-a-only"]],
    ["account-b-key", ["account-b-only", "account-b-sibling"]],
  ]);
  let discoveryAvailable = true;
  let heldDiscovery:
    | {
        started: ReturnType<typeof createDeferred<void>>;
        release: ReturnType<typeof createDeferred<void>>;
      }
    | undefined;
  const pending: Promise<void>[] = [];
  const endpoint = createServer((request, response) => {
    const work = (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        const held = heldDiscovery;
        if (held) {
          held.started.resolve();
          await held.release.promise;
        }
        if (!discoveryAvailable) {
          response.writeHead(503).end();
          return;
        }
        const key = request.headers.authorization?.replace(/^Bearer /, "");
        const models = key ? advertised.get(key) : undefined;
        if (!models) {
          response.writeHead(401).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: models.map((id) => ({ id, object: "model" })) }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const recorded: DispatchRequest = {
        authorization: request.headers.authorization,
        requestHeader: request.headers["x-dispatch-request"],
        body: JSON.parse(await readText(request)),
      };
      requests.push(recorded);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          id: "chatcmpl-lifecycle",
          object: "chat.completion.chunk",
          created: 0,
          model: recorded.body.model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "LIFECYCLE_DISPATCH_REPLY" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        })}\n\ndata: [DONE]\n\n`,
      );
    })();
    pending.push(work);
    void work.catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  const saveAccount = async (key: string) => {
    await state.writeAuthProfiles({
      version: 1,
      profiles: { "opencode:default": { type: "api_key", provider: "opencode", key } },
    });
  };
  try {
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    if (!address || typeof address === "string") {
      throw new Error("Lifecycle fixture did not bind a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await state.writeJson("catalog-plugin/openclaw.plugin.json", {
      id: "opencode",
      providers: ["opencode"],
      modelCatalog: { discovery: { opencode: "refreshable" } },
      configSchema: { type: "object", additionalProperties: false },
    });
    const pluginPath = await state.writeText(
      "catalog-plugin/index.cjs",
      `module.exports = {
        id: "opencode",
        register(api) {
          api.registerProvider({
            id: "opencode", label: "Dispatch lifecycle fixture", auth: [],
            catalog: {
              order: "profile",
              async run(ctx) {
                const auth = ctx.resolveProviderAuth("opencode");
                if (!auth.discoveryApiKey) return null;
                const response = await fetch(${JSON.stringify(`${baseUrl}/models`)}, {
                  headers: { Authorization: "Bearer " + auth.discoveryApiKey },
                });
                if (!response.ok) return {
                  providers: {}, outcomes: [{ provider: "opencode", status: "unavailable" }],
                };
                const { data } = await response.json();
                return { provider: {
                  baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions",
                  models: data.map(({ id }) => ({
                    id, name: id, reasoning: false, input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 32768, maxTokens: 1536,
                    compat: { maxTokensField: "max_tokens" },
                  })),
                } };
              },
            },
          });
        },
      };`,
    );
    const token = "dispatch-lifecycle-gateway-token";
    const cfg = {
      models: {
        providers: {
          opencode: {
            baseUrl: "",
            models: [],
            request: {
              allowPrivateNetwork: true,
              headers: { "X-Dispatch-Request": "initial-transport" },
            },
          },
        },
      },
      agents: {
        defaults: {
          skipBootstrap: true,
          heartbeat: { every: "0m" },
          modelPolicy: { allow: ["opencode/*"] },
        },
        list: [{ id: "main", workspace: state.workspaceDir }],
      },
      tools: { profile: "minimal" },
      plugins: {
        allow: ["opencode"],
        load: { paths: [pluginPath] },
        slots: { memory: "none" },
      },
      gateway: { mode: "local", auth: { mode: "token", token } },
    } satisfies OpenClawConfig;
    await state.writeConfig(cfg);
    await saveAccount("account-a-key");
    const start = async () => {
      const started = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        scopes: ["operator.admin"],
        hotReloadRecovery,
      });
      gateway = started;
      await started.server.startupSettled;
      return started;
    };
    let active = await start();
    await run({
      get client() {
        return active.client;
      },
      requests,
      advertised,
      setDiscoveryAvailable: (available) => {
        discoveryAvailable = available;
      },
      holdDiscovery: () => {
        const held = { started: createDeferred(), release: createDeferred() };
        heldDiscovery = held;
        return {
          started: held.started.promise,
          release: () => {
            heldDiscovery = undefined;
            held.release.resolve();
          },
        };
      },
      saveAccount,
      restart: async () => {
        await disconnectGatewayClient(active.client);
        await active.server.close();
        gateway = undefined;
        active = await start();
      },
      list: (refresh = false, view = "all") =>
        active.client.request<ModelsListResult>("models.list", {
          agentId: "main",
          provider: "opencode",
          view,
          refresh,
        }),
      send: async (model, name) => {
        const session = await active.client.request<{ key: string }>("sessions.create", {
          agentId: "main",
          key: `agent:main:${name}`,
          label: name,
          model: `opencode/${model}`,
        });
        const started = await active.client.request<{ runId: string; status: string }>(
          "chat.send",
          {
            sessionKey: session.key,
            message: "Reply with the lifecycle dispatch marker.",
            idempotencyKey: name,
          },
        );
        expect(started.status).toBe("started");
        const completed = await active.client.request<{ status: string; error?: string }>(
          "agent.wait",
          { runId: started.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        );
        if (completed.status === "ok") {
          const history = await active.client.request<{ messages: unknown[] }>("chat.history", {
            sessionKey: session.key,
          });
          expect(history.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                role: "assistant",
                content: expect.arrayContaining([
                  expect.objectContaining({ type: "text", text: "LIFECYCLE_DISPATCH_REPLY" }),
                ]),
              }),
            ]),
          );
        }
        return completed;
      },
    });
    expect(hotReloadRecovery).not.toHaveBeenCalled();
  } finally {
    heldDiscovery?.release.resolve();
    try {
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close();
      }
    } finally {
      endpoint.closeAllConnections();
      try {
        await new Promise<void>((resolve, reject) => {
          endpoint.close((error) => (error ? reject(error) : resolve()));
        });
        await Promise.all(pending);
      } finally {
        await state.cleanup();
      }
    }
  }
}

it("models.list retains executable rows on failed refresh and replaces them after Gateway restart", async () => {
  await withDispatchLifecycle(async (fixture) => {
    const discovered = await fixture.list(true);
    expect(discovered.models).toContainEqual(
      expect.objectContaining({ provider: "opencode", id: "account-a-only", available: true }),
    );
    await expect(fixture.send("account-a-only", "before-failure")).resolves.toMatchObject({
      status: "ok",
    });
    expect(fixture.requests).toHaveLength(1);

    fixture.setDiscoveryAvailable(false);
    const failed = await fixture.list(true);
    expect(failed.refreshFailed).toBe(true);
    expect(failed.models).toContainEqual(
      expect.objectContaining({ provider: "opencode", id: "account-a-only", available: true }),
    );
    await expect(fixture.send("account-a-only", "after-failure")).resolves.toMatchObject({
      status: "ok",
    });
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[1]).toMatchObject({
      authorization: "Bearer account-a-key",
      requestHeader: "initial-transport",
      body: { model: "account-a-only", max_tokens: 1536 },
    });

    fixture.advertised.set("account-a-key", ["after-restart"]);
    fixture.setDiscoveryAvailable(true);
    await fixture.restart();
    const restarted = await fixture.list(true);
    expect(
      restarted.models.filter((model) => model.provider === "opencode").map((model) => model.id),
    ).toEqual(["after-restart"]);
    await expect(fixture.send("after-restart", "first-after-restart")).resolves.toMatchObject({
      status: "ok",
    });
    expect(fixture.requests).toHaveLength(3);
    expect(fixture.requests[2]).toMatchObject({
      authorization: "Bearer account-a-key",
      requestHeader: "initial-transport",
      body: { model: "after-restart", max_tokens: 1536 },
    });
    await expect(fixture.send("account-a-only", "withdrawn-after-restart")).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("The configured model is unavailable from the provider"),
    });
    expect(fixture.requests).toHaveLength(3);
  });
}, 180_000);

it("models.authRefresh revokes old executable rows before discovery and config.patch applies current policy and transport", async () => {
  await withDispatchLifecycle(async (fixture) => {
    await fixture.list(true);
    await expect(fixture.send("account-a-only", "before-replacement")).resolves.toMatchObject({
      status: "ok",
    });
    expect(fixture.requests[0]).toMatchObject({ authorization: "Bearer account-a-key" });

    const held = fixture.holdDiscovery();
    try {
      await fixture.saveAccount("account-b-key");
      await fixture.client.request("models.authRefresh", { agentId: "main", operation: "login" });
      await withTestTimeout(held.started, 30_000, "Replacement account discovery did not start");
      expect((await fixture.list()).models).not.toContainEqual(
        expect.objectContaining({ provider: "opencode", id: "account-a-only" }),
      );
      await expect(fixture.send("account-a-only", "during-replacement")).resolves.toMatchObject({
        status: "error",
        error: expect.stringContaining("The configured model is unavailable from the provider"),
      });
      expect(fixture.requests).toHaveLength(1);
    } finally {
      held.release();
    }
    await expect
      .poll(
        async () =>
          (await fixture.list()).models
            .filter((model) => model.provider === "opencode")
            .map((model) => model.id),
        { timeout: 30_000 },
      )
      .toEqual(["account-b-only", "account-b-sibling"]);
    await expect(fixture.send("account-b-only", "after-replacement")).resolves.toMatchObject({
      status: "ok",
    });
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[1]).toMatchObject({
      authorization: "Bearer account-b-key",
      requestHeader: "initial-transport",
      body: { model: "account-b-only", max_tokens: 1536 },
    });

    const config = await fixture.client.request<{ hash: string }>("config.get", {});
    await fixture.client.request("config.patch", {
      baseHash: config.hash,
      replacePaths: ["agents.defaults.modelPolicy.allow"],
      raw: JSON.stringify({
        agents: { defaults: { modelPolicy: { allow: ["opencode/account-b-only"] } } },
        models: {
          providers: {
            opencode: { request: { headers: { "X-Dispatch-Request": "reloaded-transport" } } },
          },
        },
      }),
    });
    await expect
      .poll(
        async () => {
          const publication = await fixture.list(false, "default");
          return {
            pending: publication.pendingProviders ?? [],
            models: publication.models
              .filter((model) => model.provider === "opencode")
              .map(({ id, contextWindow, available }) => ({ id, contextWindow, available })),
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({
        pending: [],
        models: [{ id: "account-b-only", contextWindow: 32768, available: true }],
      });
    await expect(
      fixture.client.request("sessions.create", {
        agentId: "main",
        key: "agent:main:denied-after-reload",
        model: "opencode/account-b-sibling",
      }),
    ).rejects.toThrow("model not allowed");
    expect(fixture.requests).toHaveLength(2);
    await expect(fixture.send("account-b-only", "after-config-reload")).resolves.toMatchObject({
      status: "ok",
    });
    expect(fixture.requests).toHaveLength(3);
    expect(fixture.requests[2]).toMatchObject({
      authorization: "Bearer account-b-key",
      requestHeader: "reloaded-transport",
      body: { model: "account-b-only", max_tokens: 1536 },
    });
  });
}, 180_000);
