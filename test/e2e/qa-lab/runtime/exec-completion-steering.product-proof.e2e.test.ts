/**
 * Product proof for exec-completion steering through a real Gateway and real
 * provider HTTP I/O (a loopback OpenAI Responses server).
 *
 * The model starts real background execs through the exec tool. Each phase then
 * reads the provider request bodies the Gateway actually sent:
 * - A: the completion arrives while the requester session is busy, and the next
 *   turn carries it to the provider exactly once.
 * - B: a heartbeat that fails at the provider leaves the completion pending, and
 *   the next turn delivers it.
 * - C: another agent on the same Gateway never sends the owner's completion, and
 *   the owner's next turn does.
 * - D: replacing the session store retires a queued copy before any later provider
 *   request.
 * - E: replacing the session store after the next turn leased the copy makes that
 *   turn refuse it before provider I/O.
 */
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasPendingExecSteeringItems,
  resetExecSteeringQueueForTest,
} from "../../../../src/agents/exec-steering-queue.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import { resetConfigOverrides } from "../../../../src/config/runtime-overrides.js";
import { clearSessionStoreCacheForTest } from "../../../../src/config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../../../../src/gateway/test-openai-responses-model.js";
import { resetAgentEventsForTest } from "../../../../src/infra/agent-events.js";
import {
  onHeartbeatEvent,
  type HeartbeatEventPayload,
} from "../../../../src/infra/heartbeat-events.js";
import { resolveSystemEventQueueKey } from "../../../../src/infra/system-event-ownership.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../../../src/infra/system-events.js";
import { resetTaskRegistryForTests } from "../../../../src/tasks/task-runtime.test-helpers.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../../../src/test-utils/env.js";
import { writeOpenAiResponsesSse } from "../../../helpers/openai-responses-sse.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;
const PROOF_CHANNEL_ID = "exec-steering-proof";
// In-process gate the proof plugin's before_agent_run hook waits on. That hook runs
// after the prompt build leased the exec steering copy and before provider dispatch.
const PROOF_GATE_SYMBOL = "openclaw.execSteeringProof.gate";
type ProofGate = {
  match: string;
  reached: boolean;
  hold: () => Promise<void>;
  release: () => void;
};
function armProofGate(match: string): ProofGate {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate: ProofGate = {
    match,
    reached: false,
    hold: async () => {
      gate.reached = true;
      await released;
    },
    release,
  };
  (globalThis as Record<symbol, unknown>)[Symbol.for(PROOF_GATE_SYMBOL)] = gate;
  return gate;
}
function releaseProofGate(): void {
  const key = Symbol.for(PROOF_GATE_SYMBOL);
  const gate = (globalThis as Record<symbol, unknown>)[key] as ProofGate | undefined;
  gate?.release();
  delete (globalThis as Record<symbol, unknown>)[key];
}
const STEERING_HEADER = "Background exec completions arrived since your last turn.";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let sequence = 0;

type ProviderRequest = {
  seq: number;
  lastUser: string;
  status: number;
  kind: string;
  toolOutput?: string;
};
type AgentResult = { runId?: string; status?: string };

function resetState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
  resetSystemEventsForTest();
  resetExecSteeringQueueForTest();
  resetTaskRegistryForTests({ persist: false });
}

function proof(label: string, data: Record<string, unknown>): void {
  console.log(`[exec-steering proof] ${label} ${JSON.stringify(data)}`);
}

// A minimal channel so the idle heartbeat has a real delivery route and runs a
// model turn, instead of skipping the session as routeless.
async function writeProofChannelPlugin(pluginDir: string, tracePath: string): Promise<void> {
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PROOF_CHANNEL_ID,
      activation: { onStartup: true },
      channels: [PROOF_CHANNEL_ID],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "index.cjs"),
    [
      'const fs = require("node:fs");',
      "module.exports = {",
      `  id: ${JSON.stringify(PROOF_CHANNEL_ID)},`,
      "  register(api) {",
      "    api.registerChannel({",
      "      plugin: {",
      `        id: ${JSON.stringify(PROOF_CHANNEL_ID)},`,
      "        meta: {",
      `          id: ${JSON.stringify(PROOF_CHANNEL_ID)},`,
      '          label: "Exec Steering Proof",',
      '          selectionLabel: "Exec Steering Proof",',
      '          docsPath: "/channels/exec-steering-proof",',
      '          blurb: "Records heartbeat deliveries for the exec steering proof.",',
      "        },",
      '        capabilities: { chatTypes: ["direct"] },',
      "        config: {",
      '          listAccountIds: () => ["default"],',
      '          resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "default" }),',
      "          isEnabled: () => true,",
      "          isConfigured: () => true,",
      "        },",
      "        outbound: {",
      '          deliveryMode: "direct",',
      "          sendText: async ({ to, text }) => {",
      `            fs.appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ to, text }) + "\\n");`,
      `            return { channel: ${JSON.stringify(PROOF_CHANNEL_ID)}, messageId: "proof" };`,
      "          },",
      "        },",
      "      },",
      "    });",
      '    api.on("before_agent_run", async (event) => {',
      `      const gate = globalThis[Symbol.for(${JSON.stringify(PROOF_GATE_SYMBOL)})];`,
      '      if (gate && typeof event.prompt === "string" && event.prompt.includes(gate.match)) {',
      "        await gate.hold();",
      "      }",
      "    });",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
}

function marker(phase: string): string {
  return `EXEC_DONE_${phase}`;
}

// The current turn's user content: every user item after the last assistant
// message, skipping the tool loop. A turn carries its prompt and a separate
// runtime-context message, so the prompt is not always the final user item.
function lastUserText(body: Record<string, unknown>): string {
  const input = Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : [];
  const turn: unknown[] = [];
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item?.role === "assistant" && item.type !== "function_call") {
      break;
    }
    if (item?.role === "user") {
      turn.unshift(item.content);
    }
  }
  return JSON.stringify(turn);
}

function endsWithToolOutput(body: Record<string, unknown>): boolean {
  const input = Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : [];
  return input.at(-1)?.type === "function_call_output";
}

function completed(output: unknown[]) {
  return {
    type: "response.completed",
    response: {
      id: `resp_${sequence++}`,
      status: "completed",
      output,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  };
}

function writeText(response: ServerResponse, text: string): void {
  const message = {
    type: "message",
    id: `msg_${sequence++}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
    { type: "response.output_item.done", output_index: 0, item: message },
    completed([message]),
  ]);
}

function writeExecCall(response: ServerResponse, phase: string): void {
  // The command prints the marker from two words, so the marker text itself
  // never appears in the tool-call arguments the provider sees in history.
  const args = JSON.stringify({
    command: `sleep ${phase === "B" ? 4 : 1}; printf '%s_%s\\n' EXEC_DONE ${phase}`,
    background: true,
  });
  const item = {
    type: "function_call",
    id: `fc_${sequence++}`,
    call_id: `call_${sequence++}`,
    name: "exec",
    arguments: args,
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      name: "exec",
      arguments: args,
    },
    { type: "response.output_item.done", output_index: 0, item },
    completed([item]),
  ]);
}

async function waitFor<T>(
  label: string,
  read: () => T | undefined | false,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

describe("exec completion steering product proof", () => {
  beforeEach(resetState);
  afterEach(resetState);

  it(
    "delivers, recovers and refuses exec completions at real provider I/O",
    { timeout: 900_000 },
    async () => {
      const envSnapshot = captureEnv([...ENV_KEYS]);
      const tempHome = tempDirs.make("openclaw-exec-steering-proof-");
      const stateDir = path.join(tempHome, ".openclaw");
      const workspaceDir = path.join(tempHome, "workspace");
      const bundledPluginsDir = path.join(tempHome, "empty-bundled-plugins");
      const configPath = path.join(stateDir, "openclaw.json");
      await Promise.all([
        fs.mkdir(workspaceDir, { recursive: true }),
        fs.mkdir(bundledPluginsDir, { recursive: true }),
        fs.mkdir(stateDir, { recursive: true }),
      ]);
      const token = `exec-steering-proof-${process.pid}`;
      for (const [key, value] of Object.entries({
        HOME: tempHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      })) {
        setTestEnvValue(key, value);
      }
      deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
      deleteTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY");
      deleteTestEnvValue("OPENCLAW_SKIP_CHANNELS");
      const pluginDir = path.join(workspaceDir, "plugins", PROOF_CHANNEL_ID);
      const deliveryTracePath = path.join(tempHome, "deliveries.jsonl");
      await writeProofChannelPlugin(pluginDir, deliveryTracePath);
      const readDeliveries = async () =>
        (await fs.readFile(deliveryTracePath, "utf8").catch(() => "")).split("\n").filter(Boolean);

      const requests: ProviderRequest[] = [];
      const holds = new Map<string, () => void>();
      const holdPhases = new Set<string>();
      let failingHeartbeatMarker: string | undefined;
      const providerServer = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            proof("provider.unrouted", { method: request.method, url: request.url });
            response.writeHead(404).end();
            return;
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >;
          const lastUser = lastUserText(body);
          const start = /PROOF_START (\w+)/u.exec(lastUser)?.[1];
          const record: ProviderRequest = {
            seq: requests.length + 1,
            lastUser,
            status: 200,
            kind: "text",
          };
          requests.push(record);
          const input = Array.isArray(body.input)
            ? (body.input as Array<Record<string, unknown>>)
            : [];
          if (endsWithToolOutput(body)) {
            const output = input.at(-1)?.output;
            record.toolOutput = typeof output === "string" ? output : JSON.stringify(output);
          }
          const tools = Array.isArray(body.tools) ? (body.tools as Array<{ name?: unknown }>) : [];
          proof("provider.request", {
            seq: record.seq,
            start: start ?? null,
            inputItems: input.length,
            lastItemType: input.at(-1)?.type ?? input.at(-1)?.role ?? null,
            hasExecTool: tools.some((tool) => tool.name === "exec"),
            lastUserHead: lastUser.slice(0, 80),
          });
          if (
            // While the failure window is open, refuse every request that is not an
            // operator turn: the heartbeat turn and any retry of it.
            failingHeartbeatMarker &&
            !lastUser.includes("PROOF_START") &&
            !lastUser.includes("PROOF_FOLLOWUP")
          ) {
            record.status = 400;
            record.kind = "heartbeat-refused";
            // A non-retryable client error, so the heartbeat turn fails once instead of
            // retrying behind the transport's backoff.
            response.writeHead(400, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                error: { message: "injected provider refusal", type: "invalid_request_error" },
              }),
            );
            return;
          }
          if (start && endsWithToolOutput(body)) {
            if (holdPhases.has(start)) {
              record.kind = "held";
              await new Promise<void>((resolve) => {
                holds.set(start, resolve);
              });
            }
            writeText(response, `started ${start}`);
            return;
          }
          if (start) {
            record.kind = "exec-call";
            writeExecCall(response, start);
            return;
          }
          writeText(response, "handled");
        })().catch((error: unknown) => {
          if (!response.headersSent) {
            response.writeHead(500);
          }
          response.end(error instanceof Error ? error.message : String(error));
        });
      });

      const heartbeats: HeartbeatEventPayload[] = [];
      const stopHeartbeats = onHeartbeatEvent((event) => heartbeats.push(event));
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          providerServer.once("error", reject);
          providerServer.listen(0, "127.0.0.1", resolve);
        });
        const address = providerServer.address();
        if (!address || typeof address === "string") {
          throw new Error("provider did not bind a loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${address.port}/v1`,
          "gpt-exec-steering-proof",
        );
        const storeTemplate = (name: string) =>
          path.join(stateDir, name, "{agentId}", "sessions.json");
        const config = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              heartbeat: { every: "24h", target: "last" },
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
            ownership: "explicit",
            entries: { main: {}, research: {} },
          },
          models: {
            mode: "replace",
            providers: {
              [provider.providerId]: {
                ...provider.config,
                models: provider.config.models.map((model) =>
                  Object.assign({}, model, { input: Array.from(model.input) }),
                ),
              },
            },
          },
          tools: { profile: "coding", exec: { host: "gateway", security: "full", ask: "off" } },
          session: { store: storeTemplate("store-a") },
          gateway: { auth: { mode: "token", token } },
          plugins: {
            enabled: true,
            allow: [PROOF_CHANNEL_ID],
            load: { paths: [pluginDir] },
            entries: {
              [PROOF_CHANNEL_ID]: {
                enabled: true,
                // The lease gate observes the prompt, so it needs conversation access.
                hooks: {
                  allowConversationAccess: true,
                  timeouts: { before_agent_run: 120_000 },
                },
              },
            },
            slots: { memory: "none" },
          },
        } satisfies OpenClawConfig;

        gateway = await startGatewayWithClient({
          cfg: config,
          configPath,
          token,
          clientDisplayName: "vitest-exec-steering-proof",
        });
        await gateway.server.startupSettled;
        const client = gateway.client;
        const startRun = async (params: {
          sessionKey: string;
          message: string;
          agentId?: string;
          route?: { channel: string; to: string; accountId: string };
        }) => {
          const runId = `proof-run-${sequence++}`;
          const accepted = await client.request<AgentResult>("agent", {
            ...(params.agentId ? { agentId: params.agentId } : {}),
            sessionKey: params.sessionKey,
            message: params.message,
            deliver: false,
            ...(params.route
              ? {
                  channel: params.route.channel,
                  replyChannel: params.route.channel,
                  to: params.route.to,
                  accountId: params.route.accountId,
                }
              : {}),
            idempotencyKey: runId,
          });
          proof("agent.accepted", { sessionKey: params.sessionKey, status: accepted.status });
          return runId;
        };
        const waitRun = async (runId: string) => {
          const terminal = await client.request<AgentResult>(
            "agent.wait",
            { runId, timeoutMs: 180_000 },
            { timeoutMs: 185_000 },
          );
          return terminal.status;
        };
        const requestFor = (followup: string) =>
          requests.find((entry) => entry.lastUser.includes(followup));
        const summary = (entry: ProviderRequest | undefined, phase: string) =>
          entry
            ? {
                providerRequest: entry.seq,
                httpStatus: entry.status,
                carriesCompletion: entry.lastUser.includes(marker(phase)),
                carriesSteeringHeader: entry.lastUser.includes(STEERING_HEADER),
              }
            : { providerRequest: null };
        const heartbeatsSince = (from: number) =>
          heartbeats
            .slice(from)
            .map((event) => `${event.status}${event.reason ? ":" + event.reason : ""}`);
        // Redacted provider trace: the current turn's user text exactly as the
        // loopback provider received it, with the temp root and ids masked.
        const trace = (entry: ProviderRequest | undefined) =>
          entry
            ? {
                providerRequest: entry.seq,
                request: "POST /v1/responses",
                httpStatus: entry.status,
                currentTurnUserText: entry.lastUser
                  .split(tempHome)
                  .join("<tmp>")
                  .replace(
                    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu,
                    "<uuid>",
                  )
                  .slice(0, 900),
              }
            : { providerRequest: null };
        // Read the durable queue under the same agent-qualified key the Gateway
        // uses, so a literal key such as "global" resolves to its owner's queue.
        const durablePending = (key: string, phase: string, ownerAgentId = "main") => {
          try {
            return peekSystemEvents(resolveSystemEventQueueKey(key, ownerAgentId)).some((text) =>
              text.includes(marker(phase)),
            );
          } catch {
            return false;
          }
        };
        const steeringPending = (key: string, ownerAgentId = "main") =>
          hasPendingExecSteeringItems({ requesterSessionKey: key, ownerAgentId });

        // Phase A: the exec finishes while the session is busy.
        {
          const key = "agent:main:proof-busy";
          const hb = heartbeats.length;
          holdPhases.add("A");
          const first = await startRun({ sessionKey: key, message: "PROOF_START A" });
          try {
            await waitFor("held A follow-up", () => holds.has("A"), 120_000);
          } catch (error) {
            const terminal = await client.request<Record<string, unknown>>(
              "agent.wait",
              { runId: first, timeoutMs: 5_000 },
              { timeoutMs: 10_000 },
            );
            proof("A.run-terminal", terminal);
            throw error;
          }
          await waitFor("exec A durable event", () => durablePending(key, "A"));
          proof("A.exec-exited-while-busy", {
            durableEventQueued: true,
            steeringQueued: steeringPending(key),
          });
          const second = await startRun({ sessionKey: key, message: "PROOF_FOLLOWUP A" });
          // Release the held turn only once the exec's heartbeat wake has observed the
          // busy session and deferred, so the follow-up turn is what delivers it.
          await waitFor("A heartbeat deferred while busy", () =>
            heartbeatsSince(hb).includes("skipped:requests-in-flight"),
          );
          proof("A.heartbeats-while-busy", { events: heartbeatsSince(hb) });
          holds.get("A")?.();
          proof("A.runs", { first: await waitRun(first), second: await waitRun(second) });
          const delivered = requestFor("PROOF_FOLLOWUP A");
          const carriers = requests.filter((entry) => entry.lastUser.includes(marker("A")));
          proof("A.next-turn-provider-request", summary(delivered, "A"));
          proof("A.provider-trace", trace(delivered));
          proof("A.settled", {
            providerRequestsCarryingCompletion: carriers.length,
            durableEventPending: durablePending(key, "A"),
            steeringPending: steeringPending(key),
            heartbeats: heartbeatsSince(hb),
          });
          expect(delivered?.lastUser).toContain(marker("A"));
          expect(delivered?.lastUser).toContain(STEERING_HEADER);
          expect(carriers).toHaveLength(1);
          expect(durablePending(key, "A")).toBe(false);
        }

        // Phase B: the idle heartbeat fails at the provider; the next turn recovers.
        {
          const key = "agent:main:proof-heartbeat";
          const hb = heartbeats.length;
          failingHeartbeatMarker = marker("B");
          // The turn carries a real channel route, so the idle heartbeat runs a
          // model turn for this session rather than skipping it as routeless.
          const first = await startRun({
            sessionKey: key,
            message: "PROOF_START B",
            route: { channel: PROOF_CHANNEL_ID, to: "proof-destination", accountId: "default" },
          });
          proof("B.first-run", { status: await waitRun(first) });
          const refused = await waitFor(
            "refused heartbeat request",
            () => requests.find((request) => request.kind === "heartbeat-refused"),
            45_000,
          );
          // The heartbeat turn settles with some terminal outcome after the refusal;
          // record it rather than assuming its shape.
          await waitFor(
            "heartbeat terminal outcome",
            () =>
              heartbeats
                .slice(hb)
                .some((event) => event.status !== "skipped" && event.ts >= Date.now() - 120_000),
            120_000,
          );
          // The failed heartbeat must leave both representations pending; wait for
          // that state instead of a fixed settle delay.
          await waitFor(
            "B completion pending after refused heartbeat",
            () => durablePending(key, "B") && steeringPending(key),
            30_000,
          );
          proof("B.heartbeat-refused-at-provider", {
            providerRequest: refused.seq,
            httpStatus: refused.status,
            requestCarriesCompletion: refused.lastUser.includes(marker("B")),
            heartbeats: heartbeatsSince(hb),
            channelDeliveries: (await readDeliveries()).length,
            durableEventPending: durablePending(key, "B"),
            steeringPending: steeringPending(key),
          });
          const second = await startRun({ sessionKey: key, message: "PROOF_FOLLOWUP B" });
          proof("B.recovery-run", { status: await waitRun(second) });
          failingHeartbeatMarker = undefined;
          const recovered = requestFor("PROOF_FOLLOWUP B");
          proof("B.next-turn-provider-request", summary(recovered, "B"));
          proof("B.provider-trace.refused-heartbeat", trace(refused));
          proof("B.provider-trace.recovery-turn", trace(recovered));
          proof("B.settled", {
            durableEventPending: durablePending(key, "B"),
            steeringPending: steeringPending(key),
          });
          expect(refused.lastUser).toContain(marker("B"));
          expect(recovered?.lastUser).toContain(marker("B"));
          expect(durablePending(key, "B")).toBe(false);
        }

        // Phase C: two agents on one Gateway. The owner runs an owner-qualified exec
        // whose completion is really queued; the other agent's turn on the literal
        // key must not carry it, and the owner's next turn must, exactly once.
        {
          const ownerKey = "agent:research:global";
          const hb = heartbeats.length;
          holdPhases.add("C");
          const owner = await startRun({
            agentId: "research",
            sessionKey: ownerKey,
            message: "PROOF_START C",
          });
          await waitFor("held C follow-up", () => holds.has("C"), 120_000);
          await waitFor("exec C durable event", () => durablePending(ownerKey, "C", "research"));
          await waitFor("exec C steering copy", () => steeringPending(ownerKey, "research"));
          proof("C.owner-exec-queued", {
            ownerKey,
            durableEventQueued: true,
            steeringQueued: true,
            foreignSteeringQueued: steeringPending("global", "main"),
            foreignDurableQueued: durablePending("global", "C", "main"),
          });
          const foreign = await startRun({
            agentId: "main",
            sessionKey: "global",
            message: "PROOF_FOLLOWUP C foreign",
          });
          proof("C.foreign-run", { status: await waitRun(foreign) });
          const foreignRequest = requestFor("PROOF_FOLLOWUP C foreign");
          proof("C.foreign-agent-provider-request", summary(foreignRequest, "C"));
          const ownerNext = await startRun({
            agentId: "research",
            sessionKey: ownerKey,
            message: "PROOF_FOLLOWUP C owner",
          });
          await waitFor("C heartbeat deferred while owner busy", () =>
            heartbeatsSince(hb).includes("skipped:requests-in-flight"),
          );
          holds.get("C")?.();
          proof("C.owner-runs", { first: await waitRun(owner), next: await waitRun(ownerNext) });
          const ownerRequest = requestFor("PROOF_FOLLOWUP C owner");
          const carriers = requests.filter((entry) => entry.lastUser.includes(marker("C")));
          proof("C.owner-provider-request", summary(ownerRequest, "C"));
          proof("C.settled", {
            providerRequestsCarryingCompletion: carriers.length,
            carrierIsOwnerTurn: carriers[0]?.seq === ownerRequest?.seq,
            durableEventPending: durablePending(ownerKey, "C", "research"),
            steeringPending: steeringPending(ownerKey, "research"),
            heartbeats: heartbeatsSince(hb),
          });
          expect(foreignRequest).toBeDefined();
          expect(foreignRequest?.lastUser ?? "").not.toContain(marker("C"));
          expect(ownerRequest?.lastUser).toContain(marker("C"));
          expect(ownerRequest?.lastUser).toContain(STEERING_HEADER);
          expect(carriers).toHaveLength(1);
          expect(durablePending(ownerKey, "C", "research")).toBe(false);
        }

        // Phase D: replacing the session store retires the queued output.
        {
          const key = "agent:main:proof-store";
          holdPhases.add("D");
          const first = await startRun({ sessionKey: key, message: "PROOF_START D" });
          await waitFor("held D follow-up", () => holds.has("D"));
          await waitFor("exec D steering copy", () => steeringPending(key));
          proof("D.before-store-replacement", {
            durableEventPending: durablePending(key, "D"),
            steeringPending: true,
          });
          const snapshot = await client.request<{ hash: string }>("config.get", {});
          await client.request("config.patch", {
            baseHash: snapshot.hash,
            raw: JSON.stringify({ session: { store: storeTemplate("store-b") } }),
          });
          let retired = false;
          try {
            retired = await waitFor(
              "store replacement retirement",
              () => !steeringPending(key),
              20_000,
            );
          } catch {
            retired = false;
          }
          proof("D.after-store-replacement", {
            steeringRetired: retired,
            durableEventPending: durablePending(key, "D"),
          });
          const second = await startRun({ sessionKey: key, message: "PROOF_FOLLOWUP D" });
          holds.get("D")?.();
          proof("D.runs", { first: await waitRun(first), second: await waitRun(second) });
          const next = requestFor("PROOF_FOLLOWUP D");
          proof("D.next-turn-provider-request", summary(next, "D"));
          expect(retired).toBe(true);
          expect(next?.lastUser ?? "").not.toContain(marker("D"));
        }
        // Phase E: the next turn leases the completion, and the store is replaced while
        // that turn waits in before_agent_run, after the lease and before dispatch. The
        // lease loses authority, so no provider request may carry the completion.
        {
          const key = "agent:main:proof-lease";
          holdPhases.add("E");
          const first = await startRun({ sessionKey: key, message: "PROOF_START E" });
          await waitFor("held E follow-up", () => holds.has("E"), 120_000);
          await waitFor("exec E steering copy", () => steeringPending(key));
          const gate = armProofGate("PROOF_FOLLOWUP E lease");
          const second = await startRun({ sessionKey: key, message: "PROOF_FOLLOWUP E lease" });
          holds.get("E")?.();
          proof("E.first-run", { status: await waitRun(first) });
          await waitFor("E follow-up paused after lease", () => gate.reached, 60_000);
          const leased = {
            // A leased copy is no longer listed as pending; the durable event still is.
            steeringPending: steeringPending(key),
            durableEventPending: durablePending(key, "E"),
            followupProviderRequests: requests.filter((entry) =>
              entry.lastUser.includes("PROOF_FOLLOWUP E lease"),
            ).length,
          };
          proof("E.leased-before-dispatch", leased);
          const snapshot = await client.request<{ hash: string }>("config.get", {});
          await client.request("config.patch", {
            baseHash: snapshot.hash,
            raw: JSON.stringify({ session: { store: storeTemplate("store-c") } }),
          });
          let durableRetired = false;
          try {
            durableRetired = await waitFor(
              "E durable retirement",
              () => !durablePending(key, "E"),
              20_000,
            );
          } catch {
            durableRetired = false;
          }
          proof("E.store-replaced-while-leased", { durableRetired });
          releaseProofGate();
          const terminal = await client.request<Record<string, unknown>>(
            "agent.wait",
            { runId: second, timeoutMs: 180_000 },
            { timeoutMs: 185_000 },
          );
          const carriers = requests.filter((entry) => entry.lastUser.includes(marker("E")));
          proof("E.leased-turn-outcome", {
            status: terminal.status ?? null,
            terminal: JSON.stringify(terminal).split(tempHome).join("<tmp>").slice(0, 400),
            followupProviderRequests: requests
              .filter((entry) => entry.lastUser.includes("PROOF_FOLLOWUP E lease"))
              .map((entry) => summary(entry, "E")),
            providerRequestsCarryingCompletion: carriers.length,
          });
          const third = await startRun({ sessionKey: key, message: "PROOF_FOLLOWUP E next" });
          proof("E.next-run", { status: await waitRun(third) });
          const next = requestFor("PROOF_FOLLOWUP E next");
          proof("E.next-turn-provider-request", summary(next, "E"));
          expect(leased.steeringPending).toBe(false);
          expect(leased.durableEventPending).toBe(true);
          expect(leased.followupProviderRequests).toBe(0);
          expect(durableRetired).toBe(true);
          expect(carriers).toHaveLength(0);
          expect(next?.lastUser ?? "").not.toContain(marker("E"));
          expect(steeringPending(key)).toBe(false);
        }
        proof("provider-requests", {
          total: requests.length,
          byKind: requests.reduce<Record<string, number>>((acc, entry) => {
            acc[entry.kind] = (acc[entry.kind] ?? 0) + 1;
            return acc;
          }, {}),
        });
      } catch (error) {
        proof("failure.provider-requests", {
          requests: requests.map((entry) => ({
            seq: entry.seq,
            kind: entry.kind,
            status: entry.status,
            lastUserHead: entry.lastUser.slice(0, 80),
          })),
          heartbeats: heartbeats.map(
            (event) => event.status + (event.reason ? ":" + event.reason : ""),
          ),
        });
        throw error;
      } finally {
        releaseProofGate();
        for (const release of holds.values()) {
          release();
        }
        stopHeartbeats();
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "exec steering proof complete" });
        }
        providerServer.closeAllConnections();
        await new Promise<void>((resolve) => {
          providerServer.close(() => resolve());
        });
        envSnapshot.restore();
      }
    },
  );
});
