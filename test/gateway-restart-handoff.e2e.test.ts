import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { openNodeSqliteDatabase } from "../src/infra/node-sqlite.js";
import { writeGatewayRestartIntentSync } from "../src/infra/restart-intent.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import { startGatewayRestartProvider } from "./helpers/gateway-restart-provider.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { awaitGateBeforeSettlement, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const NATIVE_STOP_MS = 46_000;
const APPLICATION_STOP_MS = 41_000;
const SERVICE_ID = "restart-handoff-pending-service";
const SERVICE_STOP = "RESTART_HANDOFF_SERVICE_STOP_ENTERED";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function journal(logs: string) {
  return logs.split("\n").flatMap((line) => {
    try {
      const row: unknown = JSON.parse(line);
      if (!isRecord(row) || typeof row.time !== "string" || typeof row.message !== "string") {
        return [];
      }
      return [{ message: row.message, path: row.path, at: Date.parse(row.time) }];
    } catch {
      return [];
    }
  });
}

// The real CLI process, model transport, exec subprocesses, and native deadline belong in E2E.
it.skipIf(process.platform !== "linux")(
  "writes a clean restart receipt with six pending runs, two background execs, and unfinished plugin cleanup",
  { timeout: 180_000 },
  async ({ signal }) => {
    const provider = await startGatewayRestartProvider(signal);
    let instance: OpenClawTestInstance | undefined;
    let client: GatewayClient | undefined;
    let nativeDeadline: NodeJS.Timeout | undefined;
    await runQaGatewayFixture(
      async () => {
        const pluginDir = tempDirs.make("restart-handoff-plugin-");
        await writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
            id: SERVICE_ID,
            activation: { onStartup: true },
            configSchema: { type: "object", additionalProperties: false, properties: {} },
          }),
        );
        await writeFile(
          path.join(pluginDir, "index.js"),
          `module.exports = {
          id: ${JSON.stringify(SERVICE_ID)},
          register(api) {
            api.registerService({
              id: ${JSON.stringify(SERVICE_ID)}, start() {},
              stop() {
                api.logger.info(${JSON.stringify(SERVICE_STOP)});
                return new Promise(() => {});
              }
            });
          }
        };\n`,
        );
        const model = buildMockOpenAiResponsesProvider(provider.baseUrl, "gpt-5.6-luna");
        const modelRef = `openai/${model.modelId}`;
        instance = await createOpenClawTestInstance({
          name: "restart-handoff",
          signal,
          startTimeoutMs: 120_000,
          gatewayCommandPrefix: [
            process.execPath,
            "--import",
            fileURLToPath(new URL("./fixtures/gateway-restart-supervisor.mjs", import.meta.url)),
          ],
          config: {
            update: { checkOnStart: false },
            browser: { enabled: false },
            discovery: { mdns: { mode: "off" } },
            logging: { consoleLevel: "debug", consoleStyle: "json" },
            agents: {
              defaults: {
                maxConcurrent: 12,
                timeoutSeconds: 3600,
                heartbeat: { every: "0m" },
                model: { primary: modelRef },
                models: {
                  [modelRef]: {
                    agentRuntime: { id: "openclaw" },
                    params: { transport: "sse", openaiWsWarmup: false },
                  },
                },
              },
            },
            models: {
              mode: "merge",
              providers: {
                openai: {
                  ...model.config,
                  agentRuntime: { id: "openclaw" },
                  request: { allowPrivateNetwork: true },
                },
              },
            },
            plugins: {
              enabled: true,
              load: { paths: [pluginDir] },
              entries: {
                [SERVICE_ID]: { enabled: true },
                browser: { enabled: false },
                "memory-core": { config: { dreaming: { enabled: false } } },
              },
            },
            tools: { codeMode: false, exec: { host: "gateway", security: "full", ask: "off" } },
          },
          env: {
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            VITEST: undefined,
            NODE_ENV: undefined,
            NODE_OPTIONS: undefined,
            OPENCLAW_NO_RESPAWN: "1",
            OPENCLAW_SKIP_PROVIDERS: undefined,
            OPENCLAW_SKIP_CRON: undefined,
            OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
            OPENAI_API_KEY: "synthetic-restart-handoff",
            OPENCLAW_SYSTEMD_UNIT: "restart-handoff.service",
            INVOCATION_ID: randomUUID().replaceAll("-", ""),
            OPENCLAW_TEST_SUPERVISOR_STOP_MS: String(NATIVE_STOP_MS),
          },
        });
        await instance.startGateway();
        expect(
          journal(instance.logs()).some(
            (row) =>
              row.message.includes("shutdown budget at startup:") &&
              row.message.includes("shutdown=41000ms") &&
              row.message.includes("TimeoutStopUSec=46000ms"),
          ),
          instance.logs(),
        ).toBe(true);
        const child = instance.child;
        if (!child) {
          throw new Error("Gateway exited before restart proof");
        }
        const closed = once(child, "close");
        client = await acquireGatewayTestClient(
          {
            url: instance.url,
            token: instance.gatewayToken,
            clientName: "gateway-client",
            mode: "backend",
            clientDisplayName: "restart-handoff-proof",
            clientVersion: "test",
            platform: "linux",
            role: "operator",
            scopes: ["operator.admin", "operator.read", "operator.write"],
            deviceIdentity: loadOrCreateDeviceIdentity({
              path: instance.state.path("client-device.sqlite"),
            }),
          },
          {
            timeoutMs: 30_000,
            timeoutMessage: "restart proof client did not connect",
            closeMessage: "restart proof client closed",
            signal,
          },
        );
        const sessionKeys = Array.from(
          { length: 6 },
          (_, index) => `agent:main:restart-handoff-${index}`,
        );
        for (const key of sessionKeys) {
          await client.request("sessions.create", { agentId: "main", key });
        }
        const connection = client;
        const accepted = await Promise.all(
          sessionKeys.map((sessionKey, index) =>
            connection.request<{ runId: string }>(
              "chat.send",
              {
                sessionKey,
                idempotencyKey: randomUUID(),
                message: `RESTART_HANDOFF_${index}: keep the model request pending.`,
                deliver: false,
              },
              { expectFinal: false },
            ),
          ),
        );
        const runIds = accepted.map((result) => {
          expect(result.runId).toEqual(expect.any(String));
          return result.runId;
        });
        expect(new Set(runIds).size).toBe(6);
        await withinTest(
          awaitGateBeforeSettlement(
            provider.ready,
            closed,
            "Gateway exited before all six model calls and two exec sessions were pending",
          ),
          signal,
        );
        expect(
          writeGatewayRestartIntentSync({
            env: instance.env,
            targetPid: child.pid,
            intent: { reason: "gateway.restart", force: true, waitMs: 1000 },
          }),
        ).toBe(true);
        let exitedAt = Number.POSITIVE_INFINITY;
        child.once("exit", () => {
          exitedAt = Date.now();
        });
        const signaledAt = Date.now();
        // Enforce the emulated native supervisor deadline independently of Gateway's own timer.
        nativeDeadline = setTimeout(() => child.kill("SIGKILL"), NATIVE_STOP_MS);
        expect(child.kill("SIGTERM")).toBe(true);
        await withinTest(closed, signal);
        clearTimeout(nativeDeadline);
        const rows = journal(instance.logs()).filter(
          (row) => row.at >= signaledAt && row.at <= exitedAt,
        );
        const agentPath = path.join(instance.state.agentDir(), "openclaw-agent.sqlite");
        const receipt = rows.find(
          (row) => row.path === agentPath && row.message.includes("clean-close receipt: written"),
        );
        const abort = rows.find((row) =>
          /restart drain budget.*exhausted|aborted for restart/.test(row.message),
        );
        const deadline = rows.find((row) => row.message.includes("shutdown deadline reached"));
        const serviceStop = rows.find((row) => row.message.includes(SERVICE_STOP));
        expect(serviceStop, instance.logs()).toBeDefined();
        expect(receipt, instance.logs()).toBeDefined();
        expect(abort, instance.logs()).toBeDefined();
        expect(
          rows.some(
            (row) =>
              row.message.includes("shutdown budget at shutdown:") &&
              row.message.includes("TimeoutStopUSec=46000ms"),
          ),
          instance.logs(),
        ).toBe(true);
        expect(receipt!.at).toBeGreaterThanOrEqual(abort!.at);
        expect(receipt!.at).toBeLessThan(
          Math.min(signaledAt + APPLICATION_STOP_MS, exitedAt, deadline?.at ?? Infinity),
        );
        expect(
          rows.some((row) => row.message.includes("backgroundExecSessions=2")),
          instance.logs(),
        ).toBe(true);
        expect(
          rows.some((row) => row.message.includes("embeddedRuns=6")),
          instance.logs(),
        ).toBe(true);
        for (const runId of runIds) {
          expect(
            rows.some((row) =>
              row.message.includes(`lease released: reason=restart-abort runId=${runId}`),
            ),
            instance.logs(),
          ).toBe(true);
        }
        const shared = openNodeSqliteDatabase(
          instance.state.statePath("state", "openclaw.sqlite"),
          { readOnly: true },
        );
        const receipts = openNodeSqliteDatabase(
          instance.state.statePath("state", "openclaw-quarantine.sqlite"),
          { readOnly: true },
        );
        try {
          const leases = shared
            .prepare("SELECT lease_id FROM agent_database_leases WHERE path=?")
            .all(agentPath);
          const verification = receipts
            .prepare("SELECT clean_close FROM agent_integrity_verifications WHERE path=?")
            .get(agentPath);
          expect(leases).toEqual([]);
          expect(verification).toEqual({ clean_close: 1 });
          console.info(
            JSON.stringify({
              proof: "gateway-restart-handoff",
              signalAtMs: signaledAt,
              abortAtMs: abort!.at,
              receiptAtMs: receipt!.at,
              exitAtMs: exitedAt,
              receiptAfterSignalMs: receipt!.at - signaledAt,
              receiptAfterAbortMs: receipt!.at - abort!.at,
              exitAfterSignalMs: exitedAt - signaledAt,
              applicationBudgetMs: APPLICATION_STOP_MS,
              pendingServiceStopAtMs: serviceStop!.at,
              acceptedRuns: runIds.length,
              confirmedRunReleases: runIds.length,
              backgroundExecSessions: 2,
              remainingLeases: leases.length,
              cleanClose: verification?.clean_close,
            }),
          );
        } finally {
          shared.close();
          receipts.close();
        }
      },
      () => {
        clearTimeout(nativeDeadline);
      },
      () => client?.stopAndWait({ timeoutMs: 1000 }),
      () => instance?.cleanup(),
      () => provider.close(),
    );
  },
);
