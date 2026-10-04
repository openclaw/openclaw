import { MANAGED_HANDOFF_RUNTIME_ENTRY } from "./update-managed-service-handoff-runtime-assets.js";

// Terminal recording runs inside the sealed helper with its captured lifecycle owners.
export const MANAGED_HANDOFF_RESULT_SOURCE = String.raw`
let triageFailure;
let runLedger;
let runOutcome;
let closedUpdateResult;
let handoffFailure;
let terminalRuntimePath = params.recoveryModulePath;
let serviceStoppedAtMs, serviceDowntimeMs;

async function finishManagedUpdateRun() {
  if (!runLedger || !runOutcome) return;
  if (foregroundParked && runOutcome.status === "succeeded") return;
  if (!ownsManagedUpdateLease()) throw new Error("managed update terminal writer lost its current claim");
  const terminalResult = {
    ...runOutcome,
    ...(closedUpdateResult ? { reason: closedUpdateResult.reason ?? runOutcome.reason, after: closedUpdateResult.after } : {}),
    diagnostics: {
      steps: closedUpdateResult?.steps,
      recovery: closedUpdateResult?.recovery,
      ...(handoffFailure && runOutcome.status === "failed" ? { failure: { step: "managed-service-handoff", detail: handoffFailure, exitCode: 1 } } : {}),
    },
    ...(serviceDowntimeMs !== undefined ? { downtimeMs: serviceDowntimeMs } : {}),
  };
  if (!updaterStarted) { recordRunWarnings(runLedger); await runLedger.finishUpdateRun(params.runId, terminalResult); }
  else {
    // Doctor may have advanced the schema. A new process loads the candidate's
    // entire module graph; a cache-busted import would retain old DB readers.
    const payload = JSON.stringify([terminalRuntimePath, params.runId, terminalResult, [...runWarnings],
      path.join(params.cwd, "runtime", ${JSON.stringify(MANAGED_HANDOFF_RUNTIME_ENTRY)}),
      params.updateLeaseDatabaseIdentity, params.updateLeaseKey, params.handoffId, managedUpdateLease.helper]);
    // Child diagnostics can exceed argv limits. The private helper directory owns
    // this short-lived transfer file, which terminal cleanup removes with its inputs.
    const terminalPath = path.join(params.cwd, "terminal-result.json");
    fs.writeFileSync(terminalPath, payload, { mode: 0o600 });
    const exit = await runOwnedUpdateCommand("finalize", [process.execPath, ...params.runtimeArgs, "--input-type=module", "-e",
      'import { readFileSync } from "node:fs"; import { pathToFileURL } from "node:url"; const [modulePath, runId, result, warnings, leaseRuntime, databaseIdentity, root, owner, helper] = JSON.parse(readFileSync(process.argv[1], "utf8")); const { finishUpdateRun, recordUpdateRunDiagnostic, recordUpdateRunStep } = await import(pathToFileURL(modulePath).href); const { createManagedHandoffLeaseStore } = await import(pathToFileURL(leaseRuntime).href); const store = createManagedHandoffLeaseStore({ databasePath: databaseIdentity.databasePath, existingIdentity: databaseIdentity }); const current = store.read(root); const lease = current.kind === "current" ? current.lease : null; if (!lease || lease.owner !== owner || lease.executor.pid !== process.pid || JSON.stringify(lease.helper) !== JSON.stringify(helper) || !(store.isProcessIdentityCurrent(lease.executor) || (process.connected && store.acceptParentBoundExecutor(lease)))) throw new Error("managed update terminal writer lost its current claim"); for (const [step, detail] of warnings) { try { if (recordUpdateRunDiagnostic) recordUpdateRunDiagnostic(runId, detail, undefined, step); else recordUpdateRunStep(runId, {step,status:"completed",detail,endedAtMs:Date.now()}); } catch {} } await finishUpdateRun(runId, result);',
      terminalPath], params.recoveryTimeoutMs);
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
    triageFailure = { ...triageFailure, reason: closedUpdateResult?.reason ?? "managed-service-handoff-failed" };
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
  handoffFailure = reason;
  reason = closedUpdateResult?.reason ?? reason;
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
      if (typeof restored === "boolean") {
        payload.stats.steps = [
          ...(payload.stats.steps || []),
          { name: "service-restore", command: params.serviceRecovery.kind,
            log: { exitCode: restored ? 0 : 1, ...(completedStatus && !restored ? { stderrTail: handoffFailure } : {}) } },
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



`;
