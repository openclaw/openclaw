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
import { resolveUpdatedInstallCommandEnv } from "../cli/update-cli/update-command-service-env.js";
import type { TriageFailureContext } from "../commands/triage-prompt.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { findInstalledSystemdGatewayScope } from "../daemon/systemd-scope.js";
import { resolveSystemdServiceName } from "../daemon/systemd-service-files.js";
import { buildCliRespawnPlan } from "../entry.respawn.js";
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
import { installationTargetEnv, resolveInstallationTarget } from "./installation-target-context.js";
import { resolveNodeSqliteLocation } from "./node-sqlite.js";
import { probePortUsage } from "./ports-probe.js";
import type { GatewayRestartIntent } from "./restart-intent.js";
import { SUPERVISOR_HINT_ENV_VARS, type RespawnSupervisor } from "./supervisor-markers.js";
import type { UpdateChannel } from "./update-channels.js";
import {
  CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
  readControlPlaneUpdateSentinelMeta,
  MANAGED_SERVICE_UPDATE_UNSAFE_EXIT_CODE,
  UPDATE_RUN_ID_ENV,
  type ControlPlaneUpdateSentinelMetaFile,
} from "./update-control-plane-sentinel.js";
import { applyDevUpdateTargetEnv, type DevUpdateTarget } from "./update-dev-target.js";
import { resolvePnpmGlobalInstallOwner, verifyPackageUpdateRecovery } from "./update-global.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";
import { MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX } from "./update-managed-service-handoff-cleanup.js";
import {
  formatManagedServiceUpdateCommand,
  resolveManagedServiceCliArgv,
  resolveUpdateCliArgv,
} from "./update-managed-service-handoff-command.js";
import {
  HANDOFF_COMMAND_RUNNER_SCRIPT,
  HANDOFF_EXEC_RUNNER_SCRIPT,
  HANDOFF_NOTICE_MARKER,
  unrefHandoffPipe,
  waitForHandoffResponse,
  type HandoffChild,
} from "./update-managed-service-handoff-control.js";
import {
  assertManagedUpdateLeaseDatabaseIdentity,
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
  type ManagedUpdateLeaseDatabaseIdentity,
} from "./update-managed-service-handoff-database.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
  type ManagedHandoffLease,
} from "./update-managed-service-handoff-lease.js";
import { MANAGED_HANDOFF_NATIVE_SCOPE_SOURCE } from "./update-managed-service-handoff-native-scope-source.js";
import { MANAGED_HANDOFF_RUNTIME_ENTRY } from "./update-managed-service-handoff-runtime-assets.js";
import { stageManagedHandoffRuntime } from "./update-managed-service-handoff-runtime.js";
import { resolveGatewayServiceRecovery } from "./update-managed-service-handoff-service.js";
import { resolveManagedUpdateRequester } from "./update-requester-authority.js";
import type {
  ForegroundUpdateOrigin,
  UpdateRestartSentinelMeta,
} from "./update-restart-sentinel-payload.js";
import { recordUpdateRunStep } from "./update-run-ledger.js";
import { readCurrentGitUpdateRecovery } from "./update-runner-git-recovery.js";
import { looksLikeGitCheckout } from "./update-runner-install-surface.js";

// The activation deadline covers Gateway drain plus this shutdown reserve.
const PARENT_EXIT_SHUTDOWN_RESERVE_MS = 30_000;
const HANDOFF_READY_MARKER = "OPENCLAW_UPDATE_HANDOFF_READY\n";
const HANDOFF_BUSY_MARKER = "HANDOFF_BUSY ";
const SERVICE_IDENTITY_ENV_VARS = new Set<string>([
  "OPENCLAW_LAUNCHD_LABEL",
  "OPENCLAW_SYSTEMD_UNIT",
  "OPENCLAW_WINDOWS_TASK_NAME",
] as const);
const HANDOFF_SCRIPT = String.raw`
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const params = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));

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

const { OPENCLAW_STATE_SCHEMA_SQL, assertOpenClawStateWriteAllowed, createManagedHandoffLeaseStore, extractSqliteTableSchema, readRestartSentinelRowSync, writeRestartSentinelRowIfRevisionSync, resolveImmutableSqliteFileUri, resolveUpdateRestartNoticeMeta, shouldPublishUpdateRestartNotice } =
  require("./runtime/${MANAGED_HANDOFF_RUNTIME_ENTRY}");
if (!params.updateLeaseDatabaseIdentity) {
  throw new Error("Managed handoff requires its prepared lease database identity");
}
const leaseStore = createManagedHandoffLeaseStore({
  databasePath: params.updateLeaseDatabasePath,
  serviceManagerEnv: params.serviceManagerEnv,
  existingIdentity: params.updateLeaseDatabaseIdentity,
  onProcessIdentityWarning: (pid, message) => {
    appendLog(message);
    runWarnings.set("warning:process-start-identity:" + pid, message);
    if (runLedger && !updaterStarted) recordRunWarnings(runLedger);
  },
}, { warn: (message, metadata) => appendLog(message + " " + JSON.stringify(metadata)) });
const { isPidAlive, properties: parseSystemdProperties, validFailure: validTriageFailure } = leaseStore;
const runWarnings = new Map();
function recordRunWarnings(ledger) {
  if (!params.runId) return;
  for (const [step, detail] of runWarnings) {
    try {
      ledger.recordUpdateRunStep(params.runId, { step, status: "completed", detail, endedAtMs: Date.now() });
      runWarnings.delete(step);
    } catch { /* The candidate runtime records warnings after state migration. */ }
  }
}
function parentIdentityCurrent() {
  return leaseStore.isProcessIdentityCurrent({ pid: params.parentPid, startIdentity: params.parentStartIdentity }, params.parentPid === process.ppid && !process.stdin.destroyed && !process.stdin.readableEnded);
}
let managedUpdateLease = null;
let triageRequesterAuthority;
function assertTriageRequester() {
  if (triageRequesterAuthority && !triageRequesterAuthority.isCurrent())
    throw new Error("requester-revoked");
}
let activeCommand;
let updateCancelled = false;
let activationRejected;
function initialTriageAction() {
  return { kind: "triage", phase: "reserved", lifetime: { kind: "native", unit: params.serviceRecovery.unit, scope: params.scopeUnit, placement: { kind: "pending" } } };
}
function acquireManagedUpdateLease() {
  const result = leaseStore.acquire(params.updateLeaseKey, params.updateLeaseOwner,
    params.action === "triage" ? initialTriageAction() : { kind: "update" }, params.triageTransition);
  if (result.kind === "acquired") {
    managedUpdateLease = result.lease;
    if (params.action === "triage") nativePlacement = result.lease;
  }
  return { acquired: result.kind === "acquired", owner: result.owner };
}
function bindManagedUpdateLeaseToProcess(pid, expectedPayload, action, argv) {
  if (!managedUpdateLease || expectedPayload && managedUpdateLease.payload !== expectedPayload) return false;
  const next = leaseStore.bind(managedUpdateLease, pid, action, argv);
  if (!next) return false;
  managedUpdateLease = next;
  return true;
}
function hasManagedUpdateLease() { return managedUpdateLease && leaseStore.owns(managedUpdateLease); }
function ownsManagedUpdateLease() {
  return hasManagedUpdateLease() && (managedUpdateLease.executor.pid === process.pid ||
    (activeCommand?.pid === managedUpdateLease.executor.pid &&
      leaseStore.isProcessIdentityCurrent(managedUpdateLease.executor, activeCommand.exitCode === null && activeCommand.signalCode === null)));
}
function releaseManagedUpdateLease() {
  const lease = managedUpdateLease;
  if (!lease) return;
  try {
    if (lease.action.kind === "triage") leaseStore.settle(lease, "closing");
    else leaseStore.release(lease);
  } catch (error) { appendLog("managed handoff release failed: " + String(error)); }
  managedUpdateLease = null;
}

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


let triageFailure;
let runLedger;
let runOutcome;
let terminalRuntimePath = params.recoveryModulePath;
let serviceStoppedAtMs, serviceDowntimeMs;

async function finishManagedUpdateRun() {
  if (!runLedger || !runOutcome) return;
  if (foregroundParked && runOutcome.status === "succeeded") return;
  if (!ownsManagedUpdateLease()) throw new Error("managed update terminal writer lost its current claim");
  const terminalResult = { ...runOutcome, ...(serviceDowntimeMs !== undefined ? { downtimeMs: serviceDowntimeMs } : {}) };
  if (!updaterStarted) { recordRunWarnings(runLedger); runLedger.finishUpdateRun(params.runId, terminalResult); }
  else {
    // Doctor may have advanced the schema. A new process loads the candidate's
    // entire module graph; a cache-busted import would retain old DB readers.
    const payload = JSON.stringify([terminalRuntimePath, params.runId, terminalResult, [...runWarnings],
      path.join(params.cwd, "runtime", ${JSON.stringify(MANAGED_HANDOFF_RUNTIME_ENTRY)}),
      params.updateLeaseDatabaseIdentity, params.updateLeaseKey, params.handoffId, managedUpdateLease.helper]);
    if (Buffer.byteLength(payload) > 64 * 1024) throw new Error("managed update terminal result exceeds the command payload limit");
    const exit = await runOwnedUpdateCommand("finalize", [process.execPath, "--input-type=module", "-e",
      'import { pathToFileURL } from "node:url"; const [modulePath, runId, result, warnings, leaseRuntime, databaseIdentity, root, owner, helper] = JSON.parse(process.argv[1]); const { finishUpdateRun, recordUpdateRunDiagnostic, recordUpdateRunStep } = await import(pathToFileURL(modulePath).href); const { createManagedHandoffLeaseStore } = await import(pathToFileURL(leaseRuntime).href); const store = createManagedHandoffLeaseStore({ databasePath: databaseIdentity.databasePath, existingIdentity: databaseIdentity }); const current = store.read(root); const lease = current.kind === "current" ? current.lease : null; if (!lease || lease.owner !== owner || lease.executor.pid !== process.pid || JSON.stringify(lease.helper) !== JSON.stringify(helper) || !(store.isProcessIdentityCurrent(lease.executor) || (process.connected && store.acceptParentBoundExecutor(lease)))) throw new Error("managed update terminal writer lost its current claim"); for (const [step, detail] of warnings) { try { if (recordUpdateRunDiagnostic) recordUpdateRunDiagnostic(runId, detail, undefined, step); else recordUpdateRunStep(runId, {step,status:"completed",detail,endedAtMs:Date.now()}); } catch {} } finishUpdateRun(runId, result);',
      payload], params.recoveryTimeoutMs);
    if (exit.signal || exit.code !== 0) throw new Error("installed runtime could not finalize the update run");
  }
  runOutcome = undefined;
}

function isFailedUpdateOutcome(status, reason) {
  return status === "error" || (status === "skipped" &&
    !params.nonFailureSkippedReasons.includes(reason));
}

function captureFailedUpdateResult() {
  // Enrich an already recorded failure; diagnostic artifacts never decide the
  // update outcome or permission to restart the service.
  if (fs.existsSync(params.triageContextPath)) {
    triageFailure = { ...triageFailure, reason: "managed-service-handoff-failed" };
    return true;
  }
  const db = openStateDatabase();
  if (!db) return false;
  try {
    const current = readRestartSentinelRowSync(db);
    const payload = current.kind === "valid" ? current.sentinel.payload : undefined;
    if (payload?.kind !== "update" || payload.stats?.handoffId !== params.handoffId ||
      !isFailedUpdateOutcome(payload.status, payload.stats?.reason)) return false;
    triageFailure = { ...triageFailure, payload, reason: payload.stats.reason || "managed-service-handoff-failed" };
    return true;
  } finally {
    db.close();
  }
}

function recordUpdateHandoffOutcome(reason, restored, completedStatus, expectedRevision) {
  if (!ownsManagedUpdateLease()) return false;
  let metaFile;
  try {
    metaFile = JSON.parse(fs.readFileSync(params.metaPath, "utf-8"));
  } catch {}
  const run = runLedger?.getUpdateRun(params.runId);
  // Cancellation must preserve a refusal already recorded by the Gateway.
  if (reason === "managed-service-handoff-cancelled" && run?.reason &&
      run.steps.some((step) => step.step === "requested" && step.status === "failed")) reason = run.reason;
  const meta = resolveUpdateRestartNoticeMeta(run, metaFile && metaFile.version === 1 && metaFile.meta ? metaFile.meta : {});
  const status = (reason === "managed-service-handoff-cancelled" || completedStatus === "skipped") && restored !== false
    ? "skipped" : "error";
  runOutcome = { status: status === "error" ? "failed" : "skipped", reason };
  const fallbackPayload = {
    kind: "update",
    status,
    ts: Date.now(),
    message: typeof meta.note === "string" ? meta.note : null,
    stats: {
      mode: "unknown",
      ...(typeof meta.runId === "string" && meta.runId.trim() ? { runId: meta.runId } : {}),
      ...(typeof meta.root === "string" && meta.root.trim() ? { root: meta.root } : {}),
      ...(meta.completionOwner !== "gateway-restart" && typeof meta.handoffId === "string" && meta.handoffId.trim()
        ? { handoffId: meta.handoffId }
        : {}),
      reason,
      steps: [],
      durationMs: 0,
    },
  };
  for (const key of ["sessionKey", "threadId"]) {
    if (typeof meta[key] === "string" && meta[key].trim()) fallbackPayload[key] = meta[key];
  }
  if (meta.deliveryContext && typeof meta.deliveryContext === "object") {
    fallbackPayload.deliveryContext = meta.deliveryContext;
  }
  if (status === "error") triageFailure ??= { payload: fallbackPayload, reason };
  if (triageFailure && typeof restored === "boolean") triageFailure.restored = restored;
  // The direct child verdict, native lease and original run still own settlement.
  // Do not synthesize a notice that an older restored runtime would turn into work.
  if (!shouldPublishUpdateRestartNotice(run, meta)) return true;
  const db = openStateDatabase();
  if (!db) return null;
  let recorded = null;
  try {
    leaseStore.transact(db, () => {
      assertStateDatabaseWriteAllowed(db);
      const row = readRestartSentinelRowSync(db);
      if (row.kind === "invalid") return;
      const current = row.kind === "valid" ? row.sentinel : null;
      if (expectedRevision !== undefined && (!current || current.revision !== expectedRevision)) {
        recorded = true;
        return;
      }
      let payload = current && current.payload;
      // A completed child attempts publication before recovery. A missing row
      // may already be consumed; do not retry its best-effort notification here.
      if (completedStatus && !payload) { recorded = true; return; }
      const handoffId = typeof params.handoffId === "string" ? params.handoffId.trim() : "";
      if (
        (payload && (payload.kind !== "update" || (!isFailedUpdateOutcome(payload.status, payload.stats?.reason) &&
          (payload.status !== "skipped" || (completedStatus !== "skipped" &&
            !["managed-service-handoff-started", "restart-health-pending", "managed-service-handoff-cancelled"].includes(payload.stats?.reason)))))) ||
        (payload && handoffId && (!payload.stats || payload.stats.handoffId !== handoffId)) ||
        (payload?.stats?.root && payload.stats.root !== params.updateLeaseKey)
      ) {
        return;
      }
      if (payload) {
        const failed = isFailedUpdateOutcome(payload.status, payload.stats?.reason);
        const preserveChildStatus = completedStatus === payload.status && restored !== false;
        // A failed attempt keeps its reason when recovery turns a skipped status into an error.
        payload = {
          ...payload,
          status: payload.status === "error" || preserveChildStatus ? payload.status : status,
          stats: { ...(payload.stats || {}), reason: failed || preserveChildStatus ? payload.stats?.reason ?? reason : reason },
        };
        delete payload.continuation;
      } else {
        payload = fallbackPayload;
      }
      if (isFailedUpdateOutcome(payload.status, payload.stats?.reason)) {
        payload.doctorHint = params.triageHint;
        triageFailure ??= { reason };
        triageFailure.payload = payload;
      }
      if (params.foregroundOrigin) delete payload.stats.handoffId;
      runOutcome = { status: payload.status === "error" ? "failed" : "skipped", reason: payload.stats?.reason ?? reason };
      if (typeof restored === "boolean") {
        payload.stats.steps = [
          ...(payload.stats.steps || []),
          { name: "service-restore", command: params.serviceRecovery.kind,
            log: { exitCode: restored ? 0 : 1, ...(completedStatus && !restored ? { stderrTail: reason } : {}) } },
        ];
      }
      recorded = writeRestartSentinelRowIfRevisionSync(db, payload, current ? current.revision : null)?.revision ?? null;
      if (recorded === null) {
        throw new Error("restart sentinel changed before guarded failure write");
      }
      if (triageFailure) triageFailure.payload = payload;
    });
  } catch (err) {
    recorded = null;
    appendLog("failed to write update sentinel failure: " + (err && err.stack ? err.stack : String(err)));
  } finally {
    try {
      db.close();
    } catch {}
  }
  return recorded;
}



function runServiceCommand(command, args, onSpawn, deadline, timeoutCap) {
  if (!hasManagedUpdateLease()) return Promise.resolve({ code: 1, stdout: "", stderr: "" });
  return new Promise((resolve) => {
    const remaining = deadline === undefined ? params.recoveryTimeoutMs : deadline - Date.now();
    if (remaining <= 0) return resolve({ code: 1, stdout: "", stderr: "" });
    let stdout = "",
      stderr = "";
    const child = spawn(command, args, {
      env: params.serviceManagerEnv,
      stdio: ["ignore", "pipe", "pipe"],
      killSignal: "SIGKILL",
      timeout: Math.min(timeoutCap ?? remaining, remaining),
    });
    child.stdout?.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-8192);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.once("spawn", () => onSpawn?.());
    child.once("error", (error) => {
      stderr = String(error);
    });
    child.once("close", (code) =>
      resolve({ code: typeof code === "number" ? code : 1, stdout, stderr }),
    );
  });
}

${MANAGED_HANDOFF_NATIVE_SCOPE_SOURCE}

process.once("SIGTERM", () => {
  if (params.action !== "triage") return process.exit(143);
  if (managedUpdateLease) leaseStore.settle(managedUpdateLease, "closing");
  appendLog("automatic triage cancelled by termination signal; no Gateway restoration");
  cleanupSensitiveFiles();
  releaseManagedUpdateLease();
  stopTriageScope();
  process.exit(143);
});

async function enterTriageAfterUpdate(continuation) {
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
    process.argv[1],
    process.argv[2],
  ];
  const triageEnv = { ...process.env };
  delete triageEnv[${JSON.stringify(UPDATE_RUN_ID_ENV)}];
  process.execve(command, argv, triageEnv);
}

function isLaunchdNotLoaded(result) {
  return /no such process|could not find service|not found/i.test(result.stderr || result.stdout);
}

let parkedServiceGeneration = null;
let parkedServiceInvocation = null;
let parkedServiceFragment = null;
let restorationArmed = false;
let updaterStarted = false;
let pendingServiceStop;
let finishBeforeParkNotice;

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
  if (updateCancelled || (params.foregroundOrigin && activationRejected) || !ownsManagedUpdateLease() ||
    !parentIdentityCurrent()) {
    throw new Error("managed update activation no longer owns the serving gateway");
  }
}

async function parkGatewayService() {
  const recovery = params.serviceRecovery;
  if (!recovery) return;
  assertGatewayParkOwner();
  if (recovery.kind === "schtasks") {
    pendingServiceStop = runServiceCommand("schtasks.exe", ["/End", "/TN", recovery.taskName], () => {
      restorationArmed = true;
      recordServiceStop();
    }, params.parentExitDeadlineAt, params.parentExitTimeoutMs);
    if ((await pendingServiceStop).code !== 0) throw new Error("scheduled task stop failed");
    return;
  }
  if (recovery.kind === "systemd") {
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
    // Keep the exact stop job open across parent exit; its completion is the
    // authoritative systemd fact, even after inactive-unit metadata is collected.
    await new Promise((resolve, reject) => {
      pendingServiceStop = runServiceCommand(
        "systemctl",
        ["--user", "stop", recovery.unit],
        () => {
          restorationArmed = true;
          recordServiceStop();
          resolve();
        },
        params.parentExitDeadlineAt,
        params.parentExitTimeoutMs,
      );
      pendingServiceStop.then((result) => {
        if (!restorationArmed) reject(new Error("systemd stop failed: " + result.stderr));
      });
    });
    return;
  }
  if (recovery.kind !== "launchd") throw new Error("unsupported managed update supervisor");
  const target = "gui/" + recovery.uid + "/" + recovery.label;
  const inspection = await runServiceCommand("launchctl", ["print", target], undefined, params.parentExitDeadlineAt);
  const parentMatch = /^\s*pid\s*=\s*([1-9]\d*)\s*$/im.exec(inspection.stdout);
  if (inspection.code !== 0 || Number(parentMatch?.[1]) !== params.parentPid) {
    throw new Error("launchd service does not match the exact active gateway parent");
  }
  assertGatewayParkOwner();
  restorationArmed = true;
  const disabled = await runServiceCommand("launchctl", ["disable", target], undefined, params.parentExitDeadlineAt);
  if (disabled.code !== 0) throw new Error("launchctl disable failed: " + disabled.stderr);
  assertGatewayParkOwner();
  // bootout shares the activation deadline; its accepted spawn acknowledges parking.
  await new Promise((resolve, reject) => {
    pendingServiceStop = runServiceCommand("launchctl", ["bootout", target], () => { recordServiceStop(); resolve(); }, params.parentExitDeadlineAt);
    pendingServiceStop.then((result) => {
      if (result.code !== 0 && !isLaunchdNotLoaded(result)) {
        reject(new Error("launchctl bootout failed: " + result.stderr));
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
  if (decision?.serviceRestartSafe !== true || !decision.version) {
    appendLog("recovery refused: original runtime identity could not be verified");
    record(false);
    return false;
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
      appendLog("recovery refused: exact systemd stop did not complete");
      record(false);
      return false;
    }
    const parked = await inspectSystemdService(recovery.unit);
    const retained = parked?.ExecMainStartTimestampMonotonic === parkedServiceGeneration &&
      parked?.InvocationID === parkedServiceInvocation;
    const cleared = parked?.ExecMainStartTimestampMonotonic === "0" && !parked?.InvocationID;
    // A Gateway that exits non-zero during the stop (KillMode=mixed) settles the unit
    // into ActiveState=failed with the parked identity retained; that is still the
    // exact parked generation and recovery stays safe. An owned candidate boot can
    // advance inactive-unit metadata. Only a verified full-generation rollback
    // permits recovering that later stopped invocation.
    if (!parked || parked.Id !== recovery.unit || parked.LoadState !== "loaded" ||
      (parked.ActiveState !== "inactive" && parked.ActiveState !== "failed") ||
      parked.MainPID !== "0" || !(previousGeneration || retained || cleared) ||
      !ownsRecovery()) {
      appendLog("recovery refused: parked systemd service identity changed or stop is incomplete");
      record(false);
      return false;
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
      const pid = Number(/^\s*pid\s*=\s*([1-9]\d*)\s*$/im.exec(before.stdout)?.[1]);
      if (pid && pid !== params.parentPid) {
        appendLog("recovery refused: launchd service has another process generation");
        record(false);
        return false;
      }
    } else if (!isLaunchdNotLoaded(before)) {
      record(false);
      return false;
    }
    if (childStatus) {
      const restarted = await restart();
      // The guarded CLI owns its restart deadline; identity inspection gets a fresh probe budget.
      const current = ownsRecovery()
        ? await runOwned("launchctl", ["print", target]) : null;
      const pid = current?.code === 0
        ? Number(/^\s*pid\s*=\s*([1-9]\d*)\s*$/im.exec(current.stdout)?.[1]) : 0;
      serviceRunning = current?.code === 0 ? Boolean(pid && isPidAlive(pid)) : undefined;
      servicePid = serviceRunning ? pid : undefined;
      restored = !restarted.signal && restarted.code === 0 && Boolean(pid && pid !== params.parentPid && serviceRunning);
    } else {
    const enabled = await run(["enable", target]);
    let kickstarted = false;
    for (let inspection = enabled; enabled.code === 0 && Date.now() < deadline;) {
      inspection = await run(["print", target]);
      if (inspection.code === 0) {
        const pid = Number(/^\s*pid\s*=\s*([1-9]\d*)\s*$/im.exec(inspection.stdout)?.[1]);
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
      if ((current.ActiveState === "inactive" || current.ActiveState === "failed") &&
        current.MainPID === "0") {
        // KillMode=mixed units settle into ActiveState=failed instead of inactive
        // when the Gateway main process exits non-zero during the stop. The parked
        // generation/invocation stays retained in that state, so it is still the
        // exact parked unit and activation may proceed.
        const retainedIdentity =
          current.ExecMainStartTimestampMonotonic === parkedServiceGeneration &&
          current.InvocationID === parkedServiceInvocation;
        const clearedIdentity =
          current.ExecMainStartTimestampMonotonic === "0" && !current.InvocationID;
        if (!retainedIdentity && !clearedIdentity) {
          throw new Error("systemd service remained active or changed execution generation");
        }
        break;
      }
      if (current.ActiveState !== "deactivating" || current.MainPID !== "0" ||
        current.ExecMainStartTimestampMonotonic !== parkedServiceGeneration ||
        current.InvocationID !== parkedServiceInvocation) {
        throw new Error("systemd service remained active or changed execution generation");
      }
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
  await assertForegroundOrigin();
  await prepareTransferredGateway();
  const deadline = Date.now() + params.parentExitTimeoutMs;
  while (!foregroundClosed) {
    assertGatewayParkOwner();
    if (Date.now() >= deadline) throw new Error("foreground Gateway did not close before activation deadline");
    await sleep(Math.min(25, Math.max(0, deadline - Date.now())));
  }
  await assertForegroundOrigin(true);
  foregroundParked = true;
}
async function prepareTransferredGateway() {
  if (!transferPrepared) {
    const delayedUntil = Date.now() + params.restartDelayMs;
    while (Date.now() < delayedUntil) {
      if (updateCancelled || !ownsManagedUpdateLease()) throw new Error("managed update activation cancelled");
      await sleep(Math.min(250, Math.max(0, delayedUntil - Date.now())));
    }
    // The serving Gateway owns its final notice; the retained control pipe joins
    // that durable write before native stop, without extending the 10s notice bound.
    if (params.beforePark && !process.stdin.destroyed) {
      await new Promise((resolve) => {
        const finish = () => { clearTimeout(timer); finishBeforeParkNotice = undefined; resolve(); };
        const timer = setTimeout(() => {
          appendLog("pre-park notice timed out after 10 seconds");
          finish();
        }, 10_000);
        finishBeforeParkNotice = finish;
        fs.writeSync(1, ${JSON.stringify(HANDOFF_NOTICE_MARKER)});
      });
    }
  }
  if (params.requester) {
    const { isManagedUpdateRequesterOwner } = await import(pathToFileURL(params.recoveryModulePath).href);
    if (!(await isManagedUpdateRequesterOwner(params.requester))) {
      throw Object.assign(new Error("owner_required: chat requester is no longer a configured command owner"), { code: "owner_required" });
    }
  }
  assertGatewayParkOwner();
  transferPrepared = true;
}

async function activateTransferredGateway() {
  await prepareTransferredGateway();
  // Validation has its own budget. The shutdown reserve starts only at activation.
  params.parentExitDeadlineAt = Date.now() + params.parentExitTimeoutMs;
  await parkGatewayService();
  while (isPidAlive(params.parentPid)) {
    if (!ownsManagedUpdateLease()) throw new Error("managed update activation ownership lost");
    if (!parentIdentityCurrent()) {
      if (!isPidAlive(params.parentPid)) break;
      throw new Error("managed update parent identity changed during activation");
    }
    if (Date.now() >= params.parentExitDeadlineAt) {
      try { process.kill(params.parentPid, "SIGKILL"); } catch {}
      throw new Error("managed update parent exit exceeded the activation deadline");
    }
    await sleep(Math.min(25, Math.max(0, params.parentExitDeadlineAt - Date.now())));
  }
  await finishGatewayServicePark();
}

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


async function runOwnedUpdateCommand(phase, commandArgv, timeoutMs, cwd = params.cwd, env = process.env) {
  const updaterChunks = [];
  let updaterBytes = 0;
  let outputOverflow = false;
  let outputFd;
  let timeout;
  let continuation;
  let stagedContinuation;
  let continuationCancelled = false;
  let triageAdmitted = false;
  let leaseWatch;
  let admissionDeadline;
  let activation;
  let activationAcknowledged = false;
  let outputPrefix = Buffer.alloc(0);
  let controlPending = phase === "update" && !restorationArmed;
  try {
    outputFd = fs.openSync(params.logPath, "a", 0o600);
    const retainedIpc = Array.isArray(params.nodeExecArgv);
    const child = spawn(
      retainedIpc ? commandArgv[0] : process.execPath,
      retainedIpc
        ? [
            ...params.nodeExecArgv,
            "--import",
            ${JSON.stringify(`data:text/javascript,${encodeURIComponent(HANDOFF_COMMAND_RUNNER_SCRIPT)}`)},
            ...commandArgv.slice(1),
          ]
        : ["-e", ${JSON.stringify(HANDOFF_EXEC_RUNNER_SCRIPT)}, JSON.stringify(commandArgv)],
      {
        cwd,
        env:
          params.action === "triage"
            ? { ...env, NODE_DISABLE_COMPILE_CACHE: "1" }
            : phase === "update" ? { ...env, OPENCLAW_UPDATE_RUN_HANDOFF: "1" } : env,
        detached: true,
        stdio: ["pipe", "pipe", outputFd, "ipc", "pipe"],
      },
    );
    const rejectActivation = (error) => {
      if (!activationAcknowledged) activationRejected = error?.code === "owner_required" ? "owner_required" : "managed-service-handoff-helper-failed";
      appendLog("managed update activation failed: " + String(error));
      child.stdin.end("cancelled\n");
      if (child.exitCode === null && child.signalCode === null) killOwnedCommand(child);
    };
    child.stdout.on("data", (chunk) => {
      if (controlPending) {
        outputPrefix = Buffer.concat([outputPrefix, chunk]);
        const marker = Buffer.from("park\n");
        if (outputPrefix.length < marker.length && marker.subarray(0, outputPrefix.length).equals(outputPrefix)) return;
        controlPending = false;
        if (outputPrefix.subarray(0, marker.length).equals(marker)) {
          chunk = outputPrefix.subarray(marker.length);
          activation = (async () => {
            try {
              await activateTransferredGateway();
            } finally {
              // Join a dispatched stop even when parent-exit verification failed.
              await pendingServiceStop;
            }
            if (!ownsManagedUpdateLease()) throw new Error("managed update activation ownership lost");
            activationAcknowledged = true;
            child.stdin.end("parked\n");
          })().catch(rejectActivation);
        } else {
          chunk = outputPrefix;
        }
        outputPrefix = Buffer.alloc(0);
      }
      try { fs.writeSync(outputFd, chunk); } catch {}
      updaterBytes += chunk.length;
      if (updaterBytes > 4 * 1024 * 1024) {
        outputOverflow = true;
        updaterChunks.length = 0;
      } else updaterChunks.push(chunk);
    });
    let childError;
    const exited = new Promise((resolve) => {
      child.once("error", (error) => { childError = error; });
      child.once("close", (code, signal) => resolve({ code, signal, error: childError }));
    });
    // Descendants can retain stdio and IPC after their executor exits.
    child.once("exit", (code, signal) => {
      if (params.action === "triage") {
        appendLog("automatic triage executor exited code=" + code + " signal=" + signal + "; retiring native scope");
        stopTriageScope();
      }
    });
    child.stdin.on("error", () => {});
    const gate = child.stdio[4];
    gate.on("error", () => {});
    let runnerIdentity = managedUpdateLease?.payload;
    activeCommand = child;
    try {
      // Errors before the gate still own this runner and its pipe/IPC handles.
      await new Promise((resolve, reject) => child.once("spawn", resolve).once("error", reject));
      if (!bindManagedUpdateLeaseToProcess(child.pid, undefined, undefined, child.spawnargs)) {
        throw new Error("managed update runner lease binding failed");
      }
      runnerIdentity = managedUpdateLease.payload;
      assertTriageRequester();
      child.once("disconnect", () => {
        if (params.action === "triage" && !triageClosing) {
          const completion = managedUpdateLease && leaseStore.readGeneration(managedUpdateLease);
          if (completion?.action.phase !== "closed") {
            appendLog("automatic triage executor disconnected without cleanup; retiring native scope");
            stopTriageScope();
          }
        }
        if (stagedContinuation) {
          appendLog("automatic triage skipped: updater disconnected before committing its request");
          stagedContinuation = undefined;
        }
      });
      child.on("message", async (message) => {
        try {
          if (phase === "update" && message?.version === 2 &&
            message.type === "triage-request-cancel" && Object.keys(message).length === 2 &&
            !continuation) {
            stagedContinuation = undefined;
            continuationCancelled = true;
            appendLog("automatic triage request cancelled before handoff");
            return;
          }
          if (
            !message ||
            message.version !== 2 ||
            !hasManagedUpdateLease() ||
            managedUpdateLease.payload !== runnerIdentity ||
            child.exitCode !== null ||
            child.signalCode !== null
          ) {
            throw new Error("managed handoff child lost its current claim");
          }
          if (phase === "update" && params.foregroundOrigin &&
            ["foreground-inspect", "foreground-park"].includes(message.type) &&
            typeof message.requestId === "string" && message.requestId.length <= 64 &&
            Object.keys(message).length === 3) {
            try {
              if (message.type === "foreground-park") {
                foregroundParkFlight ??= parkForegroundGateway();
                activation = foregroundParkFlight.catch(() => {});
                await foregroundParkFlight;
              } else if (!foregroundParked) await assertForegroundOrigin();
              assertGatewayParkOwner();
              if (!hasManagedUpdateLease() || managedUpdateLease.payload !== runnerIdentity ||
                !child.connected || child.exitCode !== null || child.signalCode !== null)
                throw new Error("foreground updater lost its current claim");
              child.send({ type: message.type, version: 2, requestId: message.requestId, ok: true }, () => {});
            } catch (error) {
              if (child.connected) child.send({ type: message.type, version: 2, requestId: message.requestId, ok: false }, () => {});
              if (message.type === "foreground-park") rejectActivation(error);
            }
            return;
          }
          if (
            params.action === "triage" &&
            message.type === "triage-ready" &&
            !triageAdmitted &&
            Object.keys(message).length === 2
          ) {
            // Claim the one admission before awaiting native inspection; duplicate
            // messages cannot both pass the same current runner lease.
            triageAdmitted = true;
            const scope = await inspectTriageScope();
            if (
              !hasManagedUpdateLease() ||
              managedUpdateLease.payload !== runnerIdentity ||
              !procCgroupMembershipMatches(
                fs.readFileSync("/proc/" + child.pid + "/cgroup", "utf8"),
                scope.ControlGroup,
              )
            ) {
              throw new Error("automatic triage executor lost its native placement");
            }
            if (!child.connected || child.exitCode !== null || child.signalCode !== null) throw new Error("automatic triage child disconnected");
            assertTriageRequester();
            const admitted = leaseStore.activate(managedUpdateLease);
            if (!admitted) throw new Error("automatic triage activation lost its claim");
            managedUpdateLease = admitted;
            runnerIdentity = admitted.payload;
            clearTimeout(admissionDeadline);
            child.send(
              {
                type: "triage",
                version: 2,
                failure: params.failure,
                installRoot: params.updateLeaseKey,
                owner: managedUpdateLease.owner,
                requester: params.requester,
              },
              () => {},
            );
          } else if (
            phase === "update" &&
            message.type === "triage-request" &&
            !stagedContinuation && !continuation && !continuationCancelled &&
            Object.keys(message).length === 4 &&
            Array.isArray(message.commandArgv) &&
            (message.commandArgv.length === 3 ||
              (message.commandArgv.length === 5 && message.commandArgv[3] === "--update-result")) &&
            message.commandArgv.every((arg) => typeof arg === "string" && arg.length < 4096) &&
            message.commandArgv[2] === "triage" &&
            validTriageFailure(message.failure) &&
            message.failure.kind === "update" &&
            params.serviceRecovery?.kind === "systemd" &&
            Buffer.byteLength(JSON.stringify(message)) <= 16384
          ) {
            stagedContinuation = message;
            child.send({ type: "triage-queued", version: 2 }, () => {});
          } else if (phase === "update" && message.type === "triage-commit" &&
            Object.keys(message).length === 2 && stagedContinuation &&
            !continuation && !continuationCancelled) {
            // The same live updater transfers its request only after the queue ACK.
            // Never infer this decision from its exit code or disconnected IPC.
            continuation = stagedContinuation;
            stagedContinuation = undefined;
            // The updater stays alive until it receives this accepted transfer.
            child.send({ type: "triage-committed", version: 2 }, () => {});
          } else throw new Error("invalid or repeated managed handoff continuation");
        } catch (error) {
          if (!continuation) {
            stagedContinuation = undefined;
            continuationCancelled = true;
          }
          appendLog("automatic triage admission failed: " + String(error));
          if (params.action === "triage") stopTriageScope();
          else if (child.connected) child.send({ type: "triage-refused", version: 2 }, () => {});
        }
      });
      if (params.action === "triage") {
        admissionDeadline = setTimeout(() => {
          appendLog("The installed update did not start diagnostics. Run openclaw triage manually.");
          stopTriageScope();
        }, 30000);
        leaseWatch = setInterval(() => {
          try {
            assertTriageRequester();
            if (!hasManagedUpdateLease()) throw new Error("lease lost or replaced");
          } catch (error) {
            clearInterval(leaseWatch);
            appendLog("automatic triage cancelled: " + String(error));
            stopTriageScope();
          }
        }, 250);
      }
      // Sending the gate can start mutation even if its write callback fails.
      // From here, only the updater can authorize recovery of this installation.
      if (phase === "update") updaterStarted = true;
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          appendLog("verified recovery command exceeded its update timeout");
          killOwnedCommand(child);
        }, timeoutMs);
      }
      await new Promise((resolve, reject) => {
        gate.once("error", reject);
        gate.once("close", () => reject(new Error("managed update runner admission closed")));
        child.once("exit", () =>
          reject(new Error("managed update runner exited before its gate")),
        );
        gate.end("go", (error) => (error ? reject(error) : resolve()));
      });
      if (!controlPending) child.stdin.end();
    } catch (error) {
      // A rejected spawn has no signalable process, but still needs its close join.
      if (child.pid) killOwnedCommand(child);
      await exited;
      try {
        if (runnerIdentity) bindManagedUpdateLeaseToProcess(process.pid, runnerIdentity);
      } catch (rebindError) {
        appendLog("managed update runner cleanup could not rebind helper: " + String(rebindError));
      }
      throw error;
    }
    appendLog("managed update " + phase + " command pid=" + (child.pid || "unknown"));
    const exit = await exited;
    await activation;
    clearInterval(leaseWatch);
    clearTimeout(admissionDeadline);
    if (params.action !== "triage" && !bindManagedUpdateLeaseToProcess(process.pid, runnerIdentity)) {
      throw new Error("managed update command lease binding was lost");
    }
    if (exit.error) throw exit.error;
    appendLog(
      "managed update " + phase + " command exited code=" +
        (exit && exit.code !== null && exit.code !== undefined ? exit.code : "null") +
        " signal=" +
        (exit && exit.signal ? exit.signal : "null"),
    );
    if (params.action === "triage" && !triageAdmitted) {
      appendLog(
        "The installed update does not support automatic diagnostics. Run openclaw triage manually.",
      );
      process.exitCode = 1;
    }
    return { ...exit, continuation, updaterOutput: Buffer.concat(updaterChunks).toString(), outputOverflow };
  } finally {
    activeCommand = undefined;
    clearTimeout(timeout);
    clearInterval(leaseWatch);
    clearTimeout(admissionDeadline);
    if (outputFd !== undefined) {
      try {
        fs.closeSync(outputFd);
      } catch {
        // Ignore close failures.
      }
    }
  }
}

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
    if (!params.triageTransition) fs.writeSync(1, ${JSON.stringify(HANDOFF_READY_MARKER)});
    const commands = [];
    let transferred = false;
    let input = "";
    let disconnected = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
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
            if (params.foregroundOrigin) activationRejected ??= "managed-service-handoff-helper-failed";
          }
          finishBeforeParkNotice?.();
        } else if (transferred && params.foregroundOrigin && command === "closed") {
          if (!foregroundParkFlight || !parentIdentityCurrent() || !ownsManagedUpdateLease())
            return process.stdin.destroy();
          foregroundClosed = true;
        } else if (command === "cancel" && transferred) {
          // Before activation the candidate is disposable; after parking only
          // the orchestrator may decide whether the installed tree can restart.
          if (!restorationArmed && !foregroundClosed) {
            updateCancelled = true;
            if (activeCommand) killOwnedCommand(activeCommand);
            reply("cancelled");
          } else reply("cancel-unavailable");
        } else commands.push(command);
      }
      wake?.();
    });
    const onDisconnect = () => { disconnected = true; wake?.(); };
    process.stdin.once("end", onDisconnect).once("close", onDisconnect);
    const reply = (line) => fs.writeSync(1, line + "\n");
    let parked = false;
    while (outcome !== "triage" && isPidAlive(params.parentPid)) {
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

    if (params.action === "update" && params.requester) {
      const { isManagedUpdateRequesterOwner } = await import(pathToFileURL(params.recoveryModulePath).href);
      if (!(await isManagedUpdateRequesterOwner(params.requester))) {
        throw Object.assign(new Error("owner_required: chat requester is no longer a configured command owner"), { code: "owner_required" });
      }
    }
    if (updateCancelled) {
      recordUpdateHandoffOutcome("managed-service-handoff-cancelled");
      return;
    }
    appendLog("starting managed update command: " + params.commandLabel);
    // Update inputs retain shell-relative paths; recovery keeps the durable helper cwd.
    const exit = await runOwnedUpdateCommand(params.action, params.commandArgv, undefined, params.action === "update" ? params.invocationCwd : params.cwd);
    if (params.action === "triage") {
      if (exit.signal || exit.code !== 0) process.exitCode = exit.code || 1;
      return;
    }
    automaticRequested = Boolean(exit.continuation);
    if (updateCancelled || activationRejected) {
      const reason = updateCancelled ? "managed-service-handoff-cancelled" : activationRejected;
      // No parked acknowledgement authorized a swap. Recovery waits for any
      // dispatched stop, even when cancellation overlaps the parent's drain.
      if (restorationArmed) {
        if (!(await restoreGatewayService(reason))) process.exitCode = 1;
      } else recordUpdateHandoffOutcome(reason);
      if (!updateCancelled) process.exitCode = 1;
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
      process.exitCode = exit.code;
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
        process.exitCode = exit.code || (runOutcome.status === "skipped" && !reportedFailure && !exit.signal ? 0 : 1);
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
      process.exitCode = exit.code;
    } else if (!resultRoot || result?.status !== "ok" ||
      exit.signal || exit.code !== 0) {
      let restored = !restorationArmed || (safe && recovery.service === "healthy");
      if (restorationArmed && safe && recovery.service === undefined) {
        restored = await restoreGatewayService(previousGeneration ? result.reason : "managed-service-handoff-failed", recovery, childStatus, previousGeneration);
      } else {
        if (restored && triageFailure) triageFailure.restored = true;
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
      process.exitCode = previousGeneration && restored ? 1 : exit.code ||
        (childStatus === "skipped" && restored && !exit.signal && !reportedFailure ? 0 : 1);
    }
    if (exit.continuation && !exit.signal) await enterTriageAfterUpdate(exit.continuation);
  } catch (err) {
    appendLog("handoff failed: " + (err && err.stack ? err.stack : String(err)));
    const reason = err?.code === "owner_required" ? "owner_required" : "managed-service-handoff-helper-failed";
    if (params.action === "update") runOutcome = { status: "failed", reason };
    if (hasManagedUpdateLease()) {
      if (params.action !== "triage") bindManagedUpdateLeaseToProcess(process.pid);
      if (restorationArmed && !updaterStarted) await restoreGatewayService(reason);
      else if (params.action === "update") recordUpdateHandoffOutcome(reason);
    }
    process.exitCode = 1;
  } finally {
    clearTimeout(parentExitDeadline);
    try { await finishManagedUpdateRun(); }
    catch (error) {
      appendLog("failed to finalize update run: " + String(error));
      foregroundRespawn = false;
      process.exitCode = 1;
    }
    if (params.action === "update" && !automaticRequested) await collectUpdateFailureTriage();
    releaseManagedUpdateLease();
    cleanupSensitiveFiles();
    stopTriageScope();
    appendLog("managed update helper completed code=" + (process.exitCode || 0));
    if (foregroundClosed && parentIdentityCurrent())
      fs.writeSync(1, "foreground-settled:" + (foregroundRespawn ? "respawn" : "stopped") + "\n");
    process.stdin.destroy();
  }
})().catch((err) => {
  appendLog("handoff setup failed: " + (err && err.stack ? err.stack : String(err)));
  cleanupSensitiveFiles();
  stopTriageScope();
  process.exitCode = 1;
});
`;

type ManagedServiceUpdateHandoffParams = {
  runId?: string;
  beforePark?: () => Promise<void>;
  root: string;
  timeoutMs?: number;
  recoveryTimeoutMs?: number;
  restartDrainTimeoutMs: number;
  restartDelayMs?: number;
  channel?: UpdateChannel;
  tag?: string;
  acceptCapabilities?: boolean;
  reapplyLocalOverrides?: boolean;
  meta: UpdateRestartSentinelMeta;
  requester?: { channel?: string; accountId?: string; senderId?: string };
  handoffId?: string;
  supervisor?: RespawnSupervisor | null;
  foregroundOrigin?: ForegroundUpdateOrigin;
  env?: NodeJS.ProcessEnv;
  devTarget?: DevUpdateTarget;
  execPath?: string;
  argv1?: string;
  parentPid?: number;
  invocationCwd?: string;
  action?: {
    kind: "triage";
    failure: TriageFailureContext;
    entrypoint: string;
    nodeRunner: string;
  };
};

type ManagedServiceUpdateHandoffResult = {
  pid?: number;
  command: string;
  logPath: string;
} & (
  | { status: "started"; handoffId: string; installRoot: string }
  | { status: "joined"; handoffId?: string }
);

type ActiveManagedServiceUpdateHandoff = {
  handoffId: string;
  recoveryTimeoutMs: number;
  parentExitTimeoutMs: number;
  beforePark?: () => Promise<void>;
  flight?: Promise<ManagedServiceUpdateHandoffResult>;
  launcher?: HandoffChild;
  closed?: Promise<void>;
  leaseStore?: ReturnType<typeof createManagedHandoffLeaseStore>;
  leaseDatabaseIdentity?: ManagedUpdateLeaseDatabaseIdentity;
  launcherStartIdentity?: string | null;
  helper?: ManagedHandoffLease;
  claimed?: boolean;
  transferred?: boolean;
  cancelling?: boolean;
  exited?: boolean;
  foregroundOrigin?: ForegroundUpdateOrigin;
  parkReady?: true;
  closeForStop?: () => void;
};
const activeManagedServiceUpdateHandoffs = new Map<string, ActiveManagedServiceUpdateHandoff>();

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
  const updateLeaseDatabasePath =
    owner.leaseDatabaseIdentity?.databasePath ?? resolveManagedUpdateLeaseDatabasePath();
  // The helper and its parent retain one database identity through settlement.
  const updateLeaseDatabaseIdentity =
    owner.leaseDatabaseIdentity ??
    createManagedHandoffLeaseDatabase(updateLeaseDatabasePath)(true, () =>
      captureManagedUpdateLeaseDatabaseIdentity(updateLeaseDatabasePath),
    );
  owner.leaseDatabaseIdentity = updateLeaseDatabaseIdentity;
  const identityStore = createManagedHandoffLeaseStore({
    databasePath: updateLeaseDatabasePath,
    existingIdentity: updateLeaseDatabaseIdentity,
    serviceManagerEnv: resolveServiceManagerEnv(serviceEnv),
    onProcessIdentityWarning: (pid, message) => {
      console.warn(`[update] ${message}`);
      if (params.runId) {
        try {
          recordUpdateRunStep(
            params.runId,
            {
              step: `warning:process-start-identity:${pid}`,
              status: "completed",
              detail: message,
              endedAtMs: Date.now(),
            },
            { env: serviceEnv },
          );
        } catch {
          /* Identity warnings must not abort an update. */
        }
      }
    },
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
  const commandArgv = params.action
    ? [params.action.nodeRunner, params.action.entrypoint, "triage"]
    : resolveUpdateCliArgv({
        acceptCapabilities: params.acceptCapabilities,
        reapplyLocalOverrides: params.reapplyLocalOverrides,
        timeoutMs: params.timeoutMs,
        channel: params.channel,
        tag: params.tag,
        execPath: params.execPath ?? process.execPath,
        argv1: params.argv1 ?? process.argv[1],
      });
  const commandLabel = params.action
    ? "openclaw triage (automatic)"
    : formatManagedServiceUpdateCommand(
        {
          timeoutMs: params.timeoutMs,
          channel: params.channel,
          tag: params.tag,
          acceptCapabilities: params.acceptCapabilities,
          reapplyLocalOverrides: params.reapplyLocalOverrides,
        },
        params.env,
      );
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
  let spawnCommand = params.execPath ?? process.execPath;
  const spawnArgs = [scriptPath, paramsPath];
  let scopeUnit: string | undefined;
  let systemdRunPath: string | undefined;
  if (!params.foregroundOrigin && params.supervisor === "systemd") {
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
  const parentExitTimeoutMs = owner.parentExitTimeoutMs;
  const childEnv: NodeJS.ProcessEnv = {
    ...serviceEnv,
    // Resolve relative/default target selectors before entering the helper scratch directory.
    ...installationTargetEnv(resolveInstallationTarget(serviceEnv)),
    [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
    OPENCLAW_UPDATE_RUN_HANDOFF: "1",
    ...(metaFile.meta.runId ? { [UPDATE_RUN_ID_ENV]: metaFile.meta.runId } : {}),
  };
  for (const key of SUPERVISOR_HINT_ENV_VARS) {
    if (!SERVICE_IDENTITY_ENV_VARS.has(key)) {
      delete childEnv[key];
    }
  }
  const preparedEnv = resolveUpdatedInstallCommandEnv({
    processEnv: childEnv,
    invocationCwd: process.cwd(),
  });
  const nodeCommand =
    commandArgv[0] === process.execPath ||
    /^(?:node|bun)(?:\.exe)?$/iu.test(path.basename(commandArgv[0] ?? ""));
  const startup = nodeCommand
    ? buildCliRespawnPlan({
        argv: commandArgv,
        env: preparedEnv,
        execArgv: [],
        execPath: commandArgv[0],
      })
    : null;
  const nodeExecArgv = nodeCommand
    ? (startup?.argv.slice(0, startup.argv.length - commandArgv.length + 1) ?? [])
    : undefined;
  if (startup) {
    commandArgv[0] = startup.command;
  }
  const readyEnv = startup?.env ?? preparedEnv;
  const env = params.devTarget ? applyDevUpdateTargetEnv(readyEnv, params.devTarget) : readyEnv;

  const helperParams = {
    runId: metaFile.meta.runId,
    beforePark: Boolean(params.beforePark),
    requester: resolveManagedUpdateRequester(params.requester),
    serviceManagerEnv: resolveServiceManagerEnv(serviceEnv),
    nodeExecArgv,
    action: params.action?.kind ?? "update",
    failure: params.action?.failure,
    scopeUnit,
    systemdRun: systemdRunPath,
    parentPid,
    parentStartIdentity,
    parentExitTimeoutMs,
    restartDelayMs: Math.max(0, Math.min(60_000, params.restartDelayMs ?? 0)),
    parentExitDeadlineAt: Date.now() + parentExitTimeoutMs,
    cwd: dir,
    invocationCwd: params.invocationCwd,
    commandArgv,
    recoveryCommandArgv: resolveManagedServiceCliArgv(
      { execPath: params.execPath ?? process.execPath, argv1: params.argv1 ?? process.argv[1] },
      ["gateway", "restart", "--preserve-definition", "--json"],
    ),
    recoveryTimeoutMs: owner.recoveryTimeoutMs,
    triageCommandArgv: resolveManagedServiceCliArgv(
      { execPath: params.execPath ?? process.execPath, argv1: params.argv1 ?? process.argv[1] },
      ["triage", "--json", "--non-interactive"],
    ),
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
    sensitivePaths: [scriptPath, paramsPath, metaPath, triageInputPath],
    foregroundOrigin: params.foregroundOrigin,
    serviceRecovery: params.foregroundOrigin
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
  };
  try {
    helperParams.sensitivePaths.push(...stageManagedHandoffRuntime(dir));
    await fs.writeFile(scriptPath, `${HANDOFF_SCRIPT}\n`, { mode: 0o700 });
    await fs.writeFile(paramsPath, `${JSON.stringify(helperParams, null, 2)}\n`, { mode: 0o600 });
    await fs.writeFile(metaPath, `${JSON.stringify(metaFile, null, 2)}\n`, { mode: 0o600 });

    assertManagedUpdateLeaseDatabaseIdentity(updateLeaseDatabaseIdentity);
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
    owner.closed = new Promise((resolve) => {
      child.once("close", () => resolve());
    });
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
    let buffered = "";
    const identity = {
      kind: "managed-update-handoff" as const,
      installRoot: rootIdentity,
      handoffId: owner.handoffId,
    };
    const isCurrent = () =>
      activeManagedServiceUpdateHandoffs.get(rootIdentity) === owner &&
      owner.transferred &&
      !owner.cancelling &&
      !owner.exited &&
      (!owner.foregroundOrigin || claimManagedServiceUpdateHandoff(identity));
    const onNotice = (chunk: Buffer | string) => {
      buffered = `${buffered}${chunk.toString()}`.slice(-1024);
      if (!buffered.includes(HANDOFF_NOTICE_MARKER)) {
        return;
      }
      child.stdout.off("data", onNotice);
      if (!isCurrent()) {
        return;
      }
      // The helper's lease now names the validating runner. Its park owner
      // revalidates that lease; this captured pipe only coordinates the notice.
      void (async () => {
        await owner.beforePark?.();
        if (isCurrent()) {
          owner.parkReady = true;
          owner.closeForStop?.();
          if (isCurrent()) {
            child.stdin.write("noticed\n");
          }
        }
      })().catch(() => {
        if (isCurrent()) {
          child.stdin.write("notice-failed\n");
        }
      });
    };
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
  if (
    !params.foregroundOrigin &&
    params.supervisor === "systemd" &&
    (await findInstalledSystemdGatewayScope(params.env ?? process.env))?.scope === "system"
  ) {
    throw new Error(
      "Managed update handoff requires a user-scope systemd unit; perform a manual system-service update.",
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
    recoveryTimeoutMs: params.recoveryTimeoutMs ?? params.timeoutMs ?? 30 * 60_000,
    parentExitTimeoutMs: Math.min(
      2_147_483_647,
      Math.max(0, params.restartDrainTimeoutMs) + PARENT_EXIT_SHUTDOWN_RESERVE_MS,
    ),
    ...(params.beforePark ? { beforePark: params.beforePark } : {}),
    ...(params.foregroundOrigin ? { foregroundOrigin: { ...params.foregroundOrigin } } : {}),
    ...(active?.leaseDatabaseIdentity
      ? { leaseDatabaseIdentity: active.leaseDatabaseIdentity }
      : {}),
  };
  activeManagedServiceUpdateHandoffs.set(root, owner);
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
    if (activeManagedServiceUpdateHandoffs.get(root) === owner) {
      activeManagedServiceUpdateHandoffs.delete(root);
    }
    throw err;
  }
}

export function claimManagedServiceUpdateHandoff(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): boolean {
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
    active.cancelling ||
    lease?.owner !== identity.handoffId ||
    helper?.owner !== identity.handoffId ||
    (!(active.foregroundOrigin && active.transferred) &&
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
    return false;
  }
  active.claimed = true;
  return true;
}

/** A transferred updater may manage its serving ancestor only under its current lease. */
export async function isCurrentManagedServiceUpdateHandoffProcess(params: {
  root: string;
  runId: string | undefined;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const env = params.env ?? process.env;
  if (env.OPENCLAW_UPDATE_RUN_HANDOFF !== "1" || !params.runId) {
    return false;
  }
  const meta = await readControlPlaneUpdateSentinelMeta(env);
  const root = resolveUpdateInstallRoot(params.root);
  if (
    meta?.runId !== params.runId ||
    !meta.handoffId ||
    !meta.root ||
    resolveUpdateInstallRoot(meta.root) !== root
  ) {
    return false;
  }
  const lease = readManagedServiceUpdateHandoffLease(root);
  const store = createManagedHandoffLeaseStore();
  return (
    lease?.owner === meta.handoffId &&
    lease.executor.pid === process.pid &&
    (store.isProcessIdentityCurrent(lease.executor) ||
      (process.connected && store.acceptParentBoundExecutor(lease)))
  );
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

function readManagedServiceUpdateHandoffLease(
  root: string,
  stale?: ActiveManagedServiceUpdateHandoff,
): ManagedHandoffLease | null | undefined {
  const owner = stale ?? activeManagedServiceUpdateHandoffs.get(root);
  const store = owner ? owner.leaseStore : createManagedHandoffLeaseStore();
  if (!store) {
    return undefined;
  }
  const result = store.read(root);
  if (result.kind !== "current") {
    return result.kind === "absent" ? null : undefined;
  }
  const lease = result.lease;
  if (
    stale?.handoffId === lease.owner &&
    JSON.stringify(stale.helper?.helper) === JSON.stringify(lease.helper) &&
    (lease.action.kind !== "update" || stale.helper?.payload === lease.payload) &&
    (lease.action.kind !== "triage" ||
      (stale.helper?.action.kind === "triage" &&
        JSON.stringify(stale.helper.action.lifetime) === JSON.stringify(lease.action.lifetime))) &&
    store.release(lease)
  ) {
    return null;
  }
  return lease;
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
  }
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
