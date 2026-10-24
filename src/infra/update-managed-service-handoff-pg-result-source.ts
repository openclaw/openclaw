// The SQLite result source is kept intact for restored published runtimes.
export const MANAGED_HANDOFF_PG_RESULT_SOURCE = String.raw`
let sentinelRequestId = 0;
let pendingSentinel;
process.on("message", (message) => {
  if (!pendingSentinel || message?.type !== "handoff-sentinel" || message.requestId !== pendingSentinel.id) return;
  const pending = pendingSentinel;
  pendingSentinel = undefined;
  clearTimeout(pending.timer);
  if (message.error) pending.reject(new Error(message.error));
  else pending.resolve(message.result);
});
process.on("disconnect", () => {
  if (!pendingSentinel) return;
  const pending = pendingSentinel;
  pendingSentinel = undefined;
  clearTimeout(pending.timer);
  pending.reject(new Error("Parent sentinel owner disconnected before its reply"));
});
process.channel?.unref();

async function runSentinelOperation(operation) {
  if (!ownsManagedUpdateLease()) throw new Error("Managed handoff sentinel lease lost");
  const request = { operation, databaseIdentity: params.updateLeaseDatabaseIdentity, helper: managedUpdateLease.helper };
  if (process.connected && parentIdentityCurrent()) {
    return new Promise((resolve, reject) => {
      const id = ++sentinelRequestId;
      pendingSentinel = { id, resolve, reject, timer: setTimeout(() => {
        pendingSentinel = undefined;
        reject(new Error("Parent sentinel owner did not reply"));
      }, 10000) };
      process.send({ type: "handoff-sentinel", requestId: id, request });
    });
  }
  const inputPath = path.join(params.cwd, "sentinel-operation.json");
  const resultPath = path.join(params.cwd, "sentinel-result.json");
  try {
    fs.writeFileSync(inputPath, JSON.stringify({ modulePath: terminalRuntimePath, request, resultPath }), { mode: 0o600 });
    const exit = await runOwnedUpdateCommand("sentinel", [process.execPath, ...params.runtimeArgs, "--input-type=module", "-e",
      'import fs from "node:fs"; import { pathToFileURL } from "node:url"; try { const { modulePath, request, resultPath } = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const { runManagedHandoffSentinelChild } = await import(pathToFileURL(modulePath).href); const result = await runManagedHandoffSentinelChild(request); fs.writeFileSync(resultPath, JSON.stringify(result), { mode: 0o600 }); } catch { console.error("Shared-state sentinel operation unavailable; inspect PostgreSQL and Gateway availability."); process.exitCode = 1; }', inputPath], params.recoveryTimeoutMs);
    if (exit.signal || exit.code !== 0) throw new Error("Installed runtime could not record the shared-state notice");
    return JSON.parse(fs.readFileSync(resultPath, "utf8"));
  } finally {
    fs.rmSync(inputPath, { force: true });
    fs.rmSync(resultPath, { force: true });
  }
}

function sentinelIdentity() {
  return { handoffId: params.handoffId, runId: params.runId, root: params.updateLeaseKey };
}

async function captureManagedUpdateResult() {
  if (params.stateEngine !== "postgres") return captureFailedUpdateResult();
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
  } catch {
    appendLog("Shared-state update notice could not be inspected; service recovery retains its local lease.");
    return false;
  }
}

async function recordManagedUpdateOutcome(reason, restored, completedStatus, expectedRevision) {
  if (params.stateEngine !== "postgres") return recordUpdateHandoffOutcome(reason, restored, completedStatus, expectedRevision);
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
      appendLog("Shared-state update notice changed or belongs to another handoff; it was not replaced.");
      return false;
    }
    if (result.sentinel && triageFailure) triageFailure.payload = result.sentinel.payload;
    return result.sentinel?.revision ?? true;
  } catch {
    appendLog("Shared-state update notice could not be recorded; service recovery retains its local lease. Inspect PostgreSQL and Gateway availability.");
    return null;
  }
}
`;
