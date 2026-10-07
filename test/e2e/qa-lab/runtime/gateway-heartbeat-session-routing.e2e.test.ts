import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
} from "../../../../src/config/config.js";
import { resetConfigOverrides } from "../../../../src/config/runtime-overrides.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../../src/config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../../../src/config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { readSessionMessagesAsync } from "../../../../src/gateway/session-transcript-readers.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../../../../src/gateway/test-openai-responses-model.js";
import { resetAgentEventsForTest } from "../../../../src/infra/agent-events.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../../../src/infra/system-events.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../../../src/test-utils/env.js";
import { normalizeSessionDeliveryState } from "../../../../src/utils/delivery-context.shared.js";
import { writeOpenAiResponsesSse } from "../../../helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const PROOF_CHANNEL_ID = "heartbeat-route-proof";
const MEDIA_GROUP_TOOL_POLICIES = {
  "group-media-allowed": { allow: ["read"] },
  "group-media-denied": { deny: ["read"] },
} as const;
const ISOLATED_GATEWAY_ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN",
  "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN",
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

type DeliveryTrace = {
  accountId: string | null;
  kind: "media" | "text";
  mediaBytes?: string;
  mediaError?: string;
  mediaUrl?: string;
  text: string;
  threadId: string | number | null;
  to: string;
};

type PolicyTrace = {
  groupId: string | null;
  tools?: { allow?: string[]; deny?: string[] };
};

let sequence = 0;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function nextId(prefix: string): string {
  return `${prefix}-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}-${sequence++}`;
}

function resetGatewayState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
  resetSystemEventsForTest();
}

function writeAssistantResponse(response: ServerResponse, text: string): void {
  const message = {
    type: "message",
    id: nextId("provider-message"),
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: nextId("provider-response"),
        status: "completed",
        output: [message],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);
}

async function writeRouteCapturePlugin(params: {
  pluginDir: string;
  tracePath: string;
  policyTracePath: string;
  cronReadyEvent: string;
  groupToolPolicies: Readonly<
    Record<string, { allow?: readonly string[]; deny?: readonly string[] }>
  >;
}): Promise<void> {
  await fs.mkdir(params.pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(params.pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: PROOF_CHANNEL_ID,
        activation: { onStartup: true },
        channels: [PROOF_CHANNEL_ID],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(params.pluginDir, "index.cjs"),
    [
      'const fs = require("node:fs");',
      "let sequence = 0;",
      `const tracePath = ${JSON.stringify(params.tracePath)};`,
      `const policyTracePath = ${JSON.stringify(params.policyTracePath)};`,
      `const groupToolPolicies = ${JSON.stringify(params.groupToolPolicies)};`,
      'const record = (entry) => fs.appendFileSync(tracePath, JSON.stringify(entry) + "\\n", "utf8");',
      'const recordPolicy = (entry) => fs.appendFileSync(policyTracePath, JSON.stringify(entry) + "\\n", "utf8");',
      "module.exports = {",
      `  id: ${JSON.stringify(PROOF_CHANNEL_ID)},`,
      "  register(api) {",
      '    api.on("cron_reconciled", (event) => {',
      `      process.emit(${JSON.stringify(params.cronReadyEvent)}, event);`,
      "    });",
      "    api.registerChannel({",
      "      plugin: {",
      `        id: ${JSON.stringify(PROOF_CHANNEL_ID)},`,
      "        meta: {",
      `          id: ${JSON.stringify(PROOF_CHANNEL_ID)},`,
      '          label: "Heartbeat Route Proof",',
      '          selectionLabel: "Heartbeat Route Proof",',
      '          docsPath: "/channels/heartbeat-route-proof",',
      '          blurb: "Captures heartbeat routes for Gateway boundary tests.",',
      "        },",
      '        capabilities: { chatTypes: ["direct", "group"] },',
      "        messaging: {",
      "          normalizeTarget: (raw) => raw.trim(),",
      '          inferTargetChatType: ({ to }) => to.startsWith("group-") ? "group" : "direct",',
      "        },",
      "        config: {",
      '          listAccountIds: () => ["default"],',
      '          resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "default" }),',
      "          isEnabled: () => true,",
      "          isConfigured: () => true,",
      "        },",
      "        groups: {",
      "          resolveToolPolicy: ({ groupId }) => {",
      '            const tools = groupToolPolicies[groupId ?? ""];',
      "            recordPolicy({ groupId: groupId ?? null, tools });",
      "            return tools;",
      "          },",
      "        },",
      "        outbound: {",
      '          deliveryMode: "direct",',
      "          sendText: async ({ to, text, accountId, threadId }) => {",
      "            record({",
      '              kind: "text",',
      "              to,",
      "              text,",
      "              accountId: accountId ?? null,",
      "              threadId: threadId ?? null,",
      "            });",
      "            sequence += 1;",
      `            return { channel: ${JSON.stringify(PROOF_CHANNEL_ID)}, messageId: \`proof-\${sequence}\` };`,
      "          },",
      "          sendMedia: async ({ to, text, mediaUrl, mediaReadFile, accountId, threadId }) => {",
      "            let mediaBytes;",
      "            let mediaError;",
      "            try {",
      '              if (typeof mediaReadFile !== "function") throw new Error("media reader unavailable");',
      '              mediaBytes = (await mediaReadFile(mediaUrl)).toString("utf8");',
      "            } catch (error) {",
      "              mediaError = error instanceof Error ? error.message : String(error);",
      "            }",
      "            record({",
      '              kind: "media",',
      "              to,",
      "              text,",
      "              mediaUrl,",
      "              mediaBytes,",
      "              mediaError,",
      "              accountId: accountId ?? null,",
      "              threadId: threadId ?? null,",
      "            });",
      "            if (mediaError) throw new Error(mediaError);",
      "            sequence += 1;",
      `            return { channel: ${JSON.stringify(PROOF_CHANNEL_ID)}, messageId: \`proof-\${sequence}\` };`,
      "          },",
      "        },",
      "      },",
      "    });",
      "  },",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function readDeliveryTrace(filePath: string): Promise<DeliveryTrace[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DeliveryTrace);
}

async function readPolicyTrace(filePath: string): Promise<PolicyTrace[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PolicyTrace);
}

async function readSessionTranscript(sessionKey: string): Promise<unknown[]> {
  const entry = loadSessionEntry({ agentId: "main", sessionKey, readConsistency: "latest" });
  if (!entry?.sessionId) {
    throw new Error(`Session entry ${sessionKey} was not persisted`);
  }
  return await readSessionMessagesAsync(
    {
      agentId: "main",
      sessionEntry: entry,
      sessionId: entry.sessionId,
      sessionKey,
    },
    { mode: "full", reason: "heartbeat session routing Gateway boundary proof" },
  );
}

describe("Gateway heartbeat and cron session routing", () => {
  let fixtureSettlement: Promise<void> | undefined;
  beforeEach(resetGatewayState);
  afterEach(async () => {
    // A timed-out body still owns Gateway shutdown. Join it before outer hooks
    // reset runtime state or remove the fixture's files.
    await fixtureSettlement;
    fixtureSettlement = undefined;
    resetGatewayState();
  });

  it(
    "routes monitor wakes and current cron delivery through their bound sessions",
    { timeout: 90_000 },
    async ({ signal }) => {
      const envSnapshot = captureEnv([...ISOLATED_GATEWAY_ENV_KEYS]);
      const tempHome = tempDirs.make("openclaw-gateway-heartbeat-routing-");
      const stateDir = path.join(tempHome, ".openclaw");
      const workspaceDir = path.join(tempHome, "workspace");
      const policyMediaPath = path.join(workspaceDir, "destination-policy-proof.txt");
      const policyMediaContents = nextId("destination-policy-media");
      const pluginDir = path.join(workspaceDir, "plugins", PROOF_CHANNEL_ID);
      const deliveryTracePath = path.join(tempHome, "heartbeat-deliveries.jsonl");
      const policyTracePath = path.join(tempHome, "heartbeat-policies.jsonl");
      const cronReadyEvent = nextId("cron-reconciled");
      const cronReconciled = createDeferred<unknown>();
      const onCronReconciled = (event: unknown) => cronReconciled.resolve(event);
      const bundledPluginsDir = path.join(tempHome, "empty-bundled-plugins");
      const configPath = path.join(stateDir, "openclaw.json");
      await Promise.all([
        fs.mkdir(workspaceDir, { recursive: true }),
        fs.mkdir(bundledPluginsDir, { recursive: true }),
        fs.mkdir(path.dirname(configPath), { recursive: true }),
      ]);
      await Promise.all([
        fs.writeFile(
          path.join(workspaceDir, "HEARTBEAT.md"),
          "Process all pending system events and report what was handled.\n",
        ),
        fs.writeFile(policyMediaPath, policyMediaContents, "utf8"),
        writeRouteCapturePlugin({
          pluginDir,
          tracePath: deliveryTracePath,
          policyTracePath,
          cronReadyEvent,
          groupToolPolicies: MEDIA_GROUP_TOOL_POLICIES,
        }),
      ]);

      const token = nextId("heartbeat-routing-token");
      for (const [key, value] of Object.entries({
        HOME: tempHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "0",
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

      const configuredSessionKey = "agent:main:ops-heartbeat";
      const configuredSessionId = nextId("configured-heartbeat-session");
      const configuredEvent = nextId("configured-heartbeat-event");
      const configuredReply = nextId("configured-heartbeat-reply");
      const cronSourceKey = "agent:main:dashboard:cron-delivery-source";
      const cronSourceSessionId = nextId("cron-source-session");
      const cronPrompt = nextId("cron-source-prompt");
      const cronReply = nextId("cron-source-reply");
      const allowedMediaSourceKey = "agent:main:dashboard:cron-media-allowed";
      const allowedMediaSourceSessionId = nextId("cron-media-allowed-session");
      const allowedMediaPrompt = nextId("cron-media-allowed-prompt");
      const allowedMediaReply = nextId("cron-media-allowed-reply");
      const deniedMediaSourceKey = "agent:main:dashboard:cron-media-denied";
      const deniedMediaSourceSessionId = nextId("cron-media-denied-session");
      const deniedMediaPrompt = nextId("cron-media-denied-prompt");
      const deniedMediaReply = nextId("cron-media-denied-reply");
      const explicitSessionKey = "agent:main:user-session";
      const explicitSessionId = nextId("explicit-heartbeat-session");
      const explicitQueuedEvent = nextId("explicit-queued-event");
      const explicitWakeText = nextId("explicit-wake-event");
      const explicitReply = nextId("explicit-heartbeat-reply");
      const mainSessionKey = "agent:main:main";
      const mainSessionId = nextId("main-session");
      const providerRequests: Array<Record<string, unknown>> = [];
      const providerServer = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >;
          providerRequests.push(body);
          const serialized = JSON.stringify(body);
          writeAssistantResponse(
            response,
            serialized.includes(allowedMediaPrompt)
              ? `${allowedMediaReply}\nMEDIA:${policyMediaPath}`
              : serialized.includes(deniedMediaPrompt)
                ? `${deniedMediaReply}\nMEDIA:${policyMediaPath}`
                : serialized.includes(cronPrompt)
                  ? cronReply
                  : serialized.includes(configuredEvent)
                    ? configuredReply
                    : serialized.includes(explicitQueuedEvent) ||
                        serialized.includes(explicitWakeText)
                      ? explicitReply
                      : nextId("unexpected-heartbeat-reply"),
          );
        })().catch((error: unknown) => {
          response.writeHead(500).end(error instanceof Error ? error.message : String(error));
        });
      });

      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      const fixtureSettled = createDeferred();
      fixtureSettlement = fixtureSettled.promise;
      try {
        process.on(cronReadyEvent, onCronReconciled);
        await new Promise<void>((resolve, reject) => {
          providerServer.once("error", reject);
          providerServer.listen(0, "127.0.0.1", resolve);
        });
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("mock OpenAI Responses server did not bind a loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${providerAddress.port}/v1`,
          "gpt-heartbeat-session-routing",
        );
        const config = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              heartbeat: { every: "24h", session: "ops-heartbeat", target: "last" },
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: {
                  params: { transport: "sse", openaiWsWarmup: false },
                },
                "catalog-proof/*": {},
              },
            },
            entries: { main: {} },
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
          tools: { allow: ["read"] },
          // Full configs may contain nested nulls; heartbeat admission must not reinterpret them as patches.
          tts: { providers: { fixture: { disabledVoice: null } } },
          gateway: { auth: { mode: "token", token } },
          plugins: {
            enabled: true,
            allow: [PROOF_CHANNEL_ID],
            load: { paths: [pluginDir] },
            entries: { [PROOF_CHANNEL_ID]: { enabled: true } },
            slots: { memory: "none" },
          },
        } satisfies OpenClawConfig;

        gateway = await startGatewayWithClient({
          cfg: config,
          configPath,
          token,
          clientDisplayName: "vitest-gateway-heartbeat-session-routing",
        });
        await gateway.server.startupSettled;
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "heartbeat catalog-owner restart proof" });
        gateway = await startGatewayWithClient({
          cfg: config,
          configPath,
          token,
          clientDisplayName: "vitest-gateway-heartbeat-session-routing-restarted",
        });
        await gateway.server.startupSettled;
        const runtimeConfig = getRuntimeConfigSnapshot();
        if (!runtimeConfig) {
          throw new Error("gateway runtime config snapshot was not initialized");
        }
        const client = gateway.client;

        const seedSession = async (params: {
          sessionId: string;
          sessionKey: string;
          to: string;
        }) => {
          await replaceSessionEntry(
            { agentId: "main", sessionKey: params.sessionKey },
            {
              sessionId: params.sessionId,
              updatedAt: Date.now(),
              delivery: normalizeSessionDeliveryState({
                context: {
                  channel: PROOF_CHANNEL_ID,
                  to: params.to,
                  accountId: "default",
                },
              }),
            },
          );
        };
        await seedSession({
          sessionId: configuredSessionId,
          sessionKey: configuredSessionKey,
          to: "configured-destination",
        });
        await seedSession({
          sessionId: cronSourceSessionId,
          sessionKey: cronSourceKey,
          to: "cron-source-destination",
        });
        await seedSession({
          sessionId: allowedMediaSourceSessionId,
          sessionKey: allowedMediaSourceKey,
          to: "group-media-allowed",
        });
        await seedSession({
          sessionId: deniedMediaSourceSessionId,
          sessionKey: deniedMediaSourceKey,
          to: "group-media-denied",
        });
        await seedSession({
          sessionId: explicitSessionId,
          sessionKey: explicitSessionKey,
          to: "explicit-destination",
        });
        await seedSession({
          sessionId: mainSessionId,
          sessionKey: mainSessionKey,
          to: "main-destination",
        });

        await expect(
          client.request<{ ok: boolean }>("system-event", {
            text: configuredEvent,
            sessionKey: configuredSessionKey,
            wake: false,
          }),
        ).resolves.toEqual({ ok: true });
        expect(peekSystemEvents(configuredSessionKey)).toContain(configuredEvent);

        // A connected Gateway may still be starting cron; its lifecycle hook owns readiness.
        expect(await withinTest(cronReconciled.promise, signal)).toEqual({
          reason: "startup",
          enabled: true,
        });
        const listed = await client.request<{
          jobs: Array<{
            agentId?: string;
            declarationKey?: string;
            enabled: boolean;
            id: string;
            payload: { kind: string };
            sessionTarget: string;
          }>;
        }>("cron.list", { includeDisabled: true });
        const monitor = listed.jobs.find((job) => job.declarationKey === "heartbeat:main");
        expect(monitor).toMatchObject({
          agentId: "main",
          declarationKey: "heartbeat:main",
          enabled: true,
          payload: { kind: "heartbeat" },
          sessionTarget: "main",
        });
        if (!monitor) {
          throw new Error("system-owned main-agent heartbeat monitor was not listed");
        }

        const configuredRequestBaseline = providerRequests.length;
        const configuredRun = await client.request<{
          enqueued: boolean;
          ok: boolean;
          runId: string;
        }>("cron.run", {
          id: monitor.id,
          mode: "force",
        });
        expect(configuredRun).toMatchObject({
          ok: true,
          enqueued: true,
          runId: expect.any(String),
        });
        await expect
          .poll(
            async () => {
              const history = await client.request<{
                entries: Array<{ error?: string; runId?: string; status?: string }>;
              }>("cron.runs", {
                id: monitor.id,
                runId: configuredRun.runId,
                limit: 1,
              });
              return history.entries.find((entry) => entry.runId === configuredRun.runId);
            },
            { timeout: 15_000, interval: 50 },
          )
          .toMatchObject({ runId: configuredRun.runId, status: "ok" });
        await expect
          .poll(() => providerRequests.length, { timeout: 15_000, interval: 50 })
          .toBeGreaterThan(configuredRequestBaseline);
        const configuredRequest = JSON.stringify(providerRequests[configuredRequestBaseline]);
        expect(configuredRequest).toContain(configuredEvent);
        await expect
          .poll(() => peekSystemEvents(configuredSessionKey).includes(configuredEvent), {
            timeout: 15_000,
            interval: 50,
          })
          .toBe(false);
        await expect
          .poll(() => readDeliveryTrace(deliveryTracePath), { timeout: 15_000, interval: 50 })
          .toHaveLength(1);
        expect(await readDeliveryTrace(deliveryTracePath)).toEqual([
          {
            accountId: "default",
            kind: "text",
            text: configuredReply,
            threadId: null,
            to: "configured-destination",
          },
        ]);
        await expect
          .poll(() => readSessionTranscript(configuredSessionKey).then(JSON.stringify), {
            timeout: 15_000,
            interval: 50,
          })
          .toContain(configuredReply);
        expect(
          loadSessionEntry({
            agentId: "main",
            sessionKey: configuredSessionKey,
            readConsistency: "latest",
          })?.sessionId,
        ).toBe(configuredSessionId);
        const configuredTranscript = JSON.stringify(
          await readSessionTranscript(configuredSessionKey),
        );
        expect(configuredTranscript).toContain(configuredReply);
        expect(JSON.stringify(await readSessionTranscript(mainSessionKey))).not.toContain(
          configuredReply,
        );

        const cronJob = await client.request<{
          id: string;
          sessionKey?: string;
          sessionTarget: string;
        }>("cron.add", {
          agentId: "main",
          name: "Dashboard current-session delivery proof",
          enabled: false,
          schedule: { kind: "every", everyMs: 86_400_000 },
          sessionTarget: "current",
          sessionKey: cronSourceKey,
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: cronPrompt, toolsAllow: [] },
          delivery: { mode: "announce", channel: "last" },
        });
        expect(cronJob).toMatchObject({
          sessionKey: cronSourceKey,
          sessionTarget: "current",
        });
        const cronRun = await client.request<{
          enqueued: boolean;
          ok: boolean;
          runId: string;
        }>("cron.run", { id: cronJob.id, mode: "force" });
        expect(cronRun).toMatchObject({ ok: true, enqueued: true, runId: expect.any(String) });
        await expect
          .poll(
            async () => {
              const history = await client.request<{
                entries: Array<{
                  deliveryStatus?: string;
                  runId?: string;
                  status?: string;
                }>;
              }>("cron.runs", { id: cronJob.id, runId: cronRun.runId, limit: 1 });
              return history.entries.find((entry) => entry.runId === cronRun.runId);
            },
            { timeout: 15_000, interval: 50 },
          )
          .toMatchObject({
            runId: cronRun.runId,
            status: "ok",
            deliveryStatus: "delivered",
          });
        await expect
          .poll(() => readDeliveryTrace(deliveryTracePath), { timeout: 15_000, interval: 50 })
          .toHaveLength(2);
        expect((await readDeliveryTrace(deliveryTracePath))[1]).toEqual({
          accountId: "default",
          kind: "text",
          text: cronReply,
          threadId: null,
          to: "cron-source-destination",
        });
        await expect
          .poll(() => readSessionTranscript(cronSourceKey).then(JSON.stringify), {
            timeout: 15_000,
            interval: 50,
          })
          .toContain(cronReply);
        expect(
          loadSessionEntry({
            agentId: "main",
            sessionKey: cronSourceKey,
            readConsistency: "latest",
          })?.sessionId,
        ).toBe(cronSourceSessionId);
        expect(peekSystemEvents(cronSourceKey).join("\n")).toContain(cronReply);
        expect(JSON.stringify(await readSessionTranscript(mainSessionKey))).not.toContain(
          cronReply,
        );

        const allowedMediaJob = await client.request<{
          id: string;
          sessionKey?: string;
          sessionTarget: string;
        }>("cron.add", {
          agentId: "main",
          name: "Dashboard destination-policy media allow proof",
          enabled: false,
          schedule: { kind: "every", everyMs: 86_400_000 },
          sessionTarget: "current",
          sessionKey: allowedMediaSourceKey,
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: allowedMediaPrompt, toolsAllow: [] },
          delivery: { mode: "announce", channel: "last" },
        });
        expect(allowedMediaJob).toMatchObject({
          sessionKey: allowedMediaSourceKey,
          sessionTarget: "current",
        });
        const allowedMediaRun = await client.request<{
          enqueued: boolean;
          ok: boolean;
          runId: string;
        }>("cron.run", { id: allowedMediaJob.id, mode: "force" });
        expect(allowedMediaRun).toMatchObject({
          ok: true,
          enqueued: true,
          runId: expect.any(String),
        });
        await expect
          .poll(
            async () => {
              const history = await client.request<{
                entries: Array<{
                  deliveryStatus?: string;
                  runId?: string;
                  status?: string;
                }>;
              }>("cron.runs", {
                id: allowedMediaJob.id,
                runId: allowedMediaRun.runId,
                limit: 1,
              });
              return history.entries.find((entry) => entry.runId === allowedMediaRun.runId);
            },
            { timeout: 15_000, interval: 50 },
          )
          .toMatchObject({
            runId: allowedMediaRun.runId,
            status: "ok",
            deliveryStatus: "delivered",
          });
        await expect
          .poll(() => readDeliveryTrace(deliveryTracePath), { timeout: 15_000, interval: 50 })
          .toHaveLength(3);
        expect((await readDeliveryTrace(deliveryTracePath))[2]).toEqual({
          accountId: "default",
          kind: "media",
          mediaBytes: policyMediaContents,
          mediaUrl: policyMediaPath,
          text: allowedMediaReply,
          threadId: null,
          to: "group-media-allowed",
        });
        await expect
          .poll(() => readSessionTranscript(allowedMediaSourceKey).then(JSON.stringify), {
            timeout: 15_000,
            interval: 50,
          })
          .toContain(allowedMediaReply);

        const deniedMediaJob = await client.request<{
          id: string;
          sessionKey?: string;
          sessionTarget: string;
        }>("cron.add", {
          agentId: "main",
          name: "Dashboard destination-policy media denial proof",
          enabled: false,
          schedule: { kind: "every", everyMs: 86_400_000 },
          sessionTarget: "current",
          sessionKey: deniedMediaSourceKey,
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: deniedMediaPrompt, toolsAllow: [] },
          delivery: { mode: "announce", channel: "last" },
        });
        expect(deniedMediaJob).toMatchObject({
          sessionKey: deniedMediaSourceKey,
          sessionTarget: "current",
        });
        const deniedMediaRun = await client.request<{
          enqueued: boolean;
          ok: boolean;
          runId: string;
        }>("cron.run", { id: deniedMediaJob.id, mode: "force" });
        expect(deniedMediaRun).toMatchObject({
          ok: true,
          enqueued: true,
          runId: expect.any(String),
        });
        await expect
          .poll(
            async () => {
              const history = await client.request<{
                entries: Array<{ runId?: string; status?: string }>;
              }>("cron.runs", {
                id: deniedMediaJob.id,
                runId: deniedMediaRun.runId,
                limit: 1,
              });
              return history.entries.find((entry) => entry.runId === deniedMediaRun.runId)?.status;
            },
            { timeout: 15_000, interval: 50 },
          )
          .toBe("ok");
        await expect
          .poll(() => readPolicyTrace(policyTracePath), { timeout: 15_000, interval: 50 })
          .toContainEqual({
            groupId: "group-media-denied",
            tools: { deny: ["read"] },
          });
        const deniedMediaHistory = await client.request<{
          entries: Array<{
            deliveryStatus?: string;
            runId?: string;
            status?: string;
          }>;
        }>("cron.runs", {
          id: deniedMediaJob.id,
          runId: deniedMediaRun.runId,
          limit: 1,
        });
        expect(deniedMediaHistory.entries).toContainEqual(
          expect.objectContaining({
            runId: deniedMediaRun.runId,
            status: "ok",
            deliveryStatus: "not-delivered",
          }),
        );
        await expect
          .poll(() => readSessionTranscript(deniedMediaSourceKey).then(JSON.stringify), {
            timeout: 15_000,
            interval: 50,
          })
          .toContain(deniedMediaReply);
        expect(await readDeliveryTrace(deliveryTracePath)).toHaveLength(3);
        expect((await readDeliveryTrace(deliveryTracePath)).map((entry) => entry.to)).not.toContain(
          "group-media-denied",
        );

        await expect(
          client.request<{ ok: boolean }>("system-event", {
            text: explicitQueuedEvent,
            sessionKey: explicitSessionKey,
            wake: false,
          }),
        ).resolves.toEqual({ ok: true });
        expect(peekSystemEvents(explicitSessionKey)).toContain(explicitQueuedEvent);
        const explicitRequestBaseline = providerRequests.length;
        await expect(
          client.request<{ ok: boolean }>("wake", {
            mode: "now",
            text: explicitWakeText,
            agentId: "main",
            sessionKey: explicitSessionKey,
          }),
        ).resolves.toEqual({ ok: true });
        await expect
          .poll(() => providerRequests.length, { timeout: 15_000, interval: 50 })
          .toBeGreaterThan(explicitRequestBaseline);
        const explicitRequest = JSON.stringify(providerRequests[explicitRequestBaseline]);
        expect(explicitRequest).toContain(explicitQueuedEvent);
        expect(explicitRequest).toContain(explicitWakeText);
        await expect
          .poll(
            () => {
              const queued = peekSystemEvents(explicitSessionKey);
              return queued.includes(explicitQueuedEvent) || queued.includes(explicitWakeText);
            },
            { timeout: 15_000, interval: 50 },
          )
          .toBe(false);
        await expect
          .poll(() => readDeliveryTrace(deliveryTracePath), { timeout: 15_000, interval: 50 })
          .toHaveLength(4);
        expect(await readDeliveryTrace(deliveryTracePath)).toEqual([
          {
            accountId: "default",
            kind: "text",
            text: configuredReply,
            threadId: null,
            to: "configured-destination",
          },
          {
            accountId: "default",
            kind: "text",
            text: cronReply,
            threadId: null,
            to: "cron-source-destination",
          },
          {
            accountId: "default",
            kind: "media",
            mediaBytes: policyMediaContents,
            mediaUrl: policyMediaPath,
            text: allowedMediaReply,
            threadId: null,
            to: "group-media-allowed",
          },
          {
            accountId: "default",
            kind: "text",
            text: explicitReply,
            threadId: null,
            to: "explicit-destination",
          },
        ]);
        await expect
          .poll(() => readSessionTranscript(explicitSessionKey).then(JSON.stringify), {
            timeout: 15_000,
            interval: 50,
          })
          .toContain(explicitReply);
        expect(
          loadSessionEntry({
            agentId: "main",
            sessionKey: explicitSessionKey,
            readConsistency: "latest",
          })?.sessionId,
        ).toBe(explicitSessionId);
        const explicitTranscript = JSON.stringify(await readSessionTranscript(explicitSessionKey));
        expect(explicitTranscript).toContain(explicitReply);
        expect(explicitTranscript).not.toContain(configuredReply);
        expect(JSON.stringify(await readSessionTranscript(configuredSessionKey))).not.toContain(
          explicitReply,
        );
        const mainTranscript = JSON.stringify(await readSessionTranscript(mainSessionKey));
        expect(mainTranscript).not.toContain(configuredReply);
        expect(mainTranscript).not.toContain(cronReply);
        expect(mainTranscript).not.toContain(explicitReply);
        expect((await readDeliveryTrace(deliveryTracePath)).map((entry) => entry.to)).not.toContain(
          "main-destination",
        );
      } finally {
        process.removeListener(cronReadyEvent, onCronReconciled);
        try {
          if (gateway) {
            await disconnectGatewayClient(gateway.client);
            await gateway.server.close({
              reason: "Gateway heartbeat session routing test complete",
            });
          }
          providerServer.closeAllConnections();
          await new Promise<void>((resolve) => {
            providerServer.close(() => resolve());
          });
          envSnapshot.restore();
        } finally {
          fixtureSettled.resolve();
        }
      }
    },
  );
});
