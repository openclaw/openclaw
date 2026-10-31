import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { text as readText } from "node:stream/consumers";
import { assert, expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { closeSkillsWatchers } from "../skills/runtime/refresh.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayClient } from "./client.js";
import type { GatewayServer } from "./server.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it(
  "N6 N8: reads persisted dashboard, Telegram, and other Learned markers without replaying them to the provider",
  { timeout: 120_000 },
  async () => {
    const state = await createOpenClawTestState({
      layout: "home",
      prefix: "openclaw-persisted-notice-contract-",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    let gateway: { client: GatewayClient; server: Pick<GatewayServer, "close"> } | undefined;
    const requests: Array<{ input?: Array<{ role?: string; content?: unknown }> }> = [];
    const providerErrors: unknown[] = [];
    const runId = `skill-workshop-review:${randomUUID()}`;
    const marker = {
      kind: "skill-workshop-change",
      agentId: "main",
      runId,
      skills: [{ name: "saved-receipt", action: "created", summary: "retain verified steps" }],
    };
    const noticeText =
      '💾 Learned: created `saved-receipt` (retain verified steps). Say "undo" to revert this skill change.';
    const keys = [
      "agent:main:dashboard:persisted-notice",
      "agent:main:telegram:direct:4321",
      "agent:main:persisted-notice",
    ];
    try {
      await withServer(
        (request, response) => {
          void (async () => {
            requests.push(JSON.parse(await readText(request)));
            const id = `replay-${requests.length}`;
            writeOpenAiResponsesText(response, {
              text: "PERSISTED_REPLAY_COMPLETE",
              messageId: id,
              responseId: id,
            });
          })().catch((error: unknown) => {
            providerErrors.push(error);
            response.writeHead(500).end(String(error));
          });
        },
        async (baseUrl) => {
          const provider = buildMockOpenAiResponsesProvider(`${baseUrl}/v1`, "persisted-notice");
          const token = "isolated-persisted-notice-token";
          const config = {
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                skipBootstrap: true,
                model: { primary: provider.modelRef },
                models: {
                  [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                },
              },
            },
            gateway: { auth: { mode: "token", token } },
            models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
            plugins: { slots: { memory: "none" } },
            tools: { profile: "minimal" },
            skills: { load: { watch: false }, workshop: { autonomous: { mode: "off" } } },
          } satisfies OpenClawConfig;
          // The census found this exact marker shape in on-disk transcript_events.
          // Initialize the schema, join every worker, then take exclusive offline custody.
          const databasePath = openOpenClawAgentDatabase({ agentId: "main" }).path;
          await closeStateDatabaseForTest();
          await closeOpenClawAgentDatabaseByPathAsync(databasePath);
          const database = new DatabaseSync(databasePath);
          try {
            database.exec("PRAGMA foreign_keys=ON; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
            const node = database.prepare(
              "INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at) VALUES (?, ?, ?, 1, ?)",
            );
            const window = database.prepare(
              "INSERT INTO session_windows (session_id, session_key, reason, created_at, updated_at) VALUES (?, ?, 'initial', ?, ?)",
            );
            const event = database.prepare(
              "INSERT INTO transcript_events (session_id, seq, event_json, created_at, navigation_type, message_role) VALUES (?, ?, ?, ?, json_extract(?, '$.type'), json_extract(?, '$.message.role'))",
            );
            for (const [index, sessionKey] of keys.entries()) {
              const sessionId = randomUUID();
              const now = Date.now();
              node.run(sessionKey, sessionId, JSON.stringify({ sessionId, updatedAt: now }), now);
              window.run(sessionId, sessionKey, now, now);
              const assistant = {
                role: "assistant",
                api: "openai-responses",
                provider: provider.providerId,
                model: provider.modelId,
                content: [{ type: "text", text: `ORDINARY_ASSISTANT_${index}` }],
                stopReason: "stop",
                timestamp: now,
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
              };
              const events = [
                {
                  type: "session",
                  version: 3,
                  id: sessionId,
                  timestamp: new Date(now).toISOString(),
                  cwd: state.workspaceDir,
                },
                {
                  type: "message",
                  id: `user-${index}`,
                  parentId: null,
                  timestamp: new Date(now).toISOString(),
                  message: { role: "user", content: `ORDINARY_USER_${index}`, timestamp: now },
                },
                {
                  type: "message",
                  id: `assistant-${index}`,
                  parentId: `user-${index}`,
                  timestamp: new Date(now).toISOString(),
                  message: assistant,
                },
                {
                  type: "message",
                  id: `notice-${index}`,
                  parentId: `assistant-${index}`,
                  timestamp: new Date(now).toISOString(),
                  message: {
                    ...assistant,
                    provider: "openclaw",
                    model: "delivery-mirror",
                    content: [{ type: "text", text: noticeText }],
                    openclawDeliveryMirror: marker,
                    idempotencyKey: `skill-workshop-notice:${runId}`,
                  },
                },
              ];
              events.forEach((row, seq) => {
                const json = JSON.stringify(row);
                event.run(sessionId, seq + 1, json, now, json, json);
              });
            }
            database.exec("COMMIT");
          } finally {
            database.close();
          }
          const active = await startGatewayWithClient({
            cfg: config,
            configPath: state.configPath,
            token,
            scopes: ["operator.admin", "operator.read", "operator.write"],
          });
          gateway = active;
          for (const [index, sessionKey] of keys.entries()) {
            const history = await active.client.request<{
              messages: Array<{ content?: unknown; openclawDeliveryMirror?: unknown }>;
            }>("chat.history", { sessionKey, limit: 20 });
            const notices = history.messages.filter(
              (message) => message.openclawDeliveryMirror !== undefined,
            );
            expect(notices).toHaveLength(1);
            const notice = notices[0];
            assert.isDefined(notice);
            expect(notice.openclawDeliveryMirror).toEqual(marker);
            expect(JSON.stringify(notice.content)).toContain(
              JSON.stringify(noticeText).slice(1, -1),
            );
            const accepted = await active.client.request<{ runId: string }>("agent", {
              sessionKey,
              message: "Continue with one acknowledgement.",
              deliver: false,
              idempotencyKey: randomUUID(),
            });
            const completed = await active.client.request(
              "agent.wait",
              { runId: accepted.runId, timeoutMs: 45_000 },
              { timeoutMs: 50_000 },
            );
            expect(completed, JSON.stringify(completed)).toMatchObject({ status: "ok" });
            const replay = requests.at(-1);
            expect(JSON.stringify(replay)).toContain(`ORDINARY_USER_${index}`);
            expect(JSON.stringify(replay)).toContain(`ORDINARY_ASSISTANT_${index}`);
            expect(JSON.stringify(replay)).not.toContain("💾 Learned:");
            expect(JSON.stringify(replay)).not.toContain("saved-receipt");
          }
          expect(requests).toHaveLength(3);
          expect(providerErrors).toEqual([]);
        },
      );
    } finally {
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "Persisted notice proof cleanup" });
      }
      await closeSkillsWatchers(true);
      await state.cleanup();
    }
  },
);
