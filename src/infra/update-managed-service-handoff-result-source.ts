import { MANAGED_HANDOFF_RUNTIME_ENTRY } from "./update-managed-service-handoff-runtime-assets.js";
import { MANAGED_HANDOFF_SENTINEL_SOURCE } from "./update-managed-service-handoff-sentinel-source.js";

// Terminal recording runs inside the sealed helper with its captured lifecycle owners.
export const MANAGED_HANDOFF_RESULT_SOURCE =
  MANAGED_HANDOFF_SENTINEL_SOURCE +
  String.raw`
let triageFailure;
let runLedger;
let runOutcome;
let closedUpdateResult;
let handoffFailure;
let terminalRuntimePath = params.recoveryModulePath;
let serviceStoppedAtMs, serviceDowntimeMs;
let recoveryObservation;

async function observeUnrecordedRecovery() {
  if (!triageFailure || typeof triageFailure.restored === "boolean" || !ownsManagedUpdateLease()) return;
  const previous = closedUpdateResult?.steps?.findLast((step) => step.name === "gateway recovery verification");
  if (previous) {
    triageFailure.restored = previous.exitCode === 0 && !previous.failureFacts?.length;
    return;
  }
  const startedAt = Date.now();
  let verified = false;
  let code = "gateway-probe-failed";
  let detail = terminationRequested ? "Gateway recovery verification was cancelled."
    : !params.serviceRecovery ? (params.foregroundOrigin
      ? "Foreground Gateway serving health remains unverified by its current owner."
      : "Gateway serving health remains unverified by its external service owner.")
    : closedUpdateResult?.recovery?.reason || "Recovery runtime identity is unavailable.";
  let verification;
  // A pre-activation refusal leaves the original service untouched. Observe that
  // generation without granting restart authority or claiming candidate activation.
  if (!terminationRequested && params.serviceRecovery && !restorationArmed && params.recovery?.version) {
    try {
      const { waitForGatewayUpdateRecovery } = await import(pathToFileURL(params.recoveryModulePath).href);
      if (!ownsManagedUpdateLease()) return;
      const health = await waitForGatewayUpdateRecovery(params.recovery.version, params.recovery.buildId, Math.min(params.recoveryTimeoutMs, 3000));
      if (!ownsManagedUpdateLease()) return;
      const running = health.runtime?.status === "running";
      const versionMatch = health.gatewayVersion === params.recovery.version &&
        (!params.recovery.buildId || health.gatewayBuildId === params.recovery.buildId);
      verified = running && versionMatch && health.healthy === true;
      verification = {
        serviceRunning: running ? true : health.runtime?.status === "stopped" ? false : undefined,
        pid: typeof health.runtime?.pid === "number" ? health.runtime.pid : undefined,
        runningVersion: health.gatewayVersion ?? undefined,
        runningBuildId: health.gatewayBuildId ?? undefined,
        versionMatch, settled: health.healthy === true, coreReady: health.healthy === true,
      };
      code = health.runtime?.status === "stopped" ? "service-not-running"
        : !running ? "gateway-probe-failed" : !versionMatch ? "version-mismatch" : "gateway-readiness-unverified";
      detail = verified ? "Original Gateway is verified serving." : "Original Gateway serving health was not verified: " + code;
    } catch (error) {
      detail = "Original Gateway recovery probe failed.";
      appendLog(detail + " " + String(error));
    }
  }
  triageFailure.restored = verified;
  triageFailure.recoveryReason = verified ? undefined : detail;
  recoveryObservation = {
    verification,
    step: {
      name: "gateway recovery verification", command: "gateway verification", cwd: params.updateLeaseKey,
      durationMs: Math.max(0, Date.now() - startedAt), exitCode: verified ? 0 : 1,
      ...(!verified ? { failureFacts: [{ check: "gateway-recovery", code, message: detail }] } : {}),
    },
  };
}

async function finishManagedUpdateRun() {
  try { await observeUnrecordedRecovery(); }
  catch (error) {
    appendLog("Gateway recovery observation could not complete: " + String(error));
  }
  if (!runLedger || !runOutcome) return;
  if (foregroundParked && runOutcome.status === "succeeded") return;
  if (!ownsManagedUpdateLease()) throw new Error("managed update terminal writer lost its current claim");
  const childFailure = closedUpdateResult?.steps?.find((step) => step.exitCode !== 0 && !step.advisory);
  const childDetail = childFailure?.failureFacts?.find((fact) => fact.message)?.message ?? childFailure?.diagnostics?.[0];
  const failureDetail = closedUpdateResult?.reason
    ? closedUpdateResult.reason + (childDetail ? ": " + childDetail : "")
    : handoffFailure;
  const terminalResult = {
    ...runOutcome,
    ...(closedUpdateResult ? { reason: closedUpdateResult.reason ?? runOutcome.reason, after: closedUpdateResult.after } : {}),
    diagnostics: {
      steps: [...(closedUpdateResult?.steps ?? []), ...(recoveryObservation ? [recoveryObservation.step] : [])],
      recovery: closedUpdateResult?.recovery,
      verification: recoveryObservation?.verification ?? closedUpdateResult?.verification,
      ...(handoffFailure && runOutcome.status === "failed" ? { failure: { step: "managed-service-handoff", detail: failureDetail, exitCode: 1 } } : {}),
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

async function captureManagedUpdateResult() {
  if (fs.existsSync(params.triageContextPath)) {
    triageFailure = { ...triageFailure, reason: closedUpdateResult?.reason ?? "managed-service-handoff-failed" };
    return true;
  }
  try {
    const result = await runSentinelOperation({ kind: "inspect", input: sentinelIdentity() });
    if (!result.sentinel) return false;
    const payload = result.sentinel.payload;
    triageFailure = { ...triageFailure, payload, reason: payload.stats?.reason || "managed-service-handoff-failed" };
    return true;
  } catch (error) {
    // SQLite read failures end diagnostics at their cleanup boundary. Remote
    // transport failure keeps the direct child's bounded diagnostic context.
    if (params.stateEngine !== "postgres") throw error;
    appendLog("Update notice could not be inspected; service recovery retains its local lease.");
    return false;
  }
}

async function recordManagedUpdateOutcome(reason, restored, completedStatus, expectedRevision) {
  if (!ownsManagedUpdateLease()) return false;
  handoffFailure = reason;
  reason = closedUpdateResult?.reason ?? reason;
  let metaFile;
  try { metaFile = JSON.parse(fs.readFileSync(params.metaPath, "utf8")); } catch {}
  let run;
  try { run = runLedger?.getUpdateRun(params.runId); } catch {}
  if (reason === "managed-service-handoff-cancelled" && run?.reason &&
      run.steps.some((step) => step.step === "requested" && step.status === "failed")) reason = run.reason;
  const meta = resolveUpdateRestartNoticeMeta(run, metaFile?.version === 1 ? metaFile.meta : {});
  const status = (reason === "managed-service-handoff-cancelled" || completedStatus === "skipped") && restored !== false ? "skipped" : "error";
  runOutcome = { status: status === "error" ? "failed" : "skipped", reason };
  const fallbackPayload = {
    kind: "update", status, ts: Date.now(), message: meta.note,
    stats: { mode: "unknown", root: params.updateLeaseKey, handoffId: params.handoffId,
      ...(params.runId ? { runId: params.runId } : {}), reason, steps: [], durationMs: 0 },
    ...(meta.sessionKey ? { sessionKey: meta.sessionKey } : {}),
    ...(meta.threadId ? { threadId: meta.threadId } : {}),
    ...(meta.deliveryContext ? { deliveryContext: meta.deliveryContext } : {}),
  };
  if (status === "error") triageFailure ??= { payload: fallbackPayload, reason };
  if (triageFailure && typeof restored === "boolean") triageFailure.restored = restored;
  if (!shouldPublishUpdateRestartNotice(run, meta)) return true;
  try {
    const result = await runSentinelOperation({ kind: "record", input: {
      ...sentinelIdentity(), reason, restored, completedStatus,
      expectedRevision: typeof expectedRevision === "number" ? expectedRevision : undefined,
      foreground: Boolean(params.foregroundOrigin), fallbackPayload, triageHint: params.triageHint,
      serviceKind: params.serviceRecovery?.kind ?? "foreground", handoffFailure,
    } });
    if (result.kind === "refused") {
      appendLog("Update notice changed or belongs to another handoff; it was not replaced.");
      return false;
    }
    if (result.sentinel && triageFailure) triageFailure.payload = result.sentinel.payload;
    return result.sentinel?.revision ?? true;
  } catch (error) {
    // Remote transport errors can contain connection details; keep those private.
    appendLog(params.stateEngine === "postgres"
      ? "Update notice could not be recorded; service recovery retains its local lease. Inspect PostgreSQL and Gateway availability."
      : "failed to write update sentinel failure: " + (error && error.stack ? error.stack : String(error)));
    return null;
  }
}
`;
