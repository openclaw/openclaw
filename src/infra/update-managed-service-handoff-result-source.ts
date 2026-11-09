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

// Child JSON is untyped. Keep malformed supplied reasons reportable before
// typed classification, sentinel publication, and terminal recording consume them.
function parseManagedUpdateResult(output) {
  let result;
  try { result = JSON.parse(output); } catch { return null; }
  if (Object.hasOwn(result ?? {}, "reason") && typeof result.reason !== "string") result.reason = "managed-service-handoff-failed";
  return result;
}

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
    const leaseRuntime = path.join(params.cwd, "runtime", ${JSON.stringify(MANAGED_HANDOFF_RUNTIME_ENTRY)});
    const payload = JSON.stringify([fs.existsSync(terminalRuntimePath) ? terminalRuntimePath : leaseRuntime, params.runId, terminalResult, [...runWarnings],
      leaseRuntime,
      params.updateLeaseDatabaseIdentity, params.updateLeaseKey, params.handoffId, managedUpdateLease.helper]);
    // Child diagnostics can exceed argv limits. The private helper directory owns
    // this short-lived transfer file, which terminal cleanup removes with its inputs.
    const terminalPath = path.join(params.cwd, "terminal-result.json");
    fs.writeFileSync(terminalPath, payload, { mode: 0o600 });
    const exit = await runOwnedUpdateCommand("finalize", [process.execPath, ...params.runtimeArgs, "--input-type=module", "-e",
      'import { readFileSync } from "node:fs"; import { pathToFileURL } from "node:url"; const [modulePath, runId, result, warnings, leaseRuntime, databaseIdentity, root, owner, helper] = JSON.parse(readFileSync(process.argv[1], "utf8")); const { finishUpdateRun, recordUpdateRunDiagnostic, recordUpdateRunStep } = await import(pathToFileURL(modulePath).href); const { createManagedHandoffLeaseStore } = await import(pathToFileURL(leaseRuntime).href); const store = createManagedHandoffLeaseStore({ databasePath: databaseIdentity.databasePath, existingIdentity: databaseIdentity }); const current = store.read(root); const lease = current.kind === "current" ? current.lease : null; if (!lease || lease.owner !== owner || lease.executor.pid !== process.pid || JSON.stringify(lease.helper) !== JSON.stringify(helper) || !(store.isProcessIdentityCurrent(lease.executor) || (process.connected && store.acceptParentBoundExecutor(lease)))) throw new Error("managed update terminal writer lost its current claim"); for (const [step, detail] of warnings) { try { if (recordUpdateRunDiagnostic) recordUpdateRunDiagnostic(runId, detail, undefined, step); else recordUpdateRunStep(runId, {step,status:"completed",detail,endedAtMs:Date.now()}); } catch {} } await finishUpdateRun(runId, result);',
      terminalPath], params.recoveryTimeoutMs);
    if (exit.signal || exit.code !== 0) throw new Error("recovery runtime could not finalize the update run");
  }
  runOutcome = undefined;
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

function stagedRuntimePath() {
  return path.join(params.cwd, "runtime", ${JSON.stringify(MANAGED_HANDOFF_RUNTIME_ENTRY)});
}

function shouldRecoverInterruptedUpdater() {
  if (!params.runId || params.foregroundOrigin) return false;
  return restorationArmed || readManagedHandoffGatewayStop()?.runId === params.runId;
}

// Post-core repair may advance the state schema past this helper's staged reader.
// A fresh process loads the installed candidate's whole module graph per call.
function createInstalledRuntimeLedger(modulePath) {
  const call = (name, args) => {
    const out = require("node:child_process").spawnSync(process.execPath, [...params.runtimeArgs, "--input-type=module", "-e",
      'import { pathToFileURL } from "node:url"; const [modulePath, name, args] = JSON.parse(process.argv[1]); const value = await (await import(pathToFileURL(modulePath).href))[name](...args); process.stdout.write(JSON.stringify(value ?? null));',
      JSON.stringify([modulePath, name, args])], { encoding: "utf8", timeout: params.recoveryTimeoutMs, maxBuffer: 16 * 1024 * 1024 });
    if (out.status !== 0) throw new Error("installed runtime ledger " + name + " failed: " + String(out.stderr || out.error || "").slice(-400));
    return JSON.parse(out.stdout || "null") ?? undefined;
  };
  return Object.fromEntries(["adoptUpdateRun", "finishUpdateRun", "getUpdateRun", "listUpdateRuns", "recordUpdateRunStep", "recordUpdateRunVerification"]
    .map((name) => [name, (...args) => call(name, args)]));
}

function readGatewayStop() {
  // Only the installed-runtime ledger lists runs; before post-core repair the staged reader
  // matches the schema. An older installed candidate may not export the listing.
  if (!runLedger?.listUpdateRuns) return readManagedHandoffGatewayStop();
  try { return findUpdateGatewayStop(runLedger.listUpdateRuns({ limit: 100 })); }
  catch (error) {
    appendLog("installed runtime could not list update history; using the staged reader: " + String(error));
    return readManagedHandoffGatewayStop();
  }
}

async function recoverInterruptedUpdater() {
  const reason = "managed-service-handoff-interrupted";
  terminalRuntimePath = stagedRuntimePath();
  try {
    const assertCurrent = () => {
      if (!ownsManagedUpdateLease()) throw new Error("managed update recovery ownership was lost");
    };
    const updaterStopped = !restorationArmed;
    if (updaterStopped) {
      const stop = readGatewayStop();
      if (stop?.runId !== params.runId || stop.started)
        throw new Error("Gateway stop intent was superseded by a later running service");
    }
    const recovered = await recoverInterruptedManagedUpdate({
      root: params.updateLeaseKey, runId: params.runId, owner: params.updateLeaseOwner,
      databaseIdentity: params.updateLeaseDatabaseIdentity, original: params.recovery,
      originalIdentity: originalInstallationIdentity, timeoutMs: params.recoveryTimeoutMs,
      assertCurrent,
      finalize: async () => {
        const repair = await runOwnedUpdateCommand("repair", params.finalizeCommandArgv,
          params.recoveryTimeoutMs, params.cwd, { ...process.env, OPENCLAW_UPDATE_RUN_HANDOFF: "1" });
        let repaired;
        try { repaired = JSON.parse(repair.updaterOutput); } catch {}
        assertCurrent();
        if (repair.signal || repair.code !== 0 || repaired?.coreUpdate !== "completed" ||
          !["ok", "warning"].includes(repaired.status)) {
          throw new Error("Interrupted update post-core repair did not complete");
        }
        runLedger = createInstalledRuntimeLedger(params.recoveryModulePath);
        return runLedger.getUpdateRun(params.runId);
      },
    });
    terminalRuntimePath = params.recoveryModulePath;
    const restored = await restoreGatewayService(
      recovered.status === "rolled-back" ? "managed-service-handoff-cancelled" : reason,
      recovered.recovery, updaterStopped || recovered.status === "succeeded" ? "error" : undefined,
      false, updaterStopped,
    );
    if (!restored) throw new Error("Recovered runtime could not restore Gateway readiness and identity");
    runOutcome = { status: recovered.status, reason: recovered.status === "succeeded"
      ? "managed-service-handoff-recovered" : reason,
      after: { version: recovered.recovery.version, buildId: recovered.recovery.buildId } };
    if (recovered.warning) {
      appendLog(recovered.warning);
      runWarnings.set("warning:plugin-cohort-recovery", recovered.warning);
      runOutcome.nextAction = "openclaw update repair";
    }
    runLedger.recordUpdateRunStep(params.runId, { step: "managed-service-handoff-recovery", status: "completed",
      detail: recovered.status === "succeeded" ? "Succeeded with recovery after the updater exited without a result." : "Cancelled activation; original Gateway restored.", endedAtMs: Date.now() });
    triageFailure = undefined;
    finalExitCode = recovered.status === "succeeded" ? 0 : 1;
  } catch (error) {
    const detail = String(error) + "; run openclaw update repair and openclaw gateway status --deep";
    appendLog(detail);
    runWarnings.set("warning:gateway-availability", detail);
    await recordManagedUpdateOutcome(reason, false);
    if (runOutcome) runOutcome.nextAction = "openclaw update repair; openclaw gateway status --deep";
    finalExitCode = 1;
  }
}

`;
