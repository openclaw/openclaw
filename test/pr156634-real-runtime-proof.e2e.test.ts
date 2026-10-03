/**
 * Real runtime proof for PR #156634: queued channel replies adopt the replacement
 * runtime-config generation instead of re-resolving SecretRefs into config bytes that
 * diverge from the prepared model catalog.
 *
 * Queue mechanics exercised here (verified in source): with `messages.queue.mode:
 * "followup"` a second chat.send against a session with an active run enqueues a
 * FollowupRun (agent-runner-run.ts enqueueFollowupRun) instead of steering into the
 * active turn. When the active run's operation clears, the queue drains through
 * runOutsidePreparedModelRuntimePluginGenerationScope (queue/drain.ts), so
 * admitFollowupTurn's resolveQueuedReplyExecutionConfig sees no admitted generation
 * and rebinds the parked config to the current publication.
 *
 * Scenario 1 (the PR's core claim): turn 1 holds its provider call open, turn 2
 * queues behind it, a real config.patch rotates the runtime-config generation, turn 1
 * releases, and the queued turn drains and completes against the replacement
 * generation. On the pre-PR resolver this path keeps the retired generation's bytes
 * and trips the catalog identity guard.
 *
 * Scenario 2 (the P1 admitted-turn gate): a direct turn whose preflight compaction
 * call is held open across the rotation keeps its retained config paired with its
 * generation lease. Without the admittedGeneration gate in
 * resolveQueuedReplyRuntimeConfig, executeAgentTurn rebinds the admitted turn's
 * config to the new publication while its lease still carries the prior plugin
 * generation, and the nested prepared-runtime borrow fails as superseded.
 *
 * The harness supplies only the loopback provider and its response gates; the
 * gateway, WebSocket RPC client, config write path, hot reload, followup queue, and
 * drain are the real ones.
 */
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { getPreparedModelCatalogOwnerSnapshot } from "../src/agents/prepared-model-catalog.js";
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
  "PR156634_PROVIDER_API_KEY",
] as const;

const PROVIDER_ID = "mock-anthropic";
const MODEL_ID = "claude-opus-5";
const TOKEN = "pr156634-proof-token";
const API_KEY_ENV = "PR156634_PROVIDER_API_KEY";
const INITIAL_API_KEY = "sk-ant-api03-pr156634-proof"; // pragma: allowlist secret
const ROTATED_API_KEY = "sk-ant-api03-pr156634-rotated"; // pragma: allowlist secret
const QUEUED_REPLY_MARKER = "PR156634_QUEUED_TURN_COMPLETED_AFTER_ROTATION";
const HELD_REPLY_MARKER = "PR156634_HELD_TURN_COMPLETED";
const DIRECT_REPLY_MARKER = "PR156634_DIRECT_TURN_COMPLETED_AFTER_ROTATION";
const CATALOG_GUARD_ERRORS = [
  "PreparedModelCatalogConfigReplacedError",
  "PreparedModelRuntimeOwnerNotPublishedError",
  "prepared model catalog",
  "plugin generation was superseded",
] as const;

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

/** A plain streamed text answer with caller-controlled reported usage. */
function textTurn(model: string, text: string, usage: { input: number; output: number }): string {
  return anthropicSse([
    {
      type: "message_start",
      message: {
        id: `msg_pr156634_${Math.random().toString(36).slice(2, 10)}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: usage.input, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: usage.output },
    },
    { type: "message_stop" },
  ]);
}

function buildMockAnthropicProvider(baseUrl: string) {
  const model: ModelDefinitionConfig = {
    id: MODEL_ID,
    name: "Mock Claude Opus 5",
    api: "anthropic-messages",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
  // The apiKey is an env-sourced SecretRef, matching the PR's motivating shape: gateway
  // activation resolves it into the published runtime-config bytes, so a queued reply
  // that re-resolves secrets on stale config diverges from the prepared catalog.
  const config: Omit<ModelProviderConfig, "models"> & { models: [ModelDefinitionConfig] } = {
    baseUrl,
    apiKey: { source: "env", provider: "default", id: API_KEY_ENV },
    api: "anthropic-messages",
    models: [model],
  };
  return { providerId: PROVIDER_ID, primaryRef: `${PROVIDER_ID}/${MODEL_ID}`, config } as const;
}

function createChatFinalTracker() {
  const terminals: Record<string, unknown>[] = [];
  const markerWaiters: { marker: string; resolve: (payload: Record<string, unknown>) => void }[] =
    [];
  const onEvent = (evt: { event?: string; payload?: unknown }) => {
    if (evt.event !== "chat" || typeof evt.payload !== "object" || evt.payload === null) {
      return;
    }
    const payload = evt.payload as Record<string, unknown>;
    if (payload.state !== "final" && payload.state !== "aborted" && payload.state !== "error") {
      return;
    }
    proof("chat_terminal_event", {
      runId: payload.runId,
      state: payload.state,
      stopReason: payload.stopReason,
      message: payload.message,
    });
    terminals.push(payload);
    const serialized = JSON.stringify(payload);
    for (let index = markerWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = markerWaiters[index];
      if (waiter && serialized.includes(waiter.marker)) {
        markerWaiters.splice(index, 1);
        waiter.resolve(payload);
      }
    }
  };
  /** Resolves with the terminal chat broadcast whose payload carries the marker. */
  const waitForMarker = (marker: string): Promise<Record<string, unknown>> => {
    const existing = terminals.find((payload) => JSON.stringify(payload).includes(marker));
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      markerWaiters.push({ marker, resolve });
    });
  };
  return { onEvent, waitForMarker };
}

type ProofScenario = {
  label: string;
  sessionKey: string;
  warmupUsage: { input: number; output: number };
  queueMode: "followup";
};

async function setupScenario(
  tempDirs: ReturnType<typeof useAutoCleanupTempDirTracker>,
  scenario: ProofScenario,
) {
  const tempHome = tempDirs.make(`openclaw-pr156634-${scenario.label}-`);
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
    [API_KEY_ENV]: INITIAL_API_KEY,
  })) {
    setTestEnvValue(key, value);
  }
  return { workspaceDir, configPath };
}

describe("PR #156634 real runtime proof", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it(
    "completes a queued followup after a runtime-config rotation",
    { timeout: 120_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      const providerRequests: string[] = [];
      const providerApiKeys: string[] = [];
      // Turn 1's provider call parks here while turn 2 queues and the rotation lands.
      let heldResponse: ServerResponse | undefined;
      let resolveHeld = () => {};
      const held = new Promise<void>((resolve) => {
        resolveHeld = resolve;
      });
      let holdNextCall = false;

      try {
        const scenario: ProofScenario = {
          label: "queued",
          sessionKey: "agent:main:pr156634-proof-queued",
          warmupUsage: { input: 320, output: 8 },
          queueMode: "followup",
        };
        const { workspaceDir, configPath } = await setupScenario(tempDirs, scenario);

        providerServer = createServer((request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            providerRequests.push(body);
            providerApiKeys.push(String(request.headers["x-api-key"] ?? ""));
            const requestIndex = providerRequests.length - 1;
            proof("provider_request", {
              index: requestIndex,
              held: holdNextCall,
              hasQueuedTurnText: body.includes("PR156634 queued turn"),
              apiKey: providerApiKeys[requestIndex],
              maxTokens: (JSON.parse(body) as { max_tokens?: number }).max_tokens,
            });
            if (holdNextCall) {
              holdNextCall = false;
              heldResponse = response;
              resolveHeld();
              return;
            }
            const text = body.includes("PR156634 queued turn") ? QUEUED_REPLY_MARKER : "warmup-ok";
            response.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
            });
            response.end(textTurn(MODEL_ID, text, scenario.warmupUsage));
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
              model: { primary: provider.primaryRef },
              thinkingDefault: "low",
            },
            entries: { main: { default: true } },
          },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          messages: { queue: { mode: scenario.queueMode } },
          gateway: { auth: { mode: "token", token: TOKEN } },
        };
        const chatFinals = createChatFinalTracker();
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token: TOKEN,
          clientDisplayName: "pr156634-proof-queued",
          scopes: ["operator.admin", "operator.read", "operator.write"],
          onEvent: chatFinals.onEvent,
          // Models hot reloads are classified irreversible and refuse to apply without
          // a restart recovery owner; a real Gateway always runs with one (gateway-cli).
          hotReloadRecovery: () => ({ status: "emitted" as const }),
        });
        const client = gateway.client;
        proof("gateway_ready", { port: gateway.port, scenario: scenario.label });

        const rpc = async <T>(method: string, params: unknown): Promise<T> => {
          proof("rpc_request", { method, params });
          const result = await client.request<T>(method, params, { timeoutMs: 60_000 });
          proof("rpc_response", { method, result });
          return result;
        };

        // Baseline: a real turn completes against the loopback provider under config A.
        const warmup = await rpc<{ runId?: string; status?: string }>("chat.send", {
          sessionKey: scenario.sessionKey,
          message: "warmup turn",
          deliver: false,
          idempotencyKey: "pr156634-queued-warmup",
        });
        expect(warmup.status).toBe("started");
        const warmupWaited = await rpc<{ status?: string }>("agent.wait", {
          runId: warmup.runId,
          timeoutMs: 30_000,
        });
        expect(warmupWaited).toMatchObject({ status: "ok" });
        proof("warmup_completed", { providerRequests: providerRequests.length });

        const configA = getRuntimeConfig();
        proof("config_a_owner_published", {
          ownerForConfigA: getPreparedModelCatalogOwnerSnapshot({ config: configA }) !== undefined,
        });

        // Turn 1 parks at the provider so the session carries an active run.
        holdNextCall = true;
        const heldTurn = await rpc<{ runId?: string; status?: string }>("chat.send", {
          sessionKey: scenario.sessionKey,
          message: "hold this turn open",
          deliver: false,
          idempotencyKey: "pr156634-queued-held",
        });
        expect(heldTurn.status).toBe("started");
        await held;
        const requestsAtHold = providerRequests.length;
        proof("turn_one_held", { runId: heldTurn.runId, providerRequests: requestsAtHold });

        // Turn 2 enqueues as followup work behind the active run (messages.queue.mode
        // "followup"); it must not reach the provider while turn 1 is parked.
        const queuedTurn = await rpc<{ runId?: string; status?: string }>("chat.send", {
          sessionKey: scenario.sessionKey,
          message: "PR156634 queued turn behind the active run",
          deliver: false,
          idempotencyKey: "pr156634-queued-followup",
        });
        expect(queuedTurn.status).toBe("started");
        expect(providerRequests.length).toBe(requestsAtHold);
        proof("turn_two_queued", { runId: queuedTurn.runId, providerRequests: requestsAtHold });

        // Rotate the env-sourced provider secret, then publish generation B through
        // the real gateway write path while turn 1 is mid-call and turn 2 is parked
        // in the followup queue. The reload re-activates secrets, so generation B
        // carries the rotated key; the retired generation A still carries the old
        // one, and drain-time command SecretRef re-resolution over the stale config
        // is exactly the bytes divergence the PR removes.
        setTestEnvValue(API_KEY_ENV, ROTATED_API_KEY);
        const before = await rpc<{ hash: string }>("config.get", {});
        // Generation B also lowers the model's maxTokens: which max_tokens the queued
        // turn's request carries shows which generation it actually executed on.
        const rotatedModels = [{ ...provider.config.models[0], maxTokens: 2048 }];
        const patched = await rpc<{ hash?: string }>("config.patch", {
          baseHash: before.hash,
          raw: JSON.stringify({
            agents: { defaults: { thinkingDefault: "medium" } },
            models: {
              providers: {
                [provider.providerId]: { ...provider.config, models: rotatedModels },
              },
            },
          }),
        });
        expect(patched.hash).toEqual(expect.any(String));
        const configB = getRuntimeConfig();
        proof("config_b_published", {
          runtimeConfigReplaced: configB !== configA,
          ownerForConfigA: getPreparedModelCatalogOwnerSnapshot({ config: configA }) !== undefined,
          ownerForConfigB: getPreparedModelCatalogOwnerSnapshot({ config: configB }) !== undefined,
          queuedStillParked: providerRequests.length === requestsAtHold,
        });
        expect(configB).not.toBe(configA);
        expect(getPreparedModelCatalogOwnerSnapshot({ config: configA })).toBeUndefined();
        expect(getPreparedModelCatalogOwnerSnapshot({ config: configB })).toBeDefined();
        expect(providerRequests.length).toBe(requestsAtHold);

        // Release turn 1: its retained lease finishes the turn, the reply operation
        // clears, and the followup queue drains outside the generation scope.
        if (!heldResponse) {
          throw new Error("turn 1 provider call was not held");
        }
        heldResponse.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        });
        heldResponse.end(textTurn(MODEL_ID, HELD_REPLY_MARKER, scenario.warmupUsage));
        proof("turn_one_released", { runId: heldTurn.runId });

        const heldWaited = await rpc<{ status?: string }>("agent.wait", {
          runId: heldTurn.runId,
          timeoutMs: 30_000,
        });
        expect(heldWaited).toMatchObject({ status: "ok" });

        // The queued turn drains, rebinds to generation B, and completes for real.
        // Queued followups execute under a fresh internal runId (followup-turn-admission
        // preallocates one) and the client runId's "final" broadcast is only the queue
        // source settlement, so the drained run's completion signal is the terminal
        // chat broadcast carrying its reply.
        const queuedFinal = await chatFinals.waitForMarker(QUEUED_REPLY_MARKER);
        proof("queued_turn_terminal", {
          clientRunId: queuedTurn.runId,
          drainedRunId: queuedFinal.runId,
          state: queuedFinal.state,
          providerRequestsAfterDrain: providerRequests.length,
        });
        expect(queuedFinal.state).toBe("final");
        // The queued turn's request reached the real transport only after the drain,
        // and it authenticated with generation B's rotated secret: the drain adopted
        // the replacement generation instead of re-resolving refs on the retired one.
        expect(providerRequests.length).toBe(requestsAtHold + 1);
        const queuedRequest = providerRequests[providerRequests.length - 1] ?? "";
        expect(queuedRequest).toContain("PR156634 queued turn");
        expect(providerApiKeys[providerApiKeys.length - 1]).toBe(ROTATED_API_KEY);
        expect(providerApiKeys.slice(0, requestsAtHold)).toEqual(
          Array.from({ length: requestsAtHold }, () => INITIAL_API_KEY),
        );
        // The queued request carries generation B's model params: the drain executed
        // on the replacement generation, not the retired one it captured at enqueue.
        expect((JSON.parse(queuedRequest) as { max_tokens?: number }).max_tokens).toBe(2048);

        const history = await rpc<{ messages?: unknown[] }>("chat.history", {
          sessionKey: scenario.sessionKey,
          limit: 20,
        });
        const serialized = JSON.stringify(history.messages ?? []);
        expect(serialized).toContain(QUEUED_REPLY_MARKER);
        for (const guardError of CATALOG_GUARD_ERRORS) {
          expect(serialized).not.toContain(guardError);
        }
        proof("scenario_pass", {
          scenario: scenario.label,
          queuedMarkerPresent: serialized.includes(QUEUED_REPLY_MARKER),
        });
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          heldResponse?.destroy();
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

  it(
    "keeps an admitted direct turn on its retained config across a rotation",
    { timeout: 120_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      const providerRequests: string[] = [];
      // The admitted turn's preflight compaction call parks here: the turn already
      // holds its prepared-runtime lease and generation scope, and the rotation lands
      // before executeAgentTurn resolves the run config again.
      let heldResponse: ServerResponse | undefined;
      let resolveHeld = () => {};
      const held = new Promise<void>((resolve) => {
        resolveHeld = resolve;
      });
      let holdNextCall = false;

      try {
        const scenario: ProofScenario = {
          label: "direct",
          // Warmup reports usage above the compaction threshold (contextWindow 200k -
          // 20k reserve) so the proof turn runs a preflight compaction model call.
          sessionKey: "agent:main:pr156634-proof-direct",
          warmupUsage: { input: 190_000, output: 8 },
          queueMode: "followup",
        };
        const { workspaceDir, configPath } = await setupScenario(tempDirs, scenario);

        providerServer = createServer((request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            providerRequests.push(body);
            const requestIndex = providerRequests.length - 1;
            proof("provider_request", {
              index: requestIndex,
              held: holdNextCall,
              hasDirectTurnText: body.includes("PR156634 direct turn"),
            });
            if (holdNextCall) {
              holdNextCall = false;
              heldResponse = response;
              resolveHeld();
              return;
            }
            const isWarmup = requestIndex === 0;
            response.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
            });
            response.end(
              textTurn(
                MODEL_ID,
                isWarmup ? "warmup-ok" : DIRECT_REPLY_MARKER,
                isWarmup ? scenario.warmupUsage : { input: 320, output: 8 },
              ),
            );
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
              model: { primary: provider.primaryRef },
              thinkingDefault: "low",
            },
            entries: { main: { default: true } },
          },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          messages: { queue: { mode: scenario.queueMode } },
          gateway: { auth: { mode: "token", token: TOKEN } },
        };
        const chatFinals = createChatFinalTracker();
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token: TOKEN,
          clientDisplayName: "pr156634-proof-direct",
          scopes: ["operator.admin", "operator.read", "operator.write"],
          onEvent: chatFinals.onEvent,
          hotReloadRecovery: () => ({ status: "emitted" as const }),
        });
        const client = gateway.client;
        proof("gateway_ready", { port: gateway.port, scenario: scenario.label });

        const rpc = async <T>(method: string, params: unknown): Promise<T> => {
          proof("rpc_request", { method, params });
          const result = await client.request<T>(method, params, { timeoutMs: 60_000 });
          proof("rpc_response", { method, result });
          return result;
        };

        // Warmup inflates the persisted session tokens past the compaction threshold.
        const warmup = await rpc<{ runId?: string; status?: string }>("chat.send", {
          sessionKey: scenario.sessionKey,
          message: "warmup turn",
          deliver: false,
          idempotencyKey: "pr156634-direct-warmup",
        });
        expect(warmup.status).toBe("started");
        const warmupWaited = await rpc<{ status?: string }>("agent.wait", {
          runId: warmup.runId,
          timeoutMs: 30_000,
        });
        expect(warmupWaited).toMatchObject({ status: "ok" });
        proof("warmup_completed", { providerRequests: providerRequests.length });

        const configA = getRuntimeConfig();
        proof("config_a_owner_published", {
          ownerForConfigA: getPreparedModelCatalogOwnerSnapshot({ config: configA }) !== undefined,
        });

        // The proof turn's first provider call is its preflight compaction run,
        // executed inside the admitted turn's generation scope. Park it there.
        holdNextCall = true;
        const directTurn = await rpc<{ runId?: string; status?: string }>("chat.send", {
          sessionKey: scenario.sessionKey,
          message: "PR156634 direct turn across the rotation",
          deliver: false,
          idempotencyKey: "pr156634-direct-held",
        });
        expect(directTurn.status).toBe("started");
        await held;
        const requestsAtHold = providerRequests.length;
        proof("compaction_call_held", {
          runId: directTurn.runId,
          providerRequests: requestsAtHold,
        });

        // Rotate the runtime-config generation while the admitted turn is mid-call.
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
        expect(getPreparedModelCatalogOwnerSnapshot({ config: configA })).toBeUndefined();
        expect(getPreparedModelCatalogOwnerSnapshot({ config: configB })).toBeDefined();

        // Let the held compaction call complete normally. The turn then resolves its
        // run config in executeAgentTurn and performs the nested prepared-runtime
        // borrow under its retained generation lease before the main model call.
        if (!heldResponse) {
          throw new Error("compaction provider call was not held");
        }
        heldResponse.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        });
        heldResponse.end(
          textTurn(MODEL_ID, "compaction summary of the warmup conversation", {
            input: 200,
            output: 50,
          }),
        );
        proof("compaction_call_released", { runId: directTurn.runId });

        const waited = await rpc<{ status?: string }>("agent.wait", {
          runId: directTurn.runId,
          timeoutMs: 30_000,
        });
        proof("direct_turn_terminal", {
          waited,
          providerRequestsAfterTurn: providerRequests.length,
        });
        expect(waited).toMatchObject({ status: "ok" });
        // Compaction really ran: warmup + held compaction call + main turn call.
        expect(providerRequests.length).toBe(requestsAtHold + 1);
        expect(providerRequests[providerRequests.length - 1]).toContain("PR156634 direct turn");

        const history = await rpc<{ messages?: unknown[] }>("chat.history", {
          sessionKey: scenario.sessionKey,
          limit: 20,
        });
        const serialized = JSON.stringify(history.messages ?? []);
        expect(serialized).toContain(DIRECT_REPLY_MARKER);
        for (const guardError of CATALOG_GUARD_ERRORS) {
          expect(serialized).not.toContain(guardError);
        }
        proof("scenario_pass", {
          scenario: scenario.label,
          directMarkerPresent: serialized.includes(DIRECT_REPLY_MARKER),
        });
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          heldResponse?.destroy();
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
