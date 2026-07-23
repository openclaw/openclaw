import {
  REMOTE_QUIESCENCE_LEASE_JS,
  REMOTE_QUIESCENCE_PROCESS_PROBE_CONCURRENCY,
  REMOTE_QUIESCENCE_PS_JS,
  REMOTE_WATCHDOG_PROCESS_PROBE_TIMEOUT_MS,
  REMOTE_WATCHDOG_PROCESS_RECOVERY_TIMEOUT_MS,
} from "./workspace-quiescence-script-runtime.js";
export const REMOTE_WORKSPACE_QUIESCE_JS = String.raw`const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.realpathSync(process.argv[1]);
if (typeof process.getuid !== "function") throw new Error("workspace quiescence requires POSIX");
const uid = process.getuid();
if (uid === 0) throw new Error("workspace quiescence refuses root-owned worker sessions");
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const leaseDirectory = path.join(os.homedir(), ".openclaw-worker", "quiescence");
fs.mkdirSync(leaseDirectory, { recursive: true, mode: 0o700 });
fs.chmodSync(leaseDirectory, 0o700);
const workspaceKey = crypto.createHash("sha256").update(root).digest("hex");
const nonce = crypto.randomBytes(16).toString("hex");
const leasePath = path.join(leaseDirectory, workspaceKey + "." + nonce + ".json");
const watchdogTimeoutMs = Number(process.argv[2] || 12 * 60 * 1000);
if (!Number.isSafeInteger(watchdogTimeoutMs) || watchdogTimeoutMs < 1) throw new Error("invalid watchdog timeout");
${REMOTE_QUIESCENCE_PS_JS}
${REMOTE_QUIESCENCE_LEASE_JS}
const frozen = new Map();
let watchdogReference = null;
function writeLease(expiresAtMs = Date.now() + watchdogTimeoutMs) {
  persistLease(leasePath, {
    version: 1,
    nonce,
    processes: [...frozen].map(([pid, start]) => ({ pid, start })),
    watchdog: watchdogReference,
    expiresAtMs,
  });
}
async function recoverOrphanLease(orphanPath, expectedNonce) {
  const mutation = acquireLeaseMutation(orphanPath);
  try {
    let raw;
    try {
      raw = fs.readFileSync(orphanPath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
    const lease = parseLease(raw, expectedNonce);
    const references = [
      ...(lease.watchdog === null ? [] : [{ ...lease.watchdog, signal: "SIGTERM" }]),
      ...lease.processes.map((entry) => ({ ...entry, signal: "SIGCONT" })),
    ];
    const recovery = await recoverProcessReferences(references);
    const remaining = recovery.remaining;
    if (remaining.length === 0) {
      fs.unlinkSync(orphanPath);
      return;
    }
    const watchdog = remaining.find((entry) => entry.signal === "SIGTERM") ?? null;
    const processes = remaining
      .filter((entry) => entry.signal === "SIGCONT")
      .map(({ pid, start }) => ({ pid, start }));
    persistLeaseLocked(
      orphanPath,
      {
        ...lease,
        processes,
        watchdog: watchdog === null ? null : { pid: watchdog.pid, start: watchdog.start },
        recovery: {
          state: recovery.failed ? "recovery-failed" : "probe-timeout",
          failedAtMs: Date.now(),
        },
      },
      (current) => {
        if (
          current.nonce !== lease.nonce ||
          current.expiresAtMs !== lease.expiresAtMs ||
          current.watchdog?.pid !== lease.watchdog?.pid ||
          current.watchdog?.start !== lease.watchdog?.start ||
          !sameProcessReferences(current.processes, lease.processes)
        ) {
          throw new Error("workspace quiescence lease changed during orphan recovery");
        }
      },
    );
    const failure = recovery.failed ? "failed" : "timed out";
    throw new Error(
      "workspace quiescence orphan recovery " +
        failure +
        "; lease retained for operator recovery",
    );
  } finally {
    releaseLeaseMutation(mutation);
  }
}
async function quiesce() {
const orphanNames = fs.readdirSync(leaseDirectory).filter((name) =>
  name.startsWith(workspaceKey + ".") && name.endsWith(".json"),
);
if (orphanNames.length > 16) throw new Error("too many workspace quiescence leases");
for (const name of orphanNames) {
  const match = name.match(/^[a-f0-9]{64}\.([a-f0-9]{32})\.json$/);
  if (!match) continue;
  const orphanPath = path.join(leaseDirectory, name);
  await recoverOrphanLease(orphanPath, match[1]);
}
writeLease();
const watchdogSource = [
  'const childProcess = require("node:child_process");',
  'const crypto = require("node:crypto");',
  'const fs = require("node:fs");',
  probeProcessIdentity.toString(),
  signalProcessReferences.toString(),
  retryProcessReferences.toString(),
  recoverProcessReferences.toString(),
  validProcessReference.toString(),
  validRecovery.toString(),
  parseLease.toString(),
  leaseMutationProcessStartTime.toString(),
  leaseMutationOwnerDefinitelyStale.toString(),
  leaseMutationOwnerName.toString(),
  parseLeaseMutationOwnerName.toString(),
  leaseMutationDirectoryOwners.toString(),
  removeLeaseMutationOwner.toString(),
  clearStaleLeaseMutation.toString(),
  leaseMutationTimeout.toString(),
  acquireLeaseMutation.toString(),
  releaseLeaseMutation.toString(),
  persistLeaseLocked.toString(),
  "(" + watchdogMain.toString() + ")(process.argv[1], process.argv[2]);",
].join("\n");
const watchdog = childProcess.spawn(
  process.execPath,
  ["-e", watchdogSource, leasePath, nonce],
  { detached: true, stdio: "ignore" },
);
watchdog.unref();
if (!Number.isSafeInteger(watchdog.pid) || watchdog.pid < 1) {
  fs.unlinkSync(leasePath);
  throw new Error("workspace quiescence watchdog did not start");
}
let watchdogStart = null;
for (let attempt = 0; attempt < 100 && !watchdogStart; attempt += 1) {
  watchdogStart = processIdentity(watchdog.pid);
  if (!watchdogStart) Atomics.wait(sleeper, 0, 0, 10);
}
if (!watchdogStart) {
  try { process.kill(watchdog.pid, "SIGTERM"); } catch {}
  fs.unlinkSync(leasePath);
  throw new Error("workspace quiescence watchdog identity was not observable");
}
watchdogReference = { pid: watchdog.pid, start: watchdogStart };
writeLease();
let quietScans = 0;
try {
  for (let attempt = 0; attempt < 250 && quietScans < 3; attempt += 1) {
    const candidates = quiescenceCandidates(
      processes(),
      uid,
      new Set([watchdog.pid]),
      frozen,
    );
    if (candidates.length + frozen.size > 4096) {
      throw new Error("too many worker processes to quiesce safely");
    }
    for (const [pid, row] of candidates) {
      try {
        frozen.set(pid, row.start);
        writeLease();
        if (processIdentity(pid) !== row.start) {
          frozen.delete(pid);
          writeLease();
          continue;
        }
        process.kill(pid, "SIGSTOP");
      } catch (error) {
        if (!error || error.code !== "ESRCH") throw error;
      }
    }
    Atomics.wait(sleeper, 0, 0, 20);
    const writable = quiescenceCandidates(
      processes(),
      uid,
      new Set([watchdog.pid]),
    ).length > 0;
    quietScans = writable ? 0 : quietScans + 1;
  }
  if (quietScans < 3) {
    throw new Error("worker processes did not reach a quiescent state");
  }
} catch (error) {
  const mutation = acquireLeaseMutation(leasePath);
  try {
    const recovery = await recoverProcessReferences([
      { pid: watchdog.pid, start: watchdogStart, signal: "SIGTERM" },
      ...[...frozen].map(([pid, start]) => ({ pid, start, signal: "SIGCONT" })),
    ]);
    if (recovery.remaining.length === 0) {
      try { fs.unlinkSync(leasePath); } catch (unlinkError) { if (!unlinkError || unlinkError.code !== "ENOENT") throw unlinkError; }
    } else {
      const remainingWatchdog = recovery.remaining.find((entry) => entry.signal === "SIGTERM");
      const remainingProcesses = recovery.remaining
        .filter((entry) => entry.signal === "SIGCONT")
        .map(({ pid, start }) => ({ pid, start }));
      persistLeaseLocked(leasePath, {
        version: 1,
        nonce,
        processes: remainingProcesses,
        watchdog: remainingWatchdog
          ? { pid: remainingWatchdog.pid, start: remainingWatchdog.start }
          : null,
        expiresAtMs: Date.now(),
        recovery: {
          state: recovery.failed ? "recovery-failed" : "probe-timeout",
          failedAtMs: Date.now(),
        },
      });
    }
  } finally {
    releaseLeaseMutation(mutation);
  }
  throw error;
}
function watchdogMain(watchedLeasePath, watchedNonce) {
  const check = async () => {
    let mutation = null;
    try {
      const lease = parseLease(fs.readFileSync(watchedLeasePath, "utf8"), watchedNonce);
      const remainingMs = lease.expiresAtMs - Date.now();
      if (remainingMs > 0) {
        setTimeout(check, Math.min(remainingMs, 60 * 1000));
        return;
      }
      mutation = acquireLeaseMutation(watchedLeasePath);
      const current = parseLease(fs.readFileSync(watchedLeasePath, "utf8"), watchedNonce);
      if (current.watchdog === null) return;
      if (current.expiresAtMs > Date.now()) {
        setTimeout(check, Math.min(current.expiresAtMs - Date.now(), 60 * 1000));
        return;
      }
      const recoveryDeadlineMs = Date.now() + ${REMOTE_WATCHDOG_PROCESS_RECOVERY_TIMEOUT_MS};
      const recovery = await recoverProcessReferences(
        current.processes.map((entry) => ({ ...entry, signal: "SIGCONT" })),
        ${REMOTE_QUIESCENCE_PROCESS_PROBE_CONCURRENCY},
        recoveryDeadlineMs,
      );
      const remainingReferences = recovery.remaining;
      const remaining = remainingReferences.map(({ pid, start }) => ({ pid, start }));
      if (remaining.length === 0) {
        fs.unlinkSync(watchedLeasePath);
        return;
      }
      persistLeaseLocked(
        watchedLeasePath,
        {
          ...current,
          processes: remaining,
          watchdog: null,
          recovery: {
            state: recovery.failed ? "recovery-failed" : "probe-timeout",
            failedAtMs: Date.now(),
          },
        },
        (latest) => {
          if (
            latest.nonce !== current.nonce ||
            latest.expiresAtMs !== current.expiresAtMs ||
            latest.watchdog?.pid !== current.watchdog.pid ||
            latest.watchdog?.start !== current.watchdog.start
          ) {
            throw new Error("workspace quiescence lease changed during watchdog recovery");
          }
        },
      );
    } catch (error) {
      if (error && error.code === "ELOCKED") {
        setTimeout(check, ${REMOTE_WATCHDOG_PROCESS_PROBE_TIMEOUT_MS});
        return;
      }
      if (!error || error.code !== "ENOENT") process.exitCode = 1;
    } finally {
      if (mutation !== null) releaseLeaseMutation(mutation);
    }
  };
  void check();
}
process.stdout.write("quiesced " + nonce + "\n");
}
void quiesce().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

export const REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS = String.raw`const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.realpathSync(process.argv[1]);
const nonce = process.argv[2];
const timeoutMs = Number(process.argv[3] || 12 * 60 * 1000);
const validationMode = process.argv[4] || "final";
if (typeof process.getuid !== "function") throw new Error("workspace quiescence requires POSIX");
const uid = process.getuid();
if (!/^[a-f0-9]{32}$/.test(nonce || "")) throw new Error("invalid workspace quiescence nonce");
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 * 1000) throw new Error("invalid watchdog timeout");
if (validationMode !== "heartbeat" && validationMode !== "final") throw new Error("invalid workspace quiescence validation mode");
const leasePath = path.join(os.homedir(), ".openclaw-worker", "quiescence", crypto.createHash("sha256").update(root).digest("hex") + "." + nonce + ".json");
${REMOTE_QUIESCENCE_PS_JS}
${REMOTE_QUIESCENCE_LEASE_JS}
const input = parseLease(fs.readFileSync(leasePath, "utf8"), nonce, {
  errorMessage: "workspace quiescence lease is no longer active",
});
if (input.recovery !== undefined) {
  const failure = input.recovery.state === "recovery-failed" ? "failed" : "timed out";
  throw new Error("workspace quiescence recovery " + failure + "; lease retained for operator recovery");
}
if (input.watchdog === null || input.expiresAtMs - Date.now() < 5000) {
  throw new Error("workspace quiescence lease is no longer active");
}
function writeLease(processes, expiresAtMs) {
  persistLease(leasePath, { ...input, processes, expiresAtMs }, (current) => {
    if (
      current.nonce !== nonce ||
      current.expiresAtMs !== input.expiresAtMs ||
      current.recovery !== undefined ||
      current.watchdog?.pid !== input.watchdog.pid ||
      current.watchdog?.start !== input.watchdog.start ||
      !sameProcessReferences(current.processes, input.processes)
    ) {
      throw new Error("workspace quiescence lease changed during renewal");
    }
  });
  input.processes = processes;
  input.expiresAtMs = expiresAtMs;
}
function assertWatchdogActive() {
  const status = processStatus(input.watchdog.pid);
  if (!status || status.start !== input.watchdog.start) {
    throw new Error("workspace quiescence watchdog identity changed unexpectedly");
  }
  try { process.kill(input.watchdog.pid, 0); } catch (error) {
    if (error && error.code === "ESRCH") throw new Error("workspace quiescence watchdog exited unexpectedly");
    throw error;
  }
}
function refreshLease(processes) {
  assertWatchdogActive();
  writeLease(processes, Date.now() + timeoutMs);
}
for (const entry of input.processes) {
  const status = processStatus(entry.pid);
  if (!status || status.start !== entry.start) continue;
  if (status.state && !status.state.startsWith("T")) throw new Error("workspace quiescence process resumed unexpectedly");
}
refreshLease(input.processes);
if (validationMode === "final") {
  const frozen = new Map(input.processes.map((entry) => [entry.pid, entry.start]));
  let quietScans = 0;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  // A control tunnel can reconnect after the initial freeze; enroll every late process.
  for (let attempt = 0; attempt < 250 && quietScans < 3; attempt += 1) {
    const candidates = quiescenceCandidates(
      processes(),
      uid,
      new Set([input.watchdog.pid]),
    );
    if (candidates.length + frozen.size > 4096) {
      throw new Error("too many worker processes to quiesce safely");
    }
    for (const [pid, row] of candidates) frozen.set(pid, row.start);
    let frozenEntries = [...frozen].map(([pid, start]) => ({ pid, start }));
    refreshLease(frozenEntries);
    for (const [pid, row] of candidates) {
      try {
        if (input.expiresAtMs - Date.now() < 5000) refreshLease(frozenEntries);
        const current = processStatus(pid);
        if (!current || current.start !== row.start) {
          frozen.delete(pid);
          continue;
        }
        if (input.expiresAtMs - Date.now() < 2500) refreshLease(frozenEntries);
        process.kill(pid, "SIGSTOP");
      } catch (error) {
        if (!error || error.code !== "ESRCH") throw error;
        frozen.delete(pid);
      }
    }
    frozenEntries = [...frozen].map(([pid, start]) => ({ pid, start }));
    refreshLease(frozenEntries);
    Atomics.wait(sleeper, 0, 0, 20);
    const unknownProcess = quiescenceCandidates(
      processes(),
      uid,
      new Set([input.watchdog.pid]),
    ).length > 0;
    quietScans = candidates.length > 0 || unknownProcess ? 0 : quietScans + 1;
  }
  if (quietScans < 3) {
    throw new Error("worker processes did not return to a quiescent state");
  }
  input.processes = [...frozen].map(([pid, start]) => ({ pid, start }));
}
const renewed = { ...input, expiresAtMs: Date.now() + timeoutMs };
refreshLease(renewed.processes);
renewed.expiresAtMs = input.expiresAtMs;
const confirmed = JSON.parse(fs.readFileSync(leasePath, "utf8"));
if (confirmed.nonce !== nonce || confirmed.expiresAtMs !== renewed.expiresAtMs) {
  throw new Error("workspace quiescence renewal was not durable");
}
process.stdout.write("renewed " + nonce + "\n");
`;

export const REMOTE_WORKSPACE_RESUME_JS = String.raw`const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
if (typeof process.getuid !== "function") throw new Error("workspace quiescence requires POSIX");
const root = fs.realpathSync(process.argv[1]);
const nonce = process.argv[2];
if (!/^[a-f0-9]{32}$/.test(nonce || "")) throw new Error("invalid workspace quiescence nonce");
const leasePath = path.join(os.homedir(), ".openclaw-worker", "quiescence", crypto.createHash("sha256").update(root).digest("hex") + "." + nonce + ".json");
${REMOTE_QUIESCENCE_PS_JS}
${REMOTE_QUIESCENCE_LEASE_JS}
async function resume() {
  const mutation = acquireLeaseMutation(leasePath);
  try {
    let raw;
    try {
      raw = fs.readFileSync(leasePath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
    const input = parseLease(raw, nonce);
    const recoveryDeadlineMs = Date.now() + ${REMOTE_WATCHDOG_PROCESS_RECOVERY_TIMEOUT_MS};
    if (input.watchdog !== null) {
      const [watchdogOutcome] = await signalProcessReferences(
        [{ ...input.watchdog, signal: "SIGTERM" }],
        1,
        recoveryDeadlineMs,
      );
      if (
        watchdogOutcome.kind === "timeout" ||
        watchdogOutcome.kind === "deferred" ||
        watchdogOutcome.kind === "failed"
      ) {
        const failure = watchdogOutcome.kind === "failed" ? "failed" : "timed out";
        throw new Error("workspace quiescence recovery " + failure + "; lease retained for operator recovery");
      }
    }
    const outcomes = await signalProcessReferences(
      input.processes.map((entry) => ({ ...entry, signal: "SIGCONT" })),
      ${REMOTE_QUIESCENCE_PROCESS_PROBE_CONCURRENCY},
      recoveryDeadlineMs,
    );
    const failed = outcomes.some((outcome) => outcome.kind === "failed");
    const remaining = retryProcessReferences(input.processes, outcomes);
    if (remaining.length > 0) {
      persistLeaseLocked(
        leasePath,
        {
          ...input,
          processes: remaining,
          watchdog: null,
          recovery: {
            state: failed ? "recovery-failed" : "probe-timeout",
            failedAtMs: Date.now(),
          },
        },
        (current) => {
          if (
            current.nonce !== input.nonce ||
            current.expiresAtMs !== input.expiresAtMs ||
            current.watchdog?.pid !== input.watchdog?.pid ||
            current.watchdog?.start !== input.watchdog?.start ||
            !sameProcessReferences(current.processes, input.processes)
          ) {
            throw new Error("workspace quiescence lease changed during operator recovery");
          }
        },
      );
      const failure = failed ? "failed" : "timed out";
      throw new Error("workspace quiescence recovery " + failure + "; lease retained for operator recovery");
    }
    fs.unlinkSync(leasePath);
  } finally {
    releaseLeaseMutation(mutation);
  }
}
void resume().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
