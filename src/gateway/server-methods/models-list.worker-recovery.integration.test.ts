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
import { getPreparedModelFullCatalogAuth } from "../../agents/prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "../../agents/prepared-model-runtime.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "../../agents/prepared-model-runtime.owner.js";
import { registerPreparedModelRuntimePublicationListener } from "../../agents/prepared-model-runtime.publication-events.js";
import type { OpenClawConfig } from "../../config/types.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";
import type { ChatMetadataResult } from "./chat-metadata-contract.js";
import { waitForCatalogPublication } from "./models-auth-catalog.test-support.js";

it("model reads recover a failed shared-worker publication and retain the failed renewal", async ({
  signal,
}) => {
  const state = await createOpenClawTestState({
    label: "catalog-worker-recovery",
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
  const reply = (response: ServerResponse, rows = advertised) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(rows));
  };
  const endpoint = createServer((request, response) => {
    if (request.url === "/prepare") {
      if (failedPreparations > 0) {
        failedPreparations--;
        response.writeHead(503).end();
      } else {
        response.writeHead(200).end();
      }
      return;
    }
    if (request.method === "POST" && request.url === "/chat/completions") {
      const work = (async () => {
        const body = JSON.parse(await readText(request));
        inferenceRequests.push({ authorization: request.headers.authorization, model: body.model });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            id: "chatcmpl-recovered-runtime",
            object: "chat.completion.chunk",
            created: 0,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "RECOVERED_RUNTIME_REPLY" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
          })}\n\ndata: [DONE]\n\n`,
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
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    if (!address || typeof address === "string") {
      throw new Error("Catalog fixture did not bind a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await state.writeJson("catalog-plugin/openclaw.plugin.json", {
      id: provider,
      providers,
      configSchema: { type: "object", additionalProperties: false },
    });
    const pluginPath = await state.writeText(
      "catalog-plugin/index.cjs",
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
                models: rows.map(id => ({ id, name: id, reasoning: false, input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 })) } };
            } },
          });
        },
      };`,
    );
    const token = "catalog-recovery-gateway-token";
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          [provider]: {
            baseUrl,
            models: [],
            request: { allowPrivateNetwork: true },
          },
        },
      },
      agents: {
        defaults: {
          skipBootstrap: true,
          heartbeat: { every: "0m" },
          model: { primary: `${provider}/original` },
          modelPolicy: { allow: providers.map((id) => `${id}/*`) },
        },
        entries: { main: { workspace: state.workspaceDir } },
      },
      tools: { profile: "minimal" },
      plugins: { allow: [provider], load: { paths: [pluginPath] }, slots: { memory: "none" } },
      gateway: { mode: "local", auth: { mode: "token", token } },
    };
    await state.writeConfig(cfg);
    await state.writeAuthProfiles({
      version: 1,
      profiles: Object.fromEntries(
        providers.map((id) => [
          `${id}:default`,
          { type: "api_key", provider: id, key: `synthetic-${id}` },
        ]),
      ),
    });
    const { client, server } = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: ["operator.admin"],
    });
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
      expect(
        initial.models
          .filter((row) => providers.includes(row.provider))
          .map((row) => row.id)
          .toSorted(),
      ).toEqual(["healthy", "original"]);
      const original = getPreparedModelRuntimeSnapshot({
        agentId: "main",
        agentDir: state.agentDir(),
        config: cfg,
      });
      expect(original).toBeDefined();
      const providerFacts = resolvePreparedModelRuntimeOwnerBySnapshot(
        original!,
      )?.catalogInventory?.providers.get(provider);
      if (!providerFacts) {
        throw new Error("Missing published recovery fixture inventory");
      }
      expect(providerFacts.expiresAt).toBeUndefined();
      const initialRequests = requests;
      expect((await list()).models).toEqual(initial.models);
      expect(requests).toBe(initialRequests);
      const renewalFailed = createDeferred<Error>();
      const recoveryFailed = createDeferred<Error>();
      releasePublication = registerPreparedModelRuntimePublicationListener((event) => {
        if (event.phase === "published" && !original!.isCurrent()) {
          events.emit("recovered");
        } else if (event.phase === "failed") {
          renewalFailed.resolve(event.error);
          recoveryFailed.resolve(event.error);
        } else if (event.phase === "catalog-failed") {
          renewalFailed.resolve(event.error);
        }
      });
      // Arm the held request before making renewal due; a wall-clock TTL can expire
      // during the initial models.list response, before this observer exists.
      hold = true;
      const renewal = once(events, "request");
      providerFacts.expiresAt = 0;
      const retained = await list();
      expect(retained.models).toEqual(initial.models);
      // Bind waits to the test signal so a stall still reaches held-response and Gateway cleanup.
      await withinTest(
        Promise.race([
          renewal,
          renewalFailed.promise.then((error) => {
            throw error;
          }),
        ]),
        signal,
      );
      const acceptedCatalog = original!.readFullModelCatalog!()!;
      const catalogAuth = getPreparedModelFullCatalogAuth(acceptedCatalog)!;
      const acceptedAuth = {
        ...catalogAuth,
        authStore: { profiles: catalogAuth.authStore.profiles },
      };
      const acceptedRuntime = original!.readPublishedModels!();
      expect(acceptedAuth?.authStore.profiles[`${provider}:default`]).toMatchObject({
        type: "api_key",
        provider,
        key: `synthetic-${provider}`,
      });
      expect(acceptedRuntime?.get(provider)?.map((model) => model.id)).toContain("original");
      const failedRequests = requests;
      const healthyRequests = siblingRequests;
      const worker = workers.get(heldThread);
      expect(worker).toBeDefined();
      expect(heldThread).toBeGreaterThan(0);
      console.info("terminating fixture catalog thread", {
        pid: process.pid,
        cwd: process.cwd(),
        threadId: heldThread,
      });
      // A real provider preparation failure rejects the automatic publication, after
      // the old worker has exited. No synthetic owner or publication event is installed.
      failedPreparations = 1;
      await worker!.terminate();
      expect((await withinTest(recoveryFailed.promise, signal)).message).toContain(
        "Fixture runtime preparation failed",
      );
      // Opening the model picker and preparing a chat share one demand-driven repair.
      // A stale cached error must not require a Gateway restart or a plugin reload.
      const [rechecked, metadata] = await Promise.all([
        list(),
        client.request<ChatMetadataResult>("chat.metadata", { agentId: "main" }),
      ]);
      expect(rechecked.models).toEqual(initial.models);
      expect(metadata.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider, id: "original", available: true }),
        ]),
      );
      for (let read = 0; read < 3; read++) {
        const saved = await list();
        expect(saved.models).toEqual(initial.models);
        expect(saved.refreshFailed).toBe(true);
        expect(requests).toBe(failedRequests);
        expect(siblingRequests).toBe(healthyRequests);
      }
      const replacement = getPreparedModelRuntimeSnapshot({
        agentId: "main",
        agentDir: state.agentDir(),
        config: cfg,
      })!;
      const replacementAuth = getPreparedModelFullCatalogAuth(
        replacement.readFullModelCatalog!()!,
      )!;
      expect({
        ...replacementAuth,
        authStore: { profiles: replacementAuth.authStore.profiles },
      }).toEqual(acceptedAuth);
      expect(replacement.readPublishedModels!()).toEqual(acceptedRuntime);
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
      const reloadedOwner = getPreparedModelRuntimeSnapshot({
        agentId: "main",
        agentDir: state.agentDir(),
        config: cfg,
      })!;
      const reloadedAuth = getPreparedModelFullCatalogAuth(reloadedOwner.readFullModelCatalog!()!)!;
      expect({ ...reloadedAuth, authStore: { profiles: reloadedAuth.authStore.profiles } }).toEqual(
        acceptedAuth,
      );
      expect(reloadedOwner.readPublishedModels!()).toEqual(acceptedRuntime);
      expect(reloadedOwner.config.agents?.defaults?.model).toEqual({
        primary: `${provider}/original`,
      });
      expect(await fs.readFile(state.configPath, "utf8")).toBe(savedConfig);
      expect(requests).toBe(failedRequests);
      expect((await refresh(sibling)).refreshFailed).toBe(true);
      expect(requests).toBe(failedRequests);
      advertised = ["original", "recovered"];
      hold = false;
      for (const response of held.splice(0)) {
        reply(response);
      }
      const refreshed = await refresh(provider);
      expect(
        refreshed.models.filter((row) => row.provider === provider).map((row) => row.id),
      ).toEqual(["original", "recovered"]);
      expect(refreshed.refreshFailed).not.toBe(true);
      const session = await client.request<{ key: string }>("sessions.create", {
        agentId: "main",
        key: "agent:main:recovered-runtime",
        model: `${provider}/original`,
      });
      const turn = await client.request<{ runId: string; status: string }>("chat.send", {
        sessionKey: session.key,
        message: "Reply with the recovered runtime marker.",
        idempotencyKey: "recovered-runtime-turn",
      });
      expect(turn.status).toBe("started");
      const completed = await client.request<{ status: string; error?: string }>(
        "agent.wait",
        { runId: turn.runId, timeoutMs: 30_000 },
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
              expect.objectContaining({ type: "text", text: "RECOVERED_RUNTIME_REPLY" }),
            ]),
          }),
        ]),
      );
      expect(inferenceRequests).toEqual([
        { authorization: `Bearer synthetic-${provider}`, model: "original" },
      ]);
    } finally {
      releasePublication?.();
      hold = false;
      for (const response of held.splice(0)) {
        reply(response);
      }
      await disconnectGatewayClient(client);
      await server.close();
    }
  } finally {
    workerChannel.unsubscribe(recordWorker);
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => {
      endpoint.close(() => resolve());
    });
    await Promise.all(providerWork);
    await state.cleanup();
  }
}, 120_000);
