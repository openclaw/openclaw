import { createServer } from "node:http";
import { text as readText } from "node:stream/consumers";
import { expect, it, vi } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { waitForCatalogPublication } from "./models-auth-catalog.test-support.js";
import {
  catalogReply,
  catalogSessionRpc,
  createCatalogAuthProfiles,
  createCatalogModel,
  expectAssistantReply,
  writeCatalogPlugin,
} from "./models-catalog-fixture.test-support.js";
import {
  closeModelsEndpoint,
  createModelsTestState,
  listenModelsEndpoint,
  modelsTestConfig,
  settleModelsWork,
  startModelsGateway,
} from "./models-integration.test-support.js";

type DispatchRequest = {
  authorization: string | undefined;
  requestHeader: string | string[] | undefined;
  body: { model: string; max_tokens: number; messages: unknown[] };
};

function expectDispatch(
  requests: DispatchRequest[],
  index: number,
  model: string,
  account = "account-a-key",
  requestHeader = "initial-transport",
) {
  expect(requests).toHaveLength(index + 1);
  expect(requests[index]).toMatchObject({
    authorization: `Bearer ${account}`,
    requestHeader,
    body: { model, max_tokens: 1536 },
  });
}

function providerModels(result: ModelsListResult) {
  return result.models.filter((model) => model.provider === "opencode");
}

async function withDispatchLifecycle(
  signal: AbortSignal,
  run: (fixture: {
    client: Awaited<ReturnType<typeof startModelsGateway>>["client"];
    requests: DispatchRequest[];
    discoveryAccounts: (string | undefined)[];
    advertised: Map<string, string[]>;
    setDiscoveryAvailable: (available: boolean) => void;
    holdDiscovery: () => { started: Promise<void>; release: () => void };
    saveAccount: (key: string) => Promise<void>;
    restart: () => Promise<void>;
    list: (refresh?: boolean, view?: "all" | "default") => Promise<ModelsListResult>;
    send: (model: string, name: string, missing?: boolean) => Promise<void>;
  }) => Promise<void>,
) {
  await using state = await createModelsTestState("models-dispatch-lifecycle", {
    env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
  });
  const requests: DispatchRequest[] = [];
  const discoveryAccounts: (string | undefined)[] = [];
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
        const key = request.headers.authorization?.replace(/^Bearer /, "");
        discoveryAccounts.push(key);
        const held = heldDiscovery;
        if (held) {
          held.started.resolve();
          await held.release.promise;
        }
        if (!discoveryAvailable) {
          response.writeHead(503).end();
          return;
        }
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
        catalogReply("chatcmpl-lifecycle", recorded.body.model, "LIFECYCLE_DISPATCH_REPLY"),
      );
    })();
    pending.push(work);
    void work.catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  let gateway: Awaited<ReturnType<typeof startModelsGateway>> | undefined;
  const saveAccount = async (key: string) => {
    await state.writeAuthProfiles(createCatalogAuthProfiles({ opencode: key }));
  };
  try {
    const baseUrl = `${await listenModelsEndpoint(endpoint)}/v1`;
    const pluginPath = await writeCatalogPlugin(
      state,
      "opencode",
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
                  providers: {}, outcomes: [{ provider: "opencode", profileId: auth.profileId, status: "unavailable" }],
                };
                const { data } = await response.json();
                return { provider: {
                  baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions",
                  models: data.map(({ id }) => ({
                    ...${JSON.stringify({ ...createCatalogModel(""), maxTokens: 1536, compat: { maxTokensField: "max_tokens" } })}, id, name: id,
                  })),
                }, outcomes: [{ provider: "opencode", profileId: auth.profileId, status: "ready" }] };
              },
            },
          });
        },
      };`,
      { modelCatalog: { discovery: { opencode: "refreshable" } } },
    );
    const token = "dispatch-lifecycle-gateway-token";
    const cfg = modelsTestConfig(state, token, {
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
          modelPolicy: { allow: ["opencode/*"] },
        },
      },
      tools: { profile: "minimal" },
      plugins: {
        allow: ["opencode"],
        load: { paths: [pluginPath] },
        slots: { memory: "none" },
      },
    });
    await state.writeConfig(cfg);
    await saveAccount("account-a-key");
    const start = async () => {
      const started = await startModelsGateway(state, cfg, token, { hotReloadRecovery });
      gateway = started;
      await started.server.startupSettled;
      return started;
    };
    let active = await start();
    const readModels = (refresh = false, view: "all" | "default" = "all") =>
      active.client.request<ModelsListResult>("models.list", {
        agentId: "main",
        provider: "opencode",
        view,
        refresh,
      });
    await run({
      get client() {
        return active.client;
      },
      requests,
      discoveryAccounts,
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
        await active.close();
        gateway = undefined;
        active = await start();
      },
      list: (refresh = false, view = "all") =>
        refresh
          ? waitForCatalogPublication({
              signal,
              start: () => readModels(true, view),
              read: () => readModels(false, view),
              ready: (result) => !result.pendingProviders?.length,
            })
          : readModels(false, view),
      send: async (model, name, missing = false) => {
        const rpc = catalogSessionRpc(active.client);
        const session = await rpc.create(`opencode/${model}`, `agent:main:${name}`, {
          label: name,
        });
        const started = await rpc.send(
          session.key,
          "Reply with the lifecycle dispatch marker.",
          name,
        );
        expect(started.status).toBe("started");
        const completed = await rpc.wait(started.runId);
        expect(completed).toMatchObject(
          missing
            ? { status: "error", error: expect.stringContaining("This model was not found.") }
            : { status: "ok" },
        );
        if (completed.status === "ok") {
          expectAssistantReply(
            (await rpc.history(session.key)).messages,
            "LIFECYCLE_DISPATCH_REPLY",
          );
        }
      },
    });
    expect(hotReloadRecovery).not.toHaveBeenCalled();
  } finally {
    heldDiscovery?.release.resolve();
    try {
      await gateway?.close();
    } finally {
      endpoint.closeAllConnections();
      await closeModelsEndpoint(endpoint);
      await Promise.all(pending);
    }
  }
}

it(
  "models.list keeps the selected session catalog when another session label changes",
  { timeout: 180_000 },
  async ({ signal }) => {
    await withDispatchLifecycle(signal, async (fixture) => {
      const createSession = (name: string, label: string) =>
        fixture.client.request<{ key: string }>("sessions.create", {
          agentId: "main",
          key: `agent:main:catalog-${name}`,
          label,
          model: "opencode/account-a-only",
        });
      const expectedIds = [
        "account-a-only",
        ...Array.from({ length: 64 }, (_, index) => `account-a-extra-${index}`),
      ];
      fixture.advertised.set("account-a-key", expectedIds);
      await fixture.list(true);
      const selected = await createSession("selected", "Selected catalog session");
      const other = await createSession("other", "Other session");
      fixture.discoveryAccounts.length = 0;
      const held = fixture.holdDiscovery();
      const pending = settleModelsWork(
        fixture.client.request<ModelsListResult>("models.list", {
          agentId: "main",
          sessionKey: selected.key,
          provider: "opencode",
          view: "all",
          refresh: true,
        }),
      );
      try {
        await withTestTimeout(held.started, 30_000, "Selected session discovery did not start");
        expect(fixture.discoveryAccounts).toEqual(["account-a-key"]);
        await expect(
          fixture.client.request("sessions.patch", {
            key: other.key,
            label: "Other session renamed",
          }),
        ).resolves.toMatchObject({ entry: { label: "Other session renamed" } });
      } finally {
        held.release();
        await pending;
      }
      const outcome = await pending;
      expect(outcome.error).toBeUndefined();
      expect(
        outcome.result &&
          providerModels(outcome.result).map(({ id, available }) => ({ id, available })),
      ).toEqual(
        ["account-a-only", ...expectedIds.filter((id) => id !== "account-a-only").toSorted()].map(
          (id) => ({ id, available: true }),
        ),
      );
      expect(fixture.discoveryAccounts).toEqual(["account-a-key"]);
    });
  },
);

it("models.list retains executable rows on failed refresh and replaces them after Gateway restart", async ({
  signal,
}) => {
  await withDispatchLifecycle(signal, async (fixture) => {
    const discovered = await fixture.list(true);
    expect(discovered.models).toContainEqual(
      expect.objectContaining({ provider: "opencode", id: "account-a-only", available: true }),
    );
    await fixture.send("account-a-only", "before-failure");
    expect(fixture.requests).toHaveLength(1);

    fixture.setDiscoveryAvailable(false);
    const failed = await fixture.list(true);
    expect(failed.refreshFailed).toBe(true);
    expect(failed.models).toContainEqual(
      expect.objectContaining({ provider: "opencode", id: "account-a-only", available: true }),
    );
    await fixture.send("account-a-only", "after-failure");
    expectDispatch(fixture.requests, 1, "account-a-only");

    fixture.advertised.set("account-a-key", ["after-restart"]);
    fixture.setDiscoveryAvailable(true);
    await fixture.restart();
    const restarted = await fixture.list(true);
    expect(providerModels(restarted).map((model) => model.id)).toEqual(["after-restart"]);
    await fixture.send("after-restart", "first-after-restart");
    expectDispatch(fixture.requests, 2, "after-restart");
    await fixture.send("account-a-only", "withdrawn-after-restart", true);
    expect(fixture.requests).toHaveLength(3);
  });
}, 180_000);

it("models.authRefresh revokes old executable rows before discovery and config.patch applies current policy and transport", async ({
  signal,
}) => {
  await withDispatchLifecycle(signal, async (fixture) => {
    await fixture.list(true);
    await fixture.send("account-a-only", "before-replacement");
    expect(fixture.requests[0]).toMatchObject({ authorization: "Bearer account-a-key" });

    const held = fixture.holdDiscovery();
    try {
      await fixture.saveAccount("account-b-key");
      await fixture.client.request("models.authRefresh", { agentId: "main", operation: "login" });
      await withTestTimeout(held.started, 30_000, "Replacement account discovery did not start");
      expect((await fixture.list()).models).not.toContainEqual(
        expect.objectContaining({ provider: "opencode", id: "account-a-only" }),
      );
      await fixture.send("account-a-only", "during-replacement", true);
      expect(fixture.requests).toHaveLength(1);
    } finally {
      held.release();
    }
    await expect
      .poll(async () => providerModels(await fixture.list()).map((model) => model.id), {
        timeout: 30_000,
      })
      .toEqual(["account-b-only", "account-b-sibling"]);
    await fixture.send("account-b-only", "after-replacement");
    expectDispatch(fixture.requests, 1, "account-b-only", "account-b-key");

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
            models: providerModels(publication).map(({ id, contextWindow, available }) => ({
              id,
              contextWindow,
              available,
            })),
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
    await fixture.send("account-b-only", "after-config-reload");
    expectDispatch(fixture.requests, 2, "account-b-only", "account-b-key", "reloaded-transport");
  });
}, 180_000);
