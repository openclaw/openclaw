import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { openNodeSqliteDatabase } from "../src/infra/node-sqlite.js";
import { writeGatewayRestartIntentSync } from "../src/infra/restart-intent.js";
import { readSqliteCleanCloseSeal } from "../src/infra/sqlite-clean-close-seal.js";
import { sqliteDatabaseSealSchemaFor } from "../src/state/openclaw-database-seal-schema.js";
import { writeRestartPlugin, connectRestartClient } from "./gateway-restart.test-support.js";
import {
  GATEWAY_RESTART_TEST_KILL_MS,
  GATEWAY_RESTART_TEST_SHUTDOWN_MS as APPLICATION_STOP_MS,
  GATEWAY_RESTART_TEST_STOP_MS as NATIVE_STOP_MS,
} from "./helpers/gateway-restart-budget.js";
import { startGatewayRestartProvider } from "./helpers/gateway-restart-provider.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { awaitGateBeforeSettlement, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

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
      return [{ message: row.message, path: row.path, check: row.check, at: Date.parse(row.time) }];
    } catch {
      return [];
    }
  });
}

// The real CLI process, model transport, exec subprocesses, and native deadline belong in E2E.
it.skipIf(process.platform !== "linux")(
  "hands off within five seconds of its clean-close receipt after plugin cleanup",
  { timeout: 180_000 },
  async ({ signal }) => {
    const beforeExit = <T>(pending: Promise<T>, closed: Promise<unknown>, message: string) =>
      withinTest(awaitGateBeforeSettlement(pending, closed, message), signal);
    const provider = await startGatewayRestartProvider(signal);
    let instance: OpenClawTestInstance | undefined;
    let client: GatewayClient | undefined;
    let nativeDeadline: NodeJS.Timeout | undefined;
    await runQaGatewayFixture(
      async () => {
        const pluginDir = tempDirs.make("restart-handoff-plugin-");
        await writeRestartPlugin(
          pluginDir,
          {
            id: SERVICE_ID,
            activation: { onStartup: true },
            configSchema: { type: "object", additionalProperties: false, properties: {} },
          },
          `module.exports = {
          id: ${JSON.stringify(SERVICE_ID)},
          register(api) {
            api.registerService({
              id: ${JSON.stringify(SERVICE_ID)}, start() {},
              stop() { api.logger.info(${JSON.stringify(SERVICE_STOP)}); }
            });
          }
        };\n`,
          "index.js",
        );
        const model = buildMockOpenAiResponsesProvider(provider.baseUrl, "gpt-5.6-luna");
        const modelRef = `openai/${model.modelId}`;
        instance = await createOpenClawTestInstance({
          name: "restart-handoff",
          signal,
          startTimeoutMs: 120_000,
          gracefulShutdownTimeoutMs: GATEWAY_RESTART_TEST_KILL_MS,
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
        const child = expectDefined(instance.child, "Gateway process before restart proof");
        const closed = once(child, "close");
        const gateway = instance;
        const sessionKeys = Array.from(
          { length: 6 },
          (_, index) => `agent:main:restart-handoff-${index}`,
        );
        const connect = () =>
          connectRestartClient(
            gateway,
            {
              mode: "backend",
              clientDisplayName: "restart-handoff-proof",
              clientVersion: "test",
              platform: "linux",
              role: "operator",
              deviceIdentity: loadOrCreateDeviceIdentity({
                path: gateway.state.path("client-device", "client", "credentials.sqlite"),
              }),
            },
            signal,
          );
        client = await connect();
        for (const key of sessionKeys) {
          await client.request("sessions.create", { agentId: "main", key });
        }
        const connection = client;
        const runIds = await Promise.all(
          sessionKeys.map(async (sessionKey, index) => {
            const { runId } = await connection.request<{ runId: string }>(
              "chat.send",
              {
                sessionKey,
                idempotencyKey: randomUUID(),
                message: `RESTART_HANDOFF_${index}: keep the model request pending.`,
                deliver: false,
              },
              { expectFinal: false },
            );
            expect(runId).toEqual(expect.any(String));
            return runId;
          }),
        );
        expect(new Set(runIds).size).toBe(6);
        await beforeExit(
          provider.ready,
          closed,
          "Gateway exited before all six model calls and two exec sessions were pending",
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
        const exit = await withinTest(closed, signal);
        clearTimeout(nativeDeadline);
        const rows = journal(instance.logs()).filter(
          (row) => row.at >= signaledAt && row.at <= exitedAt,
        );
        const agentPath = path.join(instance.state.agentDir(), "openclaw-agent.sqlite");
        // stdout and stderr are captured separately; accepted writes can also
        // reopen an idle-closed database and invalidate an earlier receipt.
        const cleanReceipts = rows
          .filter(
            (row) => row.path === agentPath && row.message.includes("clean-close receipt: written"),
          )
          .toSorted((left, right) => left.at - right.at);
        const receipt = cleanReceipts.at(-1);
        const deadline = rows.find((row) => row.message.includes("shutdown deadline reached"));
        const serviceStop = rows.find((row) => row.message.includes(SERVICE_STOP));
        expect(exit, instance.logs()).toEqual([0, null]);
        expect(receipt, instance.logs()).toBeDefined();
        expect(receipt!.at).toBeGreaterThanOrEqual(signaledAt);
        expect(receipt!.at).toBeLessThan(
          Math.min(signaledAt + APPLICATION_STOP_MS, exitedAt, deadline?.at ?? Infinity),
        );
        expect(exitedAt - receipt!.at, instance.logs()).toBeLessThanOrEqual(5_000);
        expect(deadline, instance.logs()).toBeUndefined();
        expect(serviceStop, instance.logs()).toBeDefined();
        expect(serviceStop!.at).toBeLessThanOrEqual(exitedAt);
        // The Gateway and test runner use the same runtime and storage policy.
        const artifactSchema = sqliteDatabaseSealSchemaFor("agent")?.schemaIdentity;
        const seal = readSqliteCleanCloseSeal(agentPath, statSync(agentPath, { bigint: true }));
        expect(seal).toMatchObject({ schemaIdentity: artifactSchema });
        const shared = openNodeSqliteDatabase(
          instance.state.statePath("state", "openclaw.sqlite"),
          { readOnly: true },
        );
        const agent = openNodeSqliteDatabase(agentPath, { readOnly: true });
        try {
          const leases = shared
            .prepare("SELECT lease_id FROM agent_database_leases WHERE path=?")
            .all(agentPath);
          const boot = shared
            .prepare(
              "SELECT outcome, completed_at_ms FROM gateway_boot_lifecycle WHERE pid=? ORDER BY started_at_ms DESC LIMIT 1",
            )
            .get(child.pid!);
          expect(leases).toEqual([]);
          expect(boot).toEqual({
            outcome: "planned_restart",
            completed_at_ms: expect.any(Number),
          });
          expect(boot?.completed_at_ms).toBeGreaterThanOrEqual(signaledAt);
          expect(boot?.completed_at_ms).toBeLessThanOrEqual(exitedAt);
          for (const sessionKey of sessionKeys) {
            const row = agent
              .prepare(
                "SELECT current_session_id, entry_json FROM session_nodes WHERE session_key=?",
              )
              .get(sessionKey);
            if (typeof row?.entry_json !== "string" || typeof row.current_session_id !== "string") {
              throw new Error(`Restart lost persisted session ${sessionKey}`);
            }
            const entry: unknown = JSON.parse(row.entry_json);
            expect(entry).toMatchObject({ resumeAfterRestart: { queuedInputIds: [] } });
          }
        } finally {
          shared.close();
          agent.close();
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
