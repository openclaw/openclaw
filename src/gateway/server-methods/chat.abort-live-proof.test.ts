import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core";
import { afterAll, expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { closeProvider, listenProvider } from "../gateway-provider-fixture.test-support.js";
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
    const text = (Array.isArray(message?.content) ? message.content : [])
      .map((block) => asOptionalRecord(block)?.text)
      .filter((value): value is string => typeof value === "string")
      .join("");
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
    const replyVisible = createDeferred();
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
          writeOpenAiResponsesText(response, {
            text: REPLY_TEXT,
            messageId: "pr132123-proof-reply",
            responseId: "pr132123-proof-response",
          });
        })().catch((error: unknown) => response.destroy(error as Error));
      });
      const providerUrl = await listenProvider(providerServer);
      const provider = buildMockOpenAiResponsesProvider(providerUrl);
      await Promise.all([
        fs.writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          `${JSON.stringify({
            id: CONTEXT_ENGINE_ID,
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
            `      async commitTurn() { const response = await fetch(${JSON.stringify(new URL("/after-turn", providerUrl).href)}, { method: "POST" }); if (!response.ok) throw new Error(`,
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
        onEvent: (event) => {
          if (event.event === "chat" && JSON.stringify(event.payload ?? {}).includes(REPLY_TEXT)) {
            const payload = (event.payload ?? {}) as Record<string, unknown>;
            replyEvents.push(payload);
            replyVisible.resolve();
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
      await replyVisible.promise;
      await afterTurnStarted.promise;

      const waitForRun = (timeoutMs: number, rpcTimeout: number) =>
        client.request<{ status?: string }>(
          "agent.wait",
          { runId: started.runId, timeoutMs },
          { timeoutMs: rpcTimeout },
        );
      expect(await waitForRun(100, 5_000)).toMatchObject({ status: "timeout" });
      const loaded = await loadSessionEntryAsync(sessionKey);
      assert(loaded.entry?.sessionId, "proof session did not persist its transcript identity");
      const transcriptScope = {
        agentId: loaded.agentId,
        sessionId: loaded.entry.sessionId,
        sessionKey: loaded.canonicalKey,
        storePath: loaded.storePath,
      };
      const readReplies = async () => assistantRows(await loadTranscriptEvents(transcriptScope));
      expect(await readReplies()).toMatchObject([{ __openclaw: { runId: started.runId } }]);

      const abort = await client.request<{ aborted?: boolean; runIds?: string[] }>(
        "chat.abort",
        { sessionKey, runId: started.runId },
        { timeoutMs: 15_000 },
      );
      const expectCommittedReply = async () => {
        const rows = await readReplies();
        expect(rows.map((message) => Boolean(message.openclawAbort))).toEqual([false]);
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
        await closeProvider(providerServer);
      }
      envSnapshot.restore();
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      clearSessionStoreCacheForTest();
    }
  },
);
