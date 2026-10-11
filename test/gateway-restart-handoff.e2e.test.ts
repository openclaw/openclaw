import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
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
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "./helpers/promise.js";
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
      return [{ message: row.message, path: row.path, check: row.check, at: Date.parse(row.time) }];
    } catch {
      return [];
    }
  });
}

// The real CLI process, model transport, exec subprocesses, and native deadline belong in E2E.
it.skipIf(process.platform !== "linux")(
  "hands six pending runs and two background execs to a fresh Gateway within five seconds of its receipt despite unfinished plugin cleanup",
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
        const gateway = instance;
        const connect = () =>
          acquireGatewayTestClient(
            {
              url: gateway.url,
              token: gateway.gatewayToken,
              clientName: "gateway-client",
              mode: "backend",
              clientDisplayName: "restart-handoff-proof",
              clientVersion: "test",
              platform: "linux",
              role: "operator",
              scopes: ["operator.admin", "operator.read", "operator.write"],
              deviceIdentity: loadOrCreateDeviceIdentity({
                path: gateway.state.path("client-device.sqlite"),
              }),
            },
            {
              timeoutMs: 30_000,
              timeoutMessage: "restart proof client did not connect",
              closeMessage: "restart proof client closed",
              signal,
            },
          );
        client = await connect();
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
        const firstReceipt = cleanReceipts[0];
        const abort = rows.find((row) =>
          /restart drain budget.*exhausted|aborted for restart/.test(row.message),
        );
        const deadline = rows.find((row) => row.message.includes("shutdown deadline reached"));
        const serviceStop = rows.find((row) => row.message.includes(SERVICE_STOP));
        console.info(
          JSON.stringify({
            proof: "gateway-restart-handoff",
            signalAtMs: signaledAt,
            abortAtMs: abort?.at,
            receiptAtMs: receipt?.at,
            firstReceiptAtMs: firstReceipt?.at,
            receiptCount: cleanReceipts.length,
            exitAtMs: exitedAt,
            receiptAfterSignalMs: receipt ? receipt.at - signaledAt : null,
            receiptAfterAbortMs: receipt && abort ? receipt.at - abort.at : null,
            exitAfterSignalMs: exitedAt - signaledAt,
            exitAfterReceiptMs: receipt ? exitedAt - receipt.at : null,
            exitAfterFirstReceiptMs: firstReceipt ? exitedAt - firstReceipt.at : null,
            applicationBudgetMs: APPLICATION_STOP_MS,
            shutdownDeadlineAtMs: deadline?.at,
            pendingServiceStopAtMs: serviceStop?.at,
            acceptedRuns: runIds.length,
            confirmedRunReleases: runIds.filter((runId) =>
              rows.some((row) =>
                row.message.includes(`lease released: reason=restart-abort runId=${runId}`),
              ),
            ).length,
            backgroundExecSessions: 2,
            exitCode: exit[0],
            exitSignal: exit[1],
          }),
        );
        expect(exit, instance.logs()).toEqual([0, null]);
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
        expect(exitedAt - receipt!.at, instance.logs()).toBeLessThanOrEqual(5_000);
        expect(deadline, instance.logs()).toBeUndefined();
        expect(serviceStop, instance.logs()).toBeUndefined();
        const shared = openNodeSqliteDatabase(
          instance.state.statePath("state", "openclaw.sqlite"),
          { readOnly: true },
        );
        const receipts = openNodeSqliteDatabase(
          instance.state.statePath("state", "openclaw-quarantine.sqlite"),
          { readOnly: true },
        );
        const agent = openNodeSqliteDatabase(agentPath, { readOnly: true });
        const persistedSessions = new Map<string, string>();
        try {
          const leases = shared
            .prepare("SELECT lease_id FROM agent_database_leases WHERE path=?")
            .all(agentPath);
          const verification = receipts
            .prepare("SELECT clean_close FROM agent_integrity_verifications WHERE path=?")
            .get(agentPath);
          const boot = shared
            .prepare(
              "SELECT outcome, completed_at_ms FROM gateway_boot_lifecycle WHERE pid=? ORDER BY started_at_ms DESC LIMIT 1",
            )
            .get(child.pid!);
          expect(leases).toEqual([]);
          expect(verification).toEqual({ clean_close: 1 });
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
            expect(entry).toMatchObject({
              status: "interrupted",
              abortedLastRun: true,
              mainRestartRecovery: {
                cycleId: expect.any(String),
                revision: expect.any(Number),
              },
            });
            persistedSessions.set(sessionKey, row.current_session_id);
          }
          console.info(
            JSON.stringify({
              proof: "gateway-restart-handoff-state",
              bootOutcome: boot?.outcome,
              bootCompletedAtMs: boot?.completed_at_ms,
              remainingLeases: leases.length,
              cleanClose: verification?.clean_close,
              persistedRecoverySessions: persistedSessions.size,
            }),
          );
        } finally {
          shared.close();
          receipts.close();
          agent.close();
        }
        await client.stopAndWait({ timeoutMs: 1000 });
        client = undefined;
        const successorStartedAt = Date.now();
        await instance.startGateway();
        const successorReadyAt = Date.now();
        const successor = instance.child;
        if (!successor) {
          throw new Error("Successor exited before restart admission proof");
        }
        expect(successor.pid).not.toBe(child.pid);
        const successorClosed = once(successor, "close");
        const verified = createDeferred();
        const observeVerification = () => {
          if (
            journal(gateway.logs()).some(
              (row) =>
                row.at >= successorStartedAt &&
                row.path === agentPath &&
                row.check === "quick" &&
                row.message.includes("database integrity verification passed"),
            )
          ) {
            verified.resolve();
          }
        };
        successor.stdout.on("data", observeVerification);
        successor.stderr.on("data", observeVerification);
        try {
          observeVerification();
          await withinTest(
            awaitGateBeforeSettlement(
              verified.promise,
              successorClosed,
              "Successor exited before verifying its reused clean-close receipt",
            ),
            signal,
          );
        } finally {
          successor.stdout.off("data", observeVerification);
          successor.stderr.off("data", observeVerification);
        }
        client = await connect();
        const restored = await client.request<SessionsListResult>("sessions.list", {
          agentId: "main",
        });
        for (const [index, sessionKey] of sessionKeys.entries()) {
          expect(restored.sessions.find((row) => row.key === sessionKey)).toMatchObject({
            sessionId: persistedSessions.get(sessionKey),
          });
          const history = await client.request<{
            messages: Array<{ role: string; content?: unknown }>;
          }>("chat.history", { sessionKey });
          expect(
            history.messages.filter(
              (message) =>
                message.role === "user" &&
                JSON.stringify(message.content)?.includes(`RESTART_HANDOFF_${index}:`),
            ),
          ).toHaveLength(1);
        }
        console.info(
          JSON.stringify({
            proof: "gateway-restart-handoff-successor",
            receiptAdmission: "quick-check-passed",
            successorReadyAfterExitMs: successorReadyAt - exitedAt,
            preservedSessions: persistedSessions.size,
            preservedUserTurns: sessionKeys.length,
          }),
        );
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
