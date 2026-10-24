import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { CronJob } from "../../../../src/cron/types.js";
import { readSessionMessagesAsync } from "../../../../src/gateway/session-transcript-readers.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../../../../src/gateway/test-openai-responses-model.js";
import { peekSystemEvents } from "../../../../src/infra/system-events.js";
import { normalizeSessionDeliveryState } from "../../../../src/utils/delivery-context.shared.js";
import {
  listenLoopback,
  readRequestText,
  closeHttpServer,
} from "../../../helpers/gateway-integration-fixtures.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { writeFixtureReply } from "./gateway-recovery.test-support.js";
import { prepareRecoveryHome, resetGatewayState } from "./gateway-startup-routing.test-support.js";

const PROOF_CHANNEL_ID = "heartbeat-route-proof";

type DeliveryTrace = {
  accountId: string | null;
  text: string;
  threadId: string | number | null;
  to: string;
};

let sequence = 0;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function nextId(prefix: string): string {
  return `${prefix}-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}-${sequence++}`;
}

async function writeRouteCapturePlugin(params: {
  pluginDir: string;
  tracePath: string;
  cronReadyEvent: string;
}): Promise<void> {
  await fs.mkdir(params.pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(params.pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PROOF_CHANNEL_ID,
      activation: { onStartup: true },
      channels: [PROOF_CHANNEL_ID],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(params.pluginDir, "index.cjs"),
    [
      'const fs = require("node:fs");',
      "let sequence = 0;",
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
      '        capabilities: { chatTypes: ["direct"] },',
      "        config: {",
      '          listAccountIds: () => ["default"],',
      '          resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "default" }),',
      "          isEnabled: () => true,",
      "          isConfigured: () => true,",
      "        },",
      "        outbound: {",
      '          deliveryMode: "direct",',
      "          sendText: async ({ to, text, accountId, threadId }) => {",
      `            fs.appendFileSync(${JSON.stringify(params.tracePath)}, JSON.stringify({`,
      "              to,",
      "              text,",
      "              accountId: accountId ?? null,",
      "              threadId: threadId ?? null,",
      '            }) + "\\n", "utf8");',
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

const poll = <T>(read: () => T) => expect.poll(read, { timeout: 15_000, interval: 50 });
const transcript = (key: string) => readSessionTranscript(key).then(JSON.stringify);
const readSessionId = (sessionKey: string) =>
  loadSessionEntry({ agentId: "main", sessionKey, readConsistency: "latest" })?.sessionId;

describe("Gateway automation session routing", () => {
  let fixtureSettlement: Promise<void> | undefined;
  // Compile the server before the behavior timeout includes both real starts.
  beforeAll(() => import("../../../../src/gateway/server-start.js"));
  beforeEach(resetGatewayState);
  afterEach(async () => {
    // A timed-out body still owns Gateway shutdown. Join it before outer hooks
    // reset runtime state or remove the fixture's files.
    await fixtureSettlement;
    fixtureSettlement = undefined;
    resetGatewayState();
  });

  it(
    "routes ordinary automations through their persisted session while preserving explicit wake sessions",
    { timeout: 90_000 },
    async ({ signal }) => {
      const tempHome = tempDirs.make("openclaw-gateway-heartbeat-routing-");
      const token = nextId("heartbeat-routing-token");
      const { workspaceDir, configPath, envSnapshot } = await prepareRecoveryHome(
        tempHome,
        token,
        true,
      );
      const pluginDir = path.join(workspaceDir, "plugins", PROOF_CHANNEL_ID);
      const deliveryTracePath = path.join(tempHome, "heartbeat-deliveries.jsonl");
      const cronReadyEvent = nextId("cron-reconciled");
      const cronReconciled = createDeferred<unknown>();
      const onCronReconciled = (event: unknown) => cronReconciled.resolve(event);
      await writeRouteCapturePlugin({ pluginDir, tracePath: deliveryTracePath, cronReadyEvent });

      const configuredSessionKey = "agent:main:ops-heartbeat";
      const configuredSessionId = nextId("configured-heartbeat-session");
      const configuredEvent = nextId("configured-heartbeat-event");
      const configuredPassiveEvent = nextId("configured-passive-event");
      const configuredReply = nextId("configured-heartbeat-reply");
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
          const raw = await readRequestText(request);
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          const body = JSON.parse(raw) as Record<string, unknown>;
          providerRequests.push(body);
          const serialized = JSON.stringify(body);
          writeFixtureReply(
            response,
            serialized.includes(configuredEvent)
              ? configuredReply
              : serialized.includes(explicitQueuedEvent) || serialized.includes(explicitWakeText)
                ? explicitReply
                : nextId("unexpected-heartbeat-reply"),
            nextId("provider-message"),
            nextId("provider-response"),
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
        const providerUrl = await listenLoopback(providerServer);
        const provider = buildMockOpenAiResponsesProvider(
          `${providerUrl}/v1`,
          "gpt-heartbeat-session-routing",
        );
        const config = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
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
          // Full configs may contain nested nulls; automation admission must not reinterpret them as patches.
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
        const automation = await gateway.client.request<CronJob>("cron.add", {
          agentId: "main",
          name: "Session routing proof",
          enabled: true,
          schedule: { kind: "every", everyMs: 86_400_000 },
          sessionTarget: `session:${configuredSessionKey}`,
          wakeMode: "now",
          payload: {
            kind: "agentTurn",
            message: `Process this scheduled task and report what was handled: ${configuredEvent}`,
          },
          delivery: { mode: "announce", channel: "last" },
        });
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
        const queueEvent = async (sessionKey: string, text: string) => {
          await expect(
            client.request("system-event", { text, sessionKey, wake: false }),
          ).resolves.toEqual({ ok: true });
          expect(peekSystemEvents(sessionKey)).toContain(text);
        };

        const seedSession = async (sessionId: string, sessionKey: string, to: string) => {
          await replaceSessionEntry(
            { agentId: "main", sessionKey },
            {
              sessionId,
              updatedAt: Date.now(),
              delivery: normalizeSessionDeliveryState({
                context: { channel: PROOF_CHANNEL_ID, to, accountId: "default" },
              }),
            },
          );
        };
        await seedSession(configuredSessionId, configuredSessionKey, "configured-destination");
        await seedSession(explicitSessionId, explicitSessionKey, "explicit-destination");
        await seedSession(mainSessionId, mainSessionKey, "main-destination");

        await queueEvent(configuredSessionKey, configuredPassiveEvent);

        // A connected Gateway may still be starting cron; its lifecycle hook owns readiness.
        expect(await withinTest(cronReconciled.promise, signal)).toEqual({
          reason: "startup",
          enabled: true,
        });
        const listed = await client.request<{ jobs: CronJob[] }>("cron.list", {
          includeDisabled: true,
        });
        expect(listed.jobs.find((job) => job.id === automation.id)).toMatchObject({
          agentId: "main",
          enabled: true,
          payload: { kind: "agentTurn" },
          sessionTarget: `session:${configuredSessionKey}`,
        });

        const configuredRequestBaseline = providerRequests.length;
        const configuredRun = await client.request<{
          enqueued: boolean;
          ok: boolean;
          runId: string;
        }>("cron.run", {
          id: automation.id,
          mode: "force",
        });
        expect(configuredRun).toMatchObject({
          ok: true,
          enqueued: true,
          runId: expect.any(String),
        });
        await poll(async () => {
          const history = await client.request<{
            entries: Array<{ error?: string; runId?: string; status?: string }>;
          }>("cron.runs", {
            id: automation.id,
            runId: configuredRun.runId,
            limit: 1,
          });
          return history.entries.find((entry) => entry.runId === configuredRun.runId);
        }).toMatchObject({ runId: configuredRun.runId, status: "ok" });
        await poll(() => providerRequests.length).toBeGreaterThan(configuredRequestBaseline);
        const configuredRequest = JSON.stringify(providerRequests[configuredRequestBaseline]);
        expect(configuredRequest).toContain(configuredEvent);
        expect(configuredRequest).not.toContain(configuredPassiveEvent);
        expect(peekSystemEvents(configuredSessionKey)).toContain(configuredPassiveEvent);
        const delivery = (text: string, to: string) => ({
          accountId: "default",
          text,
          threadId: null,
          to,
        });
        const configuredDelivery = delivery(configuredReply, "configured-destination");
        await poll(() => readDeliveryTrace(deliveryTracePath)).toHaveLength(1);
        expect(await readDeliveryTrace(deliveryTracePath)).toEqual([configuredDelivery]);
        await poll(() => transcript(configuredSessionKey)).toContain(configuredReply);
        expect(readSessionId(configuredSessionKey)).toBe(configuredSessionId);
        expect(await transcript(mainSessionKey)).not.toContain(configuredReply);

        await queueEvent(explicitSessionKey, explicitQueuedEvent);
        const explicitRequestBaseline = providerRequests.length;
        await expect(
          client.request<{ ok: boolean }>("wake", {
            mode: "now",
            text: explicitWakeText,
            agentId: "main",
            sessionKey: explicitSessionKey,
          }),
        ).resolves.toEqual({ ok: true });
        await poll(() => providerRequests.length).toBeGreaterThan(explicitRequestBaseline);
        const explicitRequest = JSON.stringify(providerRequests[explicitRequestBaseline]);
        expect(explicitRequest).not.toContain(explicitQueuedEvent);
        expect(explicitRequest).toContain(explicitWakeText);
        await poll(() => peekSystemEvents(explicitSessionKey).includes(explicitWakeText)).toBe(
          false,
        );
        expect(peekSystemEvents(explicitSessionKey)).toContain(explicitQueuedEvent);
        await poll(() => readDeliveryTrace(deliveryTracePath)).toHaveLength(2);
        expect(await readDeliveryTrace(deliveryTracePath)).toEqual([
          configuredDelivery,
          delivery(explicitReply, "explicit-destination"),
        ]);
        await poll(() => transcript(explicitSessionKey)).toContain(explicitReply);
        expect(readSessionId(explicitSessionKey)).toBe(explicitSessionId);
        const explicitTranscript = await transcript(explicitSessionKey);
        expect(explicitTranscript).not.toContain(configuredReply);
        expect(await transcript(configuredSessionKey)).not.toContain(explicitReply);
        const mainTranscript = await transcript(mainSessionKey);
        expect(mainTranscript).not.toContain(configuredReply);
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
          await closeHttpServer(providerServer);
          envSnapshot.restore();
        } finally {
          fixtureSettled.resolve();
        }
      }
    },
  );
});
