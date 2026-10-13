// Readiness/transfer timeouts finish before online staging, validation and ten-minute repair.
// Native activation requires exact parent exit; foreground activation joins server/lock closure.
// Both use the same prepared helper before activation, migration and successor verification.
// No-op updates and failed validation leave the serving parent untouched.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatInstallationTargetCommand } from "../cli/installation-target-format.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { resolveSystemdServiceName } from "../daemon/systemd-service-files.js";
import { forceKillChildProcessTree } from "../process/child-process-tree.js";
import {
  GatewayDrainingError,
  isGatewayRestartDraining,
} from "../process/gateway-work-admission.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { SKIPPED_UPDATE_OUTCOMES } from "../shared/update-outcome.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { resolveExecutableFromPathEnv } from "./executable-path.js";
import { readActiveGatewayLockIdentity } from "./gateway-lock.js";
import { readGatewayOwnerLease } from "./gateway-owner-lease.js";
import { resolveInstallationTarget } from "./installation-target-context.js";
import { resolveNodeSqliteLocation } from "./node-sqlite.js";
import { resolveOpenClawCliEntryPath } from "./openclaw-cli-invocation.js";
import { probePortUsage } from "./ports-probe.js";
import type { GatewayRestartIntent } from "./restart-intent.js";
import { resolveRuntimeArgs } from "./runtime-worker-url.js";
import {
  readControlPlaneUpdateSentinelMeta,
  MANAGED_SERVICE_UPDATE_UNSAFE_EXIT_CODE,
  UPDATE_RUN_ID_ENV,
  type ControlPlaneUpdateSentinelMetaFile,
} from "./update-control-plane-sentinel.js";
import { applyDevUpdateTargetEnv } from "./update-dev-target.js";
import { resolvePnpmGlobalInstallOwner, verifyPackageUpdateRecovery } from "./update-global.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";
import { MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX } from "./update-managed-service-handoff-cleanup.js";
import { MANAGED_HANDOFF_COMMAND_SOURCE } from "./update-managed-service-handoff-command-source.js";
import {
  formatManagedServiceUpdateCommand,
  resolveManagedServiceCliArgv,
  resolveUpdateCliArgv,
} from "./update-managed-service-handoff-command.js";
import {
  createHandoffLineReader,
  HANDOFF_OWNED_COMMAND_SCRIPT,
  HANDOFF_NOTICE_MARKER,
  HANDOFF_PARK_ADMITTED_MARKER,
  unrefHandoffPipe,
  waitForHandoffResponse,
  type HandoffChild,
} from "./update-managed-service-handoff-control.js";
import {
  activeManagedServiceUpdateHandoffs,
  isCurrentManagedServiceUpdateHandoffProcess,
  readManagedServiceUpdateHandoffLease,
} from "./update-managed-service-handoff-current.js";
import {
  assertManagedUpdateLeaseDatabaseIdentity,
  prepareManagedHandoffLeaseDatabaseIdentity,
} from "./update-managed-service-handoff-database.js";
import { MANAGED_HANDOFF_LEASE_SOURCE } from "./update-managed-service-handoff-lease-source.js";
import {
  prepareManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "./update-managed-service-handoff-lease.js";
import { MANAGED_HANDOFF_NATIVE_SCOPE_SOURCE } from "./update-managed-service-handoff-native-scope-source.js";
import {
  prepareManagedHandoffCliRuntime,
  resolveManagedHandoffNodeExecutable,
} from "./update-managed-service-handoff-node.js";
import { MANAGED_HANDOFF_PARENT_SOURCE } from "./update-managed-service-handoff-parent-source.js";
import { MANAGED_HANDOFF_RESULT_SOURCE } from "./update-managed-service-handoff-result-source.js";
import { MANAGED_HANDOFF_RUNTIME_ENTRY } from "./update-managed-service-handoff-runtime-assets.js";
import { stageManagedHandoffRuntime } from "./update-managed-service-handoff-runtime.js";
import {
  resolveGatewayServiceRecovery,
  admitSystemdUpdate,
  observeManagedServiceUpdateHandoffClose,
  resolveManagedHandoffCommandEnv,
  SYSTEM_SERVICE_UPDATE_SETTLED_MARKER,
} from "./update-managed-service-handoff-service.js";
import type {
  ActiveManagedServiceUpdateHandoff,
  ManagedServiceUpdateHandoffParams,
  ManagedServiceUpdateHandoffResult,
} from "./update-managed-service-handoff-types.js";
import { resolveManagedUpdateRequester } from "./update-requester-authority.js";
import type { ForegroundUpdateOrigin } from "./update-restart-sentinel-payload.js";
import { createUpdateRunProcessIdentityWarning } from "./update-run-write.async.js";
import { readCurrentGitUpdateRecovery } from "./update-runner-git-recovery.js";
import { looksLikeGitCheckout } from "./update-runner-install-surface.js";

// The activation deadline covers Gateway drain plus this shutdown reserve.
const PARENT_EXIT_SHUTDOWN_RESERVE_MS = 30_000;
const HANDOFF_READY_MARKER = "OPENCLAW_UPDATE_HANDOFF_READY\n";
const HANDOFF_BUSY_MARKER = "HANDOFF_BUSY ";
const HANDOFF_SCRIPT = String.raw`
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const params = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
const requiresRequesterAcknowledgement = params.requester?.authorizationSource?.startsWith("profile:") === true;

function appendLog(line) {
  try {
    fs.mkdirSync(path.dirname(params.logPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(params.logPath, "[" + new Date().toISOString() + "] " + line + "\n", {
      mode: 0o600,
    });
  } catch {
    // Best effort only.
  }
}

const { OPENCLAW_STATE_SCHEMA_SQL, assertOpenClawStateWriteAllowed, prepareManagedHandoffLeaseStore, extractSqliteTableSchema, readRestartSentinelRowSync, writeRestartSentinelRowIfRevisionSync, resolveImmutableSqliteFileUri, resolveUpdateRestartNoticeMeta, shouldPublishUpdateRestartNotice, procCgroupMembershipMatches } =
  require("./runtime/${MANAGED_HANDOFF_RUNTIME_ENTRY}");
if (!params.updateLeaseDatabaseIdentity) {
  throw new Error("Managed handoff requires its prepared lease database identity");
}
let leaseStore;
let isPidAlive, parseSystemdProperties, validTriageFailure;
const runWarnings = new Map();
if (params.operatorRestartWarning) runWarnings.set("warning:managed-service-reconciliation", params.operatorRestartWarning);
function recordRunWarnings(ledger) {
  if (!params.runId) return;
  for (const [step, detail] of runWarnings) {
    try {
      ledger.recordUpdateRunStep(params.runId, { step, status: "completed", detail, endedAtMs: Date.now() });
      runWarnings.delete(step);
    } catch { /* The candidate runtime records warnings after state migration. */ }
  }
}
let managedUpdateLease = null;
let triageRequesterAuthority;
function assertTriageRequester() {
  if (triageRequesterAuthority && !triageRequesterAuthority.isCurrent())
    throw new Error("requester-revoked");
}
let activeCommand;
let finalExitCode = 0;
let updateCancelled = false;
let terminationRequested = false;
let wakeTermination;
let transferred = false;
let updateRequesterIdentity;
let activationRejected;
${MANAGED_HANDOFF_LEASE_SOURCE}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupSensitiveFiles() {
  for (const filePath of params.sensitivePaths || []) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best effort only.
    }
  }
}


function assertStateDatabaseWriteAllowed(database) {
  if (
    !params.stateDatabasePath ||
    typeof params.stateDatabasePath !== "string" ||
    (!database && !fs.existsSync(params.stateDatabasePath))
  ) {
    return;
  }
  const ownsDatabase = !database;
  let db = database;
  if (!db) {
    const sqlite = require("node:sqlite");
    db = new sqlite.DatabaseSync(resolveImmutableSqliteFileUri(params.stateDatabasePath), {
      readOnly: true,
    });
  }
  try {
    if (ownsDatabase) {
      db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
    }
    assertOpenClawStateWriteAllowed({ database: db, databasePath: params.stateDatabasePath });
  } finally {
    if (ownsDatabase) {
      db.close();
    }
  }
}

function openStateDatabase() {
  if (!params.stateDatabasePath || typeof params.stateDatabasePath !== "string") {
    return null;
  }
  let db = null;
  try {
    assertStateDatabaseWriteAllowed();
    const sqlite = require("node:sqlite");
    fs.mkdirSync(path.dirname(params.stateDatabasePath), { recursive: true, mode: 0o700 });
    db = new sqlite.DatabaseSync(params.nodeSqliteLocation);
    db.exec("PRAGMA busy_timeout = 5000;");
    leaseStore.transact(db, () => {
      assertStateDatabaseWriteAllowed(db);
      db.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "gateway_restart_sentinel", {
        endMarker: "ON gateway_restart_sentinel(ts DESC, sentinel_key);",
      }));
      const columns = new Set(
        db
          .prepare("PRAGMA table_info(gateway_restart_sentinel)")
          .all()
          .map((row) => row.name),
      );
      for (const column of [
        "delivery_channel",
        "delivery_to",
        "delivery_account_id",
        "message",
        "continuation_json",
        "doctor_hint",
        "stats_json",
      ]) {
        if (!columns.has(column))
          db.exec("ALTER TABLE gateway_restart_sentinel ADD COLUMN " + column + " TEXT;");
      }
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          fs.chmodSync(params.stateDatabasePath + suffix, 0o600);
        } catch {}
      }
    });
    return db;
  } catch (err) {
    try {
      db?.close();
    } catch {}
    appendLog(
      "failed to open restart sentinel database: " + (err && err.stack ? err.stack : String(err)),
    );
    return null;
  }
}


${MANAGED_HANDOFF_RESULT_SOURCE}

${MANAGED_HANDOFF_COMMAND_SOURCE}

${MANAGED_HANDOFF_NATIVE_SCOPE_SOURCE}

process.on("SIGTERM", () => {
  if (terminationRequested) return;
  terminationRequested = true;
  appendLog("managed handoff termination requested; waiting for owned command settlement");
  if (params.action === "triage") {
    if (managedUpdateLease) leaseStore.settle(managedUpdateLease, "closing");
    appendLog("automatic triage cancelled by termination signal; no Gateway restoration");
    stopTriageScope();
  } else if (activeCommand && activeCommand.exitCode === null && activeCommand.signalCode === null) {
    // The updater owns rollback and accepted writes. Signal only its direct process,
    // then join its result before releasing the lease or deciding native recovery.
    activeCommand.kill("SIGTERM");
  }
  finishBeforeParkNotice?.("disconnected");
  wakeTermination?.();
});

async function enterTriageAfterUpdate(continuation) {
  if (terminationRequested) return;
  if (
    !ownsManagedUpdateLease() ||
    managedUpdateLease.action.kind !== "update" ||
    params.serviceRecovery?.kind !== "systemd" ||
    typeof process.execve !== "function"
  ) {
    appendLog("automatic triage continuation unavailable; run openclaw triage manually");
    return;
  }
  const primary = await inspectSystemdService(params.serviceRecovery.unit);
  if (terminationRequested) return;
  if (
    primary?.Id !== params.serviceRecovery.unit ||
    primary.LoadState !== "loaded" ||
    !parkedServiceFragment ||
    primary.FragmentPath !== parkedServiceFragment ||
    !ownsManagedUpdateLease()
  ) {
    appendLog(
      "automatic triage could not verify the installed service after update restoration; run openclaw triage manually",
    );
    return;
  }
  const scopeUnit = params.scopeUnit.replace(/^openclaw-update-/, "openclaw-triage-");
  const action = {
    kind: "triage", phase: "reserved",
    lifetime: { kind: "native", unit: params.serviceRecovery.unit, scope: scopeUnit, placement: { kind: "pending" } },
  };
  // execve replaces this process without running its finally; finish the
  // original update before transferring installation ownership to triage.
  await finishManagedUpdateRun();
  if (terminationRequested) return;
  if (!ownsManagedUpdateLease()) {
    appendLog("automatic triage lost its completed update owner; run openclaw triage manually");
    return;
  }
  let retargeted;
  try {
    retargeted = leaseStore.retarget(managedUpdateLease, continuation.failure.installationRoot, action);
  } catch (error) {
    appendLog("automatic triage destination admission failed: " + String(error) + "; run openclaw triage manually");
    return;
  }
  if (!retargeted) {
    appendLog("automatic triage lost its completed update owner; run openclaw triage manually");
    return;
  }
  if (retargeted.kind === "busy") {
    appendLog("automatic triage already owned for the installed destination; retaining the original update failure");
    return;
  }
  managedUpdateLease = retargeted.lease;
  params.updateLeaseKey = retargeted.lease.key;
  // Pre-attachment work keeps update semantics; no past STOP is inferred. Native
  // attachment starts triage cancellation, before readiness or any fixing action.
  // Close this outer restoration permanently before entering that revocable scope.
  restorationArmed = false;
  Object.assign(params, {
    action: "triage",
    runId: undefined,
    triageTransition: true,
    failure: continuation.failure,
    commandArgv: continuation.commandArgv,
    commandLabel: "openclaw triage (automatic)",
    scopeUnit,
    primaryFragment: primary.FragmentPath,
  });
  fs.writeFileSync(process.argv[2], JSON.stringify(params), { mode: 0o600 });
  const command = params.systemdRun;
  const argv = [
    command,
    "--user",
    "--scope",
    "--collect",
    "--unit=" + scopeUnit,
    "--property=PartOf=" + params.serviceRecovery.unit,
    process.execPath,
    ...params.runtimeArgs,
    process.argv[1],
    process.argv[2],
  ];
  const triageEnv = { ...process.env };
  delete triageEnv[${JSON.stringify(UPDATE_RUN_ID_ENV)}];
  if (terminationRequested || !ownsManagedUpdateLease()) return;
  process.execve(command, argv, triageEnv);
}

function isLaunchdNotLoaded(result) {
  return /no such process|could not find service|not found/i.test(result.stderr || result.stdout);
}

const parseLaunchdPid = (stdout) => Number(/^\s*pid\s*=\s*([1-9]\d*)\s*$/im.exec(stdout)?.[1]);

let parkedServiceGeneration = null;
let parkedServiceInvocation = null;
let parkedServiceFragment = null;
let restorationArmed = false;
let updaterStarted = false;
let pendingServiceStop;
let finishBeforeParkNotice;

function isParkedSystemdGeneration(current, allowCleared = false) {
  return (current?.ExecMainStartTimestampMonotonic === parkedServiceGeneration &&
    current?.InvocationID === parkedServiceInvocation) ||
    (allowCleared && current?.ExecMainStartTimestampMonotonic === "0" && !current?.InvocationID);
}

function recordServiceStop() {
  serviceStoppedAtMs ??= Date.now();
  // Both native stop observations retain the updater phase; they do not own activation.
  pendingServiceStop?.then((stopped) => {
    runLedger?.recordUpdateRunStep(params.runId, {
      step: "service-stop", status: stopped.code === 0 || (params.serviceRecovery?.kind === "launchd" && isLaunchdNotLoaded(stopped)) ? "completed" : "failed", endedAtMs: Date.now(),
    });
  }).catch((error) => appendLog("could not record service stop completion: " + String(error)));
  try {
    const metaFile = JSON.parse(fs.readFileSync(params.metaPath, "utf-8"));
    metaFile.meta.serviceStoppedAtMs ??= serviceStoppedAtMs;
    fs.writeFileSync(params.metaPath, JSON.stringify(metaFile), { mode: 0o600 });
    runLedger?.recordUpdateRunStep(params.runId, {
      step: "service-stop", status: "in_progress", startedAtMs: metaFile.meta.serviceStoppedAtMs,
    });
  } catch (error) {
    appendLog("could not record service stop time: " + String(error));
  }
}

function assertGatewayParkOwner() {
  if (terminationRequested || updateCancelled || (params.foregroundOrigin && activationRejected) || !ownsManagedUpdateLease() ||
    !parentIdentityCurrent()) {
    throw new Error("managed update activation no longer owns the serving gateway");
  }
}

async function parkGatewayService() {
  if (params.operatorRestartWarning) throw new Error(params.operatorRestartWarning);
  const recovery = params.serviceRecovery;
  if (!recovery) return;
  assertGatewayParkOwner();
  if (recovery.kind === "schtasks") {
    await prepareTransferredGateway();
    assertGatewayParkOwner();
    pendingServiceStop = runServiceCommand("schtasks.exe", ["/End", "/TN", recovery.taskName], () => {
      restorationArmed = true;
      recordServiceStop();
    }, params.parentExitDeadlineAt, params.parentExitTimeoutMs);
    if ((await pendingServiceStop).code !== 0) throw new Error("scheduled task stop failed");
    return;
  }
  const systemd = recovery.kind === "systemd";
  let target;
  if (systemd) {
    const current = await inspectSystemdService(recovery.unit, params.parentExitDeadlineAt);
    if (
      !current ||
      current.Id !== recovery.unit ||
      current.LoadState !== "loaded" ||
      current.ActiveState !== "active" ||
      current.MainPID !== String(params.parentPid) ||
      !/^[1-9]\d*$/.test(current.ExecMainStartTimestampMonotonic || "") ||
      !/^[a-f0-9]{32}$/i.test(current.InvocationID || "")) {
      throw new Error("systemd service does not match the exact active gateway parent");
    }
    assertGatewayParkOwner();
    parkedServiceGeneration = current.ExecMainStartTimestampMonotonic;
    parkedServiceInvocation = current.InvocationID;
    parkedServiceFragment = current.FragmentPath;
  } else {
    if (recovery.kind !== "launchd") throw new Error("unsupported managed update supervisor");
    target = "gui/" + recovery.uid + "/" + recovery.label;
    const inspection = await runServiceCommand("launchctl", ["print", target], undefined, params.parentExitDeadlineAt);
    if (inspection.code !== 0 || parseLaunchdPid(inspection.stdout) !== params.parentPid) {
      throw new Error("launchd service does not match the exact active gateway parent");
    }
    assertGatewayParkOwner();
  }
  await prepareTransferredGateway();
  assertGatewayParkOwner();
  if (!systemd) {
    restorationArmed = true;
    const disabled = await runServiceCommand("launchctl", ["disable", target], undefined, params.parentExitDeadlineAt);
    if (disabled.code !== 0) throw new Error("launchctl disable failed: " + disabled.stderr);
    assertGatewayParkOwner();
  }
  // Accepted spawn acknowledges parking; the exact stop stays open through parent exit.
  await new Promise((resolve, reject) => {
    pendingServiceStop = runServiceCommand(
      systemd ? "systemctl" : "launchctl",
      systemd ? ["--user", "stop", recovery.unit] : ["bootout", target],
      () => {
        if (systemd) restorationArmed = true;
        recordServiceStop();
        resolve();
      },
      params.parentExitDeadlineAt,
      systemd ? params.parentExitTimeoutMs : undefined,
    );
    pendingServiceStop.then((result) => {
      if (systemd ? !restorationArmed : result.code !== 0 && !isLaunchdNotLoaded(result)) {
        reject(new Error((systemd ? "systemd stop" : "launchctl bootout") + " failed: " + result.stderr));
      }
    });
  });
}

async function restoreGatewayService(reason, decision = params.recovery, childStatus, previousGeneration = false) {
  if (managedUpdateLease?.action.kind !== "update" || !ownsManagedUpdateLease()) return false;
  let expectedRevision;
  const record = (restored) => recordUpdateHandoffOutcome(
    restored ? reason : "managed-service-handoff-restore-failed", restored, childStatus, expectedRevision,
  );
  const refuse = (message) => {
    if (message) appendLog(message);
    record(false);
    return false;
  };
  if (decision?.serviceRestartSafe !== true || !decision.version) {
    return refuse("recovery refused: original runtime identity could not be verified");
  }
  const expectedVersion = decision.version;
  const expectedBuildId = decision.buildId;
  const recovery = params.serviceRecovery;
  let restored = false;
  let serviceRunning;
  let servicePid;
  const ownsRecovery = () => {
    try { return ownsManagedUpdateLease() && fs.realpathSync(params.updateLeaseKey) === params.updateLeaseKey; }
    catch { return false; }
  };
  const runOwned = (...args) => ownsRecovery()
    ? runServiceCommand(...args) : Promise.resolve({ code: 1, stdout: "", stderr: "recovery ownership lost" });
  const restart = () => runOwnedUpdateCommand("recovery", params.recoveryCommandArgv,
    params.recoveryTimeoutMs, params.cwd, previousGeneration
      ? { ...process.env, OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1" } : process.env);
  if (!ownsRecovery()) return false;
  // Activation may consume or replace the notification. Annotate only the
  // observed revision; notification persistence never decides recovery safety.
  if (childStatus) expectedRevision = recordUpdateHandoffOutcome(reason, undefined, childStatus);
  if (recovery?.kind === "systemd") {
    if (!pendingServiceStop || (await pendingServiceStop).code !== 0) {
      return refuse("recovery refused: exact systemd stop did not complete");
    }
    const parked = await inspectSystemdService(recovery.unit);
    // A Gateway that exits non-zero during the stop (KillMode=mixed) settles the unit
    // into ActiveState=failed with the parked identity retained; that is still the
    // exact parked generation and recovery stays safe. An owned candidate boot can
    // advance inactive-unit metadata. Only a verified full-generation rollback
    // permits recovering that later stopped invocation.
    if (!parked || parked.Id !== recovery.unit || parked.LoadState !== "loaded" ||
      (parked.ActiveState !== "inactive" && parked.ActiveState !== "failed") ||
      parked.MainPID !== "0" || !(previousGeneration || isParkedSystemdGeneration(parked, true)) ||
      !ownsRecovery()) {
      return refuse("recovery refused: parked systemd service identity changed or stop is incomplete");
    }
    const started = childStatus
      ? await restart()
      : await runOwned("systemctl", ["--user", "start", recovery.unit]);
    const current = ownsRecovery() && await inspectSystemdService(recovery.unit);
    const pid = /^[1-9]\d*$/.test(current?.MainPID || "") ? Number(current.MainPID) : undefined;
    serviceRunning = current && current.Id === recovery.unit
      ? current.ActiveState === "active" && isPidAlive(pid) : undefined;
    servicePid = serviceRunning ? pid : undefined;
    restored = !started.signal && started.code === 0 && Boolean(current && current.Id === recovery.unit &&
      current.LoadState === "loaded" && current.ActiveState === "active" &&
      /^[1-9]\d*$/.test(current.MainPID || "") && current.MainPID !== String(params.parentPid) &&
      isPidAlive(Number(current.MainPID)) &&
      /^[1-9]\d*$/.test(current.ExecMainStartTimestampMonotonic || "") &&
      current.ExecMainStartTimestampMonotonic !== parkedServiceGeneration);
  } else if (recovery?.kind === "launchd") {
    const target = "gui/" + recovery.uid + "/" + recovery.label;
    const deadline = Date.now() + params.recoveryTimeoutMs;
    const run = (args) => runOwned("launchctl", args, undefined, deadline);
    const before = await run(["print", target]);
    if (before.code === 0) {
      const pid = parseLaunchdPid(before.stdout);
      if (pid && pid !== params.parentPid) {
        return refuse("recovery refused: launchd service has another process generation");
      }
    } else if (!isLaunchdNotLoaded(before)) {
      return refuse();
    }
    if (childStatus) {
      const restarted = await restart();
      // The guarded CLI owns its restart deadline; identity inspection gets a fresh probe budget.
      const current = ownsRecovery()
        ? await runOwned("launchctl", ["print", target]) : null;
      const pid = current?.code === 0
        ? parseLaunchdPid(current.stdout) : 0;
      serviceRunning = current?.code === 0 ? Boolean(pid && isPidAlive(pid)) : undefined;
      servicePid = serviceRunning ? pid : undefined;
      restored = !restarted.signal && restarted.code === 0 && Boolean(pid && pid !== params.parentPid && serviceRunning);
    } else {
    const enabled = await run(["enable", target]);
    let kickstarted = false;
    for (let inspection = enabled; enabled.code === 0 && Date.now() < deadline;) {
      inspection = await run(["print", target]);
      if (inspection.code === 0) {
        const pid = parseLaunchdPid(inspection.stdout);
        if (pid !== params.parentPid && isPidAlive(pid)) {
          restored = true;
          servicePid = pid;
          break;
        }
        // launchd retains the old label until its ExitTimeOut-bounded teardown completes.
        if (pid === params.parentPid) {
          await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
          continue;
        }
        if (kickstarted) break;
        kickstarted = true;
        inspection = await run(["kickstart", target]);
      } else if (isLaunchdNotLoaded(inspection)) {
        inspection = await run(["bootstrap", "gui/" + recovery.uid, recovery.plistPath]);
      } else break;
      if (inspection.code === 0) continue;
      const detail = inspection.stderr || inspection.stdout;
      if (inspection.code === 130 ||
        /already exists in domain|operation already in progress|bootstrap failed: 37/i.test(detail)) continue;
      if (kickstarted && isLaunchdNotLoaded(inspection)) continue;
      if (!/bootstrap failed: 5|input\/output error/i.test(detail)) break;
      await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
    }
    serviceRunning = restored;
    }
  } else if (recovery?.kind === "schtasks") {
    restored = (await runOwned("schtasks.exe", ["/Run", "/TN", recovery.taskName])).code === 0;
  }
  // Manager liveness survives a failed readiness probe, but version facts require
  // the new process to answer; never reuse the pre-activation runtime identity.
  runLedger?.recordUpdateRunVerification(params.runId, {
    serviceRunning, pid: servicePid, runningVersion: undefined, runningBuildId: undefined, versionMatch: undefined,
    readyz: undefined, settled: undefined, channelsReady: undefined, pluginErrors: undefined,
  });
  if (restored) {
    try {
      const { waitForGatewayUpdateRecovery } = await import(pathToFileURL(params.recoveryModulePath).href);
      if (!ownsRecovery()) throw new Error("managed update recovery ownership was lost");
      const health = await waitForGatewayUpdateRecovery(expectedVersion, expectedBuildId, params.recoveryTimeoutMs);
      restored = ownsRecovery() && health.healthy === true &&
        health.runtime?.status === "running" && health.gatewayVersion === expectedVersion &&
        (!expectedBuildId || health.gatewayBuildId === expectedBuildId);
      if (restored && serviceStoppedAtMs !== undefined) serviceDowntimeMs = Math.max(0, Date.now() - serviceStoppedAtMs);
      runLedger?.recordUpdateRunVerification(params.runId, {
        serviceRunning: health.runtime?.status === "running",
        pid: typeof health.runtime?.pid === "number" ? health.runtime.pid : undefined,
        runningVersion: health.gatewayVersion ?? undefined,
        runningBuildId: health.gatewayBuildId ?? undefined,
        versionMatch: health.gatewayVersion === expectedVersion && (!expectedBuildId || health.gatewayBuildId === expectedBuildId),
        settled: health.healthy === true,
        channelsReady: health.healthy === true && !health.channelProbeErrors?.length,
        pluginErrors: health.activatedPluginErrors?.map((error) => JSON.stringify(error)) ?? [],
      });
    } catch (error) {
      appendLog("Gateway recovery readiness failed: " + String(error));
      restored = false;
    }
  }
  appendLog("gateway service recovery " + (restored ? "succeeded (readiness and runtime identity verified)" : "failed"));
  const recorded = record(restored);
  if (!recorded) {
    appendLog("managed update restoration result could not be durably recorded");
  }
  return restored;
}

async function finishGatewayServicePark() {
  const stopped = pendingServiceStop ? await pendingServiceStop : null;
  if (stopped && stopped.code !== 0 && params.serviceRecovery?.kind === "launchd" &&
    !isLaunchdNotLoaded(stopped)) {
    throw new Error("launchctl bootout failed: " + stopped.stderr);
  }
  if (params.serviceRecovery?.kind === "systemd") {
    if (!stopped || stopped.code !== 0 || Date.now() >= params.parentExitDeadlineAt) {
      throw new Error("systemd stop failed or exceeded the parent-exit deadline");
    }
    const unit = params.serviceRecovery.unit;
    for (;;) {
      const current = await inspectSystemdService(unit, params.parentExitDeadlineAt);
      if (!current || current.Id !== unit || current.LoadState !== "loaded" ||
        Date.now() >= params.parentExitDeadlineAt) {
        throw new Error("systemd service remained active or changed execution generation");
      }
      // KillMode=mixed may settle a non-zero Gateway exit as failed. Both settled
      // states accept the parked generation or its collected inactive metadata.
      const settled = current.ActiveState === "inactive" || current.ActiveState === "failed";
      if ((!settled && current.ActiveState !== "deactivating") || current.MainPID !== "0" ||
        !isParkedSystemdGeneration(current, settled)) {
        throw new Error("systemd service remained active or changed execution generation");
      }
      if (settled) break;
      // The exact stop job has completed; systemd may publish inactive a moment later.
      await sleep(Math.min(25, Math.max(0, params.parentExitDeadlineAt - Date.now())));
    }
  }
  if (params.serviceRecovery?.kind === "launchd") {
    const target = "gui/" + params.serviceRecovery.uid + "/" + params.serviceRecovery.label;
    const deadline = params.parentExitDeadlineAt;
    for (;;) {
      const result = await runServiceCommand("launchctl", ["print", target], undefined, deadline);
      if (result.code !== 0) {
        if (!isLaunchdNotLoaded(result)) throw new Error("launchctl print failed: " + result.stderr);
        break;
      }
      if (Date.now() >= deadline) throw new Error("launchd service remained loaded after parent exit");
      await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
    }
  }
  runLedger?.recordUpdateRunVerification(params.runId, { serviceRunning: false });
}

let transferPrepared = false;
let foregroundClosed = false;
let foregroundParked = false;
let foregroundParkFlight;
let foregroundRespawn = false;
async function assertForegroundOrigin(closed = false) {
  assertGatewayParkOwner();
  await runLedger.assertForegroundUpdateOrigin(params.foregroundOrigin, closed);
  assertGatewayParkOwner();
}
async function parkForegroundGateway() {
  await waitForTransferredRestartDelay();
  await assertForegroundOrigin();
  await prepareTransferredGateway();
  const deadline = Date.now() + params.parentExitTimeoutMs;
  while (!foregroundClosed) {
    assertGatewayParkOwner();
    if (Date.now() >= deadline) throw new Error("foreground Gateway did not close before activation deadline");
    await sleep(Math.min(25, Math.max(0, deadline - Date.now())));
  }
  await assertForegroundOrigin(true);
  await assertUpdateRequester();
  foregroundParked = true;
}
async function waitForTransferredRestartDelay() {
  const delayedUntil = Date.now() + params.restartDelayMs;
  while (Date.now() < delayedUntil) {
    if (terminationRequested || updateCancelled || !ownsManagedUpdateLease()) throw new Error("managed update activation cancelled");
    await sleep(Math.min(250, Math.max(0, delayedUntil - Date.now())));
  }
}

function assertPreparedProfileRequester() {
  if (!updateRequesterIdentity?.isCurrentIdentity())
    throw Object.assign(new Error("owner_required: original update requester is no longer authorized"), { code: "owner_required" });
}

async function assertUpdateRequester() {
  if (!params.requester) return;
  if (requiresRequesterAcknowledgement) {
    if (!transferred || updateCancelled || !ownsManagedUpdateLease())
      throw new Error("Profile requester requires its current transferred update owner");
    if (!updateRequesterIdentity) {
      const { prepareManagedUpdateRequesterIdentity } = await import(pathToFileURL(params.recoveryModulePath).href);
      if (!transferred || updateCancelled || !ownsManagedUpdateLease())
        throw new Error("Profile update owner changed during requester preparation");
      updateRequesterIdentity = await prepareManagedUpdateRequesterIdentity(params.requester);
    }
    if (updateCancelled || !ownsManagedUpdateLease()) throw new Error("Profile update owner changed");
    assertPreparedProfileRequester();
    return;
  }
  const { isManagedUpdateRequesterOwner } = await import(pathToFileURL(params.recoveryModulePath).href);
  if (!(await isManagedUpdateRequesterOwner(params.requester)))
    throw Object.assign(new Error("owner_required: chat requester is no longer a configured command owner"), { code: "owner_required" });
}

async function prepareTransferredGateway() {
  if (transferPrepared) return;
  await assertUpdateRequester();
  assertGatewayParkOwner();
  if (requiresRequesterAcknowledgement && (!params.beforePark || process.stdin.destroyed || process.stdin.readableEnded))
    throw Object.assign(new Error("owner_required: original Gateway park acknowledgement is unavailable"), { code: "owner_required" });
  // The existing pipe joins the final notice and original grant check before
  // native stop. Profile admission requires an affirmative reply within this bound.
  if (params.beforePark && !process.stdin.destroyed) {
    const notice = await new Promise((resolve) => {
      const finish = (outcome) => { clearTimeout(timer); finishBeforeParkNotice = undefined; resolve(outcome); };
      const timer = setTimeout(() => {
        appendLog("pre-park notice timed out after 10 seconds");
        finish("timeout");
      }, 10_000);
      finishBeforeParkNotice = finish;
      fs.writeSync(1, ${JSON.stringify(HANDOFF_NOTICE_MARKER)});
    });
    if (requiresRequesterAcknowledgement && notice !== "noticed")
      throw Object.assign(new Error("owner_required: original Gateway did not authorize parking"), { code: "owner_required" });
  }
  if (requiresRequesterAcknowledgement) {
    assertPreparedProfileRequester();
    assertGatewayParkOwner();
    const receipt = ${JSON.stringify(HANDOFF_PARK_ADMITTED_MARKER)};
    if (fs.writeSync(1, receipt) !== Buffer.byteLength(receipt))
      throw new Error("Managed update park acceptance receipt was incomplete");
  } else {
    await assertUpdateRequester();
    assertGatewayParkOwner();
  }
  transferPrepared = true;
}

${MANAGED_HANDOFF_PARENT_SOURCE}

function killOwnedCommand(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      env: params.serviceManagerEnv, stdio: "ignore", windowsHide: true, timeout: 5000,
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  try { child.kill("SIGKILL"); } catch {}
}


${HANDOFF_OWNED_COMMAND_SCRIPT}

async function collectUpdateFailureTriage() {
  try {
    if (!triageFailure || !ownsManagedUpdateLease()) return;
    // Diagnostic reads share this boundary so they cannot bypass terminal cleanup.
    captureFailedUpdateResult();
    appendLog("If triage is unavailable, run " + params.triageRecoveryCommand + " on the Gateway host.");
    // The helper and outer updater start from the same installation. Preserve
    // its complete export; absent exports have only the helper's observed failure.
    const recordedFailure = fs.existsSync(params.triageContextPath);
    if (recordedFailure) {
      appendLog("Saved update failure: " + params.triageContextPath);
      appendLog("Reuse this diagnostic context on the Gateway host: " + params.triageContextCommand);
    }
    const failure = recordedFailure
      ? JSON.parse(fs.readFileSync(params.triageContextPath, "utf8"))
      : { error: "Managed update failed: " + (triageFailure.payload?.stats?.reason || triageFailure.reason) };
    const recovery = typeof triageFailure.restored === "boolean"
      ? "Service recovery " + (triageFailure.restored ? "succeeded." : "failed.")
      : "Service recovery outcome was not recorded; inspect the handoff log before restarting.";
    failure.error = [failure.error, recovery].filter(Boolean).join("\n");
    // Keep the canonical export intact even when installed triage cannot start.
    // Only this private annotated input is removed with the helper's other files.
    fs.writeFileSync(params.triageInputPath, JSON.stringify(failure), { mode: 0o600, flag: "wx" });
    appendLog("starting diagnostic-only update triage after service recovery settled");
    const exit = await runOwnedUpdateCommand(
      "diagnostic",
      [...params.triageCommandArgv, "--update-result", params.triageInputPath],
      Math.min(params.recoveryTimeoutMs, 60_000),
    );
    appendLog(!exit.signal && exit.code === 0
      ? "update triage completed; diagnostic report is above"
      : "update triage could not complete; " + params.triageHint);
  } catch (error) {
    appendLog("update triage could not complete: " + String(error) + "; " + params.triageHint);
  }
}

let automaticRequested = false;

(async () => {
  leaseStore = await prepareManagedHandoffLeaseStore({
    databasePath: params.updateLeaseDatabasePath,
    serviceManagerEnv: params.serviceManagerEnv,
    existingIdentity: params.updateLeaseDatabaseIdentity,
    onProcessIdentityWarning: (pid, message) => {
      appendLog(message);
      runWarnings.set("warning:process-start-identity:" + pid, message);
      if (runLedger && !updaterStarted) recordRunWarnings(runLedger);
    },
  }, { warn: (message, metadata) => appendLog(message + " " + JSON.stringify(metadata)) });
  ({ isPidAlive, properties: parseSystemdProperties, validFailure: validTriageFailure } = leaseStore);
  if (
    !params.triageTransition &&
    (!Number.isInteger(params.parentPid) ||
      params.parentPid <= 0 ||
      typeof params.parentStartIdentity !== "string" ||
      !params.parentStartIdentity)
  ) {
    throw new Error("managed update parent process identity is unavailable");
  }
  if (
    !params.triageTransition &&
    isPidAlive(params.parentPid) &&
    !parentIdentityCurrent()
  ) {
    throw new Error("managed update parent process identity changed");
  }
  if (
    !["update", "triage"].includes(params.action) ||
    !Number.isFinite(params.parentExitTimeoutMs) ||
    params.parentExitTimeoutMs < 0 ||
    !Number.isFinite(params.parentExitDeadlineAt)
  ) {
    throw new Error("managed update parent exit deadline is unavailable");
  }
  const lease = acquireManagedUpdateLease();
  if (!lease.acquired) {
    appendLog("managed update handoff joined active owner=" + (lease.owner || "unknown"));
    cleanupSensitiveFiles();
    fs.writeSync(1, ${JSON.stringify(HANDOFF_BUSY_MARKER)} + (lease.owner || "") + "\n");
    await sleep(25);
    return;
  }
  let outcome = params.triageTransition ? "triage" : undefined;
  let wake;
  wakeTermination = () => wake?.();
  let deadlineExpired = false;
  const parentExitDeadline = setTimeout(() => {
    deadlineExpired = true;
    if (outcome !== "update" && outcome !== "triage") outcome = "restore";
    wake?.();
  }, params.parentExitTimeoutMs);
  try {
    if (params.action === "update" && params.runId) {
      // Admission and stop recording use the serving runtime. Terminal writes after
      // the updater starts must load the installed runtime in a fresh process.
      runLedger = await import(pathToFileURL(params.recoveryModulePath).href);
      for (const name of ["adoptUpdateRun", "finishUpdateRun", "getUpdateRun", "recordUpdateRunStep", "recordUpdateRunVerification"]) {
        if (typeof runLedger[name] !== "function") throw new Error("managed update ledger writer is unavailable");
      }
      if (!ownsManagedUpdateLease()) throw new Error("managed update lease no longer owns the helper");
      // Retain prior drivers while recording this helper's independent lifetime.
      runLedger.adoptUpdateRun(params.runId);
      recordRunWarnings(runLedger);
      if (params.foregroundOrigin) await assertForegroundOrigin();
    }
    if (params.action === "triage") {
      await admitTriageScope();
      if (params.requester) {
        const { createManagedUpdateRequesterAuthority } = await import(pathToFileURL(path.join(params.updateLeaseKey, "dist", "cli", "daemon-cli.js")).href);
        triageRequesterAuthority = await createManagedUpdateRequesterAuthority(params.requester);
        assertTriageRequester();
      }
    }
    if (terminationRequested) return;
    if (!params.triageTransition) fs.writeSync(1, ${JSON.stringify(HANDOFF_READY_MARKER)});
    const commands = [];
    let input = "";
    let disconnected = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (terminationRequested) return;
      input += chunk;
      if (input.length > 64) return process.stdin.destroy();
      let newline;
      while ((newline = input.indexOf("\n")) >= 0) {
        if (commands.length >= 4) return process.stdin.destroy();
        const command = input.slice(0, newline);
        input = input.slice(newline + 1);
        if (transferred && (command === "noticed" || command === "notice-failed")) {
          if (command === "notice-failed") {
            appendLog("pre-park notice failed");
            if (params.foregroundOrigin || requiresRequesterAcknowledgement) activationRejected ??= "managed-service-handoff-helper-failed";
          }
          finishBeforeParkNotice?.(command);
        } else if (transferred && params.foregroundOrigin && command === "closed") {
          if (!foregroundParkFlight || !parentIdentityCurrent() || !ownsManagedUpdateLease())
            return process.stdin.destroy();
          foregroundClosed = true;
        } else if (command === "cancel" && transferred) {
          // Cancellation can discard staging before park admission. After admission,
          // only the orchestrator may decide whether the installed tree can restart.
          if (!restorationArmed && !foregroundClosed && !(requiresRequesterAcknowledgement && transferPrepared) &&
              !(params.operatorRestartWarning && updaterStarted)) {
            updateCancelled = true;
            if (activeCommand) killOwnedCommand(activeCommand);
            reply("cancelled");
          } else reply("cancel-unavailable");
        } else commands.push(command);
      }
      wake?.();
    });
    const onDisconnect = () => { disconnected = true; finishBeforeParkNotice?.("disconnected"); wake?.(); };
    process.stdin.once("end", onDisconnect).once("close", onDisconnect);
    const reply = (line) => fs.writeSync(1, line + "\n");
    let parked = false;
    while (outcome !== "triage" && isPidAlive(params.parentPid)) {
      if (terminationRequested) { outcome = "restore"; break; }
      if (!ownsManagedUpdateLease())
        throw new Error("managed update lease no longer owns the helper");
      if (!parentIdentityCurrent()) {
        if (isPidAlive(params.parentPid))
          throw new Error("managed update parent process identity changed");
        await new Promise((resolve) => setImmediate(resolve));
        if (!commands.length) break;
      }
      if (deadlineExpired) {
        if (params.action === "triage") throw new Error("automatic triage admission expired");
        deadlineExpired = false;
        if (!parked) {
          recordUpdateHandoffOutcome("managed-service-handoff-cancelled");
          return;
        }
        if (
          ownsManagedUpdateLease() &&
          parentIdentityCurrent()
        ) {
          try {
            process.kill(params.parentPid, "SIGKILL");
          } catch {}
        }
      }
      const command = commands.shift();
      if (command === "transfer" && params.action === "update" && !parked && !transferred) {
        transferred = true;
        appendLog("managed update ownership transferred; validating while the gateway serves");
        reply("transferred");
        outcome = "update";
        break;
      } else if (command === "commit" && params.action === "triage") {
        await inspectTriageScope();
        if (!ownsManagedUpdateLease()) throw new Error("automatic triage admission lost its lease");
        outcome = "triage";
        reply("committed");
        break;
      } else if (command === "park" && params.action !== "triage") {

        try {
          if (!parked) await parkGatewayService();
          parked = true;
          reply("parked");
        } catch (error) {
          appendLog("managed service parking failed: " + String(error));
          if (restorationArmed) {
            outcome = "restore";
            reply("restore-after-exit");
          } else {
            recordUpdateHandoffOutcome("managed-service-handoff-cancelled");
            reply("cancelled");
            return;
          }
        }
      } else if (command === "commit" && parked) {
        const restoring = outcome === "restore" || Date.now() >= params.parentExitDeadlineAt;
        outcome = restoring ? "restore" : "update";
        reply(restoring ? "restore-after-exit" : "committed");
      } else if (command === "cancel" || (disconnected && outcome !== "update")) {
        if (!restorationArmed) {
          if (params.action === "update")
            recordUpdateHandoffOutcome("managed-service-handoff-cancelled");
          if (command) reply("cancelled");
          return;
        }
        outcome = "restore";
        if (command) reply("restore-after-exit");
      } else if (command === "restore-commit" && outcome === "restore") {
        reply("committed");
      } else if (command) {
        throw new Error("invalid managed update control command");
      }
      await Promise.race([
        sleep(25),
        new Promise((resolve) => {
          wake = resolve;
        }),
      ]);
    }
    clearTimeout(parentExitDeadline);
    if (outcome !== "update" && outcome !== "triage") {
      if (restorationArmed) await restoreGatewayService("managed-service-handoff-cancelled");
      else if (params.action === "update")
        recordUpdateHandoffOutcome("managed-service-handoff-cancelled");
      return;
    }
    if (restorationArmed) await finishGatewayServicePark();

    if (params.action === "update") await assertUpdateRequester();
    if (terminationRequested || updateCancelled) {
      if (restorationArmed) await restoreGatewayService("managed-service-handoff-cancelled");
      else recordUpdateHandoffOutcome("managed-service-handoff-cancelled");
      return;
    }
    appendLog("starting managed update command: " + params.commandLabel);
    // Update inputs retain shell-relative paths; recovery keeps the durable helper cwd.
    const exit = await runOwnedUpdateCommand(params.action, params.commandArgv, undefined, params.action === "update" ? params.invocationCwd : params.cwd);
    if (params.action === "triage") {
      if (exit.signal || exit.code !== 0) finalExitCode = exit.code || 1;
      return;
    }
    automaticRequested = Boolean(exit.continuation);
    if (updateCancelled || activationRejected) {
      const reason = updateCancelled ? "managed-service-handoff-cancelled" : activationRejected;
      // No parked acknowledgement authorized a swap. Recovery waits for any
      // dispatched stop, even when cancellation overlaps the parent's drain.
      if (restorationArmed) {
        if (!(await restoreGatewayService(reason))) finalExitCode = 1;
      } else recordUpdateHandoffOutcome(reason);
      if (!updateCancelled) finalExitCode = 1;
      return;
    }
    const { updaterOutput, outputOverflow } = exit;
    // Only this invocation's direct child result carries the producer decision.
    // Success may change install roots; only recovery requires the original root.
    // Sentinels and diagnostic exports never authorize activation.
    let result = null;
    try { if (!outputOverflow) result = JSON.parse(updaterOutput); } catch {}
    if (!exit.signal && ownsManagedUpdateLease() && result?.status === "skipped" &&
      result.reason === "update-ledger-busy" && result.root === undefined && result.runId === undefined &&
      ((result.mode === "unknown" && exit.code === 0) || (result.mode === "finalize" && exit.code === 1))) {
      // Admission never acquired an install/run result. Preserve its deferral without
      // turning the missing root into either recovery or successor authority.
      runOutcome = { status: "skipped", reason: result.reason };
      finalExitCode = exit.code;
      return;
    }
    let resultRoot;
    try { resultRoot = fs.realpathSync(result?.root); } catch {}
    if (result?.status === "ok" && resultRoot && resultRoot !== params.updateLeaseKey) {
      terminalRuntimePath = path.join(resultRoot, "dist", "cli", "daemon-cli.js");
    }
    const reportedFailure = isFailedUpdateOutcome(result?.status, result?.reason);
    if (!exit.signal && exit.code === 0 && resultRoot && result?.status === "ok") {
      runOutcome = { status: "succeeded", after: result.after };
    } else if (resultRoot && ["error", "skipped"].includes(result?.status)) {
      runOutcome = { status: result.status === "skipped" && !exit.signal && exit.code === 0 ? "skipped" : "failed", reason: result.reason, after: result.after };
    }
    if (reportedFailure) triageFailure ??= { reason: result?.reason || "managed-service-handoff-failed" };
    const childStatus = !exit.signal && resultRoot === params.updateLeaseKey && ["error", "skipped"].includes(result?.status) ? result.status : undefined;
    if (childStatus) closedUpdateResult = result;
    const recovery = childStatus ? result.recovery : null;
    const safe = !exit.signal && recovery?.serviceRestartSafe === true &&
      typeof recovery.version === "string" && recovery.version.trim() &&
      (recovery.buildId === undefined ? result.mode !== "git" :
        typeof recovery.buildId === "string" && recovery.buildId.trim() && recovery.buildId.length <= 96) &&
      ownsManagedUpdateLease();
    if (params.foregroundOrigin) {
      const succeeded = !exit.signal && exit.code === 0 && resultRoot && result?.status === "ok";
      // The updater's pending readiness result permits a fresh process without
      // turning unverified startup into a successful update.
      const readinessPending = !exit.signal && exit.code === 0 && resultRoot === params.updateLeaseKey &&
        result?.status === "skipped" && result.reason === "gateway-readiness-unverified" &&
        result.recovery?.serviceRestartSafe !== false;
      foregroundRespawn = foregroundParked && ownsManagedUpdateLease() && parentIdentityCurrent() &&
        (succeeded || readinessPending || (safe && recovery.service !== "failed" &&
          exit.code !== ${MANAGED_SERVICE_UPDATE_UNSAFE_EXIT_CODE}));
      if (!runOutcome || (foregroundParked && succeeded && !foregroundRespawn))
        runOutcome = { status: "failed", reason: "managed-service-handoff-failed" };
      if (runOutcome.status !== "succeeded")
        finalExitCode = exit.code || (runOutcome.status === "skipped" && !reportedFailure && !exit.signal ? 0 : 1);
      return;
    }
    const recoveryRun = safe && recovery.packageRollbackVerified === true && runLedger?.getUpdateRun(params.runId);
    // The rollback owner restores the generation and grants restart authority. The
    // same-run receipt corroborates it; exit 79 alone never permits a recovery start.
    const previousGeneration = restorationArmed && recoveryRun?.status === "running" &&
      recoveryRun.runId === params.runId && recoveryRun.before.version === recovery.version &&
      recoveryRun.after.version === recovery.version && result.before?.version === recovery.version &&
      result.after?.version === recovery.version && (!recovery.buildId ||
        [recoveryRun.before, recoveryRun.after, result.before, result.after].every((version) => version.buildId === recovery.buildId)) && recoveryRun.steps.some((step) =>
        step.step === "previous generation restoration" && step.status === "completed");
    if (exit.code === ${MANAGED_SERVICE_UPDATE_UNSAFE_EXIT_CODE} && !previousGeneration) {
      appendLog("managed update reported unsafe recovery; keep the gateway stopped until the installation is repaired and update succeeds");
      recordUpdateHandoffOutcome("managed-service-handoff-unsafe-recovery");
      finalExitCode = exit.code;
    } else if (!resultRoot || result?.status !== "ok" ||
      exit.signal || exit.code !== 0) {
      let restored = !restorationArmed || (safe && recovery.service === "healthy");
      if (restorationArmed && safe && recovery.service === undefined) {
        restored = await restoreGatewayService(previousGeneration ? result.reason : "managed-service-handoff-failed", recovery, childStatus, previousGeneration);
      } else {
        if (restorationArmed && restored && triageFailure) triageFailure.restored = true;
        appendLog("managed update recovery not attempted: " +
          (recovery?.serviceRestartSafe === false ? "updater explicitly rejected activation" :
            recovery?.service === "healthy" ? "updater already verified recovery" :
              recovery?.service === "failed" ? "updater recovery failed; no automatic retry" :
                "no verified recovery result; inspect the installation before restarting"));
        if (restorationArmed && !restored) { const alarm = "Gateway recovery failed after the update. OpenClaw stopped automatic recovery because it could not safely verify the installed runtime. Recovery details were saved with the update result."; appendLog(alarm); runWarnings.set("warning:gateway-availability", alarm); }
        if (childStatus !== "skipped" || !restored) {
          recordUpdateHandoffOutcome("managed-service-handoff-failed", undefined, childStatus === "skipped" ? "error" : childStatus);
        }
      }
      if (previousGeneration && restored) {
        runOutcome = { status: "rolled-back", reason: result.reason, after: result.after };
      }
      finalExitCode = previousGeneration && restored ? 1 : exit.code ||
        (childStatus === "skipped" && restored && !exit.signal && !reportedFailure ? 0 : 1);
    }
    if (exit.continuation && !exit.signal && !terminationRequested) await enterTriageAfterUpdate(exit.continuation);
  } catch (err) {
    appendLog("handoff failed: " + (err && err.stack ? err.stack : String(err)));
    const reason = err?.code === "owner_required" ? "owner_required" : "managed-service-handoff-helper-failed";
    if (params.action === "update") runOutcome = { status: "failed", reason };
    if (hasManagedUpdateLease()) {
      if (params.action !== "triage") bindManagedUpdateLeaseToProcess(process.pid);
      if (restorationArmed && !updaterStarted) await restoreGatewayService(reason);
      else if (params.action === "update") recordUpdateHandoffOutcome(reason);
    }
    finalExitCode = 1;
  } finally {
    clearTimeout(parentExitDeadline);
    try { await finishManagedUpdateRun(); }
    catch (error) {
      appendLog("failed to finalize update run: " + String(error));
      foregroundRespawn = false;
      finalExitCode = 1;
    }
    if (params.action === "update" && !automaticRequested && !terminationRequested) await collectUpdateFailureTriage();
    releaseManagedUpdateLease();
    cleanupSensitiveFiles();
    stopTriageScope();
    wakeTermination = undefined;
    if (terminationRequested) finalExitCode = 143;
    appendLog("managed update helper completed code=" + (finalExitCode || 0));
    if (params.operatorRestartWarning) fs.writeSync(1, ${JSON.stringify(SYSTEM_SERVICE_UPDATE_SETTLED_MARKER)});
    if (foregroundClosed && parentIdentityCurrent())
      fs.writeSync(1, "foreground-settled:" + (foregroundRespawn ? "respawn" : "stopped") + "\n");
    process.stdin.destroy();
    process.exitCode = finalExitCode;
  }
})().catch((err) => {
  appendLog("handoff setup failed: " + (err && err.stack ? err.stack : String(err)));
  cleanupSensitiveFiles();
  stopTriageScope();
  process.stdin.destroy();
  process.exitCode = terminationRequested ? 143 : 1;
});
`;

export { waitForSystemServiceUpdateHandoffs } from "./update-managed-service-handoff-current.js";

async function spawnManagedServiceUpdateHandoff(
  params: ManagedServiceUpdateHandoffParams & { handoffId: string },
  rootIdentity: string,
  owner: ActiveManagedServiceUpdateHandoff,
): Promise<ManagedServiceUpdateHandoffResult> {
  const parentPid = params.parentPid ?? process.pid;
  const serviceEnv = params.env ?? process.env;
  if (params.foregroundOrigin) {
    if (
      params.action ||
      params.foregroundOrigin.pid !== parentPid ||
      parentPid !== process.pid ||
      params.meta.completionOwner !== "gateway-restart"
    ) {
      throw new Error("Foreground update requires the current Gateway's completion owner");
    }
    await assertForegroundUpdateOrigin(params.foregroundOrigin, false, serviceEnv);
  }
  const handoffNodeExecutable =
    params.execPath ?? (await resolveManagedHandoffNodeExecutable(serviceEnv, params.supervisor));
  const runtimeArgs = resolveRuntimeArgs(handoffNodeExecutable);
  const updateLeaseDatabasePath =
    owner.leaseDatabaseIdentity?.databasePath ?? resolveManagedUpdateLeaseDatabasePath();
  // The helper and its parent retain one database identity through settlement.
  const updateLeaseDatabaseIdentity =
    owner.leaseDatabaseIdentity ??
    (await prepareManagedHandoffLeaseDatabaseIdentity(updateLeaseDatabasePath, () => {
      owner.requesterAuthority?.assertCurrent();
      owner.requesterAuthority?.signal?.throwIfAborted();
    }));
  owner.leaseDatabaseIdentity = updateLeaseDatabaseIdentity;
  const identityStore = await prepareManagedHandoffLeaseStore({
    databasePath: updateLeaseDatabaseIdentity.databasePath,
    existingIdentity: updateLeaseDatabaseIdentity,
    serviceManagerEnv: resolveServiceManagerEnv(serviceEnv),
    onProcessIdentityWarning: createUpdateRunProcessIdentityWarning(params.runId, serviceEnv),
  });
  owner.leaseStore = identityStore;
  const parentStartIdentity = identityStore.processIdentity(parentPid).startIdentity;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX));
  const scriptPath = path.join(dir, "handoff.cjs");
  const paramsPath = path.join(dir, "handoff.json");
  const metaPath = path.join(dir, "sentinel-meta.json");
  const triageInputPath = path.join(dir, "update-failure.json");
  const installationTarget = resolveInstallationTarget(serviceEnv);
  const triageContextPath = path.join(
    installationTarget.stateDir,
    "logs",
    "support",
    `openclaw-update-failure-${randomUUID()}.json`,
  );
  const logPath = path.join(dir, "handoff.log");
  const commandOptions = {
    acceptCapabilities: params.acceptCapabilities,
    admission: params.admission,
    reapplyLocalOverrides: params.reapplyLocalOverrides,
    timeoutMs: params.timeoutMs,
    channel: params.channel,
    tag: params.tag,
  };
  const commandRuntime = {
    execPath: handoffNodeExecutable,
    argv1: resolveOpenClawCliEntryPath(params.argv1 ?? process.argv[1]),
  };
  const commandArgv = params.action
    ? [
        params.action.nodeRunner,
        ...resolveRuntimeArgs(params.action.nodeRunner),
        params.action.entrypoint,
        "triage",
      ]
    : resolveUpdateCliArgv({ ...commandOptions, ...commandRuntime });
  if (owner.operatorRestartWarning) {
    commandArgv.push("--no-restart");
  }
  const commandLabel = params.action
    ? "openclaw triage (automatic)"
    : formatManagedServiceUpdateCommand(commandOptions, params.env) +
      (owner.operatorRestartWarning ? " --no-restart" : "");
  const metaFile: ControlPlaneUpdateSentinelMetaFile = {
    version: 1,
    meta: {
      ...params.meta,
      ...(params.runId ? { runId: params.runId } : {}),
      root: rootIdentity,
      triageContextPath,
      ...(params.foregroundOrigin ? { foregroundOrigin: params.foregroundOrigin } : {}),
    },
  };
  let spawnCommand = handoffNodeExecutable;
  const spawnArgs = [...runtimeArgs, scriptPath, paramsPath];
  let scopeUnit: string | undefined;
  let systemdRunPath: string | undefined;
  if (
    !params.foregroundOrigin &&
    params.supervisor === "systemd" &&
    !owner.operatorRestartWarning
  ) {
    const systemdRun = resolveExecutableFromPathEnv(
      "systemd-run",
      [serviceEnv.PATH ?? "", "/usr/bin", "/bin"].join(path.delimiter),
      serviceEnv,
    );
    if (!systemdRun) {
      throw new Error("systemd-run is required to launch a transient user scope");
    }
    systemdRunPath = systemdRun;
    const normalized = params.handoffId.trim().replace(/[^A-Za-z0-9_.:@-]+/gu, "-");
    const suffix =
      normalized.replace(/^-+|-+$/gu, "").slice(0, 80) || `${process.pid}-${Date.now()}`;
    scopeUnit = `openclaw-${params.action ? "triage" : "update"}-${suffix}.scope`;
    spawnArgs.unshift(
      "--user",
      "--scope",
      "--collect",
      `--unit=${scopeUnit}`,
      ...(params.action
        ? [`--property=PartOf=${resolveSystemdServiceName(serviceEnv)}.service`]
        : []),
      spawnCommand,
    );
    spawnCommand = systemdRun;
  }
  const stateDatabasePath = resolveOpenClawStateSqlitePath(serviceEnv);
  const preparedEnv = resolveManagedHandoffCommandEnv(serviceEnv, metaPath, metaFile.meta.runId);
  const { nodeExecArgv, readyEnv } = prepareManagedHandoffCliRuntime(
    commandArgv,
    preparedEnv,
    handoffNodeExecutable,
  );
  const env = params.devTarget ? applyDevUpdateTargetEnv(readyEnv, params.devTarget) : readyEnv;

  const helperParams = {
    operatorRestartWarning: owner.operatorRestartWarning,
    runId: metaFile.meta.runId,
    beforePark: Boolean(params.beforePark),
    requester: resolveManagedUpdateRequester(params.requester),
    serviceManagerEnv: resolveServiceManagerEnv(serviceEnv),
    nodeExecArgv,
    runtimeArgs,
    action: params.action?.kind ?? "update",
    failure: params.action?.failure,
    scopeUnit,
    systemdRun: systemdRunPath,
    parentPid,
    parentStartIdentity,
    parentExitTimeoutMs: owner.parentExitTimeoutMs,
    restartDelayMs: Math.max(0, Math.min(60_000, params.restartDelayMs ?? 0)),
    parentExitDeadlineAt: Date.now() + owner.parentExitTimeoutMs,
    cwd: dir,
    invocationCwd: params.invocationCwd,
    commandArgv,
    recoveryCommandArgv: resolveManagedServiceCliArgv(commandRuntime, [
      "gateway",
      "restart",
      "--preserve-definition",
      "--json",
    ]),
    recoveryTimeoutMs: owner.recoveryTimeoutMs,
    triageCommandArgv: resolveManagedServiceCliArgv(commandRuntime, [
      "triage",
      "--json",
      "--non-interactive",
    ]),
    triageContextPath,
    triageInputPath,
    triageContextCommand: formatInstallationTargetCommand(
      ["openclaw", "triage", "--update-result", triageContextPath],
      installationTarget,
      { env: serviceEnv },
    ),
    triageRecoveryCommand: formatInstallationTargetCommand(
      ["openclaw", "triage"],
      installationTarget,
      { env: serviceEnv },
    ),
    // This hint becomes a model/channel notice; host paths remain in the helper log.
    triageHint:
      "Update triage runs after service recovery; see the managed update helper log for the outcome and the installation-specific openclaw triage command.",
    commandLabel,
    handoffId: params.handoffId,
    nonFailureSkippedReasons: Object.keys(SKIPPED_UPDATE_OUTCOMES),
    logPath,
    metaPath,
    stateDatabasePath,
    nodeSqliteLocation: resolveNodeSqliteLocation(stateDatabasePath),
    updateLeaseDatabasePath: updateLeaseDatabaseIdentity.databasePath,
    updateLeaseDatabaseIdentity,
    updateLeaseKey: rootIdentity,
    updateLeaseOwner: params.handoffId,
    sensitivePaths: [
      scriptPath,
      paramsPath,
      metaPath,
      triageInputPath,
      path.join(dir, "terminal-result.json"),
    ],
    foregroundOrigin: params.foregroundOrigin,
    serviceRecovery:
      params.foregroundOrigin || owner.operatorRestartWarning
        ? undefined
        : resolveGatewayServiceRecovery(params.supervisor, serviceEnv),
    recovery: await ((await looksLikeGitCheckout(rootIdentity))
      ? readCurrentGitUpdateRecovery(rootIdentity, owner.recoveryTimeoutMs)
      : verifyPackageUpdateRecovery(rootIdentity)),
    recoveryModulePath: path.join(rootIdentity, "dist", "cli", "daemon-cli.js"),
  };

  let child!: HandoffChild;
  let readiness!: string;
  const onExit = () => {
    // Keep exact ownership until cancellation proves the durable lease was released.
    owner.exited = true;
    owner.releaseRequesterObserver?.();
  };
  try {
    helperParams.sensitivePaths.push(...stageManagedHandoffRuntime(dir));
    await fs.writeFile(scriptPath, `${HANDOFF_SCRIPT}\n`, { mode: 0o700 });
    await fs.writeFile(paramsPath, `${JSON.stringify(helperParams, null, 2)}\n`, { mode: 0o600 });
    await fs.writeFile(metaPath, `${JSON.stringify(metaFile, null, 2)}\n`, { mode: 0o600 });

    assertManagedUpdateLeaseDatabaseIdentity(updateLeaseDatabaseIdentity);
    owner.requesterAuthority?.assertCurrent();
    owner.requesterAuthority?.signal?.throwIfAborted();
    if (params.foregroundOrigin && isGatewayRestartDraining()) {
      throw new GatewayDrainingError();
    }
    child = spawn(spawnCommand, spawnArgs, {
      cwd: dir,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    owner.launcher = child;
    owner.closed = observeManagedServiceUpdateHandoffClose(owner, child);
    child.stdin.on("error", () => child.stdin.destroy()).once("close", () => child.stdin.destroy());
    // Failed spawn handles are not processes and must never be signalled.
    if (!child.pid) {
      await once(child, "spawn");
    }
    try {
      owner.launcherStartIdentity = child.pid
        ? identityStore.processIdentity(child.pid, child.spawnargs).startIdentity
        : null;
    } catch (error) {
      forceKillChildProcessTree(child);
      throw error;
    }
    if (owner.launcherStartIdentity == null) {
      forceKillChildProcessTree(child);
      throw new Error("managed update handoff process start identity is unavailable");
    }
    child.once("exit", onExit);
    // systemd-run execs the helper in its scope. Readiness binds its exact
    // lease; triage additionally verifies native cancellation before replying.
    readiness = await waitForHandoffResponse(child, owner.recoveryTimeoutMs);
    if (`${readiness}\n` !== HANDOFF_READY_MARKER && !readiness.startsWith(HANDOFF_BUSY_MARKER)) {
      throw new Error("managed update handoff returned an invalid readiness response");
    }
    if (`${readiness}\n` === HANDOFF_READY_MARKER) {
      const helper = readManagedServiceUpdateHandoffLease(rootIdentity);
      if (
        helper?.owner !== params.handoffId ||
        helper.executor.pid !== helper.helper.pid ||
        helper.executor.startIdentity !== helper.helper.startIdentity ||
        helper.action.kind !== (params.action?.kind ?? "update") ||
        (helper.action.kind === "triage" &&
          (helper.action.lifetime.kind !== "native" ||
            helper.action.lifetime.placement.kind !== "attached" ||
            helper.action.phase !== "reserved")) ||
        !isPidAlive(helper.executor.pid) ||
        !identityStore.isProcessIdentityCurrent(
          helper.executor,
          helper.executor.pid === child.pid && child.exitCode === null && child.signalCode === null,
        )
      ) {
        forceKillChildProcessTree(child);
        throw new Error("managed update handoff helper lease identity is unavailable");
      }
      owner.helper = helper;
    }
  } catch (err) {
    child?.removeListener("exit", onExit);
    child?.stdin.destroy();
    child?.stdout.destroy();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  if (params.beforePark) {
    let noticePending = false;
    const requiresAcceptance =
      params.requester?.authorizationSource?.startsWith("profile:") === true;
    const identity = {
      kind: "managed-update-handoff" as const,
      installRoot: rootIdentity,
      handoffId: owner.handoffId,
    };
    const isCurrentOwner = () => {
      try {
        return (
          currentManagedServiceUpdateHandoff(identity) === owner &&
          owner.transferred &&
          !owner.exited
        );
      } catch {
        // A replaced or unreadable native owner cannot accept a park receipt.
        return false;
      }
    };
    const isCurrent = () => isCurrentOwner() && !owner.cancelling;
    const onNotice = createHandoffLineReader((line) => {
      if (line === HANDOFF_PARK_ADMITTED_MARKER && requiresAcceptance && isCurrentOwner()) {
        owner.parkAdmitted = true;
        owner.releaseRequesterObserver?.();
        owner.parkReady = true;
        owner.closeForStop?.();
        return;
      }
      if (line !== HANDOFF_NOTICE_MARKER || noticePending || !isCurrent()) {
        return;
      }
      noticePending = true;
      void (async () => {
        owner.requesterAuthority?.assertCurrent();
        await owner.beforePark?.();
        owner.requesterAuthority?.assertCurrent();
        owner.requesterAuthority?.signal?.throwIfAborted();
        if (isCurrent()) {
          if (!requiresAcceptance) {
            owner.parkReady = true;
            owner.closeForStop?.();
          }
          child.stdin.write("noticed\n");
        }
      })().catch(() => {
        if (isCurrent()) {
          child.stdin.write("notice-failed\n");
        }
      });
    });
    child.stdout.on("data", onNotice);
    child.once("exit", () => child.stdout.off("data", onNotice));
  }

  const result = { command: commandLabel, logPath };
  const handoffId = readiness.slice(HANDOFF_BUSY_MARKER.length).trim();
  return `${readiness}\n` === HANDOFF_READY_MARKER
    ? {
        ...result,
        status: "started",
        ...(child.pid ? { pid: child.pid } : {}),
        handoffId: params.handoffId,
        installRoot: rootIdentity,
      }
    : {
        ...result,
        status: "joined",
        ...(handoffId ? { handoffId } : {}),
      };
}

export async function assertManagedServiceUpdateHandoffRoot(params: {
  expectedRoot: string;
  root: string;
  executingRoot: string | null;
  postCore: boolean;
}): Promise<void> {
  const expectedRoot = resolveUpdateInstallRoot(params.expectedRoot);
  const root = params.executingRoot ? resolveUpdateInstallRoot(params.executingRoot) : null;
  const activeExecution = root !== null && resolveUpdateInstallRoot(params.root) === root;
  if (activeExecution && expectedRoot === root) {
    return;
  }
  if (activeExecution && params.postCore) {
    const [previous, current] = await Promise.all([
      resolvePnpmGlobalInstallOwner(expectedRoot),
      resolvePnpmGlobalInstallOwner(root),
    ]);
    if (
      previous &&
      current &&
      previous.ownerRoot === current.ownerRoot &&
      resolveUpdateInstallRoot(current.packageRoot) === root
    ) {
      return;
    }
  }
  throw new Error(
    `Managed update handoff root mismatch: expected ${params.expectedRoot}, running from ${params.root}.`,
  );
}

export async function startManagedServiceUpdateHandoff(
  params: ManagedServiceUpdateHandoffParams,
): Promise<ManagedServiceUpdateHandoffResult> {
  if (
    params.requester?.authorizationSource?.startsWith("profile:") &&
    (!params.requesterAuthority || !params.beforePark)
  ) {
    throw new Error("Profile update requires its original Gateway admission and park owner.");
  }
  params.requesterAuthority?.assertCurrent();
  params.requesterAuthority?.signal?.throwIfAborted();
  if (params.action && params.supervisor !== "systemd") {
    throw new Error(
      "Automatic managed triage requires a Linux user-systemd scope; run openclaw triage manually.",
    );
  }
  if (
    !Number.isFinite(params.restartDrainTimeoutMs) ||
    !Number.isFinite(params.restartDelayMs ?? 0)
  ) {
    throw new Error("managed update handoff requires a finite restart deadline");
  }
  const operatorRestartWarning =
    !params.foregroundOrigin && params.supervisor === "systemd"
      ? await admitSystemdUpdate(params.root, params.env)
      : undefined;
  if (operatorRestartWarning && params.action) {
    throw new Error(
      "Automatic managed triage requires a Linux user-systemd scope; run openclaw triage manually.",
    );
  }
  const root = resolveUpdateInstallRoot(params.root);
  const active = activeManagedServiceUpdateHandoffs.get(root);
  let unsettledOwner: string | undefined;
  if (active?.exited && active.transferred && !active.cancelling) {
    const store = active.leaseStore;
    const lease = store?.read(root);
    if (!store || !lease || lease.kind === "unreadable") {
      throw new Error(
        "The previous managed update lease is unavailable; check it before retrying.",
      );
    }
    if (lease.kind === "current" && !store.release(lease.lease)) {
      unsettledOwner = lease.lease.owner;
    }
  }
  // After a transferred helper exits, durable admission fences any surviving
  // updater. An exited local owner must not pin no-ops or replacement helpers.
  if (
    active?.flight &&
    (!active.exited ||
      active.cancelling ||
      (active.claimed && !active.transferred) ||
      unsettledOwner)
  ) {
    const joined = await active.flight;
    const handoffId = unsettledOwner ?? joined.handoffId;
    return {
      status: "joined",
      command: joined.command,
      logPath: joined.logPath,
      ...(joined.pid ? { pid: joined.pid } : {}),
      ...(handoffId ? { handoffId } : {}),
    };
  }
  if (params.foregroundOrigin && isGatewayRestartDraining()) {
    throw new GatewayDrainingError();
  }
  const owner: ActiveManagedServiceUpdateHandoff = {
    handoffId: params.handoffId ?? randomUUID(),
    operatorRestartWarning,
    recoveryTimeoutMs: params.recoveryTimeoutMs ?? params.timeoutMs ?? 30 * 60_000,
    parentExitTimeoutMs: Math.min(
      2_147_483_647,
      Math.max(0, params.restartDrainTimeoutMs) + PARENT_EXIT_SHUTDOWN_RESERVE_MS,
    ),
    ...(params.beforePark ? { beforePark: params.beforePark } : {}),
    ...(params.requesterAuthority ? { requesterAuthority: params.requesterAuthority } : {}),
    ...(params.foregroundOrigin ? { foregroundOrigin: { ...params.foregroundOrigin } } : {}),
    ...(active?.leaseDatabaseIdentity
      ? { leaseDatabaseIdentity: active.leaseDatabaseIdentity }
      : {}),
  };
  activeManagedServiceUpdateHandoffs.set(root, owner);
  const requesterSignal = owner.requesterAuthority?.signal;
  if (requesterSignal) {
    const cancelRevokedRequester = () => {
      // Readiness owns its response stream. Cancellation joins that admission
      // before using the same pipe and remains attached until helper acceptance.
      void owner.flight?.then(
        async () => {
          if (!owner.parkAdmitted && activeManagedServiceUpdateHandoffs.get(root) === owner) {
            await cancelManagedServiceUpdateHandoff({
              kind: "managed-update-handoff",
              handoffId: owner.handoffId,
              installRoot: root,
            });
          }
        },
        () => {},
      );
    };
    requesterSignal.addEventListener("abort", cancelRevokedRequester, { once: true });
    owner.releaseRequesterObserver = () =>
      requesterSignal.removeEventListener("abort", cancelRevokedRequester);
  }
  const flight = Promise.resolve().then(() =>
    spawnManagedServiceUpdateHandoff(
      {
        ...params,
        handoffId: owner.handoffId,
        meta: {
          ...params.meta,
          handoffId: params.meta.handoffId ?? owner.handoffId,
        },
      },
      root,
      owner,
    ),
  );
  owner.flight = flight;
  try {
    return await flight;
  } catch (err) {
    owner.releaseRequesterObserver?.();
    if (activeManagedServiceUpdateHandoffs.get(root) === owner) {
      activeManagedServiceUpdateHandoffs.delete(root);
    }
    throw err;
  }
}

export function claimManagedServiceUpdateHandoff(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): boolean {
  const active = currentManagedServiceUpdateHandoff(identity);
  if (!active || active.cancelling) {
    return false;
  }
  active.claimed = true;
  return true;
}

function currentManagedServiceUpdateHandoff(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): ActiveManagedServiceUpdateHandoff | undefined {
  const root = resolveUpdateInstallRoot(identity.installRoot);
  const active = activeManagedServiceUpdateHandoffs.get(root);
  const launcher = active?.launcher;
  const helper = active?.helper;
  const lease = readManagedServiceUpdateHandoffLease(root);
  if (
    identity.kind !== "managed-update-handoff" ||
    active?.handoffId !== identity.handoffId ||
    !active.leaseStore ||
    !launcher?.pid ||
    !isPidAlive(launcher.pid) ||
    active.launcherStartIdentity == null ||
    !active.leaseStore.isProcessIdentityCurrent(
      { pid: launcher.pid, startIdentity: active.launcherStartIdentity },
      launcher.exitCode === null && launcher.signalCode === null,
    ) ||
    launcher.exitCode !== null ||
    launcher.signalCode !== null ||
    lease?.owner !== identity.handoffId ||
    helper?.owner !== identity.handoffId ||
    (!(active.transferred && helper.action.kind === "update") &&
      (lease.executor.pid !== helper.executor.pid ||
        lease.executor.startIdentity !== helper.executor.startIdentity)) ||
    JSON.stringify(lease.helper) !== JSON.stringify(helper.helper) ||
    JSON.stringify(lease.action) !== JSON.stringify(helper.action) ||
    (lease.action.kind === "triage" && lease.action.phase !== "reserved") ||
    !isPidAlive(lease.executor.pid) ||
    !active.leaseStore.isProcessIdentityCurrent(
      lease.executor,
      lease.executor.pid === launcher.pid &&
        launcher.exitCode === null &&
        launcher.signalCode === null,
    )
  ) {
    return undefined;
  }
  return active;
}

function hasForegroundUpdatePaths(origin: ForegroundUpdateOrigin, env: NodeJS.ProcessEnv): boolean {
  return (
    resolvePathViaExistingAncestorSync(resolveOpenClawStateSqlitePath(env)) ===
      origin.stateDatabasePath &&
    resolvePathViaExistingAncestorSync(resolveConfigPath(env, resolveStateDir(env))) ===
      origin.configPath
  );
}

/** Called only before activation; later admission consumes the live helper's joined park fact. */
export async function assertForegroundUpdateOrigin(
  origin: ForegroundUpdateOrigin,
  closed: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const matchesOwner = () => {
    if (!hasForegroundUpdatePaths(origin, env)) {
      return false;
    }
    const owner = readGatewayOwnerLease({ env, current: true });
    return closed
      ? owner === undefined
      : owner?.mode === "foreground" &&
          owner.state === "live" &&
          owner.owner === origin.owner &&
          owner.pid === origin.pid &&
          owner.host === origin.host &&
          owner.startedAt === origin.startedAt &&
          owner.port === origin.port;
  };
  if (!matchesOwner()) {
    throw new Error("Foreground Gateway owner or paths changed");
  }
  const lock = await readActiveGatewayLockIdentity({ env, requireInspection: true });
  if (
    closed
      ? lock !== undefined
      : lock?.pid !== origin.pid || lock.startTime !== origin.startedAt || lock.port !== origin.port
  ) {
    throw new Error("Foreground Gateway locks do not match its handoff phase");
  }
  if (closed && (await probePortUsage(origin.port)) !== "free") {
    throw new Error("Foreground Gateway port is not verified free");
  }
  if (!matchesOwner()) {
    throw new Error("Foreground Gateway owner or paths changed during inspection");
  }
}

async function exchangeForegroundUpdateHandoff(
  params: {
    root: string;
    runId: string | undefined;
    env?: NodeJS.ProcessEnv;
  },
  operation: "foreground-inspect" | "foreground-park",
): Promise<boolean> {
  const env = params.env ?? process.env;
  const meta = await readControlPlaneUpdateSentinelMeta(env);
  if (
    meta?.completionOwner !== "gateway-restart" ||
    !meta.foregroundOrigin ||
    !hasForegroundUpdatePaths(meta.foregroundOrigin, env) ||
    !process.connected ||
    !process.send ||
    !(await isCurrentManagedServiceUpdateHandoffProcess(params))
  ) {
    return false;
  }
  const lease = readManagedServiceUpdateHandoffLease(resolveUpdateInstallRoot(params.root));
  const requestId = randomUUID();
  const accepted = await new Promise<boolean>((resolve) => {
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      process.off("message", onMessage).off("disconnect", onDisconnect);
      resolve(ok);
    };
    const onDisconnect = () => finish(false);
    const onMessage = (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("requestId" in message) ||
        message.requestId !== requestId
      ) {
        return;
      }
      finish(
        "type" in message &&
          message.type === operation &&
          "version" in message &&
          message.version === 2 &&
          "ok" in message &&
          message.ok === true,
      );
    };
    const timer = setTimeout(
      () => finish(false),
      operation === "foreground-park" ? 30 * 60_000 : 30_000,
    );
    process.on("message", onMessage).once("disconnect", onDisconnect);
    process.send!({ type: operation, version: 2, requestId }, (error: Error | null) => {
      if (error) {
        finish(false);
      }
    });
  });
  const current = readManagedServiceUpdateHandoffLease(resolveUpdateInstallRoot(params.root));
  return (
    accepted &&
    current?.payload === lease?.payload &&
    hasForegroundUpdatePaths(meta.foregroundOrigin, env) &&
    (await isCurrentManagedServiceUpdateHandoffProcess(params))
  );
}

export async function isCurrentForegroundUpdateHandoffProcess(params: {
  root: string;
  runId: string | undefined;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  return exchangeForegroundUpdateHandoff(params, "foreground-inspect");
}

export async function parkForegroundUpdateHandoff(params: {
  root: string;
  run: { runId: string; env: NodeJS.ProcessEnv; gatewayRestartRequired?: true };
}): Promise<void> {
  if (
    !(await exchangeForegroundUpdateHandoff(
      { root: params.root, runId: params.run.runId, env: params.run.env },
      "foreground-park",
    ))
  ) {
    throw new Error("Foreground update helper could not verify Gateway closure");
  }
  params.run.gatewayRestartRequired = true;
}

export function isForegroundUpdateHandoff(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): boolean {
  const owner = activeManagedServiceUpdateHandoffs.get(
    resolveUpdateInstallRoot(identity.installRoot),
  );
  return owner?.handoffId === identity.handoffId && owner.foregroundOrigin !== undefined;
}

export type ForegroundUpdateStop = {
  settle: () => Promise<boolean>;
  canPark: (identity: NonNullable<GatewayRestartIntent["successorOwner"]>) => boolean;
};

/** Retain exact owners so a later Stop can reconcile previously uncertain settlement. */
export function captureForegroundUpdateHandoffStop(params: {
  onPark: (identity: NonNullable<GatewayRestartIntent["successorOwner"]>) => void;
}): ForegroundUpdateStop | undefined {
  const owners = [...activeManagedServiceUpdateHandoffs].filter(
    ([, owner]) => owner.foregroundOrigin?.pid === process.pid,
  );
  if (!owners.length) {
    return undefined;
  }
  const canPark: ForegroundUpdateStop["canPark"] = (identity) =>
    owners.some(
      ([root, owner]) =>
        owner.parkReady &&
        owner.handoffId === identity.handoffId &&
        root === resolveUpdateInstallRoot(identity.installRoot) &&
        activeManagedServiceUpdateHandoffs.get(root) === owner &&
        claimManagedServiceUpdateHandoff(identity),
    );
  return {
    canPark,
    settle: async () => {
      for (const [root, owner] of owners) {
        const identity = {
          kind: "managed-update-handoff" as const,
          installRoot: root,
          handoffId: owner.handoffId,
        };
        owner.closeForStop = () => {
          if (canPark(identity)) {
            params.onPark(identity);
          }
        };
        owner.closeForStop();
      }
      const settled = await Promise.allSettled(
        owners.map(async ([root, owner]) => {
          // A failed launch can still own a child or lease; neither is inferred absent.
          await owner.flight?.catch(() => {});
          await owner.closed;
          const child = owner.launcher;
          if (
            child &&
            ((child.pid && child.exitCode === null && child.signalCode === null) ||
              readManagedServiceUpdateHandoffLease(root, owner) !== null)
          ) {
            return false;
          }
          if (!owner.parkReady && activeManagedServiceUpdateHandoffs.get(root) === owner) {
            activeManagedServiceUpdateHandoffs.delete(root);
          }
          delete owner.closeForStop;
          return true;
        }),
      );
      return settled.every((result) => result.status === "fulfilled" && result.value);
    },
  };
}

export async function completeForegroundUpdateHandoffAfterClose(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): Promise<{ respawn: boolean } | "pending"> {
  const root = resolveUpdateInstallRoot(identity.installRoot);
  const owner = activeManagedServiceUpdateHandoffs.get(root);
  const child = owner?.launcher;
  if (
    !isForegroundUpdateHandoff(identity) ||
    !child ||
    !claimManagedServiceUpdateHandoff(identity)
  ) {
    return "pending";
  }
  const response = await sendManagedServiceUpdateHandoffCommand(identity, "closed");
  // The helper's settled reply is sent only after joining the updater and releasing its lease.
  // Join its process too; a timeout or unknown outcome never reopens the old module graph.
  await owner.closed;
  if (readManagedServiceUpdateHandoffLease(root, owner) !== null) {
    return "pending";
  }
  const respawn =
    response === "foreground-settled:respawn" &&
    child.exitCode !== null &&
    child.signalCode === null &&
    activeManagedServiceUpdateHandoffs.get(root) === owner;
  if (activeManagedServiceUpdateHandoffs.get(root) === owner) {
    activeManagedServiceUpdateHandoffs.delete(root);
  }
  return { respawn };
}

function sendManagedServiceUpdateHandoffCommand(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
  command: string,
): Promise<string | null> {
  const owner = activeManagedServiceUpdateHandoffs.get(
    resolveUpdateInstallRoot(identity.installRoot),
  );
  const child = owner?.launcher;
  if (!owner || !child?.stdin || !child.stdout || child.stdin.destroyed) {
    return Promise.resolve(null);
  }
  return waitForHandoffResponse(
    child,
    command === "park" ? owner.parentExitTimeoutMs : owner.recoveryTimeoutMs,
    command,
  ).catch(() => null);
}

export async function requestManagedServiceUpdateHandoffPark(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): Promise<boolean> {
  if (!claimManagedServiceUpdateHandoff(identity)) {
    return false;
  }
  const root = resolveUpdateInstallRoot(identity.installRoot);
  const owner = activeManagedServiceUpdateHandoffs.get(root);
  if (owner?.foregroundOrigin) {
    return true;
  }
  await owner?.beforePark?.();
  // A notice can await transport recovery. Only the same live helper may
  // receive park after that await; a replacement never inherits this effect.
  if (
    activeManagedServiceUpdateHandoffs.get(root) !== owner ||
    !claimManagedServiceUpdateHandoff(identity)
  ) {
    return false;
  }
  return (
    (await sendManagedServiceUpdateHandoffCommand(identity, "park")) === "parked" &&
    claimManagedServiceUpdateHandoff(identity)
  );
}

export async function commitManagedServiceUpdateHandoff(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
  outcome: "update" | "restore" = "update",
): Promise<boolean> {
  return (
    claimManagedServiceUpdateHandoff(identity) &&
    (await sendManagedServiceUpdateHandoffCommand(
      identity,
      outcome === "update" ? "commit" : "restore-commit",
    )) === "committed"
  );
}

export async function transferManagedServiceUpdateHandoff(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): Promise<boolean> {
  const active = activeManagedServiceUpdateHandoffs.get(
    resolveUpdateInstallRoot(identity.installRoot),
  );
  const child = active?.launcher;
  if (active?.foregroundOrigin && isGatewayRestartDraining()) {
    return false;
  }
  if (!active || !child?.stdin || !child.stdout || !claimManagedServiceUpdateHandoff(identity)) {
    return false;
  }
  active.requesterAuthority?.assertCurrent();
  active.requesterAuthority?.signal?.throwIfAborted();
  active.transferred = true;
  if ((await sendManagedServiceUpdateHandoffCommand(identity, "transfer")) !== "transferred") {
    active.transferred = false;
    return false;
  }
  // The acknowledged helper may already have bound its lease to the validating
  // child. Only acknowledged transfer releases the child and its control pipes;
  // readiness still owns cancellation through native exit.
  child.unref();
  unrefHandoffPipe(child.stdin);
  unrefHandoffPipe(child.stdout);
  return true;
}

export async function cancelManagedServiceUpdateHandoff(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): Promise<"restored-in-process" | "restart-after-exit" | false> {
  const root = resolveUpdateInstallRoot(identity.installRoot);
  const active = activeManagedServiceUpdateHandoffs.get(root);
  if (
    identity.kind !== "managed-update-handoff" ||
    active?.handoffId !== identity.handoffId ||
    !active.leaseStore ||
    active.cancelling
  ) {
    return false;
  }
  active.cancelling = true;
  try {
    const current = readManagedServiceUpdateHandoffLease(root);
    if (current?.action.kind === "triage") {
      if (
        current.owner !== active.handoffId ||
        JSON.stringify(current.helper) !== JSON.stringify(active.helper?.helper) ||
        JSON.stringify({ ...current.action, phase: "reserved" }) !==
          JSON.stringify(active.helper?.action) ||
        !active.leaseStore.stopNative(current)
      ) {
        return false;
      }
    }
    const child = active.launcher;
    if (child && !active.exited && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      const response = await sendManagedServiceUpdateHandoffCommand(identity, "cancel");
      if (response === "restore-after-exit") {
        return "restart-after-exit";
      }
      if (response !== "cancelled" && !active.exited && !child.stdin.destroyed) {
        return false;
      }
      await exited;
    }
    if (
      readManagedServiceUpdateHandoffLease(root, active) !== null ||
      activeManagedServiceUpdateHandoffs.get(root) !== active
    ) {
      return false;
    }
    activeManagedServiceUpdateHandoffs.delete(root);
    return "restored-in-process";
  } catch {
    return false;
  } finally {
    active.cancelling = false;
    if (active.parkAdmitted) {
      active.closeForStop?.();
    }
  }
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
