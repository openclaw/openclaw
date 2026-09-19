import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { loadSessionEntry } from "../session-utils.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../test-openai-responses-model.js";

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

const FIRST_REPLY = "FIRST_TURN_COMPLETE";
const FOLLOWUP_REPLY = "FROZEN_QUEUED_DELIVERY_COMPLETE";
const CONTEXT_ENGINE_ID = "frozen-queued-delivery-gate";

type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: string;
  phase?: string;
  message?: unknown;
};

async function readJsonRequest(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function writeSseResponse(res: ServerResponse, text: string, messageId: string): void {
  const message = {
    type: "message",
    id: messageId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ];
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

function assistantText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .flatMap((block) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? [(block as { text: string }).text]
        : [],
    )
    .join("");
}

function assistantRows(events: readonly unknown[]): Array<Record<string, unknown>> {
  return events.flatMap((event) => {
    const message = (event as { message?: unknown } | undefined)?.message;
    return message &&
      typeof message === "object" &&
      (message as { role?: unknown }).role === "assistant"
      ? [message as Record<string, unknown>]
      : [];
  });
}

async function waitForRunActive(
  events: Array<{ event?: string; payload?: unknown }>,
  runId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const event of events) {
      if (event.event !== "chat" || !event.payload || typeof event.payload !== "object") {
        continue;
      }
      const payload = event.payload as ChatEventPayload;
      if (
        payload.runId === runId &&
        payload.state === "status" &&
        payload.phase === "starting_model"
      ) {
        return;
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for chat run active runId=${runId}`);
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("frozen queued followup real-transport abort proof", () => {
  it(
    "rejects a real-transport chat.abort for a queued successor during pending delivery after execution-driven retirement",
    { timeout: 180_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      const afterTurnStarted = createDeferred();
      const releaseAfterTurn = createDeferred();
      const releaseFirstTurn = createDeferred();
      const followupReplyVisible = createDeferred<Record<string, unknown>>();
      const followupReplyEvents: Record<string, unknown>[] = [];
      const modelRequests: Record<string, unknown>[] = [];
      const gatewayEvents: Array<{ event?: string; payload?: unknown }> = [];
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

      try {
        const tempHome = tempDirs.make("openclaw-frozen-queued-transport-");
        const stateDir = path.join(tempHome, ".openclaw");
        const workspaceDir = path.join(tempHome, "workspace");
        const configPath = path.join(stateDir, "openclaw.json");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        const pluginDir = path.join(tempHome, "delivery-gate");
        await Promise.all([
          fs.mkdir(workspaceDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
          fs.mkdir(pluginDir, { recursive: true }),
          fs.mkdir(path.dirname(configPath), { recursive: true }),
        ]);
        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: "frozen-queued-transport-token",
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
          void (async () => {
            if (request.url === "/after-turn") {
              afterTurnStarted.resolve();
              await releaseAfterTurn.promise;
              response.writeHead(204).end();
              return;
            }
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            if (request.method === "GET" && url.pathname === "/v1/models") {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify({ data: [{ id: "frozen-queued", object: "model" }] }));
              return;
            }
            if (request.method !== "POST" || url.pathname !== "/v1/responses") {
              response.writeHead(404).end();
              return;
            }
            modelRequests.push(await readJsonRequest(request));
            if (modelRequests.length === 1) {
              await releaseFirstTurn.promise;
              if (response.destroyed) {
                return;
              }
              writeSseResponse(response, FIRST_REPLY, "msg-first");
              return;
            }
            writeSseResponse(response, FOLLOWUP_REPLY, "msg-followup");
          })().catch((error: unknown) => response.destroy(error as Error));
        });
        await new Promise<void>((resolve, reject) => {
          providerServer?.once("error", reject);
          providerServer?.listen(0, "127.0.0.1", resolve);
        });
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }
        const providerBaseUrl = `http://127.0.0.1:${providerAddress.port}`;
        const provider = buildMockOpenAiResponsesProvider(`${providerBaseUrl}/v1`);

        await fs.writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          `${JSON.stringify({
            id: CONTEXT_ENGINE_ID,
            name: "Frozen Queued Delivery Gate",
            activation: { onStartup: true },
            configSchema: { type: "object", additionalProperties: false, properties: {} },
          })}\n`,
        );
        await fs.writeFile(
          path.join(pluginDir, "index.mjs"),
          [
            "export default {",
            `  id: ${JSON.stringify(CONTEXT_ENGINE_ID)},`,
            "  register(api) {",
            `    api.registerContextEngine(${JSON.stringify(CONTEXT_ENGINE_ID)}, () => ({`,
            `      info: { id: ${JSON.stringify(CONTEXT_ENGINE_ID)}, name: "Delivery Gate", transcriptSemantics: { currentTurnFence: "before-current-turn-entry-v1", turnAdvancementIdempotency: "atomic-idempotent-v1" } },`,
            "      async ingest() { return { ingested: false }; },",
            "      async assemble({ messages }) { return { messages, estimatedTokens: 0 }; },",
            "      async compact() { return { ok: true, compacted: false }; },",
            `      async commitTurn() { const response = await fetch(${JSON.stringify(`${providerBaseUrl}/after-turn`)}, { method: "POST" }); if (!response.ok) throw new Error(`,
            "        `after-turn gate failed: ${response.status}`); },",
            "    }));",
            "  },",
            "};",
            "",
          ].join("\n"),
        );

        const cfg = {
          plugins: {
            enabled: true,
            allow: [CONTEXT_ENGINE_ID],
            load: { paths: [pluginDir] },
            entries: { [CONTEXT_ENGINE_ID]: { enabled: true } },
            slots: { memory: "none", contextEngine: CONTEXT_ENGINE_ID },
          },
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
            entries: { main: { default: true } },
          },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          gateway: { auth: { mode: "token", token: "frozen-queued-transport-token" } },
          messages: { queue: { mode: "followup" } },
        };
        const sessionKey = "agent:main:frozen-queued-transport";
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token: "frozen-queued-transport-token",
          clientDisplayName: "frozen-queued-transport-gateway",
          onEvent: (event) => {
            gatewayEvents.push(event);
            if (
              event.event === "chat" &&
              JSON.stringify(event.payload ?? {}).includes(FOLLOWUP_REPLY)
            ) {
              const payload = (event.payload ?? {}) as Record<string, unknown>;
              followupReplyEvents.push(payload);
              followupReplyVisible.resolve(payload);
            }
          },
        });

        const trace: string[] = [];

        // 1. First turn starts and is held back by the provider, becoming the active run.
        const first = await gateway.client.request<{ runId?: string; status?: string }>(
          "chat.send",
          {
            sessionKey,
            message: "OPENCLAW_TRANSPORT_HELD_TURN",
            idempotencyKey: "frozen-queued-transport-held",
          },
        );
        expect(first.status).toBe("started");
        const firstRunId = first.runId;
        expect(firstRunId).toBeTruthy();

        // 2. Synchronize on the Gateway's real "starting_model" status event so
        //    the first turn is provably the active embedded run before the
        //    second turn is submitted. The second turn can only be queued
        //    behind an active run.
        await vi.waitFor(
          async () => {
            expect(modelRequests).toHaveLength(1);
          },
          { timeout: 30_000, interval: 20 },
        );
        await waitForRunActive(gatewayEvents, firstRunId!);
        trace.push(`first turn active (provider request count=${modelRequests.length})`);

        // 3. Second turn queues as a followup and registers its Gateway cancel
        //    identity. Because the session is now active, the queue policy
        //    returns "enqueue-followup" instead of "run-now".
        const second = await gateway.client.request<{ runId?: string; status?: string }>(
          "chat.send",
          {
            sessionKey,
            message: "OPENCLAW_TRANSPORT_QUEUED_FOLLOWUP",
            idempotencyKey: "frozen-queued-transport-followup",
            queueMode: "followup",
          },
        );
        expect(second.status).toBe("started");
        const followupRunId = second.runId;
        expect(followupRunId).toBeTruthy();
        expect(followupRunId).not.toBe(firstRunId);
        trace.push(`second turn accepted (queued as followup, runId=${followupRunId})`);

        // Queued precondition: the second turn must still be waiting in the
        // followup queue, not running concurrently. The provider has only
        // received one request (for the held first turn).
        expect(modelRequests).toHaveLength(1);
        trace.push(
          `queued precondition verified: provider still has only 1 request (second turn is queued, not concurrent)`,
        );

        // 4. Release the first turn so the queue drains and the followup
        //    starts executing. The followup reaches commitTerminalOutcome
        //    (retireFollowupRunCancellation → entry.abortable=false), then
        //    commitTurn blocks via HTTP POST — creating the pending-delivery
        //    window.
        releaseFirstTurn.resolve();

        // 5. Wait for the followup's reply to become visible (provider served
        //    the second request) and for commitTurn to block (after-turn HTTP
        //    POST). commitTurn fires after retirement, so blocking here proves
        //    retireFollowupRunCancellation has already executed.
        await followupReplyVisible.promise;
        await afterTurnStarted.promise;
        trace.push(
          `followup reply visible + commitTurn blocked (retirement done, delivery pending)`,
        );

        // 6. Verify the followup's reply is durable in the transcript before abort.
        const loaded = loadSessionEntry(sessionKey);
        if (!loaded.entry?.sessionId) {
          throw new Error("proof session did not persist its transcript identity");
        }
        const transcriptScope = {
          agentId: loaded.agentId,
          sessionId: loaded.entry.sessionId,
          sessionKey: loaded.canonicalKey,
          storePath: loaded.storePath,
        };
        const beforeRows = assistantRows(await loadTranscriptEvents(transcriptScope)).filter(
          (message) => assistantText(message) === FOLLOWUP_REPLY,
        );
        expect(beforeRows).toHaveLength(1);
        expect((beforeRows[0]?.["__openclaw"] as { runId?: string } | undefined)?.runId).toBe(
          followupRunId,
        );

        // 7. Send chat.abort for the queued successor during pending delivery.
        //    The abort must be rejected because entry.abortable === false
        //    (set by the real commitTerminalOutcome → retireFollowupRunCancellation
        //    → retireQueuedChatTurnCancellation chain, not manual retirement).
        const abort = await gateway.client.request<{ aborted?: boolean; runIds?: string[] }>(
          "chat.abort",
          { sessionKey, runId: followupRunId },
          { timeoutMs: 15_000 },
        );
        trace.push(
          `late chat.abort for queued successor: aborted=${String(abort?.aborted)} runIds=${JSON.stringify(abort?.runIds)}`,
        );

        const afterRows = assistantRows(await loadTranscriptEvents(transcriptScope)).filter(
          (message) => assistantText(message) === FOLLOWUP_REPLY,
        );
        expect(afterRows).toHaveLength(1);
        expect(afterRows.filter((message) => message.openclawAbort)).toHaveLength(0);

        // 8. Release commitTurn so delivery completes.
        releaseAfterTurn.resolve();
        const terminal = await gateway.client.request<{ status?: string }>(
          "agent.wait",
          { runId: followupRunId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        );
        trace.push(`followup terminal status: ${String(terminal.status)}`);

        await disconnectGatewayClient(gateway.client);
        await gateway.server.close();
        gateway = undefined;
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        clearSessionStoreCacheForTest();
        const reopenedRows = assistantRows(await loadTranscriptEvents(transcriptScope)).filter(
          (message) => assistantText(message) === FOLLOWUP_REPLY,
        );
        const replyEventStates = followupReplyEvents.map((event) => event.state);
        const verdict = {
          firstRunId,
          followupRunId,
          modelRequestCount: modelRequests.length,
          queuedPrecondition: modelRequests.length === 1,
          replyVisible: JSON.stringify(followupReplyEvents[0] ?? {}).includes(FOLLOWUP_REPLY),
          commitTurnBlocked: true,
          durableRowsBeforeAbort: beforeRows.length,
          abort,
          terminalStatus: terminal.status,
          replyEventStates,
          abortedReplyEvents: replyEventStates.filter((state) => state === "aborted").length,
          finalReplyEvents: replyEventStates.filter((state) => state === "final").length,
          durableRowsAfterAbort: afterRows.length,
          abortMarkedRowsAfterAbort: afterRows.filter((message) => message.openclawAbort).length,
          reopenedRows: reopenedRows.length,
          reopenedAbortMarkedRows: reopenedRows.filter((message) => message.openclawAbort).length,
        };
        console.info(`FROZEN_QUEUED_TRANSPORT_VERDICT ${JSON.stringify(verdict)}`);
        trace.push(
          `RESULT: queued successor un-aborted during pending delivery, delivery completed`,
        );
        console.log(
          [
            "[transport] real Gateway + held provider + queued successor (redacted trace)",
            ...trace,
          ].join("\n"),
        );
        expect(verdict).toMatchObject({
          modelRequestCount: 2,
          queuedPrecondition: true,
          replyVisible: true,
          durableRowsBeforeAbort: 1,
          abort: { aborted: false, runIds: [] },
          terminalStatus: "ok",
          abortedReplyEvents: 0,
          finalReplyEvents: 1,
          durableRowsAfterAbort: 1,
          abortMarkedRowsAfterAbort: 0,
          reopenedRows: 1,
          reopenedAbortMarkedRows: 0,
        });
      } finally {
        releaseFirstTurn.resolve();
        releaseAfterTurn.resolve();
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          await new Promise<void>((resolve) => {
            providerServer?.close(() => resolve());
            providerServer?.closeAllConnections();
          });
        }
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    },
  );
});
