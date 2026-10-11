import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveGatewayLockPaths } from "../infra/gateway-lock.js";
import { readGatewayOwnerLease } from "../infra/gateway-owner-lease.js";
import { writeGatewayRestartIntentSync } from "../infra/restart-intent.js";
import * as ancestry from "../infra/restart-stale-pids.js";
import * as tempRoot from "../infra/tmp-openclaw-dir.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "../infra/update-managed-service-handoff-lease.js";
import * as exec from "../process/exec.js";
import * as pidIdentity from "../shared/pid-alive.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import * as existingWrites from "../state/openclaw-state-db-existing-write.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import * as launchctl from "./launchd-exec.js";
import { buildLaunchAgentPlist } from "./launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import { resolveLaunchAgentPlistPath } from "./launchd-service-files.js";
import { stopLaunchAgent } from "./launchd-stop.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";
import * as serviceMembership from "./service-process-membership.js";
import { withGatewayServiceUpdateAuthority } from "./service-update-authority.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const stdout = new Writable({
  write(_chunk, _encoding, done) {
    done();
  },
});
let root: string;
let env: NodeJS.ProcessEnv;
let effectiveEnv: NodeJS.ProcessEnv;
let child: ChildProcess;
let closed: Promise<unknown>;
let pid: number;
let bootoutFailure: boolean;
let onPrint: (() => void) | undefined;
let onBootout: (() => void) | undefined;
let prints: number;
let atBootout: unknown;
let mutations: string[];
let revoked: boolean;
const label = "ai.openclaw.private-update-intent-test";
const runId = "native-intent-test-run";

function database() {
  return openOpenClawStateDatabase({ env: effectiveEnv }).db;
}
function intentRow() {
  return database().prepare("SELECT pid, reason, updated_at_ms FROM gateway_restart_intent").get();
}
function writePlist(extra: NodeJS.ProcessEnv = {}) {
  const plist = resolveLaunchAgentPlistPath(env);
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(
    plist,
    buildLaunchAgentPlist({
      label,
      programArguments: [process.execPath, path.join(root, "dist", "index.js"), "gateway"],
      stdoutPath: path.join(root, "stdout.log"),
      stderrPath: path.join(root, "stderr.log"),
      environment: { ...effectiveEnv, ...extra },
    }),
  );
}
async function stop(updateOwned = true, disable = false) {
  const invoke = () =>
    withGatewayServiceOperationLock(env, (assertCurrent) =>
      stopLaunchAgent({
        stdout,
        env,
        disable,
        assertCurrent,
        updateHandoff: { root, runId },
      }),
    );
  return updateOwned
    ? withGatewayServiceUpdateAuthority(
        () => {
          if (revoked) {
            throw new Error("update owner revoked");
          }
        },
        invoke,
        { originalRoot: root },
      )
    : invoke();
}
async function transferred() {
  const databasePath = resolveManagedUpdateLeaseDatabasePath();
  const store = createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: process.env });
  const acquired = store.acquire(root, "handoff-owner", { kind: "update" });
  expect(acquired.kind).toBe("acquired");
  if (acquired.kind !== "acquired") {
    throw new Error("fixture acquisition failed");
  }
  // A transferred lease has a distinct live helper and executor, as in native handoff.
  const payload = JSON.parse(acquired.lease.payload);
  payload.helper = store.processIdentity(pid);
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare("UPDATE managed_update_handoffs SET payload_json = ?").run(JSON.stringify(payload));
  } finally {
    db.close();
  }
  const current = store.read(root);
  if (current.kind !== "current") {
    throw new Error("fixture lease missing");
  }
  const meta = path.join(root, "handoff-meta.json");
  fs.writeFileSync(
    meta,
    JSON.stringify({ version: 1, meta: { root, runId, handoffId: "handoff-owner" } }),
  );
  env.OPENCLAW_UPDATE_RUN_HANDOFF = "1";
  env.OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META = meta;
  return { store, lease: current.lease, meta };
}

beforeEach(async () => {
  // Keep the real plist/environment reader; only native plutil transport is host-specific.
  vi.spyOn(exec, "runExec").mockImplementation(async (command, args, options) => {
    if (command !== "/usr/bin/plutil" || typeof options !== "object" || !options.input) {
      throw new Error(`Unexpected fixture subprocess: ${command}`);
    }
    return decodeLaunchAgentPlistFixture(options.input, args[1]);
  });
  root = fs.realpathSync(dirs.make("launchd-update-intent-"));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
  );
  fs.writeFileSync(path.join(root, "dist", "index.js"), "// private service definition fixture\n");
  const tmp = path.join(root, "private-tmp");
  fs.mkdirSync(tmp, { mode: 0o700 });
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(tmp);
  // Every real handoff/operation-lock access resolves here, not HOME/TMPDIR or the live store.
  expect(resolveManagedUpdateLeaseDatabasePath()).toBe(
    path.join(tmp, "managed-update-handoffs.sqlite"),
  );
  expect(fs.realpathSync(path.dirname(resolveManagedUpdateLeaseDatabasePath()))).toBe(tmp);
  env = {
    HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "caller-state"),
    OPENCLAW_LAUNCHD_LABEL: label,
  };
  effectiveEnv = {
    OPENCLAW_STATE_DIR: path.join(root, "service-state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "service.json"),
  };
  fs.writeFileSync(effectiveEnv.OPENCLAW_CONFIG_PATH!, "{}");
  // This fixture child never imports OpenClaw or opens a handoff store; only the test parent does.
  child = spawn(
    process.execPath,
    ["-e", "process.stdout.write('ready\\n'); setInterval(()=>{}, 60000)"],
    {
      env: { HOME: root, OPENCLAW_STATE_DIR: effectiveEnv.OPENCLAW_STATE_DIR },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  closed = once(child, "close");
  await once(child.stdout!, "data");
  pid = child.pid!;
  // The synthetic LaunchAgent has a live PID but no native job separate from this runner.
  vi.spyOn(ancestry, "getSelfAndAncestorPidsSync").mockReturnValue(new Set([process.pid, 1]));
  vi.spyOn(serviceMembership, "inspectServiceProcessMembershipSync").mockImplementation((target) =>
    target === pid ? "outside" : "unknown",
  );
  const startedAt = getFileLockProcessStartTime(pid);
  expect(startedAt).not.toBeNull();
  const now = Date.now();
  database()
    .prepare(`INSERT INTO state_leases
    (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
    VALUES ('gateway-owner', 'global', 'serving-owner', ?, ?, ?, ?, ?)`)
    .run(
      now + 300000,
      now,
      JSON.stringify({
        owner: { pid, host: hostname(), startedAt },
        port: 19483,
        mode: "supervised",
        supervisor: { kind: "launchd", name: label },
      }),
      now,
      now,
    );
  expect(readGatewayOwnerLease({ env: effectiveEnv, current: true })?.state).toBe("live");
  writePlist();
  bootoutFailure = false;
  onPrint = undefined;
  onBootout = undefined;
  atBootout = undefined;
  prints = 0;
  mutations = [];
  revoked = false;
  vi.spyOn(launchctl, "execLaunchctl").mockImplementation(async (args) => {
    if (args[0] === "print") {
      if (args[1]?.startsWith("system/")) {
        return { code: 113, termination: "exit", stdout: "", stderr: "Could not find service" };
      }
      prints++;
      onPrint?.();
      return isPidAlive(pid)
        ? {
            code: 0,
            termination: "exit",
            stdout: `${args[1]} = {\n\tstate = running\n\tpid = ${pid}\n}`,
            stderr: "",
          }
        : { code: 113, termination: "exit", stdout: "", stderr: "Could not find service" };
    }
    if (args[0] === "bootout" || args[0] === "disable") {
      mutations.push(args[0]);
      if (args[0] === "bootout") {
        atBootout = intentRow();
        onBootout?.();
        if (bootoutFailure) {
          return { code: 5, termination: "exit", stdout: "", stderr: "fixture bootout failure" };
        }
        await stopChildProcess(child, 5000);
        await closed;
      }
      return { code: 0, termination: "exit", stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected fixture launchctl: ${args.join(" ")}`);
  });
});

afterEach(async () => {
  await stopChildProcess(child, 5000);
  await closed;
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("managed-update LaunchAgent stop intent", () => {
  it.each(["direct-original", "transferred"])(
    "records authenticated %s intent in the effective service database before bootout",
    async (authority) => {
      if (authority === "transferred") {
        await transferred();
      }
      await stop();
      expect(atBootout).toMatchObject({ pid, reason: "update.run" });
      expect(mutations).toEqual(["bootout"]);
      expect(isPidAlive(pid)).toBe(false);
      expect(fs.existsSync(env.OPENCLAW_STATE_DIR!)).toBe(false);
    },
  );
  it.each(["unchanged", "lock-replaced", "native-pid-reused"])(
    "revalidates legacy serving identity before bootout: %s",
    async (change) => {
      database().prepare("DELETE FROM state_leases WHERE scope='gateway-owner'").run();
      const paths = resolveGatewayLockPaths(effectiveEnv);
      expect(paths.stateLockPath.startsWith(root + path.sep)).toBe(true);
      const lock = {
        pid,
        startTime: getFileLockProcessStartTime(pid),
        ownerId: "legacy-owner",
        createdAt: new Date().toISOString(),
        configPath: paths.configPath,
        stateDir: paths.stateDir,
        port: 19483,
      };
      fs.mkdirSync(path.dirname(paths.stateLockPath), { recursive: true });
      fs.writeFileSync(paths.stateLockPath, JSON.stringify(lock));
      let recorded = false;
      if (change !== "unchanged") {
        const write = existingWrites.runExistingOpenClawStateWriteTransaction;
        vi.spyOn(existingWrites, "runExistingOpenClawStateWriteTransaction").mockImplementation(
          (mutate, options, contract) => {
            const result = write(mutate, options, contract);
            if (contract.operationLabel === "gateway.restart-intent.write") {
              recorded = result === true;
              queueMicrotask(() => {
                if (change === "lock-replaced") {
                  fs.writeFileSync(
                    paths.stateLockPath,
                    JSON.stringify({ ...lock, ownerId: "legacy-successor" }),
                  );
                } else {
                  const readStart = pidIdentity.getFileLockProcessStartTime;
                  vi.spyOn(pidIdentity, "getFileLockProcessStartTime").mockImplementation(
                    (target, processEnv) => (target === pid ? 0 : readStart(target, processEnv)),
                  );
                }
              });
            }
            return result;
          },
        );
        await expect(stop()).rejects.toThrow("Cannot verify a live serving Gateway owner");
        expect(recorded).toBe(true);
        expect(mutations).toEqual([]);
        expect(intentRow()).toBeUndefined();
        expect(isPidAlive(pid)).toBe(true);
      } else {
        await stop();
        expect(atBootout).toMatchObject({ pid, reason: "update.run" });
      }
    },
  );
  it.each(["already-stopped", "explicit-stop"])(
    "does not record restart intent for %s",
    async (mode) => {
      if (mode === "already-stopped") {
        await stopChildProcess(child, 5000);
        await closed;
        database().prepare("DELETE FROM state_leases WHERE scope='gateway-owner'").run();
      } else {
        env.OPENCLAW_UPDATE_RUN_HANDOFF = "1";
      }
      await stop(mode === "already-stopped");
      expect(atBootout).toBeUndefined();
      expect(mutations).toEqual(["bootout"]);
    },
  );
  it.each(["missing", "missing-marker", "wrong-run", "replaced", "wrong-pid", "stale-process"])(
    "refuses %s transferred authority without stopping",
    async (fault) => {
      const { store, lease, meta } = await transferred();
      if (fault === "missing-marker") {
        delete env.OPENCLAW_UPDATE_RUN_HANDOFF;
      }
      if (fault === "missing") {
        fs.rmSync(meta);
      }
      if (fault === "wrong-run") {
        fs.writeFileSync(
          meta,
          JSON.stringify({
            version: 1,
            meta: { root, runId: "wrong", handoffId: "handoff-owner" },
          }),
        );
      }
      if (fault === "replaced") {
        // Fault injection represents replacement by the helper, not an executor's release grant.
        const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
        try {
          db.prepare("UPDATE managed_update_handoffs SET owner='replacement'").run();
        } finally {
          db.close();
        }
      }
      if (fault === "stale-process" || fault === "wrong-pid") {
        const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
        try {
          const payload = JSON.parse(lease.payload);
          payload.executor =
            fault === "wrong-pid"
              ? store.processIdentity(pid)
              : { pid: process.pid, startIdentity: "0" };
          db.prepare("UPDATE managed_update_handoffs SET payload_json = ?").run(
            JSON.stringify(payload),
          );
        } finally {
          db.close();
        }
      }
      await expect(stop()).rejects.toThrow("Refusing to stop");
      expect(mutations).toEqual([]);
      expect(intentRow()).toBeUndefined();
      expect(isPidAlive(pid)).toBe(true);
    },
  );
  it.each([
    ["foreign-pid", "Cannot verify a live serving Gateway owner"],
    ["replaced-during-probe", "Cannot verify a live serving Gateway owner"],
    ["missing-command", "Effective LaunchAgent service command could not be inspected."],
    ["revoked", "update owner revoked"],
    ["replaced-after-intent", "Cannot verify a live serving Gateway owner"],
    ["storage-failure", "Cannot record restart intent"],
  ])("preserves runtime and intent when preparation fails: %s", async (fault, error) => {
    if (fault === "foreign-pid") {
      const row = database()
        .prepare("SELECT payload_json FROM state_leases WHERE scope='gateway-owner'")
        .get()!;
      const payload = JSON.parse(String(row.payload_json));
      payload.owner = {
        pid: process.pid,
        host: hostname(),
        startedAt: getFileLockProcessStartTime(process.pid),
      };
      database()
        .prepare("UPDATE state_leases SET payload_json=? WHERE scope='gateway-owner'")
        .run(JSON.stringify(payload));
    } else if (fault === "missing-command") {
      fs.rmSync(resolveLaunchAgentPlistPath(env));
    } else if (fault === "replaced-during-probe" || fault === "revoked") {
      onPrint = () => {
        if (prints !== 3) {
          return;
        }
        if (fault === "revoked") {
          revoked = true;
        } else {
          database()
            .prepare("UPDATE state_leases SET owner='new-owner' WHERE scope='gateway-owner'")
            .run();
        }
      };
    } else {
      const write = existingWrites.runExistingOpenClawStateWriteTransaction;
      vi.spyOn(existingWrites, "runExistingOpenClawStateWriteTransaction").mockImplementation(
        (mutate, options, contract) => {
          if (
            fault === "storage-failure" &&
            contract.operationLabel === "gateway.restart-intent.write"
          ) {
            throw new Error("fixture storage unavailable");
          }
          const result = write(mutate, options, contract);
          if (contract.operationLabel === "gateway.restart-intent.write") {
            queueMicrotask(() =>
              database()
                .prepare("UPDATE state_leases SET owner='successor' WHERE scope='gateway-owner'")
                .run(),
            );
          }
          return result;
        },
      );
    }
    await expect(stop(true, fault === "missing-command")).rejects.toThrow(error);
    expect(mutations).toEqual([]);
    expect(intentRow()).toBeUndefined();
    expect(isPidAlive(pid)).toBe(true);
  });
  it.each(["none", "legacy", "successor", "update.run"])(
    "clears only its own intent on failed bootout (successor=%s)",
    async (writer) => {
      bootoutFailure = true;
      if (writer !== "none") {
        onBootout = () => {
          if (writer === "legacy") {
            // Published writers use wall-clock timestamps, not monotonic increments.
            database().prepare("UPDATE gateway_restart_intent SET reason='gateway.restart'").run();
          } else {
            vi.spyOn(Date, "now").mockReturnValue(
              (atBootout as { updated_at_ms: number }).updated_at_ms,
            );
            expect(
              writeGatewayRestartIntentSync({ env: effectiveEnv, targetPid: pid, reason: writer }),
            ).toBe(true);
          }
        };
      }
      await expect(stop()).rejects.toThrow("fixture bootout failure");
      expect(atBootout).toMatchObject({ pid, reason: "update.run" });
      expect(isPidAlive(pid)).toBe(true);
      if (writer === "none") {
        expect(intentRow()).toBeUndefined();
      } else {
        expect(intentRow()).toMatchObject({
          pid,
          reason: writer === "legacy" ? "gateway.restart" : writer,
        });
      }
    },
  );
});
