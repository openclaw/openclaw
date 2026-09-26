/**
 * Real runtime proof for PR #154462: a runtime-config replacement published while a turn
 * is mid-run no longer kills the turn at its next model-capability read. A visible
 * chat.send turn starts against the loopback provider, the provider holds the primary
 * model call open while a real config.patch publishes generation B through the Gateway's
 * hot-reload path (replacing the prepared model runtime owner), and the turn — still
 * carrying config generation A — fails over to its fallback model. That failover's
 * capability read (resolveRunModelHasVision → loadProviderScopedThinkingCatalog, caller
 * config A vs published owner B) completes against the published owner instead of
 * throwing PreparedModelCatalogConfigReplacedError.
 *
 * The harness supplies only the loopback provider and its response gates; the gateway,
 * WebSocket RPC client, config write path, hot reload, and failover runner are the real
 * ones.
 */
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  getPreparedModelCatalogOwnerSnapshot,
  loadProviderScopedThinkingCatalog,
} from "../src/agents/prepared-model-catalog.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../src/config/types.models.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const envKeys = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

const PROVIDER_ID = "mock-anthropic";
const PRIMARY_MODEL_ID = "claude-opus-5";
const FALLBACK_MODEL_ID = "claude-haiku-5";
const TOKEN = "pr154462-proof-token";
const REPLY_MARKER = "PR154462_TURN_COMPLETED_AFTER_REPLACEMENT";

const epoch = performance.now();
function proof(event: string, data: Record<string, unknown> = {}): void {
  // The captured terminal output is the evidence this proof exists to produce.
  console.log(
    JSON.stringify({
      proof: true,
      event,
      utc: new Date().toISOString(),
      ms: Number((performance.now() - epoch).toFixed(1)),
      pid: process.pid,
      ...data,
    }),
  );
}

function anthropicSse(events: Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

/** A plain streamed text answer attributed to the requested model. */
function textTurn(model: string, text: string): string {
  return anthropicSse([
    {
      type: "message_start",
      message: {
        id: `msg_pr154462_${model}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 320, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 8 },
    },
    { type: "message_stop" },
  ]);
}

function buildMockAnthropicProvider(baseUrl: string) {
  const model: ModelDefinitionConfig = {
    id: PRIMARY_MODEL_ID,
    name: "Mock Claude Opus 5",
    api: "anthropic-messages",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
  // The fallback model is deliberately NOT declared: with no authored row and no carried
  // catalog entry, the failover's resolveRunModelHasVision read must hydrate its
  // capabilities through loadProviderScopedThinkingCatalog on the real turn path.
  const config: Omit<ModelProviderConfig, "models"> & { models: [ModelDefinitionConfig] } = {
    baseUrl,
    apiKey: "sk-ant-api03-pr154462-proof", // pragma: allowlist secret
    api: "anthropic-messages",
    models: [model],
  };
  return {
    providerId: PROVIDER_ID,
    primaryRef: `${PROVIDER_ID}/${PRIMARY_MODEL_ID}`,
    fallbackRef: `${PROVIDER_ID}/${FALLBACK_MODEL_ID}`,
    config,
  } as const;
}

describe("PR #154462 real runtime proof", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it(
    "keeps a turn alive across a runtime-config replacement published mid-run",
    { timeout: 120_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      const providerRequests: string[] = [];
      // The proof turn's primary-model call parks here until the test fails it.
      let heldPrimaryResponse: ServerResponse | undefined;
      let resolvePrimaryHeld = () => {};
      const primaryHeld = new Promise<void>((resolve) => {
        resolvePrimaryHeld = resolve;
      });
      let holdNextPrimaryCall = false;
      let failPrimaryCalls = false;
      let dummyServer: ReturnType<typeof createServer> | undefined;

      try {
        const tempHome = tempDirs.make("openclaw-pr154462-proof-");
        const stateDir = path.join(tempHome, ".openclaw");
        const workspaceDir = path.join(tempHome, "workspace");
        const configPath = path.join(stateDir, "openclaw.json");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        await Promise.all([
          fs.mkdir(workspaceDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
          fs.mkdir(path.dirname(configPath), { recursive: true }),
        ]);
        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: TOKEN,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        })) {
          setTestEnvValue(key, value);
        }

        providerServer = createServer((request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            const parsed = JSON.parse(body) as { model?: string };
            const model = parsed.model ?? "";
            providerRequests.push(model);
            if (holdNextPrimaryCall && model === PRIMARY_MODEL_ID) {
              holdNextPrimaryCall = false;
              heldPrimaryResponse = response;
              resolvePrimaryHeld();
              return;
            }
            // After the held call fails, retried primary calls fail the same way so the
            // runner's next candidate is the fallback model.
            if (failPrimaryCalls && model === PRIMARY_MODEL_ID) {
              response.writeHead(404, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  type: "error",
                  error: { type: "not_found_error", message: `model: ${model}` },
                }),
              );
              return;
            }
            response.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
            });
            response.end(textTurn(model, model === FALLBACK_MODEL_ID ? REPLY_MARKER : "warmup-ok"));
          });
        });
        await new Promise<void>((resolve, reject) => {
          providerServer?.once("error", reject);
          providerServer?.listen(0, "127.0.0.1", resolve);
        });
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }
        const provider = buildMockAnthropicProvider(`http://127.0.0.1:${providerAddress.port}`);
        const cfg = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.primaryRef, fallbacks: [provider.fallbackRef] },
              thinkingDefault: "low",
            },
            entries: { main: { default: true } },
          },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          gateway: { auth: { mode: "token", token: TOKEN } },
        };
        const sessionKey = "agent:main:pr154462-proof";
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token: TOKEN,
          clientDisplayName: "pr154462-proof",
          scopes: ["operator.admin", "operator.read", "operator.write"],
          // Models hot reloads are classified irreversible and refuse to apply without
          // a restart recovery owner; a real Gateway always runs with one (gateway-cli).
          hotReloadRecovery: () => ({ status: "emitted" as const }),
        });
        const client = gateway.client;
        proof("gateway_ready", { port: gateway.port });

        const rpc = async <T>(method: string, params: unknown): Promise<T> => {
          proof("rpc_request", { method, params });
          const result = await client.request<T>(method, params, { timeoutMs: 60_000 });
          proof("rpc_response", { method, result });
          return result;
        };

        // Baseline: a real turn completes against the loopback provider under config A.
        const warmup = await rpc<{ runId?: string; status?: string }>("chat.send", {
          sessionKey,
          message: "warmup turn",
          deliver: false,
          idempotencyKey: "pr154462-warmup",
        });
        expect(warmup.status).toBe("started");
        const warmupWaited = await rpc<{ status?: string }>("agent.wait", {
          runId: warmup.runId,
          timeoutMs: 30_000,
        });
        expect(warmupWaited).toMatchObject({ status: "ok" });
        proof("warmup_completed", { providerRequests: [...providerRequests] });

        // The published runtime config object IS generation A: the running turn carries it.
        const configA = getRuntimeConfig();
        proof("config_a_owner_published", {
          ownerForConfigA: getPreparedModelCatalogOwnerSnapshot({ config: configA }) !== undefined,
        });

        // Start the proof turn and park its primary-model call inside the provider, so the
        // run holds its lease and captured config generation A while the replacement lands.
        holdNextPrimaryCall = true;
        const held = await rpc<{ runId?: string; status?: string }>("chat.send", {
          sessionKey,
          message: "proof turn across config replacement",
          deliver: false,
          idempotencyKey: "pr154462-held-turn",
        });
        expect(held.status).toBe("started");
        await primaryHeld;
        proof("primary_call_held", { runId: held.runId, providerRequests: [...providerRequests] });

        // Publish generation B through the real gateway write path: config.patch persists
        // the delta and applies the hot reload, which republishes the prepared model
        // runtime under the new config generation while the turn is mid-call.
        const before = await rpc<{ hash: string }>("config.get", {});
        const patched = await rpc<{ hash?: string }>("config.patch", {
          baseHash: before.hash,
          raw: JSON.stringify({ agents: { defaults: { thinkingDefault: "medium" } } }),
        });
        expect(patched.hash).toEqual(expect.any(String));
        const configB = getRuntimeConfig();
        proof("config_b_published", {
          runtimeConfigReplaced: configB !== configA,
          ownerForConfigA: getPreparedModelCatalogOwnerSnapshot({ config: configA }) !== undefined,
          ownerForConfigB: getPreparedModelCatalogOwnerSnapshot({ config: configB }) !== undefined,
        });
        expect(configB).not.toBe(configA);
        // The published owner no longer serves generation A: exactly the replaced-config
        // window the running turn's next capability read executes in.
        expect(getPreparedModelCatalogOwnerSnapshot({ config: configA })).toBeUndefined();
        expect(getPreparedModelCatalogOwnerSnapshot({ config: configB })).toBeDefined();

        // Fail the held primary call as model_not_found: the runner immediately fails over
        // to the (undeclared) fallback model, and resolveRunModelHasVision hydrates its
        // capabilities through loadProviderScopedThinkingCatalog with config A.
        const requestsBeforeFailover = providerRequests.length;
        if (!heldPrimaryResponse) {
          throw new Error("primary call was not held");
        }
        failPrimaryCalls = true;
        heldPrimaryResponse.writeHead(404, { "content-type": "application/json" });
        heldPrimaryResponse.end(
          JSON.stringify({
            type: "error",
            error: { type: "not_found_error", message: `model: ${PRIMARY_MODEL_ID}` },
          }),
        );
        proof("primary_call_failed", { runId: held.runId });

        const waited = await rpc<{ status?: string }>("agent.wait", {
          runId: held.runId,
          timeoutMs: 30_000,
        });
        proof("held_turn_terminal", {
          waited,
          modelsAfterFailover: providerRequests.slice(requestsBeforeFailover),
        });
        expect(waited).toMatchObject({ status: "ok" });
        // The failover attempt's capability read survived the replacement and the fallback
        // request reached the real transport.
        expect(providerRequests.slice(requestsBeforeFailover)).toContain(FALLBACK_MODEL_ID);

        const history = await rpc<{ messages?: unknown[] }>("chat.history", {
          sessionKey,
          limit: 20,
        });
        const serialized = JSON.stringify(history.messages ?? []);
        expect(serialized).toContain(REPLY_MARKER);
        expect(serialized).not.toContain("PreparedModelCatalogConfigReplacedError");
        proof("history_verified", { markerPresent: serialized.includes(REPLY_MARKER) });

        // Retained capabilities: the same in-process read the turn path performs, with the
        // stale generation-A config, still resolves the published owner's capability facts.
        const staleRead = await loadProviderScopedThinkingCatalog({
          config: configA,
          provider: PROVIDER_ID,
          model: PRIMARY_MODEL_ID,
        });
        const staleEntry = staleRead.find(
          (entry) => entry.provider === PROVIDER_ID && entry.id === PRIMARY_MODEL_ID,
        );
        proof("stale_config_read", {
          entries: staleRead.length,
          reasoning: staleEntry?.reasoning,
          input: staleEntry?.input,
        });
        expect(staleEntry).toMatchObject({ reasoning: true, input: ["text", "image"] });
        proof("scenario_pass", { sessionKey });

        // Model-affecting replacement: a second real config.patch moves the provider to a
        // different loopback route (a bound listener that never receives traffic). The same
        // stale generation-A read must NOT adopt the rerouted owner's capability facts.
        dummyServer = createServer(() => {});
        await new Promise<void>((resolve, reject) => {
          dummyServer?.once("error", reject);
          dummyServer?.listen(0, "127.0.0.1", resolve);
        });
        const dummyAddress = dummyServer.address();
        if (!dummyAddress || typeof dummyAddress === "string") {
          throw new Error("dummy reroute listener did not bind a loopback port");
        }
        const reroutedBaseUrl = `http://127.0.0.1:${dummyAddress.port}`;
        const beforeReroute = await rpc<{ hash: string }>("config.get", {});
        const rerouted = await rpc<{ hash?: string }>("config.patch", {
          baseHash: beforeReroute.hash,
          raw: JSON.stringify({
            models: {
              providers: {
                [provider.providerId]: { ...provider.config, baseUrl: reroutedBaseUrl },
              },
            },
          }),
        });
        expect(rerouted.hash).toEqual(expect.any(String));
        expect(getRuntimeConfig()).not.toBe(configB);
        proof("model_affecting_config_published", { reroutedBaseUrl });
        const guardedRead = await loadProviderScopedThinkingCatalog({
          config: configA,
          provider: PROVIDER_ID,
          model: PRIMARY_MODEL_ID,
        });
        const guardedEntry = guardedRead.find(
          (entry) => entry.provider === PROVIDER_ID && entry.id === PRIMARY_MODEL_ID,
        );
        proof("model_affecting_replacement_guarded", {
          entries: guardedRead.length,
          entryPresent: guardedEntry !== undefined,
          entryBaseUrl: guardedEntry?.baseUrl,
          reroutedBaseUrl,
        });
        expect(guardedEntry).toBeUndefined();

        // Catalog-sourced route: a generation-A caller whose authored config never named the
        // provider (its transport came from its earlier catalog row, e.g. plugin discovery)
        // cannot be constrained by config alone — without the turn's effective route the
        // rerouted owner's facts are adopted; passing the warmup turn's route (the first
        // loopback baseUrl, carried on its catalog row) drops them.
        const warmupBaseUrl = provider.config.baseUrl;
        const configANoAuthoredRoute = {
          ...configA,
          models: { mode: "replace" as const, providers: {} },
        };
        const unguardedCatalogRouteRead = await loadProviderScopedThinkingCatalog({
          config: configANoAuthoredRoute,
          provider: PROVIDER_ID,
          model: PRIMARY_MODEL_ID,
        });
        const unguardedCatalogRouteEntry = unguardedCatalogRouteRead.find(
          (entry) => entry.provider === PROVIDER_ID && entry.id === PRIMARY_MODEL_ID,
        );
        expect(unguardedCatalogRouteEntry?.baseUrl).toBe(reroutedBaseUrl);
        const catalogRouteRead = await loadProviderScopedThinkingCatalog({
          config: configANoAuthoredRoute,
          provider: PROVIDER_ID,
          model: PRIMARY_MODEL_ID,
          effectiveRoute: { api: "anthropic-messages", baseUrl: warmupBaseUrl },
        });
        const catalogRouteEntry = catalogRouteRead.find(
          (entry) => entry.provider === PROVIDER_ID && entry.id === PRIMARY_MODEL_ID,
        );
        proof("catalog_sourced_route_guarded", {
          effectiveBaseUrl: warmupBaseUrl,
          reroutedBaseUrl,
          unguardedEntryBaseUrl: unguardedCatalogRouteEntry?.baseUrl,
          guardedEntryPresent: catalogRouteEntry !== undefined,
        });
        expect(catalogRouteEntry).toBeUndefined();
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (dummyServer?.listening) {
          await new Promise<void>((resolve) => {
            dummyServer?.close(() => resolve());
          });
        }
        if (providerServer?.listening) {
          heldPrimaryResponse?.destroy();
          await new Promise<void>((resolve) => {
            providerServer?.close(() => resolve());
          });
        }
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    },
  );
});
