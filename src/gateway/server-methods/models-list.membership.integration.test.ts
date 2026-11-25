import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { expect, it, type TestContext } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runQaGatewayTestFixture } from "../../../test/helpers/qa-gateway-test-lifetime.js";
import { disconnectGatewayClient } from "../test-helpers.e2e.js";
import { waitForCatalogPublication } from "./models-auth-catalog.test-support.js";
import {
  closeCatalogServer,
  catalogModelDefaults,
  catalogModelIds,
  createCatalogAuthProfiles,
  createCatalogModel,
  createCatalogState,
  listenCatalogServer,
  startCatalogGateway,
  writeCatalogPlugin,
} from "./models-catalog-fixture.test-support.js";

function runMembershipCase(
  context: Pick<TestContext, "signal" | "onTestFinished">,
  secondHook: boolean,
  beforeClose?: () => Promise<void>,
) {
  const provider = "membership-fixture";
  const allow = secondHook ? [] : [`${provider}/manual`];
  const expected = secondHook
    ? ["account-only", "manual", "sibling-only"]
    : ["account-only", "manual"];
  let state: Awaited<ReturnType<typeof createCatalogState>> | undefined;
  let gateway: Awaited<ReturnType<typeof startCatalogGateway>> | undefined;
  let requests = 0;
  const advertisedModelIds = ["manual", "account-only"];
  const hooks = [[provider, ""]];
  if (secondHook) {
    hooks.push(["membership-sibling", "/sibling"]);
  }
  const endpoint = createServer((request, response) => {
    requests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(request.url === "/sibling" ? ["manual", "sibling-only"] : advertisedModelIds),
    );
  });
  return runQaGatewayTestFixture(
    context,
    async ({ signal }) => {
      state = await createCatalogState("catalog-membership");
      const baseUrl = await listenCatalogServer(endpoint);
      const pluginPath = await writeCatalogPlugin(
        state,
        secondHook ? [provider, "membership-sibling"] : provider,
        `module.exports = {
          id: "membership-fixture", register(api) {
            for (const [id, suffix] of ${JSON.stringify(hooks)}) api.registerProvider({ id, hookAliases: ["membership-fixture"], label: "Membership fixture", auth: [],
              catalog: { order: "profile", async run(ctx) {
                if (!ctx.resolveProviderAuth("membership-fixture").discoveryApiKey) return null;
                const response = await fetch(${JSON.stringify(baseUrl)} + suffix);
                const rows = await response.json();
                return { providers: { "membership-fixture": { baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions",
                  models: rows.map(id => ({ id, name: id, ...${JSON.stringify(catalogModelDefaults())} })) } } };
              } },
            });
          },
        };`,
      );
      const token = "membership-gateway-token";
      const restricted = {
        workspace: state.workspaceDir,
        modelPolicy: { allow: [`${provider}/manual`] },
      };
      const cfg = {
        agents: {
          ownership: "explicit",
          defaults: {
            model: `${provider}/manual`,
            modelPolicy: { allow },
          },
          entries: {
            main: { workspace: state.workspaceDir },
            ...(!secondHook ? { restricted } : {}),
          },
        },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            [provider]: {
              baseUrl,
              api: "openai-completions" as const,
              models: [createCatalogModel("manual", "Manual model")],
            },
          },
        },
        plugins: {
          enabled: true,
          allow: [provider],
          entries: { [provider]: { enabled: true } },
          load: { paths: [pluginPath] },
          slots: { memory: "none" },
        },
        gateway: { mode: "local", auth: { mode: "token", token } },
      };
      await state.writeConfig(cfg);
      const authProfiles = createCatalogAuthProfiles({ [provider]: "membership-account-key" });
      await state.writeAuthProfiles(authProfiles);
      if (!secondHook) {
        await state.writeAuthProfiles(authProfiles, "restricted");
      }
      gateway = await startCatalogGateway(state, cfg, token);

      const { client, server } = gateway;
      await server.startupSettled;
      signal.throwIfAborted();
      const read = (refresh = false, agentId = "main") =>
        client.request<ModelsListResult>("models.list", { agentId, refresh }, { signal });
      const modelIds = (result: ModelsListResult) => catalogModelIds(result, provider).toSorted();
      const list = async (agentId = "main") => modelIds(await read(false, agentId));
      const refresh = async (agentId = "main") =>
        modelIds(
          await waitForCatalogPublication({
            signal,
            start: () => read(true, agentId),
            read: () => read(false, agentId),
            ready: (result) => !result.pendingProviders?.includes(provider),
          }),
        );
      const initial = allow.length === 0 ? expected : ["manual"];
      expect(await refresh()).toEqual(initial);
      expect(requests).toBeGreaterThan(0);
      if (!secondHook) {
        expect(await refresh("restricted")).toEqual(["manual"]);
      }
      const acquired = requests;
      expect(await list()).toEqual(initial);
      expect(requests).toBe(acquired);

      const patch = async (raw: unknown, replacePaths: string[] = []) => {
        const config = await client.request<{ hash: string }>("config.get", {}, { signal });
        await client.request(
          "config.patch",
          { baseHash: config.hash, replacePaths, raw: JSON.stringify(raw) },
          { signal },
        );
      };
      const setPolicy = (refs: string[]) =>
        patch({ agents: { defaults: { modelPolicy: { allow: refs } } } }, [
          "agents.defaults.modelPolicy.allow",
        ]);
      // config.patch acknowledges runtime application, so the next read needs no polling.
      const policies: [string[], string[]][] = [
        [[`${provider}/*`], expected],
        [[`${provider}/manual`], ["manual"]],
        [[`${provider}/account-only`], ["account-only"]],
        [[], expected],
      ];
      for (const [refs, rows] of policies) {
        await setPolicy(refs);
        expect(await list()).toEqual(rows);
        if (!secondHook) {
          expect(await list("restricted")).toEqual(["manual"]);
        }
        expect(requests).toBe(acquired);
      }

      const getConfig = () => client.request<{ config: typeof cfg }>("config.get", {}, { signal });
      const previousConfig = await getConfig();
      advertisedModelIds.push("next-release");
      expect(await refresh()).toEqual([...expected, "next-release"].toSorted());
      const currentConfig = await getConfig();
      expect(currentConfig.config.models.providers[provider].models).toEqual(
        previousConfig.config.models.providers[provider].models,
      );
      await beforeClose?.();
    },
    async () => {
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
      }
    },
    async () => gateway?.server.close({ reason: "catalog membership test complete" }),
    async () => {
      if (endpoint.listening) {
        await closeCatalogServer(endpoint, true);
      } else {
        endpoint.closeAllConnections();
      }
    },
    async () => state?.cleanup(),
  );
}

it("models.list retains discovery across policy changes and joins an aborted case", async (context) => {
  const abort = new AbortController();
  const signal = AbortSignal.any([context.signal, abort.signal]);
  const ready = createDeferred();
  const release = createDeferred();
  const hooks: Array<Parameters<TestContext["onTestFinished"]>[0]> = [];
  const cancellation = new Error("membership case aborted with a live catalog");
  const body = runMembershipCase(
    {
      signal,
      onTestFinished: (hook) => {
        hooks.push(hook);
        context.onTestFinished(hook);
      },
    },
    false,
    async () => {
      ready.resolve();
      await release.promise;
      signal.throwIfAborted();
    },
  );
  const outcome = body.then(
    () => undefined,
    (error: unknown) => error,
  );
  let teardown: Promise<void> | undefined;
  try {
    await Promise.race([ready.promise, body]);
    abort.abort(cancellation);
    let finished = false;
    teardown = (async () => {
      for (const hook of hooks.toReversed()) {
        await hook(context);
      }
      finished = true;
    })();
    // Model Vitest abandoning its wrapper while the real case still owns work.
    await setImmediate();
    expect(finished, "test completion must join the live catalog owner").toBe(false);
    release.resolve();
    expect(await outcome).toBe(cancellation);
    await teardown;
  } finally {
    release.resolve();
    await outcome;
    await teardown;
  }
}, 60_000);

it("models.list starts clean after an aborted case and retains both discovery hooks", async (context) => {
  await runMembershipCase(context, true);
}, 60_000);
