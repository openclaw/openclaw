import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { observeMainThreadReads } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { stateNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { stateLeaseProcessExitRuntimeEntrypoint } from "./openclaw-state-lease-runtime.test-support.js";
import { prepareOpenClawStateLeaseVerification } from "./openclaw-state-lease-storage.js";
import {
  acquireOpenClawStateLeaseInTransaction,
  readOpenClawStateLease,
  releaseOpenClawStateLeaseInTransaction,
} from "./openclaw-state-lease-store.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

type LeaseDatabase = Pick<OpenClawStateKyselyDatabase, "state_leases">;

afterEach(closeOpenClawStateDatabaseForTest);

function leaseOptions(key: string, env?: NodeJS.ProcessEnv) {
  return {
    scope: "core:test",
    key,
    leaseMs: 1_000,
    waitMs: 0,
    database: { scope: "shared" as const, ...(env ? { options: { env } } : {}) },
  };
}

function runChild(args: string[], options: SpawnOptionsWithoutStdio = {}) {
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

it.each([
  { heartbeat: undefined, termination: "exit", processBound: false },
  { heartbeat: "worker", termination: "exit", processBound: false },
  { heartbeat: undefined, termination: "SIGKILL", processBound: true },
  { heartbeat: "worker", termination: "SIGKILL", processBound: true },
  { heartbeat: "worker", termination: "SIGKILL", processBound: false },
] as const)(
  "reclaims only settled ownership after $termination with $heartbeat renewal (process-bound: $processBound)",
  ({ heartbeat, termination, processBound }) =>
    withOpenClawTestState({ label: "core-state-lease-process-exit" }, async (state) => {
      const childUrl = resolveRuntimeWorkerUrl(stateLeaseProcessExitRuntimeEntrypoint);

      const { code, signal, stdout, stderr } = await runChild([
        ...resolveRuntimeWorkerArgv(childUrl),
        state.stateDir,
        heartbeat ?? "",
        termination,
        processBound ? "process-bound" : "",
      ]);
      expect(termination === "SIGKILL" ? signal : code, `lease child: ${stdout}${stderr}`).toBe(
        termination === "SIGKILL" ? "SIGKILL" : 23,
      );

      const operation = vi.fn(async () => {});
      const acquisition = withOpenClawStateLease(
        leaseOptions("process-exit", state.env),
        operation,
      );
      const blocked = termination === "SIGKILL" && !processBound;
      if (blocked) {
        await expect(acquisition).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_HELD" });
      } else {
        await acquisition;
      }
      expect(operation).toHaveBeenCalledTimes(blocked ? 0 : 1);
    }),
);

it(
  "keeps exit-cleanup diagnostics off JSON stdout",
  () =>
    withOpenClawTestState({ label: "core-state-lease-exit-stdout" }, async (state) => {
      const leaseModuleUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.stateLease);
      const childScript = await state.writeText(
        "lease-exit-stdout-child.mjs",
        `
          import { withOpenClawStateLease } from ${JSON.stringify(leaseModuleUrl.href)};
          import { closeOpenClawStateDatabaseForTest, openOpenClawStateDatabase } from ${JSON.stringify(resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.stateDatabase).href)};
          import { loggingState } from ${JSON.stringify(resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.loggingState).href)};
          const stateDir = process.argv[2];
          const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
          // Simulate --json console routing being active for the command.
          loggingState.forceConsoleToStderr = true;
          await withOpenClawStateLease({
            scope: "core:test", key: "exit-stdout", leaseMs: 300_000, waitMs: 0,
            database: { scope: "shared", options: { env } },
          }, async () => {
            // Recreate the pending-migration condition for the exit-time reopen.
            const { db } = openOpenClawStateDatabase({ env });
            db.exec("DROP INDEX idx_worker_session_placements_environment; PRAGMA user_version = 0;");
            closeOpenClawStateDatabaseForTest();
            // Flush the piped JSON envelope before restoring routing and exiting.
            await new Promise((resolve) => {
              process.stdout.write(JSON.stringify({ ok: true }) + "\\n", resolve);
            });
            loggingState.forceConsoleToStderr = false;
            process.exit(23);
          });
        `,
      );

      const childResult = await runChild(
        [...resolveRuntimeWorkerArgv(leaseModuleUrl).slice(0, -1), childScript, state.stateDir],
        // Keep console logging enabled despite the inherited VITEST env.
        { env: { ...process.env, OPENCLAW_TEST_CONSOLE: "1" } },
      );

      expect(childResult).toMatchObject({
        code: 23,
        stdout: `${JSON.stringify({ ok: true })}\n`,
        stderr: expect.stringContaining("state database schema migration pending"),
      });
    }),
  60_000,
);

it("rechecks exact ownership inside the caller's write transaction", () =>
  withOpenClawTestState({ label: "core-state-lease" }, async () => {
    await expect(
      withOpenClawStateLease(leaseOptions("credential-write"), async (lease) => {
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
      }),
    ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
  }));

it("retains verified Gateway lease facts until their writer epoch changes", () =>
  withOpenClawTestState({ label: "lease-owner-facts" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const owner = acquireGatewayStateOwner({
      databasePath: database.path,
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: state.configPath,
        role: "gateway",
      },
    });
    let retired: OpenClawStateLeaseContext | undefined;
    try {
      await withOpenClawStateLease(
        { ...leaseOptions("facts", state.env), leaseMs: 60_000 },
        async (lease, identity) => {
          retired = lease;
          const reads = observeMainThreadReads();
          try {
            lease.assertOwned();
            lease.assertOwned();
            reads.expectIdle();
            runOpenClawStateWriteTransaction(
              ({ db }) => {
                const sibling = { ...identity, key: "sibling" };
                acquireOpenClawStateLeaseInTransaction(db, sibling, 60_000);
                releaseOpenClawStateLeaseInTransaction(db, sibling);
              },
              { env: state.env },
            );
            reads.clear();
            lease.assertOwned();
            reads.expectIdle();
            for (const mutation of ["replace", "delete", "shorten"] as const) {
              const { db } = database;
              const original = readOpenClawStateLease(db, identity)!;
              if (mutation === "delete") {
                db.prepare("DELETE FROM state_leases WHERE scope=? AND lease_key=?").run(
                  identity.scope,
                  identity.key,
                );
              } else {
                db.prepare(
                  `UPDATE state_leases SET ${mutation === "replace" ? "owner=?" : "expires_at=?"} WHERE scope=? AND lease_key=?`,
                ).run(
                  mutation === "replace" ? "successor" : Date.now() + 10_000,
                  identity.scope,
                  identity.key,
                );
              }
              reads.clear();
              if (mutation === "shorten") {
                lease.assertOwned();
                expect(reads.count()).toBeGreaterThan(0);
                const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20_000);
                try {
                  expect(() => lease.assertOwned()).toThrowError(
                    expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_LOST" }),
                  );
                } finally {
                  clock.mockRestore();
                }
              } else {
                expect(() => lease.assertOwned()).toThrowError(
                  expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_LOST" }),
                );
              }
              db.prepare(
                "INSERT OR REPLACE INTO state_leases(scope,lease_key,owner,expires_at,heartbeat_at,created_at,updated_at,payload_json) VALUES(?,?,?,?,?,?,?,NULL)",
              ).run(
                identity.scope,
                identity.key,
                identity.owner,
                original.expiresAt,
                original.heartbeatAt,
                original.createdAt,
                Date.now(),
              );
              lease.assertOwned();
            }
            runOpenClawStateWriteTransaction(
              ({ db }) => {
                db.prepare("UPDATE state_leases SET updated_at=updated_at WHERE scope=?").run(
                  identity.scope,
                );
                reads.clear();
                lease.assertOwned();
                const pendingReads = reads.count();
                lease.assertOwned();
                expect(reads.count()).toBeGreaterThan(pendingReads);
                reads.clear();
                lease.assertOwnedInTransaction(db);
                expect(reads.count()).toBeGreaterThan(0);
              },
              { env: state.env },
            );
          } finally {
            reads.restore();
          }
        },
      );
      expect(() => retired!.assertOwned()).toThrow();
      await expect(
        withOpenClawStateLease(
          { ...leaseOptions("closed-handle", state.env), leaseMs: 60_000 },
          async (lease) => {
            lease.assertOwned();
            database.db.close();
            lease.assertOwned();
          },
        ),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_STORAGE_FAILED" });
      await expect(
        withOpenClawStateLease(
          { ...leaseOptions("owner-close", state.env), leaseMs: 60_000 },
          async (lease) => {
            lease.assertOwned();
            owner.release();
            lease.assertOwned();
          },
        ),
      ).rejects.toThrow("state process owner is no longer current");
    } finally {
      owner.release();
    }
  }));

it("keeps a verified lease handle through idle expiry until its owner releases it", () =>
  withOpenClawTestState({ label: "lease-idle-retention" }, async (state) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let owner: ReturnType<typeof acquireGatewayStateOwner> | undefined;
    let verification: Awaited<ReturnType<typeof prepareOpenClawStateLeaseVerification>>;
    try {
      const database = openOpenClawStateDatabase({ env: state.env });
      owner = acquireGatewayStateOwner({
        databasePath: database.path,
        payload: {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          configPath: state.configPath,
          role: "gateway",
        },
      });
      const identity = { scope: "synthetic", key: "idle", owner: "held", leaseLabel: "idle lease" };
      runOpenClawStateWriteTransaction(
        ({ db }) => acquireOpenClawStateLeaseInTransaction(db, identity, 60_000),
        { database },
      );
      const context = captureOpenClawStateWorkerContext({ env: state.env });
      verification = await prepareOpenClawStateLeaseVerification(
        { context, identity: context.admission.identity, database },
        identity,
      );
      expect(verification).toBeDefined();
      verification!.verify();
      await database.walMaintenance.stop();
      // Only timeout scheduling advances; the persisted lease's real clock stays live.
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS + 1);
      expect(database.db.isOpen).toBe(true);
      verification!.verify();
      verification!.release();
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
      expect(database.db.isOpen).toBe(false);
    } finally {
      try {
        verification?.release();
        owner?.release();
      } finally {
        vi.useRealTimers();
      }
    }
  }));

it("records expiry and timer lateness when the native owner cannot run its heartbeat", () =>
  withOpenClawTestState({ label: "lease-starvation" }, async ({ env }) => {
    const { db } = openOpenClawStateDatabase({ env });
    let entered = false;
    const clock = vi.spyOn(Date, "now");
    const lost = await withOpenClawStateLease(
      {
        scope: "synthetic",
        key: "stall",
        leaseMs: 3_000,
        waitMs: 0,
        database: { scope: "shared", options: { env } },
      },
      async (lease) => {
        entered = true;
        const row = readOpenClawStateLease(db, { scope: "synthetic", key: "stall" });
        if (!row || row.expiresAt === null) {
          throw new Error("Expected acquired lease");
        }
        // No timer can run while synchronous work holds the event loop.
        clock.mockReturnValue(row.expiresAt + 2_000);
        lease.assertOwned();
      },
    ).catch((error: unknown) => error);
    clock.mockRestore();
    if (!entered) {
      throw lost;
    }
    expect(lost).toMatchObject({
      code: "OPENCLAW_STATE_LEASE_LOST",
      loss: {
        reason: "expired",
        expiresAt: expect.any(Number),
        expiredByMs: 2_000,
        heartbeatAgeMs: 5_000,
        renewalTimerLateByMs: expect.any(Number),
      },
    });
  }));
