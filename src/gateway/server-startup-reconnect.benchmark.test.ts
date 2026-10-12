import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import type { GatewayClient } from "./client.js";
import type { GatewayServer } from "./server-public.js";
import * as rowReads from "./session-row-database-facts.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";

// Manual, two-minute transport measurement; excluded from ordinary test execution.
it.runIf(process.env.OPENCLAW_STARTUP_RECONNECT_BENCH === "1")(
  "measures 20 reconnecting clients over 5,000 sessions for the first 120 seconds",
  { timeout: 240_000 },
  async () => {
    const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    const state = await createOpenClawTestState({
      label: "startup-reconnect-benchmark",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    const token = "startup-reconnect-synthetic-token";
    const clients: GatewayClient[] = [];
    let server: GatewayServer | undefined;
    try {
      await state.writeConfig({
        gateway: {
          auth: { mode: "token", token },
          controlUi: { enabled: false },
          port: claim.port,
        },
        agents: { defaults: { model: "unit-test/model", utilityModel: "" } },
        plugins: { enabled: false },
        discovery: { mdns: { mode: "off" } },
        cron: { enabled: false },
        logging: { level: "silent", consoleLevel: "silent" },
      });
      state.applyEnv();
      runOpenClawAgentWriteTransaction(
        () => {
          for (let index = 0; index < 5_000; index++) {
            replaceSessionEntrySync(
              { agentId: "main", sessionKey: `agent:main:reconnect-${index}` },
              { sessionId: `reconnect-${index}`, updatedAt: index + 1, visibility: "shared" },
            );
          }
        },
        { agentId: "main" },
      );
      const { startGatewayServerCore } = await import("./server-start.js");
      const methods = ["sessions.list", "sessions.messages.subscribe", "cron.list"] as const;
      // Transform-time lazy imports are test-runner work, not SQLite contention.
      const { coreGatewayHandlers } = await import("./server-methods/core-handlers.js");
      const { prepareGatewayRequestHandler } =
        await import("./server-methods/lazy-core-handlers.js");
      await Promise.all(
        methods.map((method) => prepareGatewayRequestHandler(coreGatewayHandlers[method]!)),
      );
      const read = rowReads.withSessionRowDatabaseFacts;
      let slowReads = 0;
      vi.spyOn(rowReads, "withSessionRowDatabaseFacts").mockImplementation(async (...args) => {
        if (args[0].dirty.size > 0) {
          slowReads++;
          await delay(100);
        }
        return read(...args);
      });
      const boot = performance.now();
      server = await startGatewayServerCore(claim.port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      await server.startupSettled;
      const ready = performance.now();
      const samples = Object.fromEntries(
        methods.map((method) => [method, [] as number[]]),
      ) as Record<(typeof methods)[number], number[]>;
      const firstBurst: Record<string, number[]> = {};
      await Promise.all(
        Array.from({ length: 20 }, async (_, index) => {
          const client = await connectGatewayClient({
            url: `ws://127.0.0.1:${claim.port}`,
            token,
            scopes: ["operator.admin"],
            instanceId: `reconnect-${index}`,
            timeoutMs: 30_000,
          });
          clients.push(client);
          let round = 0;
          do {
            await Promise.all(
              methods.map(async (method) => {
                const start = performance.now();
                const result = await client.request(
                  method,
                  method === "sessions.list"
                    ? { limit: 100 }
                    : method === "sessions.messages.subscribe"
                      ? { key: `agent:main:reconnect-${index}` }
                      : {},
                );
                if (method === "sessions.list") {
                  expect(result).toMatchObject({ totalCount: 5_000 });
                } else if (method === "sessions.messages.subscribe") {
                  expect(result).toMatchObject({
                    subscribed: true,
                    key: `agent:main:reconnect-${index}`,
                  });
                } else {
                  expect(result).toMatchObject({ jobs: [] });
                }
                const ms = performance.now() - start;
                samples[method].push(ms);
                if (round === 0) {
                  (firstBurst[method] ??= []).push(ms);
                }
              }),
            );
            round++;
            await delay(2_000);
          } while (performance.now() - ready < 120_000);
        }),
      );
      const summarize = (values: number[]) => {
        const sorted = values.toSorted((a, b) => a - b);
        return {
          count: values.length,
          p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1],
          maxMs: sorted.at(-1),
        };
      };
      console.log(
        JSON.stringify({
          benchmark: "startup-reconnect",
          sessions: 5_000,
          clients: 20,
          slowReads,
          bootMs: ready - boot,
          windowMs: performance.now() - ready,
          samples: Object.fromEntries(
            methods.map((method) => [method, summarize(samples[method])]),
          ),
          firstBurst: Object.fromEntries(
            methods.map((method) => [method, summarize(firstBurst[method]!)]),
          ),
        }),
      );
    } finally {
      await Promise.all(clients.map((client) => client.stopAndWait()));
      await server?.close();
      vi.restoreAllMocks();
      await state.cleanup();
      await claim.release();
    }
  },
);
