/** Real generated helper IPC and SQLite; no installed Gateway or service mutation. */
import * as childProcess from "node:child_process";
import { once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import * as tmp from "./tmp-openclaw-dir.js";
import * as lease from "./update-managed-service-handoff-lease.js";
import * as handoff from "./update-managed-service-handoff.js";
import * as ledger from "./update-run-ledger.js";

vi.mock("node:child_process", { spy: true });

it.runIf(process.platform !== "win32").each([
  [
    "late finalization failure",
    "managed-service-handoff-finalization",
    "failed",
    "failed",
    "managed-service-handoff-failed",
  ],
  ["admission refusal", "requested", "failed", "failed", "managed-service-handoff-failed"],
  ["ordinary cancellation", undefined, undefined, "skipped", "managed-service-handoff-cancelled"],
  [
    "completed finalization",
    "managed-service-handoff-finalization",
    "completed",
    "skipped",
    "managed-service-handoff-cancelled",
  ],
  [
    "unrelated failed step",
    "optional-diagnostic",
    "failed",
    "skipped",
    "managed-service-handoff-cancelled",
  ],
] as const)(
  "settles real helper ledger for %s",
  async (_label, step, stepStatus, status, reason) => {
    const root = await fs.realpath(
      // openclaw-temp-dir: allow keep backing until the owned helper and parent close.
      await fs.mkdtemp(path.join(os.tmpdir(), "handoff-ledger-cancel-")),
    );
    const databasePath = path.join(root, "managed-update-handoffs.sqlite");
    const env = {
      ...process.env,
      // Read-only ledger descendants run outside the source checkout too.
      TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
      OPENCLAW_STATE_DIR: path.join(root, "state-owner"),
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.private-ledger-cancel",
    };
    const stateDatabasePath = resolveOpenClawStateSqlitePath(env);
    await fs.mkdir(path.dirname(stateDatabasePath), { recursive: true });
    const tempSpy = vi.spyOn(tmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(root);
    const pathSpy = vi
      .spyOn(lease, "resolveManagedUpdateLeaseDatabasePath")
      .mockReturnValue(databasePath);
    const spawn = vi.mocked(childProcess.spawn);
    const actualSpawn = (await vi.importActual<typeof childProcess>("node:child_process")).spawn;
    const parent = actualSpawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const parentClosed = once(parent, "close");
    let helperProcess: childProcess.ChildProcess | undefined;
    let helperClosed: Promise<unknown> | undefined;
    let identity: Parameters<typeof handoff.cancelManagedServiceUpdateHandoff>[0] | undefined;
    let helperLogPath: string | undefined;
    const beforePark = vi.fn(async () => {});
    try {
      expect(await fs.realpath(path.dirname(stateDatabasePath))).toBe(
        path.join(root, "state-owner", "state"),
      );
      expect(lease.resolveManagedUpdateLeaseDatabasePath()).toBe(databasePath);
      // The preload runs inside the real helper, before its first SQLite access.
      const verifier = path.join(root, "verify-private.cjs");
      await fs.writeFile(
        verifier,
        `
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const root = ${JSON.stringify(root)}, leaseDb = ${JSON.stringify(databasePath)}, stateDb = ${JSON.stringify(stateDatabasePath)};
const params = JSON.parse(fs.readFileSync(process.argv.at(-1), "utf8"));
assert.equal(params.updateLeaseDatabasePath, leaseDb);
assert.equal(params.updateLeaseDatabaseIdentity.databasePath, leaseDb);
assert.equal(params.stateDatabasePath, stateDb);
for (const db of [leaseDb, stateDb]) {
  for (let p = path.dirname(db); ; p = path.dirname(p)) {
    assert.equal(fs.realpathSync(p), p);
    assert.equal(fs.lstatSync(p).isDirectory(), true);
    if (p === path.dirname(p)) break;
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const p = db + suffix;
    let s;
    try { s = fs.lstatSync(p); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    assert.equal(s.isFile(), true); assert.equal(s.nlink, 1); assert.equal(fs.realpathSync(p), p);
  }
}
fs.writeFileSync(path.join(root, "helper-store-verified"), String(process.pid), { flag: "wx" });
`,
      );
      await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
      const recovery = path.join(root, "dist", "cli", "daemon-cli.js");
      await fs.mkdir(path.dirname(recovery), { recursive: true });
      await fs.writeFile(
        recovery,
        `
const { register } = await import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)});
register({ tsconfig: ${JSON.stringify(path.resolve("tsconfig.json"))} });
const ledger = await import(${JSON.stringify(new URL("./update-run-ledger.ts", import.meta.url).href)});
export const { adoptUpdateRun, finishUpdateRun, getUpdateRun, recordUpdateRunStep, recordUpdateRunVerification } = ledger;
`,
      );
      const updater = path.join(root, "never-run.cjs");
      await fs.writeFile(updater, 'throw new Error("Updater must never run before transfer");');
      spawn.mockImplementationOnce((command, args, options) => {
        // Verify the effective sealed paths in the parent, then again inside the helper.
        const params = JSON.parse(fsSync.readFileSync(args!.at(-1)!, "utf8"));
        expect(params.updateLeaseDatabasePath).toBe(databasePath);
        expect(params.updateLeaseDatabaseIdentity.databasePath).toBe(databasePath);
        helperProcess = actualSpawn(command, ["--require", verifier, ...args!], options!);
        helperClosed = once(helperProcess, "close");
        return helperProcess;
      });
      await withEnvAsync({ OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR }, async () => {
        const run = ledger.createUpdateRun({ trigger: "api" }, { env });
        const helper = await handoff.startManagedServiceUpdateHandoff({
          root,
          supervisor: "launchd",
          env,
          runId: run.runId,
          parentPid: parent.pid!,
          execPath: process.execPath,
          argv1: updater,
          meta: {},
          beforePark,
          timeoutMs: 10_000,
          restartDrainTimeoutMs: 300_000,
        });
        expect(helper.status).toBe("started");
        if (helper.status !== "started") {
          throw new Error("Expected fresh helper");
        }
        helperLogPath = helper.logPath;
        identity = {
          kind: "managed-update-handoff",
          handoffId: helper.handoffId,
          installRoot: helper.installRoot,
        };
        expect(await fs.readFile(path.join(root, "helper-store-verified"), "utf8")).toBe(
          String(helper.pid),
        );
        if (step && stepStatus) {
          ledger.recordUpdateRunStep(
            run.runId,
            {
              step,
              status: stepStatus,
              reason: "managed-service-handoff-failed",
              detail: "initiating failure remains distinct",
            },
            { env },
          );
        }
        expect(ledger.getUpdateRun(run.runId, { env })?.status).toBe("running");
        const store = lease.createManagedHandoffLeaseStore({
          databasePath,
          serviceManagerEnv: env,
        });
        const current = store.read(helper.installRoot);
        expect(current.kind).toBe("current");
        if (current.kind !== "current") {
          throw new Error("Expected current helper lease");
        }
        expect(store.isProcessIdentityCurrent(current.lease.helper)).toBe(true);
        expect(await handoff.cancelManagedServiceUpdateHandoff(identity)).toBe(
          "restored-in-process",
        );
        await helperClosed;
        const terminal = ledger.getUpdateRun(run.runId, { env });
        expect(terminal, await fs.readFile(helper.logPath, "utf8")).toMatchObject({
          status,
          reason,
          phase: "finished",
          finishedAtMs: expect.any(Number),
        });
        if (step) {
          expect(terminal?.steps).toContainEqual(
            expect.objectContaining({
              step,
              status: stepStatus,
              detail: "initiating failure remains distinct",
            }),
          );
        }
        expect(store.read(helper.installRoot).kind).toBe("absent");
        expect(store.isProcessIdentityCurrent(current.lease.helper)).toBe(false);
        expect(store.isProcessIdentityCurrent(current.lease.executor)).toBe(false);
        expect(parent.exitCode).toBeNull();
        expect(parent.signalCode).toBeNull();
        expect(beforePark).not.toHaveBeenCalled();
      });
    } finally {
      if (helperProcess) {
        if (helperProcess.exitCode === null && helperProcess.signalCode === null) {
          helperProcess.kill("SIGKILL");
        }
        await helperClosed;
      }
      parent.stdin?.end();
      await parentClosed;
      try {
        if (identity) {
          await handoff.cancelManagedServiceUpdateHandoff(identity);
        }
      } finally {
        closeOpenClawStateDatabaseForTest();
        spawn.mockRestore();
        pathSpy.mockRestore();
        tempSpy.mockRestore();
        if (helperLogPath) {
          await fs.rm(path.dirname(helperLogPath), { recursive: true, force: true });
        }
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  },
  45_000,
);
