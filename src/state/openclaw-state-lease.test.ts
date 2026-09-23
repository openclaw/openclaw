import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { stateNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";
import { AGENT_DATABASE_MAINTENANCE_LEASE } from "./openclaw-agent-db-lease.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { stateLeaseProcessExitRuntimeEntrypoint } from "./openclaw-state-lease-runtime.test-support.js";
import { readOpenClawStateLease } from "./openclaw-state-lease-store.js";
import { withOpenClawStateLease } from "./openclaw-state-lease.js";

type LeaseDatabase = Pick<OpenClawStateKyselyDatabase, "state_leases">;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("OpenClaw state lease", () => {
  it("recovers agent maintenance after its owner dies without stealing a live lease", async () => {
    await withOpenClawTestState({ label: "agent-maintenance-owner-crash" }, async (state) => {
      const maintenanceUrl = resolveRuntimeWorkerUrl(
        stateNativeProcessEntrypoints.agentMaintenanceLease,
      );
      const childScript = await state.writeText(
        "maintenance-owner.mjs",
        `
          import { withAgentDatabaseMaintenanceLease } from ${JSON.stringify(maintenanceUrl.href)};
          await withAgentDatabaseMaintenanceLease({ env: process.env, leaseMs: 300_000 }, async () => {
            process.send("owned");
            await new Promise(() => {});
          });
        `,
      );
      const child = spawn(
        process.execPath,
        [...resolveRuntimeWorkerArgv(maintenanceUrl).slice(0, -1), childScript],
        { env: { ...process.env, ...state.env }, stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-5_000);
      });
      try {
        const [message] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
        expect(message, stderr).toBe("owned");
        let entered = false;
        const enterMaintenance = () =>
          withAgentDatabaseMaintenanceLease({ env: state.env }, async (lease) => {
            lease.assertOwned();
            entered = true;
          });
        await expect(enterMaintenance()).rejects.toMatchObject({
          code: "OPENCLAW_STATE_LEASE_HELD",
          outcome: { kind: "held" },
        });
        expect(entered).toBe(false);

        // Unlike process.exit(), abrupt service replacement cannot run exit cleanup.
        const closed = once(child, "close", { signal: AbortSignal.timeout(5_000) });
        expect(child.kill("SIGKILL")).toBe(true);
        await closed;
        const held = readOpenClawStateLease(
          openOpenClawStateDatabase({ env: state.env }).db,
          AGENT_DATABASE_MAINTENANCE_LEASE,
        );
        expect(held?.expiresAt).toBeGreaterThan(Date.now());

        await enterMaintenance();
        expect(entered).toBe(true);
        expect(
          readOpenClawStateLease(
            openOpenClawStateDatabase({ env: state.env }).db,
            AGENT_DATABASE_MAINTENANCE_LEASE,
          ),
        ).toBeUndefined();
      } finally {
        await stopChildProcess(child, 5_000, { force: true });
      }
    });
  });

  it.each([undefined, "worker"] as const)(
    "releases ownership when a CLI exits with %s renewal",
    async (heartbeat) => {
      await withOpenClawTestState({ label: "core-state-lease-process-exit" }, async (state) => {
        const childUrl = resolveRuntimeWorkerUrl(stateLeaseProcessExitRuntimeEntrypoint);

        const exitCode = await new Promise<number | null>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [...resolveRuntimeWorkerArgv(childUrl), state.stateDir, heartbeat ?? ""],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let output = "";
          child.stdout.on("data", (chunk) => (output += chunk));
          child.stderr.on("data", (chunk) => (output += chunk));
          child.on("error", reject);
          child.on("close", (code) => {
            if (code !== 23) {
              reject(new Error(`lease child exited ${code}: ${output}`));
              return;
            }
            resolve(code);
          });
        });
        expect(exitCode).toBe(23);

        let reacquired = false;
        await withOpenClawStateLease(
          {
            scope: "core:test",
            key: "process-exit",
            database: { scope: "shared", options: { env: state.env } },
            leaseMs: 1_000,
            waitMs: 0,
          },
          async () => {
            reacquired = true;
          },
        );
        expect(reacquired).toBe(true);
      });
    },
  );

  it("keeps state database exit-cleanup diagnostics off stdout for machine-readable output", async () => {
    await withOpenClawTestState({ label: "core-state-lease-exit-stdout" }, async (state) => {
      const leaseModuleUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.stateLease);
      const stateDbModuleUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.stateDatabase);
      const loggingStateModuleUrl = resolveRuntimeWorkerUrl(
        stateNativeProcessEntrypoints.loggingState,
      );
      const childScript = await state.writeText(
        "lease-exit-stdout-child.mjs",
        `
          import { withOpenClawStateLease } from ${JSON.stringify(leaseModuleUrl.href)};
          import {
            closeOpenClawStateDatabaseForTest,
            openOpenClawStateDatabase,
          } from ${JSON.stringify(stateDbModuleUrl.href)};
          import { loggingState } from ${JSON.stringify(loggingStateModuleUrl.href)};
          const stateDir = process.argv[2];
          const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
          // Simulate --json console routing being active for the command.
          loggingState.forceConsoleToStderr = true;
          await withOpenClawStateLease({
            scope: "core:test",
            key: "exit-stdout",
            database: { scope: "shared", options: { env } },
            leaseMs: 300_000,
            waitMs: 0,
          }, async () => {
            // Recreate the pending-migration condition for the exit-time reopen.
            const { db } = openOpenClawStateDatabase({ env });
            db.exec("DROP INDEX idx_worker_session_placements_environment; PRAGMA user_version = 0;");
            closeOpenClawStateDatabaseForTest();
            // Simulate the JSON envelope followed by restored output routing.
            // Await the write callback — stdout is piped in the test harness, so
            // a bare write() can drop the data before process.exit flushes.
            await new Promise((resolve) => {
              process.stdout.write(JSON.stringify({ ok: true }) + "\\n", resolve);
            });
            loggingState.forceConsoleToStderr = false;
            process.exit(23);
          });
        `,
      );

      const childResult = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [...resolveRuntimeWorkerArgv(leaseModuleUrl).slice(0, -1), childScript, state.stateDir],
          {
            // Keep console logging enabled in the child despite the inherited VITEST env.
            env: { ...process.env, OPENCLAW_TEST_CONSOLE: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });

      expect(
        childResult.code,
        `lease child exited ${childResult.code}: ${childResult.stderr}`,
      ).toBe(23);
      // The exit-time lease release reopens the state database and hits the
      // pending-migration diagnostic; stdout must stay machine-readable.
      expect(childResult.stdout).toBe(`${JSON.stringify({ ok: true })}\n`);
      expect(childResult.stderr).toContain("state database schema migration pending");
    });
  }, 60_000);

  it("rechecks exact ownership inside the caller's write transaction", async () => {
    await withOpenClawTestState({ label: "core-state-lease" }, async () => {
      await expect(
        withOpenClawStateLease(
          {
            scope: "core:test",
            key: "credential-write",
            database: { scope: "shared" },
            leaseMs: 1_000,
            waitMs: 0,
          },
          async (lease) => {
            runOpenClawStateWriteTransaction(({ db }) => {
              lease.assertOwnedInTransaction(db);
              executeSqliteQuerySync(
                db,
                getNodeSqliteKysely<LeaseDatabase>(db)
                  .updateTable("state_leases")
                  .set({ owner: "successor" })
                  .where("scope", "=", "core:test")
                  .where("lease_key", "=", "credential-write"),
              );
              expect(() => lease.assertOwnedInTransaction(db)).toThrowError(
                expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_LOST" }),
              );
            });
          },
        ),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
    });
  });
});
