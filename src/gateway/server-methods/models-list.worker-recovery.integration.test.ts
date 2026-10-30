import { channel } from "node:diagnostics_channel";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { text as readText } from "node:stream/consumers";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "../../agents/prepared-model-runtime.js";
import { registerPreparedModelRuntimePublicationListener } from "../../agents/prepared-model-runtime.publication-events.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { ChatMetadataResult } from "./chat-metadata-contract.js";
import { waitForCatalogPublication } from "./models-auth-catalog.test-support.js";
import {
  catalogReply,
  catalogAgents,
  catalogSessionRpc,
  catalogModelIds,
  catalogModelDefaults,
  createCatalogState,
  createCatalogAuthProfiles,
  expectAssistantReply,
  writeCatalogPlugin,
} from "./models-catalog-fixture.test-support.js";
import { serveModelsEndpoint, startModelsGateway } from "./models-integration.test-support.js";

it("model reads recover a failed shared-worker publication and retain the failed renewal", async ({
  signal,
}) => {
  await using state = await createCatalogState("catalog-worker-recovery");
  const provider = "recovery-fixture";
  const sibling = "healthy-fixture";
  const providers = [provider, sibling];
  const events = new EventEmitter();
  const workers = new Map<number, Worker>();
  const workerChannel = channel("worker_threads");
  const recordWorker = (message: unknown) => {
    if (isRecord(message) && message.worker instanceof Worker) {
      workers.set(message.worker.threadId, message.worker);
    }
  };
  workerChannel.subscribe(recordWorker);
  let requests = 0;
  let siblingRequests = 0;
  let heldThread = 0;
  let hold = false;
  let failedPreparations = 0;
  const inferenceRequests: Array<{ authorization?: string; model: string }> = [];
  const providerWork: Promise<void>[] = [];
  let advertised = ["original"];
  const held: ServerResponse[] = [];
  const releaseResponses = () => {
    hold = false;
    held.splice(0).forEach((response) => reply(response));
  };
  const reply = (response: ServerResponse, rows = advertised) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(rows));
  };
  const endpoint = createServer((request, response) => {
    if (request.url === "/prepare") {
      const failed = failedPreparations > 0;
      if (failed) {
        failedPreparations--;
      }
      response.writeHead(failed ? 503 : 200).end();
      return;
    }
    if (request.method === "POST" && request.url === "/chat/completions") {
      const work = (async () => {
        const body = JSON.parse(await readText(request));
        inferenceRequests.push({ authorization: request.headers.authorization, model: body.model });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          catalogReply("chatcmpl-recovered-runtime", body.model, "RECOVERED_RUNTIME_REPLY"),
        );
      })();
      providerWork.push(work);
      void work.catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }
    if (request.url === `/${sibling}`) {
      siblingRequests++;
      reply(response, ["healthy"]);
      return;
    }
    requests++;
    heldThread = Number(request.headers["x-fixture-thread"]);
    if (hold) {
      held.push(response);
    } else {
      reply(response);
    }
    events.emit("request");
  });
  try {
    await using listening = await serveModelsEndpoint(endpoint);
    const { baseUrl } = listening;
    const pluginPath = await writeCatalogPlugin(
      state,
      providers,
      `module.exports = {
        id: ${JSON.stringify(provider)}, register(api) {
          for (const provider of ${JSON.stringify(providers)}) api.registerProvider({
            id: provider, label: "Recovery fixture", auth: [],
            staticCatalog: provider === ${JSON.stringify(provider)} ? {
              order: "simple", async run() {
                const response = await fetch(${JSON.stringify(`${baseUrl}/prepare`)});
                if (!response.ok) throw new Error("Fixture runtime preparation failed");
                return null;
              },
            } : undefined,
            catalog: { order: "profile", async run(ctx) {
              const auth = ctx.resolveProviderAuth(provider);
              if (!auth.discoveryApiKey) return null;
              const { getCachedLiveCatalogValue } = await import("openclaw/plugin-sdk/provider-catalog-shared");
              const { threadId } = require("node:worker_threads");
              const rows = await getCachedLiveCatalogValue({
                keyParts: [${JSON.stringify(baseUrl)}, provider, auth.discoveryApiKey],
                ttlMs: provider === ${JSON.stringify(provider)} ? 0 : 86400000,
                load: async () => {
                  const response = await fetch(${JSON.stringify(baseUrl)} + "/" + provider, {
                    headers: { "x-fixture-thread": String(threadId) },
                  });
                  if (!response.ok) throw new Error("Fixture catalog unavailable");
                  return response.json();
                },
              });
              return { provider: { baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions",
                models: rows.map(id => ({ id, name: id, ...${JSON.stringify(catalogModelDefaults())} })) } };
            } },
          });
        },
      };`,
    );
    const token = "catalog-recovery-gateway-token";
    const cfg: OpenClawConfig = {
      models: {
        providers: { [provider]: { baseUrl, models: [], request: { allowPrivateNetwork: true } } },
      },
      agents: catalogAgents(state, {
        skipBootstrap: true,
        model: { primary: `${provider}/original` },
        modelPolicy: { allow: providers.map((id) => `${id}/*`) },
      }),
      tools: { profile: "minimal" },
      plugins: { allow: [provider], load: { paths: [pluginPath] }, slots: { memory: "none" } },
      gateway: { mode: "local", auth: { mode: "token", token } },
    };
    await state.writeConfig(cfg);
    await state.writeAuthProfiles(
      createCatalogAuthProfiles(Object.fromEntries(providers.map((id) => [id, `synthetic-${id}`]))),
    );
    await using gateway = await startModelsGateway(state, cfg, token);
    const { client, server } = gateway;
    const rpc = catalogSessionRpc(client);
    let releasePublication: (() => void) | undefined;
    try {
      await server.startupSettled;
      const list = (refresh = false, selectedProvider?: string) =>
        client.request<ModelsListResult>("models.list", {
          agentId: "main",
          view: "all",
          refresh,
          ...(selectedProvider ? { provider: selectedProvider } : {}),
        });
      const savedConfig = await fs.readFile(state.configPath, "utf8");
      const refresh = (selectedProvider?: string) =>
        waitForCatalogPublication({
          signal,
          start: () => list(true, selectedProvider),
          read: () => list(false, selectedProvider),
          ready: (result) => !result.pendingProviders?.length,
        });
      const initial = await refresh();
      expect(providers.flatMap((id) => catalogModelIds(initial, id)).toSorted()).toEqual([
        "healthy",
        "original",
      ]);
      const readSnapshot = () =>
        getPreparedModelRuntimeSnapshot({
          agentId: "main",
          agentDir: state.agentDir(),
          config: cfg,
        });
      const recoveryFailed = createDeferred<Error>();
      releasePublication = registerPreparedModelRuntimePublicationListener((event) => {
        if (event.phase === "failed") {
          recoveryFailed.resolve(event.error);
        }
      });
      hold = true;
      const renewal = once(events, "request");
      const renewing = await list(true, provider);
      expect(renewing.pendingProviders).toContain(provider);
      expect((await list()).models).toEqual(initial.models);
      await withinTest(renewal, signal);
      const failedRequests = requests;
      const healthyRequests = siblingRequests;
      const worker = workers.get(heldThread);
      expect(worker).toBeDefined();
      expect(heldThread).toBeGreaterThan(0);
      // Fail real preparation after worker exit, without synthesizing publication events.
      failedPreparations = 1;
      await worker!.terminate();
      expect((await withinTest(recoveryFailed.promise, signal)).message).toContain(
        "Fixture runtime preparation failed",
      );
      // Picker and chat must repair stale errors without a Gateway restart or plugin reload.
      const [rechecked, metadata] = await Promise.all([
        list(),
        client.request<ChatMetadataResult>("chat.metadata", { agentId: "main" }),
      ]);
      expect(rechecked.models).toEqual(initial.models);
      expect(metadata.models).toContainEqual(
        expect.objectContaining({ provider, id: "original", available: true }),
      );
      for (let read = 0; read < 3; read++) {
        const saved = await list();
        expect(saved.models).toEqual(initial.models);
        expect(saved.refreshFailed).toBe(true);
        expect(requests).toBe(failedRequests);
        expect(siblingRequests).toBe(healthyRequests);
      }
      const replacement = readSnapshot()!;
      expect(replacement.config.agents?.defaults?.model).toEqual({
        primary: `${provider}/original`,
      });
      await refreshPreparedModelRuntimeSnapshots(replacement.config, {
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
        agentIds: new Set(["main"]),
        pluginMetadataSnapshot: replacement.metadataSnapshot,
      });
      const reloaded = await list();
      expect(reloaded.models).toEqual(initial.models);
      expect(reloaded.refreshFailed).toBe(true);
      expect(await fs.readFile(state.configPath, "utf8")).toBe(savedConfig);
      expect(requests).toBe(failedRequests);
      // A real turn proves recovered model/auth usability after the static rebuild too.
      const session = await rpc.create(`${provider}/original`, "agent:main:recovered-runtime");
      const turn = await rpc.send(
        session.key,
        "Reply with the recovered runtime marker.",
        "recovered-runtime-turn",
      );
      expect(turn.status).toBe("started");
      expect(await rpc.wait(turn.runId)).toMatchObject({ status: "ok" });
      expectAssistantReply((await rpc.history(session.key)).messages, "RECOVERED_RUNTIME_REPLY");
      expect(inferenceRequests).toEqual([
        { authorization: `Bearer synthetic-${provider}`, model: "original" },
      ]);
      expect((await refresh(sibling)).refreshFailed).toBe(true);
      expect(requests).toBe(failedRequests);
      advertised = ["original", "recovered"];
      releaseResponses();
      const refreshed = await refresh(provider);
      expect(catalogModelIds(refreshed, provider)).toEqual(["original", "recovered"]);
      expect(refreshed.refreshFailed).not.toBe(true);
    } finally {
      releasePublication?.();
      releaseResponses();
    }
  } finally {
    workerChannel.unsubscribe(recordWorker);
    await Promise.all(providerWork);
  }
}, 120_000);
