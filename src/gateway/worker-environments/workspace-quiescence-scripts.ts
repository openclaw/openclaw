const REMOTE_WATCHDOG_PROCESS_PROBE_TIMEOUT_MS = 1_000;
const REMOTE_WATCHDOG_PROCESS_RECOVERY_TIMEOUT_MS = 5_000;
const REMOTE_QUIESCENCE_LEASE_LOCK_TIMEOUT_MS = 7_000;
const REMOTE_QUIESCENCE_PROCESS_PROBE_CONCURRENCY = 8;

const REMOTE_QUIESCENCE_PS_JS = String.raw`function processes() {
  const output = childProcess.execFileSync("ps", ["-axo", "pid=,ppid=,uid=,stat=,lstart="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 2000,
  });
  const rows = new Map();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    rows.set(Number(match[1]), {
      ppid: Number(match[2]),
      uid: Number(match[3]),
      state: match[4],
      start: match[5],
    });
  }
  return rows;
}
function ancestors(rows) {
  const result = new Set();
  let pid = process.pid;
  while (pid > 0 && !result.has(pid)) {
    result.add(pid);
    pid = rows.get(pid)?.ppid || 0;
  }
  return result;
}
function processIdentity(pid) {
  try {
    const start = require("node:child_process").execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      maxBuffer: 4096,
      timeout: ${REMOTE_WATCHDOG_PROCESS_PROBE_TIMEOUT_MS},
    }).trim();
    return start || null;
  } catch (error) {
    if (error && error.status === 1) return null;
    throw error;
  }
}
function probeProcessIdentity(pid, timeoutMs = ${REMOTE_WATCHDOG_PROCESS_PROBE_TIMEOUT_MS}) {
  return new Promise((resolve) => {
    let settled = false; let deadline;
    const finish = (action, value) => { if (settled) return; settled = true; clearTimeout(deadline); action(value); };
    const child = childProcess.execFile("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 4096 }, (error, stdout) => {
      if (!error) finish(resolve, { kind: "identity", start: stdout.trim() || null });
      else if (error.code === 1) finish(resolve, { kind: "missing" });
      else if (error.code === "EAGAIN" || error.code === "EMFILE") finish(resolve, { kind: "timeout" });
      else finish(resolve, { kind: "failed" });
    });
    deadline = setTimeout(() => {
      if (settled) return;
      settled = true; child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
      try { child.kill("SIGKILL"); } catch {}
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
}
async function signalProcessReferences(references, concurrency = ${REMOTE_QUIESCENCE_PROCESS_PROBE_CONCURRENCY}, deadlineMs = Date.now() + ${REMOTE_WATCHDOG_PROCESS_RECOVERY_TIMEOUT_MS}) {
  // Keep identity confirmation adjacent to its signal; unrelated slow probes must not stale it.
  const results = new Array(references.length);
  let nextIndex = 0;
  let stopped = false;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= references.length) return;
      if (stopped) {
        results[index] = { kind: "deferred" };
        continue;
      }
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        results[index] = { kind: "deferred" };
        continue;
      }
      const reference = references[index];
      const observed = await probeProcessIdentity(
        reference.pid,
        Math.min(${REMOTE_WATCHDOG_PROCESS_PROBE_TIMEOUT_MS}, remainingMs),
      );
      if (observed.kind === "timeout") {
        results[index] = observed;
        continue;
      }
      if (observed.kind === "failed") {
        results[index] = observed;
        stopped = true;
        continue;
      }
      if (observed.kind !== "identity" || observed.start !== reference.start) {
        results[index] = { kind: "missing" };
        continue;
      }
      try {
        process.kill(reference.pid, reference.signal);
        results[index] = { kind: "signaled" };
      } catch (error) {
        if (error && error.code === "ESRCH") results[index] = { kind: "missing" };
        else {
          results[index] = { kind: "failed" };
          stopped = true;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, references.length) }, worker));
  return results;
}
function retryProcessReferences(references, outcomes) {
  const deferred = [];
  const timedOut = [];
  for (let index = 0; index < references.length; index += 1) {
    if (outcomes[index].kind === "deferred") deferred.push(references[index]);
    else if (outcomes[index].kind === "timeout" || outcomes[index].kind === "failed") {
      timedOut.push(references[index]);
    }
  }
  // Rotate unattempted entries forward so repeated bounded recovery is fair.
  return [...deferred, ...timedOut];
}
async function recoverProcessReferences(references, concurrency = ${REMOTE_QUIESCENCE_PROCESS_PROBE_CONCURRENCY}, deadlineMs = Date.now() + ${REMOTE_WATCHDOG_PROCESS_RECOVERY_TIMEOUT_MS}) {
  let remaining = references;
  let failed = false;
  while (remaining.length > 0 && Date.now() < deadlineMs) {
    const outcomes = await signalProcessReferences(remaining, concurrency, deadlineMs);
    failed = outcomes.some((outcome) => outcome.kind === "failed") || failed;
    remaining = retryProcessReferences(remaining, outcomes);
    if (failed || remaining.length === 0 || Date.now() >= deadlineMs) break;
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.min(${REMOTE_WATCHDOG_PROCESS_PROBE_TIMEOUT_MS}, deadlineMs - Date.now()),
    ));
  }
  return { remaining, failed };
}
function processStatus(pid) {
  try {
    const output = childProcess.execFileSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 4096, timeout: 2000 }).trim();
    const match = /^(\S+)\s+(.+)$/u.exec(output);
    return match ? { state: match[1], start: match[2] } : null;
  } catch (error) {
    if (error && error.status === 1) return null;
    throw error;
  }
}
function quiescenceCandidates(rows, expectedUid, excludedPids, frozen) {
  const preserved = ancestors(rows);
  return [...rows.entries()].filter(
    ([pid, row]) =>
      row.uid === expectedUid &&
      !preserved.has(pid) &&
      row.ppid !== process.pid &&
      !excludedPids.has(pid) &&
      (!frozen || !frozen.has(pid)) &&
      !row.state.startsWith("T") &&
      !row.state.startsWith("Z") &&
      !row.state.startsWith("X"),
  );
}`;

const REMOTE_QUIESCENCE_LEASE_JS = String.raw`function validProcessReference(value) {
  return value && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.start === "string" && value.start.length > 0 && value.start.length <= 128;
}
function validRecovery(value) {
  return value === undefined || (value && (value.state === "probe-timeout" || value.state === "recovery-failed") && Number.isSafeInteger(value.failedAtMs) && value.failedAtMs > 0);
}
function sameProcessReferences(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((entry, index) => entry.pid === right[index].pid && entry.start === right[index].start);
}
function parseLease(raw, expectedNonce, options = {}) {
  const lease = JSON.parse(raw);
  if (
    !lease ||
    lease.version !== 1 ||
    lease.nonce !== expectedNonce ||
    !Array.isArray(lease.processes) ||
    lease.processes.length > 4096 ||
    lease.processes.some((entry) => !validProcessReference(entry)) ||
    (lease.watchdog !== null && !validProcessReference(lease.watchdog)) ||
    !validRecovery(lease.recovery) ||
    (options.requireWatchdog && lease.watchdog === null) ||
    !Number.isSafeInteger(lease.expiresAtMs) ||
    lease.expiresAtMs < 1 ||
    (options.minimumRemainingMs && lease.expiresAtMs - Date.now() < options.minimumRemainingMs)
  ) {
    throw new Error(options.errorMessage || "invalid workspace quiescence lease");
  }
  return lease;
}
function leaseMutationProcessStartTime(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const commEndIndex = stat.lastIndexOf(")");
    if (commEndIndex < 0) return null;
    const starttime = Number(stat.slice(commEndIndex + 1).trimStart().split(/\s+/)[19]);
    return Number.isInteger(starttime) && starttime >= 0 ? starttime : null;
  } catch { return null; }
}
function leaseMutationOwnerDefinitelyStale(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
  if (Number.isSafeInteger(owner.starttime) && owner.starttime >= 0) {
    const currentStarttime = leaseMutationProcessStartTime(owner.pid);
    if (currentStarttime !== null && currentStarttime !== owner.starttime) return true;
  }
  try { process.kill(owner.pid, 0); } catch (error) { return Boolean(error && error.code === "ESRCH"); }
  if (process.platform === "linux") {
    try { return /^State:\s+Z/m.test(fs.readFileSync("/proc/" + owner.pid + "/status", "utf8")); } catch {}
  }
  return false;
}
// The owner identity is atomic directory-entry metadata, so a crash cannot publish partial JSON.
function leaseMutationOwnerName(owner) {
  return "owner." + owner.pid + "." + (owner.starttime ?? "x") + "." + owner.token;
}
function parseLeaseMutationOwnerName(name) {
  const match = /^owner\.(\d+)\.(x|\d+)\.([a-f0-9]{32})$/.exec(name);
  if (!match) return null;
  const owner = { pid: Number(match[1]), token: match[3] };
  if (match[2] !== "x") owner.starttime = Number(match[2]);
  return Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner : null;
}
function leaseMutationDirectoryOwners(lockPath) {
  const owners = [];
  for (const name of fs.readdirSync(lockPath)) {
    const owner = parseLeaseMutationOwnerName(name);
    if (!owner) return null;
    owners.push({ name, owner });
  }
  return owners;
}
function removeLeaseMutationOwner(lockPath, ownerName) {
  try { fs.unlinkSync(lockPath + "/" + ownerName); } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
  try { fs.rmdirSync(lockPath); } catch (error) {
    if (!error || (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST")) throw error;
  }
  return true;
}
function clearStaleLeaseMutation(lockPath) {
  let owners;
  try {
    const observed = fs.lstatSync(lockPath);
    if (!observed.isDirectory()) return false;
    owners = leaseMutationDirectoryOwners(lockPath);
  } catch (error) { return Boolean(error && error.code === "ENOENT"); }
  if (owners === null) return false;
  if (owners.length === 0) {
    try { fs.rmdirSync(lockPath); return true; } catch (error) {
      if (error && error.code === "ENOENT") return true;
      if (error && (error.code === "ENOTEMPTY" || error.code === "EEXIST")) return false;
      throw error;
    }
  }
  let removed = false;
  for (const entry of owners) {
    if (leaseMutationOwnerDefinitelyStale(entry.owner)) {
      removed = removeLeaseMutationOwner(lockPath, entry.name) || removed;
    }
  }
  return removed;
}
function leaseMutationTimeout() {
  const timeout = new Error("workspace quiescence lease update timed out; operator recovery required"); timeout.code = "ELOCKED"; return timeout;
}
function acquireLeaseMutation(targetPath, timeoutMs = ${REMOTE_QUIESCENCE_LEASE_LOCK_TIMEOUT_MS}) {
  const lockPath = targetPath + ".lock";
  const token = crypto.randomBytes(16).toString("hex");
  const owner = { pid: process.pid, token };
  const starttime = leaseMutationProcessStartTime(process.pid);
  if (starttime !== null) owner.starttime = starttime;
  const ownerName = leaseMutationOwnerName(owner);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadlineMs = Date.now() + timeoutMs;
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      let acquired = false;
      try {
        const descriptor = fs.openSync(lockPath + "/" + ownerName, "wx", 0o600);
        fs.closeSync(descriptor);
        const owners = leaseMutationDirectoryOwners(lockPath);
        if (owners !== null && owners.length === 1 && owners[0].name === ownerName) {
          acquired = true;
          return { lockPath, ownerName };
        }
      } finally {
        if (!acquired) removeLeaseMutationOwner(lockPath, ownerName);
      }
    } catch (error) {
      if (!error || (error.code !== "EEXIST" && error.code !== "ENOENT")) throw error;
    }
    if (clearStaleLeaseMutation(lockPath)) continue;
    if (Date.now() >= deadlineMs) throw leaseMutationTimeout();
    Atomics.wait(sleeper, 0, 0, 10);
  }
}
function releaseLeaseMutation(mutation) {
  removeLeaseMutationOwner(mutation.lockPath, mutation.ownerName);
}
function withLeaseMutation(targetPath, mutate) {
  const mutation = acquireLeaseMutation(targetPath); try { return mutate(); } finally { releaseLeaseMutation(mutation); }
}
function persistLeaseLocked(targetPath, lease, verifyCurrent) {
  if (verifyCurrent) verifyCurrent(JSON.parse(fs.readFileSync(targetPath, "utf8")));
  const temporary = targetPath + "." + process.pid + "." + crypto.randomBytes(8).toString("hex");
  fs.writeFileSync(temporary, JSON.stringify(lease), { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, targetPath);
}
function persistLease(targetPath, lease, verifyCurrent) {
  return withLeaseMutation(targetPath, () => persistLeaseLocked(targetPath, lease, verifyCurrent));
}`;

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
void resume();
`;
