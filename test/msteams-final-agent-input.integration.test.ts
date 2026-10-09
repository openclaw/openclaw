import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createChannelIngressMonitor } from "openclaw/plugin-sdk/channel-outbound";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import {
  buildChannelActivity,
  createMSTeamsIngress,
  createMSTeamsMessageHandler,
  setMSTeamsRuntime,
  type MSTeamsMessageHandlerDeps,
  type MSTeamsTurnContext,
} from "../extensions/msteams/test-api.js";
import {
  disposeAllSessionMcpRuntimes,
  setSessionMcpRuntimeScheduler,
} from "../src/agents/agent-bundle-mcp-manager-api.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { createPluginRuntime } from "../src/plugins/runtime/index.js";
import { createTestGatewayScheduler } from "../src/test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return { ...actual, createChannelIngressMonitor: vi.fn(actual.createChannelIngressMonitor) };
});

function context(activity: MSTeamsTurnContext["activity"]): MSTeamsTurnContext {
  return {
    activity,
    sendActivity: vi.fn(async () => ({ id: "sent" })),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => ({ id: "updated" })),
    deleteActivity: vi.fn(async () => {}),
  };
}

function groupActivity(
  id: string,
  text: string,
  entities: MSTeamsTurnContext["activity"]["entities"] = [],
  conversationId = "19:proof-group@thread.v2",
): MSTeamsTurnContext["activity"] {
  return {
    ...buildChannelActivity({
      id,
      text,
      from: { id: "bob-id", aadObjectId: "bob-aad", name: "Bob" },
      conversation: { id: conversationId, conversationType: "groupChat" },
      channelData: {},
      entities,
    }),
  } as MSTeamsTurnContext["activity"];
}

async function withRealAgentInputIngress(
  cfg: OpenClawConfig,
  run: (params: {
    accept: (activity: MSTeamsTurnContext["activity"]) => Promise<void>;
    drain: (beforeFlush?: () => void | Promise<void>) => Promise<void>;
    modelRequests: unknown[];
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    {
      label: "msteams-final-agent-input",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_SKIP_PROVIDERS: undefined },
    },
    async (state) => {
      const modelRequests: unknown[] = [];
      const server = createServer((request, response) => {
        void (async () => {
          if (request.method === "GET" && request.url === "/v1/models") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ data: [{ id: "msteams-proof", object: "model" }] }));
            return;
          }
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          modelRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
          writeOpenAiResponsesText(response, {
            text: "Teams proof observed.",
            responseId: `response_msteams_${modelRequests.length}`,
            messageId: `message_msteams_${modelRequests.length}`,
          });
        })().catch((error: unknown) => {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      });
      let stopIngress: (() => Promise<void>) | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Microsoft Teams proof provider did not bind a loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${address.port}/v1`,
          "msteams-proof",
        );
        const proofCfg = {
          ...cfg,
          plugins: { enabled: false },
          agents: {
            entries: { main: { workspace: state.workspaceDir } },
            defaults: {
              model: { primary: provider.modelRef, fallbacks: [] },
              models: { [provider.modelRef]: { agentRuntime: { id: "openclaw" } } },
              skills: [],
              skipBootstrap: true,
              heartbeat: { every: "0m" },
            },
          },
          tools: {
            allow: [],
            codeMode: { enabled: false },
            toolSearch: false,
          },
          models: {
            mode: "replace",
            providers: {
              [provider.providerId]: {
                ...provider.config,
                request: { allowPrivateNetwork: true },
              },
            },
          },
        } satisfies OpenClawConfig;
        await state.writeConfig(proofCfg);
        const scheduler = createTestGatewayScheduler("fake-timers");
        await setSessionMcpRuntimeScheduler(scheduler);
        const runtime = createPluginRuntime();
        let capturedDrain: (() => Promise<void>) | undefined;
        let capturedFlushKey: ((key: string) => Promise<void>) | undefined;
        let expectedDebouncedEntryCount = 0;
        let debouncedEntryCount = 0;
        const debounceKeys = new Set<string>();
        runtime.channel.debounce.createInboundDebouncer = (debouncerOptions) => {
          const debouncer = createInboundDebouncer({
            ...debouncerOptions,
            buildKey: (item) => {
              const key = debouncerOptions.buildKey(item);
              if (key) {
                debounceKeys.add(key);
              }
              return key;
            },
          });
          capturedDrain = debouncer.drain;
          capturedFlushKey = debouncer.flushKey;
          const enqueue: typeof debouncer.enqueue = async (item) => {
            await debouncer.enqueue(item);
            debouncedEntryCount += 1;
          };
          return { ...debouncer, enqueue };
        };
        runtime.channel.debounce.resolveInboundDebounceMs = vi.fn(() => 60_000);
        runtime.channel.routing.resolveAgentRoute = vi.fn(({ peer }) => ({
          sessionKey: `agent:main:msteams:${peer.kind}:${peer.id}`,
          agentId: "main",
          channel: "msteams",
          accountId: "default",
          mainSessionKey: "agent:main:main",
          lastRoutePolicy: "session" as const,
          matchedBy: "default" as const,
        }));
        runtime.channel.pairing.readAllowFromStore = vi.fn(async () => []);
        runtime.channel.pairing.upsertPairingRequest = vi.fn(async () => ({
          code: "111111",
          created: true,
        }));
        setMSTeamsRuntime(runtime);

        const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-agent-"));
        const stateDir = await fs.realpath(created);
        type Queue = NonNullable<Parameters<typeof createMSTeamsIngress>[0]["queue"]>;
        type Payload = Parameters<Queue["enqueue"]>[1];
        const queue = createChannelIngressQueueForTests<Payload>({
          channelId: "msteams",
          accountId: "test-app",
          stateDir,
        });
        const conversationStore = {
          get: vi.fn<MSTeamsMessageHandlerDeps["conversationStore"]["get"]>(async () => null),
          upsert: vi.fn(async () => undefined),
          list: vi.fn(async () => []),
          remove: vi.fn(async () => false),
          findPreferredDmByUserId: vi.fn(async () => null),
        } satisfies MSTeamsMessageHandlerDeps["conversationStore"];
        const deps: MSTeamsMessageHandlerDeps = {
          cfg: proofCfg,
          runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
          appId: "test-app",
          app: {} as MSTeamsMessageHandlerDeps["app"],
          tokenProvider: {
            getAccessToken: vi.fn(async () => "token"),
          },
          textLimit: 4000,
          mediaMaxBytes: 1024 * 1024,
          conversationStore,
          pollStore: {
            recordVote: vi.fn(async () => null),
          } as unknown as MSTeamsMessageHandlerDeps["pollStore"],
          log: {
            info: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
          } as unknown as MSTeamsMessageHandlerDeps["log"],
        };
        const handler = createMSTeamsMessageHandler(deps);
        const ingress = createMSTeamsIngress({
          accountId: "test-app",
          queue,
          runtime: { error: vi.fn(), log: vi.fn() },
          dispatch: async (activity, lifecycle) => await handler(context(activity), lifecycle),
        });
        const monitorResult = vi.mocked(createChannelIngressMonitor).mock.results.at(-1);
        if (monitorResult?.type !== "return" || !capturedDrain || !capturedFlushKey) {
          throw new Error("Expected the Microsoft Teams real-agent ingress and debounce owners");
        }
        const monitor = monitorResult.value;
        const drainDebounce = capturedDrain;
        const flushDebounceKey = capturedFlushKey;
        const drain = async (beforeFlush?: () => void | Promise<void>) => {
          ingress.start();
          await monitor.waitForIdle();
          expect(debouncedEntryCount).toBe(expectedDebouncedEntryCount);
          await beforeFlush?.();
          for (const key of debounceKeys) {
            await flushDebounceKey(key);
          }
          await drainDebounce();
        };
        stopIngress = async () => {
          await monitor.pause();
          await monitor.waitForIdle();
          await drainDebounce();
          await ingress.stop();
          await disposeAllSessionMcpRuntimes();
          await scheduler.stop();
          await closeOpenClawStateDatabaseAsync();
          closeOpenClawStateDatabaseForTest();
          await fs.rm(stateDir, { recursive: true, force: true });
        };
        await run({
          accept: async (activity) => {
            await ingress.accept(activity);
            expectedDebouncedEntryCount += 1;
          },
          drain,
          modelRequests,
        });
      } finally {
        await stopIngress?.();
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    },
  );
}

describe("Microsoft Teams final agent input", () => {
  it(
    "proves quotedReply authority through production inbound execution",
    { timeout: 90_000 },
    async () => {
      const groupAllowFrom = ["bob-aad", "alice-aad"];
      await withRealAgentInputIngress(
        {
          messages: { inbound: { debounceMs: 40 } },
          channels: {
            msteams: {
              groupPolicy: "allowlist",
              groupAllowFrom,
              contextVisibility: "allowlist",
              requireMention: false,
            },
          },
        },
        async ({ accept, drain, modelRequests }) => {
          const latestModelInput = () => {
            expect(
              modelRequests,
              "expected the embedded agent to call the mock model",
            ).not.toHaveLength(0);
            return JSON.stringify(modelRequests.at(-1));
          };

          await accept(
            groupActivity("activity-agent-quote-allowed", "<at>Bot</at> ask <at>Alice</at>", [
              { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
              {
                type: "mention",
                text: "<at>Alice</at>",
                mentioned: { id: "alice-aad", name: "Alice" },
              },
              {
                type: "quotedReply",
                quotedReply: {
                  senderId: "alice-aad",
                  senderName: "Alice",
                  preview: "Allowed final-agent quoted preview",
                },
              },
            ]),
          );
          await drain();
          expect(latestModelInput()).toContain("ask @Alice");
          expect(latestModelInput()).toContain("Allowed final-agent quoted preview");
          expect(latestModelInput()).toContain("Alice");

          await accept(
            groupActivity("activity-agent-quote-blocked", "<at>Bot</at> ask <at>Mallory</at>", [
              { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
              {
                type: "mention",
                text: "<at>Mallory</at>",
                mentioned: { id: "mallory-aad", name: "Mallory" },
              },
              {
                type: "quotedReply",
                quotedReply: {
                  senderId: "mallory-aad",
                  senderName: "Mallory",
                  preview: "Blocked final-agent quoted preview",
                },
              },
            ]),
          );
          await drain();
          expect(latestModelInput()).toContain("ask @Mallory");
          expect(latestModelInput()).not.toContain("Blocked final-agent quoted preview");

          await accept({
            ...groupActivity("activity-agent-quote-mismatched", "<at>Bot</at> ask <at>Alice</at>", [
              { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
              {
                type: "mention",
                text: "<at>Alice</at>",
                mentioned: { id: "alice-aad", name: "Alice" },
              },
              {
                type: "quotedReply",
                quotedReply: {
                  messageId: "quote-agent-a",
                  senderId: "alice-aad",
                  senderName: "Alice",
                },
              },
            ]),
            attachments: [
              {
                contentType: "text/html",
                content:
                  '<blockquote itemtype="http://schema.skype.com/Reply" itemid="quote-agent-b">' +
                  '<strong itemprop="mri">Mallory</strong>' +
                  '<p itemprop="copy">Mismatched final-agent attachment body</p></blockquote>',
              },
            ],
          });
          await drain();
          expect(latestModelInput()).toContain("ask @Alice");
          expect(latestModelInput()).not.toContain("Mismatched final-agent attachment body");

          await accept(
            groupActivity("activity-agent-quote-revoked", "<at>Bot</at> ask <at>Alice</at>", [
              { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
              {
                type: "mention",
                text: "<at>Alice</at>",
                mentioned: { id: "alice-aad", name: "Alice" },
              },
              {
                type: "quotedReply",
                quotedReply: {
                  senderId: "alice-aad",
                  senderName: "Alice",
                  preview: "Revoked final-agent quoted preview",
                },
              },
            ]),
          );
          await drain(() => {
            groupAllowFrom.splice(0, groupAllowFrom.length, "bob-aad");
          });
          expect(latestModelInput()).toContain("ask @Alice");
          expect(latestModelInput()).not.toContain("Revoked final-agent quoted preview");

          groupAllowFrom.splice(0, groupAllowFrom.length, "bob-aad", "alice-aad");
          const quoteEntity = {
            type: "quotedReply",
            quotedReply: {
              senderId: "alice-aad",
              senderName: "Alice",
              preview: "Batched final-agent quoted preview",
            },
          };
          await accept(
            groupActivity("activity-agent-quote-batch-1", "<at>Bot</at> first question", [
              { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
              quoteEntity,
            ]),
          );
          const requestsBeforeBatch = modelRequests.length;
          await accept(
            groupActivity(
              "activity-agent-quote-batch-2",
              "<at>Bot</at> second question",
              [
                { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
                quoteEntity,
              ],
              "19:proof-group@thread.v2;messageid=batch-proof-2",
            ),
          );
          await drain();
          expect(modelRequests).toHaveLength(requestsBeforeBatch + 1);
          const batchModelInput = JSON.stringify(modelRequests[requestsBeforeBatch]);
          expect(batchModelInput).toContain("first question");
          expect(batchModelInput).toContain("second question");
          expect(batchModelInput).toContain("Batched final-agent quoted preview");
        },
      );
    },
  );
});
