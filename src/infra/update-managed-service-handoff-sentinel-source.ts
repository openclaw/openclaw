// SQLite uses captured row owners so recovery does not require a restored
// published runtime to export an engine-aware sentinel method.
export const MANAGED_HANDOFF_SENTINEL_SOURCE = String.raw`
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
  if (params.stateEngine !== "postgres") {
    const db = openStateDatabase();
    // Unavailable inspection adds no context; a failed query still ends triage.
    if (!db && operation.kind === "inspect") return { kind: "unavailable" };
    if (!db) throw new Error("Managed handoff sentinel database unavailable");
    try {
      if (operation.kind === "inspect") return inspectManagedHandoffSentinelRowSync(db, operation.input);
      return leaseStore.transact(db, () => {
        assertStateDatabaseWriteAllowed(db);
        if (!ownsManagedUpdateLease()) throw new Error("Managed handoff sentinel lease lost");
        return recordManagedHandoffSentinelOutcomeRowSync(db, operation.input);
      });
    } finally {
      db.close();
    }
  }
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

`;
