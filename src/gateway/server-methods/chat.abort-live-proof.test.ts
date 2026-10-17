import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core";
import { afterAll, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { loadSessionEntryAsync } from "../session-entry-load.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../test-openai-responses-model.js";

const disabledServices = [
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
];

const REPLY_TEXT = "PR132123_COMMITTED_REPLY";
const CONTEXT_ENGINE_ID = "pr132123-after-turn-gate";

function assistantRows(events: readonly unknown[]): Array<Record<string, unknown>> {
  return events.flatMap((event) => {
    const message = asOptionalRecord(asOptionalRecord(event)?.message);
    const text = Array.isArray(message?.content)
      ? message.content
          .flatMap((block) => {
            const value = asOptionalRecord(block)?.text;
            return typeof value === "string" ? [value] : [];
          })
          .join("")
      : "";
    return message?.role === "assistant" && text === REPLY_TEXT ? [message] : [];
  });
}

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-pr132123-proof-");

it(
  "rejects a late abort after the same run commits its final reply",
  { timeout: 90_000 },
  async () => {
    const tempHome = tempDirs.make();
    const stateDir = path.join(tempHome, ".openclaw");
    const workspaceDir = path.join(tempHome, "workspace");
    const configPath = path.join(stateDir, "openclaw.json");
    const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
    const pluginDir = path.join(tempHome, "after-turn-gate");
    const env = {
      HOME: tempHome,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: "pr132123-proof-token",
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      ...Object.fromEntries(disabledServices.map((key) => [key, "1"])),
    };
    const envSnapshot = captureEnv(Object.keys(env));
    const afterTurnStarted = createDeferred();
    const releaseAfterTurn = createDeferred();
    const replyVisible = createDeferred<Record<string, unknown>>();
    const replyEvents: Record<string, unknown>[] = [];
    let providerServer: ReturnType<typeof createServer> | undefined;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

    try {
      await Promise.all(
        [workspaceDir, bundledPluginsDir, pluginDir, stateDir].map((dir) =>
          fs.mkdir(dir, { recursive: true }),
        ),
      );
      for (const [key, value] of Object.entries(env)) {
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
          response.writeHead(200, { "content-type": "text/event-stream" });
          const message = {
            type: "message",
            id: "pr132123-proof-reply",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: REPLY_TEXT, annotations: [] }],
          };
          response.end(
            [
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
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .concat("data: [DONE]\n\n")
              .join(""),
          );
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
      await Promise.all([
        fs.writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          `${JSON.stringify({
            id: CONTEXT_ENGINE_ID,
            name: "PR 132123 After-Turn Gate",
            activation: { onStartup: true },
            configSchema: { type: "object", additionalProperties: false, properties: {} },
          })}\n`,
        ),
        fs.writeFile(
          path.join(pluginDir, "index.mjs"),
          [
            "export default {",
            `  id: ${JSON.stringify(CONTEXT_ENGINE_ID)},`,
            "  register(api) {",
            `    api.registerContextEngine(${JSON.stringify(CONTEXT_ENGINE_ID)}, () => ({`,
            `      info: { id: ${JSON.stringify(CONTEXT_ENGINE_ID)}, name: "After-Turn Gate", transcriptSemantics: { currentTurnFence: "before-current-turn-entry-v1", turnAdvancementIdempotency: "atomic-idempotent-v1" } },`,
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
        ),
      ]);

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
          entries: { main: {} },
        },
        models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
        gateway: { auth: { mode: "token", token: "pr132123-proof-token" } },
      };
      const sessionKey = "agent:main:pr132123-abort-proof";
      gateway = await startGatewayWithClient({
        cfg,
        configPath,
        token: "pr132123-proof-token",
        clientDisplayName: "pr132123-proof-gateway",
        onEvent: (event) => {
          if (event.event === "chat" && JSON.stringify(event.payload ?? {}).includes(REPLY_TEXT)) {
            const payload = (event.payload ?? {}) as Record<string, unknown>;
            replyEvents.push(payload);
            replyVisible.resolve(payload);
          }
        },
      });

      const client = gateway.client;
      const started = await client.request<{ runId?: string; status?: string }>("chat.send", {
        sessionKey,
        message: "Return the proof marker.",
        deliver: false,
        idempotencyKey: "pr132123-proof-run",
      });
      expect(started.status).toBe("started");
      expect(started.runId).toBeTruthy();
      const visibleEvent = await replyVisible.promise;
      await afterTurnStarted.promise;

      const waitForRun = (timeoutMs: number, rpcTimeout: number) =>
        client.request<{ status?: string }>(
          "agent.wait",
          { runId: started.runId, timeoutMs },
          { timeoutMs: rpcTimeout },
        );
      const waiting = await waitForRun(100, 5_000);
      expect(waiting.status).toBe("timeout");
      const loaded = await loadSessionEntryAsync(sessionKey);
      if (!loaded.entry?.sessionId) {
        throw new Error("proof session did not persist its transcript identity");
      }
      const transcriptScope = {
        agentId: loaded.agentId,
        sessionId: loaded.entry.sessionId,
        sessionKey: loaded.canonicalKey,
        storePath: loaded.storePath,
      };
      const readReplies = async () => assistantRows(await loadTranscriptEvents(transcriptScope));
      const beforeRows = await readReplies();
      expect(beforeRows).toHaveLength(1);
      expect(beforeRows[0]).toMatchObject({ __openclaw: { runId: started.runId } });

      const abort = await client.request<{ aborted?: boolean; runIds?: string[] }>(
        "chat.abort",
        { sessionKey, runId: started.runId },
        { timeoutMs: 15_000 },
      );
      const expectCommittedReply = async () => {
        const rows = await readReplies();
        expect(rows).toHaveLength(1);
        expect(rows.filter((message) => message.openclawAbort)).toHaveLength(0);
      };
      await expectCommittedReply();

      releaseAfterTurn.resolve();
      const terminal = await waitForRun(30_000, 35_000);
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close();
      gateway = undefined;
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      clearSessionStoreCacheForTest();
      const replyEventStates = replyEvents.map((event) => event.state);
      expect(JSON.stringify(visibleEvent)).toContain(REPLY_TEXT);
      expect(abort).toMatchObject({ aborted: false, runIds: [] });
      expect(terminal.status).toBe("ok");
      expect(replyEventStates.filter((state) => state === "aborted")).toHaveLength(0);
      expect(replyEventStates.filter((state) => state === "final")).toHaveLength(1);
      await expectCommittedReply();
    } finally {
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
    }
  },
);
