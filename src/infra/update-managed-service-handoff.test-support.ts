import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Writable } from "node:stream";
import { expect, it, vi, type Mock } from "vitest";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

const testNodeExecPath = resolveTestNodeExecPath();

export function registerPreparedCoordinatorAdmissionTest(params: {
  spawnMock: Mock;
  makeTempDir: (prefix: string) => string;
  setCoordinator: (directory: string) => void;
}): void {
  it.runIf(process.platform !== "win32")(
    "keeps the prepared coordinator authoritative across replacement admission",
    async () => {
      vi.restoreAllMocks();
      const { spawn } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const { waitForPidFile, waitForDead } = await import("../../test/helpers/process-wait.js");
      const { withTimeout } = await import("./fs-safe.js");
      const { createManagedServiceBoundaryCleanup } =
        await import("./update-managed-service-handoff-process.test-support.js");
      const { createManagedHandoffLeaseStore } =
        await import("./update-managed-service-handoff-lease.js");
      const handoff = await import("./update-managed-service-handoff.js");
      const helpers: Array<{ child: ChildProcess; closed: Promise<void> }> = [];
      params.spawnMock.mockImplementation((...args: Parameters<typeof spawn>) => {
        const child = spawn(...args);
        const closed = new Promise<void>((resolve) => {
          child.once("close", () => resolve());
        });
        helpers.push({ child, closed });
        return child;
      });
      const cleanupHelpers = createManagedServiceBoundaryCleanup(() =>
        helpers.map(({ child }) => child),
      );
      const root = await fs.promises.realpath(params.makeTempDir("handoff-original-admission-"));
      const coordinator = await fs.promises.realpath(params.makeTempDir("handoff-original-store-"));
      const fallback = await fs.promises.realpath(params.makeTempDir("handoff-relocated-store-"));
      const displaced = `${coordinator}-unavailable`;
      const releasePath = path.join(root, "release-updater");
      const pidPath = path.join(root, "updater-pid");
      const updaterPath = path.join(root, "updater.cjs");
      await fs.promises.writeFile(
        updaterPath,
        `
        const fs=require("node:fs");
        fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));
        const held=setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(releasePath)})) return;
          clearInterval(held);
          if (!process.connected) return process.exit(0);
          process.stdout.write(JSON.stringify({root:${JSON.stringify(root)},status:"skipped",mode:"npm",reason:"already-current"}),() => process.disconnect());
        },10);
      `,
      );
      params.setCoordinator(coordinator);
      const start = () =>
        handoff.startManagedServiceUpdateHandoff({
          root,
          restartDrainTimeoutMs: 300_000,
          parentPid: process.pid,
          execPath: testNodeExecPath,
          argv1: updaterPath,
          env: { ...process.env, OPENCLAW_STATE_DIR: root },
          meta: {},
        });
      let originalStore: ReturnType<typeof createManagedHandoffLeaseStore> | undefined;
      let executorPid: number | undefined;
      let moved = false;
      let latest: Awaited<ReturnType<typeof start>> | undefined;
      const failures: unknown[] = [];
      try {
        const original = await start();
        latest = original;
        if (original.status !== "started") {
          throw new Error("original helper did not start");
        }
        const originalHelper = helpers[0];
        const paramsPath = originalHelper?.child.spawnargs.at(-1);
        if (!originalHelper || !paramsPath) {
          throw new Error("missing original helper handle");
        }
        const prepared = JSON.parse(await fs.promises.readFile(paramsPath, "utf8")) as {
          updateLeaseDatabasePath: string;
          updateLeaseDatabaseIdentity: import("./update-managed-service-handoff-database.js").ManagedUpdateLeaseDatabaseIdentity;
        };
        originalStore = createManagedHandoffLeaseStore({
          databasePath: prepared.updateLeaseDatabasePath,
          existingIdentity: prepared.updateLeaseDatabaseIdentity,
          serviceManagerEnv: process.env,
        });
        await expect(
          handoff.transferManagedServiceUpdateHandoff({
            kind: "managed-update-handoff",
            ...original,
          }),
        ).resolves.toBe(true);
        executorPid = await waitForPidFile(pidPath, 15000);
        const bound = originalStore.read(root);
        if (bound.kind !== "current") {
          throw new Error("original executor lease was not published");
        }
        expect(bound.lease.helper.pid).toBe(original.pid);
        expect(bound.lease.executor.pid).toBe(executorPid);
        expect(originalStore.isProcessIdentityCurrent(bound.lease.executor)).toBe(true);
        originalHelper.child.kill("SIGKILL");
        await withTimeout(originalHelper.closed, 15000);
        expect(originalStore.read(root)).toEqual(bound);
        expect(originalStore.release(bound.lease)).toBe(false);
        expect(
          originalStore.acquire(root, "competing-installation-update", { kind: "update" }),
        ).toMatchObject({ kind: "busy", owner: original.handoffId });

        params.setCoordinator(fallback);
        latest = await start();
        expect(latest).toMatchObject({ status: "joined", handoffId: original.handoffId });
        expect(helpers).toHaveLength(1);
        expect(originalStore.read(root)).toEqual(bound);
        expect(await fs.promises.readdir(fallback)).toEqual([]);

        await fs.promises.rename(coordinator, displaced);
        moved = true;
        expect(originalStore.read(root)).toEqual({ kind: "unreadable" });
        await expect(
          start().then((result) => {
            latest = result;
            return result;
          }),
        ).rejects.toThrow(/lease|coordinator|ownership|unavailable/i);
        expect(helpers).toHaveLength(1);
        expect(await fs.promises.readdir(fallback)).toEqual([]);
        await fs.promises.rename(displaced, coordinator);
        moved = false;
        expect(originalStore.read(root)).toEqual(bound);

        await fs.promises.writeFile(releasePath, "settle original updater");
        await waitForDead(executorPid, 15000);
        expect(originalStore.read(root)).toEqual(bound);
        expect(originalStore.hasUnsettledChildren(bound.lease)).toBe(false);
        latest = await start();
        expect(latest.status).toBe("started");
        if (latest.status !== "started") {
          throw new Error("settled original owner pinned admission");
        }
        expect(helpers).toHaveLength(2);
        const replacement = helpers[1]!;
        const replacementParamsPath = replacement.child.spawnargs.at(-1);
        if (!replacementParamsPath) {
          throw new Error("replacement helper did not retain its prepared store");
        }
        const replacementPrepared = JSON.parse(
          await fs.promises.readFile(replacementParamsPath, "utf8"),
        ) as typeof prepared;
        const admittedStore = createManagedHandoffLeaseStore({
          databasePath: replacementPrepared.updateLeaseDatabasePath,
          existingIdentity: replacementPrepared.updateLeaseDatabaseIdentity,
          serviceManagerEnv: process.env,
        });
        expect(admittedStore.read(root)).toMatchObject({
          kind: "current",
          lease: { owner: latest.handoffId, helper: { pid: latest.pid } },
        });
        if (replacementPrepared.updateLeaseDatabasePath === prepared.updateLeaseDatabasePath) {
          expect(originalStore.read(root)).toMatchObject({
            kind: "current",
            lease: { owner: latest.handoffId },
          });
        } else {
          expect(originalStore.read(root)).toEqual({ kind: "absent" });
        }
        await expect(
          handoff.transferManagedServiceUpdateHandoff({
            kind: "managed-update-handoff",
            ...latest,
          }),
        ).resolves.toBe(true);
        await withTimeout(replacement.closed, 15000);
        expect(replacement.child.exitCode).toBe(0);
        expect(admittedStore.read(root)).toEqual({ kind: "absent" });
        expect(originalStore.read(root)).toEqual({ kind: "absent" });
      } catch (error) {
        failures.push(error);
      }
      const cleanup = async (operation: () => unknown) => {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      };
      await cleanup(async () => {
        if (moved) {
          await fs.promises.rename(displaced, coordinator);
        }
      });
      await cleanup(() => fs.promises.writeFile(releasePath, "fixture cleanup"));
      await cleanup(async () => {
        if (executorPid) {
          await waitForDead(executorPid, 15000);
        }
      });
      await cleanup(async () => {
        if (latest?.status === "started") {
          await handoff.cancelManagedServiceUpdateHandoff({
            kind: "managed-update-handoff",
            ...latest,
          });
        }
      });
      await cleanup(cleanupHelpers);
      await cleanup(() => Promise.all(helpers.map(({ closed }) => withTimeout(closed, 15000))));
      await cleanup(() => {
        if (originalStore) {
          const remaining = originalStore.read(root);
          if (remaining.kind === "current") {
            expect(originalStore.release(remaining.lease)).toBe(true);
          }
          expect(originalStore.read(root)).toEqual({ kind: "absent" });
        }
      });
      if (failures.length > 1) {
        throw new AggregateError(failures, "Prepared coordinator assertion and cleanup failed", {
          cause: failures[0],
        });
      }
      if (failures.length === 1) {
        throw failures[0];
      }
    },
    60_000,
  );
}

export type MockManagedUpdateHandoffLeaseFailure =
  | "absent"
  | "malformed"
  | "wrong-owner"
  | "dead-helper";

export function signalMockManagedUpdateHandoffReady(params: {
  child: EventEmitter & { pid: number; stdout: Pick<Writable, "destroyed" | "write"> };
  paramsPath: string;
  cleanups: Set<() => void>;
  startIdentity?: number;
  failure?: MockManagedUpdateHandoffLeaseFailure;
}): void {
  const { child, cleanups, failure } = params;
  if (child.stdout.destroyed) {
    return;
  }
  const lease = JSON.parse(fs.readFileSync(params.paramsPath, "utf8")) as {
    updateLeaseDatabasePath: string;
    updateLeaseKey: string;
    updateLeaseOwner: string;
    action: "update" | "triage";
    scopeUnit: string;
    serviceRecovery: { unit: string };
  };
  const startIdentity = params.startIdentity ?? getFileLockProcessStartTime(child.pid);
  if (startIdentity === null) {
    throw new Error("expected the mocked handoff child to have a live process identity");
  }
  fs.mkdirSync(path.dirname(lease.updateLeaseDatabasePath), { recursive: true, mode: 0o700 });
  const owner =
    failure === "wrong-owner" ? `${lease.updateLeaseOwner}-replacement` : lease.updateLeaseOwner;
  const payload = JSON.stringify({
    version: 2,
    executor: {
      pid: failure === "dead-helper" ? child.pid + 1_000_000 : child.pid,
      startIdentity: failure === "malformed" ? null : String(startIdentity),
    },
    helper: { pid: child.pid, startIdentity: String(startIdentity) },
    action:
      lease.action === "triage"
        ? {
            kind: "triage",
            phase: "reserved",
            lifetime: {
              kind: "native",
              unit: lease.serviceRecovery.unit,
              scope: lease.scopeUnit,
              placement: { kind: "attached", invocation: "a".repeat(32) },
            },
          }
        : { kind: "update" },
  });
  const db = new DatabaseSync(lease.updateLeaseDatabasePath);
  try {
    if (process.platform !== "win32") {
      fs.chmodSync(lease.updateLeaseDatabasePath, 0o600);
    }
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(
      "CREATE TABLE IF NOT EXISTS managed_update_handoffs " +
        "(install_root TEXT NOT NULL PRIMARY KEY, owner TEXT NOT NULL, " +
        "payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT",
    );
    if (failure !== "absent") {
      db.prepare(
        "INSERT INTO managed_update_handoffs " +
          "(install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(install_root) DO UPDATE SET updated_at = excluded.updated_at " +
          "WHERE owner = excluded.owner AND payload_json = excluded.payload_json",
      ).run(lease.updateLeaseKey, owner, payload, Date.now());
    }
  } finally {
    db.close();
  }
  if (failure !== "absent") {
    const cleanup = () => {
      cleanups.delete(cleanup);
      const cleanupDb = new DatabaseSync(lease.updateLeaseDatabasePath);
      try {
        cleanupDb.exec("PRAGMA busy_timeout = 5000;");
        cleanupDb
          .prepare(
            "DELETE FROM managed_update_handoffs " +
              "WHERE install_root = ? AND owner = ? AND payload_json = ?",
          )
          .run(lease.updateLeaseKey, owner, payload);
      } finally {
        cleanupDb.close();
      }
    };
    cleanups.add(cleanup);
    child.once("exit", cleanup);
  }
  child.stdout.write("OPENCLAW_UPDATE_HANDOFF_READY\n");
}

export async function writeConcurrentManagedHandoffParams(
  params: {
    tmpDir: string;
    baseParams: Record<string, unknown>;
    name: string;
    owner: string;
    commandArgv: string[];
    stateDatabasePath?: string;
    leaseDatabasePath?: string;
  },
  handoffParents: Map<string, import("node:child_process").ChildProcess>,
): Promise<string> {
  const { spawn } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { getFileLockProcessStartTime: readParentStartTime } =
    await import("../shared/pid-alive.js");
  const parent = spawn(testNodeExecPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  const parentPid = parent.pid;
  const startIdentity = parentPid ? readParentStartTime(parentPid) : null;
  if (!parentPid || startIdentity === null) {
    parent.kill("SIGKILL");
    throw new Error("expected a parent process with a stable start identity");
  }
  const paramsPath = path.join(params.tmpDir, `${params.name}.json`);
  handoffParents.set(paramsPath, parent);
  await fs.promises.writeFile(
    paramsPath,
    `${JSON.stringify(
      {
        ...params.baseParams,
        parentPid,
        parentStartIdentity: String(startIdentity),
        parentExitTimeoutMs: 5_000,
        handoffId: params.owner,
        updateLeaseOwner: params.owner,
        stateDatabasePath: params.stateDatabasePath ?? params.baseParams.stateDatabasePath,
        updateLeaseDatabasePath:
          params.leaseDatabasePath ?? params.baseParams.updateLeaseDatabasePath,
        commandArgv: params.commandArgv,
        triageCommandArgv: [testNodeExecPath, "-e", "process.exit(0)", "--"],
        triageContextPath: path.join(params.tmpDir, `${params.name}-failure.json`),
        logPath: path.join(params.tmpDir, `${params.name}.log`),
        sensitivePaths: [],
      },
      null,
      2,
    )}\n`,
  );
  return paramsPath;
}
