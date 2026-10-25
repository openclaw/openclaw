import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { installDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { acquireGatewayLock, readActiveGatewayLockIdentity } from "../infra/gateway-lock.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { writeRestartSentinel } from "../infra/restart-sentinel.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { prepareManagedHandoffLeaseDatabaseIdentity } from "../infra/update-managed-service-handoff-database.js";
import {
  prepareManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "../infra/update-managed-service-handoff-lease.js";
import type { ManagedHandoffSentinelRequest } from "../infra/update-managed-service-handoff-sentinel.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { startGatewayServer } from "./server.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";
import { acquireGatewayE2ePortBlock, startClaimedGateway } from "./test-helpers.listener.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection =
  typeof configured === "string" ? configured : process.env.OPENCLAW_HANDOFF_TEST_CONNECTION;
const runtimeUrl = resolveRuntimeWorkerUrl({
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "../infra/update-managed-service-handoff-sentinel",
  distWorkerPath: "infra/update-managed-service-handoff-sentinel.js",
});

describe.skipIf(!connection)("managed handoff successor socket on PostgreSQL", () => {
  it("discovers the live successor and records through its authenticated socket from a fresh child", async () => {
    const state = await createOpenClawTestState({
      label: "handoff-successor-socket",
      env: {
        ...KERNEL_TEST_ENV,
        OPENCLAW_HANDOFF_TEST_CONNECTION: connection,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    state.envVars.TMPDIR = state.root;
    state.env.TMPDIR = state.root;
    state.applyEnv();
    const client = new Client({ connectionString: connection });
    let namespace: string | undefined;
    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    let lock: Awaited<ReturnType<typeof acquireGatewayLock>> = null;
    let claim: Awaited<ReturnType<typeof acquireGatewayE2ePortBlock>> | undefined;
    try {
      await client.connect();
      const config = {
        database: {
          engine: "sqlite" as const,
          families: { state: { engine: "postgres" as const } },
          postgres: {
            connection: {
              source: "env" as const,
              provider: "default",
              id: "OPENCLAW_HANDOFF_TEST_CONNECTION",
            },
            schemaPrefix: "handoff_socket",
          },
        },
        gateway: {
          mode: "local" as const,
          bind: "loopback" as const,
          auth: { mode: "token" as const, token: "handoff-socket-synthetic-token" },
          controlUi: { enabled: false },
        },
        agents: { defaults: { workspace: state.workspaceDir } },
        plugins: { enabled: false },
        skills: { load: { watch: false } },
        logging: { level: "silent" as const, consoleLevel: "silent" as const },
        meta: { migrations: { webhookListeners: true } },
      };
      await state.writeConfig(config);
      installDatabaseEngineSelection({
        effectiveEngines: resolveDatabaseFamilyEngines(config),
        postgres: { connection: connection!, schemaPrefix: "handoff_socket" },
      });
      claim = await acquireGatewayE2ePortBlock();
      const port = claim.port;
      lock = await acquireGatewayLock({
        env: state.env,
        port,
        listenerMode: "foreground",
        allowInTests: true,
      });
      if (!lock) {
        throw new Error("Successor Gateway lock was not acquired");
      }
      server = await startClaimedGateway(claim, () =>
        startGatewayServer(port, {
          gatewayStateOwner: lock!,
          bind: "loopback",
          controlUiEnabled: false,
        }),
      );
      await server.startupSettled;
      expect(
        await readActiveGatewayLockIdentity({ env: state.env, requireInspection: true }),
      ).toMatchObject({
        pid: process.pid,
        port,
      });
      {
        using anchor = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(state.env), {
          readOnly: true,
        });
        const row = anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get();
        if (typeof row?.schema !== "string") {
          throw new Error("Missing PostgreSQL anchor");
        }
        namespace = row.schema;
      }
      const installRoot = state.path("install");
      await fs.mkdir(installRoot);
      const leaseDatabasePath = resolveManagedUpdateLeaseDatabasePath();
      const store = await prepareManagedHandoffLeaseStore({
        databasePath: leaseDatabasePath,
        serviceManagerEnv: state.env,
      });
      const acquired = store.acquire(installRoot, "socket-handoff", { kind: "update" });
      if (acquired.kind !== "acquired") {
        throw new Error("Fixture handoff lease was not acquired");
      }
      let lease = acquired.lease;
      try {
        const identity = { handoffId: lease.owner, runId: "socket-run", root: installRoot };
        const initial = await writeRestartSentinel(
          {
            kind: "update",
            status: "error",
            ts: 123,
            stats: { ...identity, reason: "candidate-doctor-failed" },
          },
          state.env,
        );
        const request: ManagedHandoffSentinelRequest = {
          operation: { kind: "inspect", input: identity },
          databaseIdentity: await prepareManagedHandoffLeaseDatabaseIdentity(leaseDatabasePath),
          helper: lease.helper,
        };
        const transferPath = state.path("handoff-request.json");
        await fs.writeFile(
          transferPath,
          JSON.stringify({
            request,
            outcome: {
              ...identity,
              completedStatus: "error",
              restored: true,
              fallbackPayload: initial.payload,
              reason: "managed-service-handoff-failed",
              triageHint: "Run openclaw update repair",
              serviceKind: "foreground",
              handoffFailure: "candidate failed",
            },
          }),
          { mode: 0o600 },
        );
        const shimPath = state.path("handoff-child.mjs");
        await fs.writeFile(
          shimPath,
          `
          import { readFileSync } from "node:fs";
          const { register } = await import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)});
          register({ tsconfig: ${JSON.stringify(path.resolve("tsconfig.json"))} });
          await new Promise((resolve) => process.on("message", function ready(message) {
            if (message === "handoff-bound") { process.off("message", ready); resolve(); }
          }));
          try {
            const { executeInstalledHandoffSentinelOperation } = await import(${JSON.stringify(runtimeUrl.href)});
            const { request, outcome } = JSON.parse(readFileSync(process.argv[2], "utf8"));
            const inspected = await executeInstalledHandoffSentinelOperation(request);
            const recorded = await executeInstalledHandoffSentinelOperation({ ...request, operation: {
              kind: "record", input: { ...outcome, expectedRevision: inspected.revision },
            } });
            process.stdout.write(JSON.stringify({ inspected, recorded }));
          } catch {
            process.stderr.write("Successor sentinel route failed");
            process.exitCode = 1;
          } finally { process.disconnect(); }
        `,
          { mode: 0o600 },
        );
        const argv = [shimPath, transferPath];
        const output = { stdout: "", stderr: "" };
        const exitCode = await runManagedCommand({
          bin: process.execPath,
          args: argv,
          cwd: state.root,
          env: state.env,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          timeoutMs: 30_000,
          onReady(child) {
            for (const key of ["stdout", "stderr"] as const) {
              child[key]?.setEncoding("utf8").on("data", (chunk) => {
                output[key] += chunk;
              });
            }
            const bound =
              child.pid && store.bind(lease, child.pid, lease.action, [process.execPath, ...argv]);
            if (!bound || !child.send) {
              throw new Error("Fixture could not bind the handoff child");
            }
            lease = bound;
            child.send("handoff-bound");
          },
        });
        expect({ exitCode, stderr: output.stderr }).toEqual({ exitCode: 0, stderr: "" });
        const { inspected, recorded } = JSON.parse(output.stdout);
        expect(inspected.revision).toBe(initial.revision);
        expect(recorded.kind).toBe("recorded");
        expect(recorded.sentinel.payload.stats).toMatchObject({
          reason: "candidate-doctor-failed",
          steps: [{ name: "service-restore", command: "foreground", log: { exitCode: 0 } }],
        });
        const persisted = await client.query(
          `SELECT doctor_hint FROM "${namespace}".gateway_restart_sentinel WHERE sentinel_key = 'current'`,
        );
        expect(persisted.rows).toEqual([{ doctor_hint: "Run openclaw update repair" }]);
        for (const text of [
          await fs.readFile(transferPath, "utf8"),
          await fs.readFile(shimPath, "utf8"),
          JSON.stringify(argv),
          ...Object.values(output),
        ]) {
          expect(text).not.toContain(connection);
          expect(text).not.toMatch(/postgres(?:ql)?:\/\//);
        }
      } finally {
        store.release(lease);
      }
    } finally {
      await server?.close({ reason: "managed handoff socket proof complete" });
      await lock?.release();
      await claim?.release();
      await closeStateDatabaseForTest();
      if (namespace) {
        await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
      }
      await client.end();
      await state.cleanup();
      resetDatabaseEngineSelectionForTest();
    }
  }, 90_000);
});
