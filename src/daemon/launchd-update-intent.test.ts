import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import { resolveGatewayLockPaths } from "../infra/gateway-lock.js";
import { readGatewayOwnerLease } from "../infra/gateway-owner-lease.js";
import { writeGatewayRestartIntentSync } from "../infra/restart-intent.js";
import * as tempRoot from "../infra/tmp-openclaw-dir.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "../infra/update-managed-service-handoff-lease.js";
import * as exec from "../process/exec.js";
import * as pidIdentity from "../shared/pid-alive.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import * as existingWrites from "../state/openclaw-state-db-existing-write.js";
import * as stateDb from "../state/openclaw-state-db.js";
import * as launchctl from "./launchd-exec.js";
import { buildLaunchAgentPlist } from "./launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import { resolveLaunchAgentPlistPath } from "./launchd-service-files.js";
import { stopLaunchAgent } from "./launchd-stop.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";
import * as serviceMembership from "./service-process-membership.js";
import { withGatewayServiceUpdateAuthority } from "./service-update-authority.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const stdout = new Writable({ write: (_chunk, _encoding, done) => done() });
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
const ownerError = "Cannot verify a live serving Gateway owner";

const database = () => stateDb.openOpenClawStateDatabase({ env: effectiveEnv }).db;
const intentRow = () =>
  database().prepare("SELECT pid, reason, updated_at_ms FROM gateway_restart_intent").get();
const run = (sql: string, ...params: SQLInputValue[]) =>
  database()
    .prepare(sql)
    .run(...params);
const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
function servingPayload(ownerPid = pid) {
  return {
    owner: {
      pid: ownerPid,
      host: hostname(),
      startedAt: getFileLockProcessStartTime(ownerPid),
      processNamespace: readGatewayLockProcessNamespace(),
    },
    port: 19483,
    mode: "supervised",
    supervisor: { kind: "launchd", name: label },
  };
}
function mutateHandoff(sql: string, ...params: SQLInputValue[]) {
  using db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
  db.prepare(`UPDATE managed_update_handoffs SET ${sql}`).run(...params);
}
function replaceOwner(owner: string) {
  run("UPDATE state_leases SET owner=? WHERE scope='gateway-owner'", owner);
}
function expectPreserved() {
  expect([mutations, intentRow(), isPidAlive(pid)]).toEqual([[], undefined, true]);
}
function interceptIntent(after: (recorded: boolean) => void, fail = false) {
  const write = existingWrites.runExistingOpenClawStateWriteTransaction;
  vi.spyOn(existingWrites, "runExistingOpenClawStateWriteTransaction").mockImplementation(
    (mutate, options, contract) => {
      const intent = contract.operationLabel === "gateway.restart-intent.write";
      if (intent && fail) {
        throw new Error("fixture storage unavailable");
      }
      const result = write(mutate, options, contract);
      if (intent) {
        after(result === true);
      }
      return result;
    },
  );
}
const nativeResult = (code: number, output = "", stderr = "") => ({
  code,
  stdout: output,
  stderr,
  termination: "exit" as const,
});
const notLoaded = () => nativeResult(113, "", "Could not find service");
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
  if (acquired.kind !== "acquired") {
    throw new Error("fixture acquisition failed");
  }
  // A transferred lease has a distinct live helper and executor, as in native handoff.
  const payload = JSON.parse(acquired.lease.payload);
  payload.helper = store.processIdentity(pid);
  mutateHandoff("payload_json = ?", JSON.stringify(payload));
  const meta = path.join(root, "handoff-meta.json");
  writeJson(meta, { version: 1, meta: { root, runId, handoffId: "handoff-owner" } });
  env.OPENCLAW_UPDATE_RUN_HANDOFF = "1";
  env.OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META = meta;
  return { store, payload, meta };
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
  writeJson(path.join(root, "package.json"), { name: "openclaw", version: "2026.9.4" });
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
  vi.spyOn(serviceMembership, "inspectServiceProcessMembershipSync").mockImplementation((target) =>
    target === pid ? "outside" : "unknown",
  );
  const serving = servingPayload();
  expect(serving.owner.startedAt).not.toBeNull();
  const now = Date.now();
  const insertOwner = `INSERT INTO state_leases
    (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
    VALUES ('gateway-owner', 'global', 'serving-owner', ?, ?, ?, ?, ?)`;
  run(insertOwner, now + 300000, now, JSON.stringify(serving), now, now);
  expect(readGatewayOwnerLease({ env: effectiveEnv, current: true })?.state).toBe("live");
  const plist = resolveLaunchAgentPlistPath(env);
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(
    plist,
    buildLaunchAgentPlist({
      label,
      programArguments: [process.execPath, path.join(root, "dist", "index.js"), "gateway"],
      stdoutPath: path.join(root, "stdout.log"),
      stderrPath: path.join(root, "stderr.log"),
      environment: effectiveEnv,
    }),
  );
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
        return notLoaded();
      }
      prints++;
      onPrint?.();
      return isPidAlive(pid)
        ? nativeResult(0, `${args[1]} = {\n\tstate = running\n\tpid = ${pid}\n}`)
        : notLoaded();
    }
    if (args[0] === "bootout" || args[0] === "disable") {
      mutations.push(args[0]);
      if (args[0] === "bootout") {
        atBootout = intentRow();
        onBootout?.();
        if (bootoutFailure) {
          return nativeResult(5, "", "fixture bootout failure");
        }
        await stopChildProcess(child, 5000);
        await closed;
      }
      return nativeResult(0);
    }
    throw new Error(`Unexpected fixture launchctl: ${args.join(" ")}`);
  });
});

afterEach(async () => {
  await stopChildProcess(child, 5000);
  await closed;
  stateDb.closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

it.each(["direct-original", "transferred", "already-stopped", "explicit-stop"])(
  "%s stop records intent only for an authenticated running updater",
  async (mode) => {
    const authentic = mode === "direct-original" || mode === "transferred";
    if (mode === "transferred") {
      await transferred();
    } else if (mode === "already-stopped") {
      await stopChildProcess(child, 5000);
      await closed;
      run("DELETE FROM state_leases WHERE scope='gateway-owner'");
    } else if (mode === "explicit-stop") {
      env.OPENCLAW_UPDATE_RUN_HANDOFF = "1";
    }
    await stop(mode !== "explicit-stop");
    expect(atBootout).toEqual(
      authentic ? expect.objectContaining({ pid, reason: "update.run" }) : undefined,
    );
    expect(mutations).toEqual(["bootout"]);
    expect(isPidAlive(pid)).toBe(false);
    if (authentic) {
      expect(fs.existsSync(env.OPENCLAW_STATE_DIR!)).toBe(false);
    }
  },
);
it.each(["unchanged", "lock-replaced", "native-pid-reused"])(
  "revalidates legacy serving identity before bootout: %s",
  async (change) => {
    run("DELETE FROM state_leases WHERE scope='gateway-owner'");
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
    writeJson(paths.stateLockPath, lock);
    let recorded = false;
    if (change !== "unchanged") {
      interceptIntent((result) => {
        recorded = result;
        queueMicrotask(() => {
          if (change === "lock-replaced") {
            writeJson(paths.stateLockPath, { ...lock, ownerId: "legacy-successor" });
          } else {
            const readStart = pidIdentity.getFileLockProcessStartTime;
            vi.spyOn(pidIdentity, "getFileLockProcessStartTime").mockImplementation(
              (target, processEnv) => (target === pid ? 0 : readStart(target, processEnv)),
            );
          }
        });
      });
      await expect(stop()).rejects.toThrow(ownerError);
      expect(recorded).toBe(true);
      expectPreserved();
    } else {
      await stop();
      expect(atBootout).toMatchObject({ pid, reason: "update.run" });
    }
  },
);
it.each(["missing", "missing-marker", "wrong-run", "replaced", "wrong-pid", "stale-process"])(
  "refuses %s transferred authority without stopping",
  async (fault) => {
    const { store, payload, meta } = await transferred();
    if (fault === "missing-marker") {
      delete env.OPENCLAW_UPDATE_RUN_HANDOFF;
    }
    if (fault === "missing") {
      fs.rmSync(meta);
    }
    if (fault === "wrong-run") {
      writeJson(meta, { version: 1, meta: { root, runId: "wrong", handoffId: "handoff-owner" } });
    }
    if (fault === "replaced") {
      // Fault injection represents replacement by the helper, not an executor's release grant.
      mutateHandoff("owner='replacement'");
    }
    if (fault === "stale-process" || fault === "wrong-pid") {
      payload.executor =
        fault === "wrong-pid"
          ? store.processIdentity(pid)
          : { pid: process.pid, startIdentity: "0" };
      mutateHandoff("payload_json = ?", JSON.stringify(payload));
    }
    await expect(stop()).rejects.toThrow("Refusing to stop");
    expectPreserved();
  },
);
it.each([
  ["foreign-pid", ownerError],
  ["replaced-during-probe", ownerError],
  ["missing-command", "Effective LaunchAgent service command could not be inspected."],
  ["revoked", "update owner revoked"],
  ["replaced-after-intent", ownerError],
  ["storage-failure", "Cannot record restart intent"],
])("preserves runtime and intent when preparation fails: %s", async (fault, error) => {
  if (fault === "foreign-pid") {
    run(
      "UPDATE state_leases SET payload_json=? WHERE scope='gateway-owner'",
      JSON.stringify(servingPayload(process.pid)),
    );
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
        replaceOwner("new-owner");
      }
    };
  } else {
    interceptIntent(
      () => queueMicrotask(() => replaceOwner("successor")),
      fault === "storage-failure",
    );
  }
  await expect(stop(true, fault === "missing-command")).rejects.toThrow(error);
  expectPreserved();
});
it.each(["none", "legacy", "successor", "update.run"])(
  "clears only its own intent on failed bootout (successor=%s)",
  async (writer) => {
    bootoutFailure = true;
    if (writer !== "none") {
      onBootout = () => {
        if (writer === "legacy") {
          // Published writers use wall-clock timestamps, not monotonic increments.
          run("UPDATE gateway_restart_intent SET reason='gateway.restart'");
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
    expect(intentRow()).toEqual(
      writer === "none"
        ? undefined
        : expect.objectContaining({
            pid,
            reason: writer === "legacy" ? "gateway.restart" : writer,
          }),
    );
  },
);
