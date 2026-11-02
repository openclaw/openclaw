import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { PluginHookRunStoppedHandler } from "../../plugins/hook-run-stopped.types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { closeProvider, listenProvider } from "../gateway-provider-fixture.test-support.js";
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
const PLUGIN_ID = "run-stopped-observer";
const EVENTS_KEY = "openclaw.test.runStoppedEvents";
const TOKEN = "run-stopped-proof-token";

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-run-stopped-proof-");

type RecordedEvent = Parameters<PluginHookRunStoppedHandler>[0] & {
  ctx: Parameters<PluginHookRunStoppedHandler>[1];
};

function recordedEvents(): RecordedEvent[] {
  const store = globalThis as Record<PropertyKey, unknown>;
  return (store[Symbol.for(EVENTS_KEY)] as RecordedEvent[] | undefined) ?? [];
}

it(
  "fires run_stopped once per explicit Gateway Stop and never for a timeout",
  { timeout: 120_000 },
  async () => {
    const tempHome = tempDirs.make();
    const stateDir = path.join(tempHome, ".openclaw");
    const workspaceDir = path.join(tempHome, "workspace");
    const configPath = path.join(stateDir, "openclaw.json");
    const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
    const pluginDir = path.join(tempHome, PLUGIN_ID);
    const env = {
      HOME: tempHome,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: TOKEN,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      ...Object.fromEntries(disabledServices.map((key) => [key, "1"])),
    };
    const envSnapshot = captureEnv(Object.keys(env));
    // The provider holds every response open, so only a Stop or the run timeout ends a turn.
    const openResponses: ServerResponse[] = [];
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
        request.resume();
        openResponses.push(response);
      });
      const provider = buildMockOpenAiResponsesProvider(await listenProvider(providerServer));
      await Promise.all([
        fs.writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          `${JSON.stringify({
            id: PLUGIN_ID,
            activation: { onStartup: true },
            configSchema: { type: "object", additionalProperties: false, properties: {} },
          })}\n`,
        ),
        fs.writeFile(
          path.join(pluginDir, "index.mjs"),
          [
            "export default {",
            `  id: ${JSON.stringify(PLUGIN_ID)},`,
            "  register(api) {",
            '    api.on("run_stopped", (event, ctx) => {',
            `      const key = Symbol.for(${JSON.stringify(EVENTS_KEY)});`,
            "      (globalThis[key] ??= []).push(structuredClone({ ...event, ctx }));",
            "    });",
            "  },",
            "};",
            "",
          ].join("\n"),
        ),
      ]);

      gateway = await startGatewayWithClient({
        cfg: {
          plugins: {
            allow: [PLUGIN_ID],
            load: { paths: [pluginDir] },
            entries: { [PLUGIN_ID]: { enabled: true } },
            slots: { memory: "none" },
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
          gateway: { auth: { mode: "token", token: TOKEN } },
        },
        configPath,
        token: TOKEN,
      });
      const client = gateway.client;

      const startHeldRun = async (sessionKey: string, extra: Record<string, unknown> = {}) => {
        const requestsBefore = openResponses.length;
        const started = await client.request<{ runId?: string; status?: string }>("chat.send", {
          sessionKey,
          message: "Wait for the Stop.",
          deliver: false,
          idempotencyKey: `${sessionKey}:run`,
          ...extra,
        });
        expect(started.status).toBe("started");
        await vi.waitFor(() => expect(openResponses.length).toBeGreaterThan(requestsBefore), {
          timeout: 30_000,
        });
        return started.runId!;
      };
      const waitForTerminal = (runId: string) =>
        client.request<{ status?: string }>(
          "agent.wait",
          { runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        );
      const eventsFor = (sessionKey: string) =>
        recordedEvents().filter((event) =>
          event.sessions.some((session) => session.sessionKey === sessionKey),
        );

      // Exact-run Stop from a Gateway client (Control UI and native apps send the runId).
      const exactKey = "agent:main:run-stopped-exact";
      const exactRun = await startHeldRun(exactKey);
      await expect(
        client.request("chat.abort", { sessionKey: exactKey, runId: exactRun }),
      ).resolves.toMatchObject({ aborted: true, runIds: [exactRun] });
      await waitForTerminal(exactRun);
      expect(eventsFor(exactKey)).toEqual([
        {
          source: "client",
          sessions: [{ agentId: "main", sessionKey: exactKey }],
          runIds: [exactRun],
          ctx: { agentId: "main", sessionKey: exactKey },
        },
      ]);

      // Session Stop from a Gateway client.
      const sessionKey = "agent:main:run-stopped-session";
      const sessionRun = await startHeldRun(sessionKey);
      await expect(client.request("chat.abort", { sessionKey })).resolves.toMatchObject({
        aborted: true,
        runIds: [sessionRun],
      });
      await waitForTerminal(sessionRun);
      expect(eventsFor(sessionKey)).toEqual([
        {
          source: "client",
          sessions: [{ agentId: "main", sessionKey }],
          runIds: [sessionRun],
          ctx: { agentId: "main", sessionKey },
        },
      ]);

      // A typed "/stop" is a channel-user Stop.
      const commandKey = "agent:main:run-stopped-command";
      const commandRun = await startHeldRun(commandKey);
      await client.request("chat.send", {
        sessionKey: commandKey,
        message: "/stop",
        deliver: false,
        idempotencyKey: `${commandKey}:stop`,
      });
      await waitForTerminal(commandRun);
      expect(eventsFor(commandKey)).toEqual([
        {
          source: "channel",
          sessions: [{ agentId: "main", sessionKey: commandKey }],
          runIds: [commandRun],
          ctx: { agentId: "main", sessionKey: commandKey },
        },
      ]);

      // A run timeout is not a user Stop.
      const timeoutKey = "agent:main:run-stopped-timeout";
      const timeoutRun = await startHeldRun(timeoutKey, { timeoutMs: 1_500 });
      expect((await waitForTerminal(timeoutRun)).status).not.toBe("ok");
      expect(eventsFor(timeoutKey)).toEqual([]);
      expect(recordedEvents()).toHaveLength(3);
    } finally {
      for (const response of openResponses) {
        response.destroy();
      }
      if (gateway) {
        await disconnectGatewayClient(gateway.client).catch(() => undefined);
        await gateway.server.close().catch(() => undefined);
      }
      if (providerServer?.listening) {
        await closeProvider(providerServer);
      }
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      envSnapshot.restore();
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      clearSessionStoreCacheForTest();
      delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(EVENTS_KEY)];
    }
  },
);
