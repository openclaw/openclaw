/**
 * Real runtime proof for PR #148895: a real Gateway caller Stop (`chat.abort` over the
 * WebSocket RPC transport) settles a foreground turn that is blocked in
 * `beginForegroundSessionMaintenance`, and releases only its own foreground
 * reservation, while a still-running maintenance owner's cleanup remains pending.
 * Cleanup then finishes on its own schedule, its reader fence completes, a later
 * optional maintenance owner runs, and a new foreground turn succeeds on the
 * same session.
 *
 * The harness supplies only the maintenance workload and its release gate; the
 * coordinator, admission path, gateway, and network client are the real ones.
 */
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionMaintenanceOwner,
  waitForSessionMaintenance,
} from "../src/agents/session-maintenance/coordinator.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../src/config/types.models.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";

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
const MODEL_ID = "claude-opus-5";
const TOKEN = "pr148895-proof-token";
const REPLY = "PR148895_OK";

type MaintenanceOwnerView = { sequence: number; running: boolean; writesReleased: boolean };
type SessionMaintenanceView = {
  owners: Set<MaintenanceOwnerView>;
  foreground: number;
};
type CoordinatorState = { sessions: Map<string, SessionMaintenanceView> };

function coordinatorState(): CoordinatorState {
  const value = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionMaintenance")
  ] as CoordinatorState | undefined;
  if (!value || !(value.sessions instanceof Map)) {
    throw new Error("session maintenance singleton is not the expected shape for this revision");
  }
  return value;
}

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

async function until(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(`condition did not hold within ${timeoutMs}ms: ${label}`);
    }
    await delay(10);
  }
}

function anthropicSse(events: Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function textTurn(id: string): string {
  return anthropicSse([
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: MODEL_ID,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: REPLY } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ]);
}

function buildMockAnthropicProvider(baseUrl: string) {
  const model: ModelDefinitionConfig = {
    id: MODEL_ID,
    name: "Mock Claude Opus 5",
    api: "anthropic-messages",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
  const config: Omit<ModelProviderConfig, "models"> & { models: [ModelDefinitionConfig] } = {
    baseUrl,
    apiKey: "sk-ant-api03-pr148895-proof", // pragma: allowlist secret
    api: "anthropic-messages",
    models: [model],
  };
  return { providerId: PROVIDER_ID, modelRef: `${PROVIDER_ID}/${MODEL_ID}`, config } as const;
}

describe("PR #148895 real runtime proof", () => {
  let tempHome: string | undefined;

  afterEach(async () => {
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  it(
    "settles a Stop through the real transport while held maintenance cleanup stays pending",
    { timeout: 240_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let providerRequests = 0;
      let releaseHeld: (() => void) | undefined;
      let heldWork: Promise<void> | undefined;
      const journal: string[] = [];

      try {
        tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr148895-proof-"));
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
          request.resume();
          request.on("end", () => {
            providerRequests += 1;
            response.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
            });
            response.end(textTurn(`msg_pr148895_${providerRequests}`));
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
              model: { primary: provider.modelRef },
            },
            entries: { main: { default: true } },
          },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          gateway: { auth: { mode: "token", token: TOKEN } },
        };
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token: TOKEN,
          clientDisplayName: "pr148895-proof",
        });
        const client = gateway.client;
        proof("gateway_ready", { port: gateway.port });

        const rpc = async <T>(method: string, params: unknown): Promise<T> => {
          proof("rpc_request", { method, params });
          const result = await client.request<T>(method, params, { timeoutMs: 60_000 });
          proof("rpc_response", { method, result });
          return result;
        };
        const successfulTurn = async (sessionKey: string, label: string) => {
          const started = await rpc<{ runId?: string; status?: string }>("chat.send", {
            sessionKey,
            message: "Reply with exactly OK.",
            deliver: false,
            idempotencyKey: `pr148895-${label}`,
          });
          expect(started.status).toBe("started");
          const waited = await rpc<{ status?: string }>("agent.wait", {
            runId: started.runId,
            timeoutMs: 60_000,
          });
          expect(waited).toMatchObject({ status: "ok" });
          proof("foreground_completed", { sessionKey, label, runId: started.runId });
        };

        for (const preemptible of [false, true]) {
          const sessionKey = `agent:main:pr148895-proof-${preemptible ? "opt" : "req"}`;
          await successfulTurn(sessionKey, `${preemptible ? "opt" : "req"}-warmup`);
          const state = coordinatorState();
          await until(() => !state.sessions.has(sessionKey), 30_000, "warm-up maintenance settled");

          let started = false;
          let writerFinished = false;
          let ownerDone = false;
          let readerDone = false;
          const gate = new Promise<void>((resolve) => {
            releaseHeld = resolve;
          });
          const owner = createSessionMaintenanceOwner({ sessionKey, preemptible });
          heldWork = owner.track(
            owner.run(async () => {
              started = true;
              proof("cleanup_held", { sessionKey, preemptible });
              // Stays pending even once this owner is asked to yield.
              await gate;
              journal.push(`${sessionKey} original-cleanup`);
              writerFinished = true;
              proof("cleanup_finished", { sessionKey });
            }),
          );
          void owner.done.then(() => {
            ownerDone = true;
            proof("owner_done", { sessionKey });
          });
          await until(() => started, 10_000, "held maintenance workload started");
          const reader = waitForSessionMaintenance(sessionKey).then(() => {
            readerDone = true;
            proof("reader_finished", { sessionKey });
          });

          const snapshot = () => {
            const session = state.sessions.get(sessionKey);
            return {
              sessionKey,
              preemptible,
              foreground: session?.foreground ?? 0,
              owners: [...(session?.owners ?? [])].map((entry) => ({
                id: entry.sequence,
                running: entry.running,
                writesReleased: entry.writesReleased,
              })),
              ownerAborted: owner.signal.aborted,
              ownerDone,
              writerFinished,
              readerDone,
              providerRequests,
            };
          };

          const providerRequestsBeforeSend = providerRequests;
          const stopped = await rpc<{ runId?: string; status?: string }>("chat.send", {
            sessionKey,
            message: "This turn is stopped before it reaches the provider.",
            deliver: false,
            idempotencyKey: `pr148895-stopped-${preemptible ? "opt" : "req"}`,
          });
          expect(stopped.status).toBe("started");
          const runId = stopped.runId;
          await until(() => snapshot().foreground > 0, 30_000, "foreground reservation taken");
          proof("admission_waiting", { runId, ...snapshot() });
          expect(ownerDone).toBe(false);
          expect(owner.signal.aborted).toBe(preemptible);

          const stopAt = performance.now();
          proof("stop_sent", { sessionKey, runId });
          // A real WebSocket RPC request, not a direct handler invocation.
          const stopResult = await rpc<{ aborted?: boolean; runIds?: string[] }>("chat.abort", {
            sessionKey,
            runId,
          });
          expect(stopResult).toMatchObject({ aborted: true });
          await until(
            () => snapshot().foreground === 0,
            2_000,
            "foreground reservation released while cleanup is held",
          );
          proof("reservation_released", {
            runId,
            stopLatencyMs: Number((performance.now() - stopAt).toFixed(1)),
            ...snapshot(),
          });
          const terminal = await rpc<{ status?: string }>("agent.wait", {
            runId,
            timeoutMs: 2_000,
          });
          const stopLatencyMs = performance.now() - stopAt;
          expect(stopLatencyMs).toBeLessThan(2_000);
          proof("caller_terminal_while_held", {
            runId,
            terminal,
            stopLatencyMs: Number(stopLatencyMs.toFixed(1)),
            ...snapshot(),
          });
          // The stopped turn never reached the provider transport.
          expect(providerRequests).toBe(providerRequestsBeforeSend);
          expect(ownerDone).toBe(false);
          expect(writerFinished).toBe(false);
          expect(readerDone).toBe(false);
          expect(snapshot().owners).toHaveLength(1);
          expect(snapshot().owners[0]?.writesReleased).toBe(false);
          if (!preemptible) {
            owner.assertCurrent();
          }

          // A visible interval separates caller termination from cleanup release.
          await delay(3_000);
          proof("still_held", { runId, ...snapshot() });
          expect(ownerDone).toBe(false);
          expect(readerDone).toBe(false);

          proof("cleanup_release", { sessionKey, runId });
          releaseHeld?.();
          releaseHeld = undefined;
          await heldWork;
          heldWork = undefined;
          await owner.done;
          await reader;
          expect(writerFinished).toBe(true);
          expect(readerDone).toBe(true);

          const successor = createSessionMaintenanceOwner({ sessionKey, preemptible: true });
          proof("optional_created", { sessionKey });
          await successor.track(
            successor.run(async () => {
              proof("optional_started", { sessionKey });
              journal.push(`${sessionKey} successor`);
            }),
          );
          await successor.done;
          proof("optional_done", { sessionKey });

          await successfulTurn(sessionKey, `${preemptible ? "opt" : "req"}-recovery`);
          expect(journal).toContain(`${sessionKey} original-cleanup`);
          expect(journal).toContain(`${sessionKey} successor`);
          proof("scenario_pass", { sessionKey, preemptible, journal: [...journal] });
        }
      } finally {
        releaseHeld?.();
        await Promise.allSettled(heldWork ? [heldWork] : []);
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
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
