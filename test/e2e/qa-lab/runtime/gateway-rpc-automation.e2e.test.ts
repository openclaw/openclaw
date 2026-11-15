import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { withFastReplyConfig } from "../../../../src/auto-reply/reply/get-reply-fast-path.test-support.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
} from "../../../../src/config/config.js";
import { resetConfigOverrides } from "../../../../src/config/runtime-overrides.js";
import { clearSessionStoreCacheForTest } from "../../../../src/config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../../../../src/gateway/test-openai-responses-model.js";
import { resetAgentEventsForTest } from "../../../../src/infra/agent-events.js";
import { resetSystemEventsForTest } from "../../../../src/infra/system-events.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../../../src/test-utils/env.js";
import { createDeferred } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  isolatedGatewayEnv,
  listenLoopback,
  writeFixtureReply,
} from "./gateway-recovery.test-support.js";

let sequence = 0;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type CronJob = { id: string; name: string; enabled: boolean };

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
  writeFixtureReply(response, text, nextId("provider-message"), nextId("provider-response"));
}

beforeEach(resetGatewayState);
afterEach(resetGatewayState);

it(
  "persists cron jobs, wakes ordinary session work, and aborts runs",
  { timeout: 90_000 },
  async () => {
    const tempHome = tempDirs.make("openclaw-gateway-automation-");
    const stateDir = path.join(tempHome, ".openclaw");
    const workspaceDir = path.join(tempHome, "workspace");
    const bundledPluginsDir = path.join(tempHome, "empty-bundled-plugins");
    const configPath = path.join(stateDir, "openclaw.json");
    await Promise.all([
      fs.mkdir(workspaceDir, { recursive: true }),
      fs.mkdir(bundledPluginsDir, { recursive: true }),
      fs.mkdir(path.dirname(configPath), { recursive: true }),
    ]);

    const token = nextId("gateway-automation-token");
    const envPatch = {
      ...isolatedGatewayEnv,
      HOME: tempHome,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_SKIP_CRON: "0",
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_GATEWAY_URL: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    };
    const envSnapshot = captureEnv([
      ...Object.keys(envPatch),
      "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN",
      "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN",
    ]);
    for (const [key, value] of Object.entries(envPatch)) {
      if (value === undefined) {
        deleteTestEnvValue(key);
      } else {
        setTestEnvValue(key, value);
      }
    }

    const taskPrompt = nextId("create-tracked-task");
    const wakeText = nextId("wake-session");
    const providerRequests: Array<Record<string, unknown>> = [];
    const taskResponseGate = createDeferred();
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
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        providerRequests.push(body);
        const serialized = JSON.stringify(body);
        if (providerRequests.length === 1 && serialized.includes(taskPrompt)) {
          await taskResponseGate.promise;
          writeAssistantResponse(response, "Tracked task completed.");
          return;
        }
        writeAssistantResponse(response, `Wake handled: ${wakeText}`);
      })().catch((error: unknown) => {
        response.writeHead(500).end(error instanceof Error ? error.message : String(error));
      });
    });

    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      const providerUrl = await listenLoopback(providerServer, "mock provider did not bind");
      const provider = buildMockOpenAiResponsesProvider(
        `${providerUrl}/v1`,
        "gpt-gateway-automation",
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
        gateway: { auth: { mode: "token", token } },
        plugins: { slots: { memory: "none" } },
      } satisfies OpenClawConfig;

      gateway = await startGatewayWithClient({
        cfg: config,
        configPath,
        token,
        clientDisplayName: "vitest-gateway-rpc-automation",
      });
      const runtimeConfig = getRuntimeConfigSnapshot();
      if (!runtimeConfig) {
        throw new Error("gateway runtime config snapshot was not initialized");
      }
      withFastReplyConfig(runtimeConfig);
      const client = gateway.client;

      const added = await client.request<CronJob>("cron.add", {
        name: "automation",
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "Future automation evidence" },
      });
      expect(added).toMatchObject({ name: "automation" });

      const read = await client.request<CronJob>("cron.get", { id: added.id });
      expect(read).toMatchObject({ id: added.id, name: "automation" });

      const listJobs = () =>
        client.request<{ jobs: CronJob[] }>("cron.list", { includeDisabled: true });
      const listed = await listJobs();
      expect(listed.jobs).toContainEqual(
        expect.objectContaining({ id: added.id, name: added.name, enabled: true }),
      );

      const patch = { name: "updated", enabled: false };
      const updatedJob = { id: added.id, ...patch };
      await expect(client.request("cron.update", { id: added.id, patch })).resolves.toMatchObject(
        updatedJob,
      );

      const listedAfterUpdate = await listJobs();
      expect(listedAfterUpdate.jobs).toContainEqual(expect.objectContaining(updatedJob));

      const removed = await client.request<{ removed: boolean }>("cron.remove", { id: added.id });
      expect(removed.removed).toBe(true);
      const listedAfterRemove = await listJobs();
      expect(listedAfterRemove.jobs).not.toContainEqual(expect.objectContaining({ id: added.id }));

      const sessionKey = "agent:main:main";
      const runId = nextId("gateway-automation-agent");
      const started = await client.request<{ runId: string; status: string }>(
        "agent",
        {
          sessionKey,
          message: taskPrompt,
          deliver: false,
          idempotencyKey: runId,
        },
        { expectFinal: false },
      );
      expect(started).toMatchObject({ runId, status: "accepted" });

      await expect
        .poll(() => providerRequests.some((body) => JSON.stringify(body).includes(taskPrompt)), {
          timeout: 10_000,
          interval: 50,
        })
        .toBe(true);
      await expect(client.request("chat.abort", { sessionKey, runId })).resolves.toMatchObject({
        aborted: true,
        runIds: [runId],
      });
      taskResponseGate.resolve();
      const agentWait = await client.request<{ status: string; error?: string }>(
        "agent.wait",
        { runId: started.runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      );
      expect(agentWait).toMatchObject({ status: "error", stopReason: "rpc" });
      const requestsBeforeWake = providerRequests.length;
      await expect(
        client.request<{ ok: boolean }>("wake", {
          mode: "now",
          text: wakeText,
          sessionKey,
          agentId: "main",
        }),
      ).resolves.toEqual({ ok: true });
      await expect
        .poll(() => providerRequests.length, { timeout: 15_000, interval: 50 })
        .toBeGreaterThan(requestsBeforeWake);
      await expect
        .poll(async () => JSON.stringify(await client.request("chat.history", { sessionKey })), {
          timeout: 15_000,
          interval: 50,
        })
        .toContain(`Wake handled: ${wakeText}`);
      expect(JSON.stringify(providerRequests[requestsBeforeWake])).toContain(wakeText);
    } finally {
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "Gateway RPC automation test complete" });
      }
      taskResponseGate.resolve();
      providerServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        providerServer.close(() => resolve());
      });
      envSnapshot.restore();
    }
  },
);
