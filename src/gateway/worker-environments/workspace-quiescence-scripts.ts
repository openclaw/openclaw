import type { NodeWorkerWorkspaceQuiescenceInput } from "../../worker/node-workspace-protocol.js";

const REMOTE_QUIESCENCE_CONTEXT_JS = String.raw`const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.realpathSync(process.argv[1]);
const workspaceKey = crypto.createHash("sha256").update(root).digest("hex");
const leaseDirectory = path.join(os.homedir(), ".openclaw-worker", "quiescence");
const windowsLeaseDatabasePath = path.join(leaseDirectory, "windows-shared-host.sqlite");`;

const REMOTE_QUIESCENCE_PS_JS = String.raw`function createProcessProbe() {
  // Share 30s across probes: tolerate multi-second stalls on slow hosts while leaving
  // the node transport's 60s command deadline room to deliver the failure and cleanup.
  const deadline = performance.now() + 30000;
  let warned = false;
  return (args, maxBuffer) => {
    let timeout = 2000;
    for (;;) {
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) {
        const message = "workspace quiescence process probe budget exhausted after 30000 ms; check host load and ps availability";
        process.stderr.write(message + "\n");
        throw Object.assign(new Error(message), { code: "WORKSPACE_PROBE_BUDGET_EXHAUSTED" });
      }
      try {
        // SIGTERM can be ignored; SIGKILL keeps even a stuck probe bounded.
        return require("node:child_process").execFileSync("ps", args, {
          encoding: "utf8", maxBuffer, timeout: Math.min(timeout, remaining), killSignal: "SIGKILL",
        });
      } catch (error) {
        if (!error || error.code !== "ETIMEDOUT") throw error;
        if (!warned) {
          process.stderr.write("workspace quiescence: slow ps probe; retrying within the shared 30000 ms budget\n");
          warned = true;
        }
        timeout *= 2;
      }
    }
  };
}
let processProbe = createProcessProbe();
function processes() {
  const output = processProbe(["-axo", "pid=,ppid=,uid=,stat=,lstart="], 4 * 1024 * 1024);
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
function processIdentity(pid, withState = false) {
  try {
    const output = processProbe(["-o", withState ? "stat=,lstart=" : "lstart=", "-p", String(pid)], 4096).trim();
    if (!withState) return output || null;
    const match = /^(\S+)\s+(.+)$/u.exec(output);
    return match ? { state: match[1], start: match[2] } : null;
  } catch (error) {
    if (error && error.status === 1) return null;
    throw error;
  }
}
function reportPendingProcesses(entries, exhausted = false) {
  const pids = entries.filter((entry) => Number.isSafeInteger(entry?.pid) && entry.pid > 0).map((entry) => entry.pid);
  // Match workspaceSyncError's single-line display in the retained diagnostic, while
  // preserving raw ps padding in lease identities used by signal guards and older watchdogs.
  const message = (exhausted
    ? "workspace quiescence recovery exhausted after 4 probe passes (30000 ms each, 7000 ms total backoff); check host load and ps availability, then retry workspace recovery; unfinished workers (PID/start): "
    : "workspace quiescence recovery pending PIDs: " + pids.join(", ") + "; unfinished workers (PID/start): ") + JSON.stringify(entries).replace(/\s+/gu, " ");
  process.stderr.write(message + "\n");
  return message;
}
// EPERM on SIGCONT implies the target was never ours to freeze: signal permission checks
// are identical for SIGSTOP and SIGCONT, so every process we stopped can be resumed.
function resumeProcesses(entries) {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    try {
      if (processIdentity(entry.pid) !== entry.start) continue;
      try { process.kill(entry.pid, "SIGCONT"); } catch (error) {
        if (!error || (error.code !== "ESRCH" && error.code !== "EPERM")) throw error;
      }
    } catch (error) {
      if (error && error.code === "WORKSPACE_PROBE_BUDGET_EXHAUSTED") reportPendingProcesses(entries.slice(index));
      throw error;
    }
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
function parseLease(raw, expectedNonce, options = {}) {
  const lease = JSON.parse(raw);
  if (
    !lease ||
    lease.version !== 1 ||
    lease.nonce !== expectedNonce ||
    (lease.sharedHost !== undefined && typeof lease.sharedHost !== "boolean") ||
    !Array.isArray(lease.processes) ||
    lease.processes.length > 4096 ||
    lease.processes.some((entry) => !validProcessReference(entry)) ||
    (lease.watchdog !== null && !validProcessReference(lease.watchdog)) ||
    (lease.recoveryError !== undefined && typeof lease.recoveryError !== "string") ||
    !Number.isSafeInteger(lease.expiresAtMs) ||
    lease.expiresAtMs < 1
  ) {
    throw new Error(options.errorMessage || "invalid workspace quiescence lease");
  }
  // Retain the detached watchdog's terminal reason, but allow foreground recovery to retry.
  if (lease.recoveryError) process.stderr.write(lease.recoveryError + "\n");
  if (
    (options.requireWatchdog && lease.watchdog === null) ||
    (options.minimumRemainingMs && lease.expiresAtMs - Date.now() < options.minimumRemainingMs)
  ) {
    throw new Error(options.errorMessage || "invalid workspace quiescence lease");
  }
  return lease;
}
function parseWindowsLease(raw, nonce, options) {
  const lease = parseLease(raw, nonce, options);
  if (lease.sharedHost !== true || lease.processes.length !== 0 || lease.watchdog !== null) {
    throw new Error("invalid Windows shared-host workspace quiescence lease");
  }
  return lease;
}
function persistLease(targetPath, lease, verifyCurrent) {
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  if (verifyCurrent) verifyCurrent(JSON.parse(fs.readFileSync(targetPath, "utf8")));
  const temporary = targetPath + "." + process.pid + "." + crypto.randomBytes(8).toString("hex");
  fs.writeFileSync(temporary, JSON.stringify(lease), { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, targetPath);
}
function withWindowsWorkspaceLease(databasePath, workspaceKey, run) {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS workspace_leases (workspace_key TEXT PRIMARY KEY, lease_json TEXT NOT NULL); BEGIN IMMEDIATE");
  try {
    database
      .prepare("DELETE FROM workspace_leases WHERE json_extract(lease_json, '$.expiresAtMs') <= ?")
      .run(Date.now());
    const row = database
      .prepare("SELECT lease_json FROM workspace_leases WHERE workspace_key = ?")
      .get(workspaceKey);
    const next = run(row ? row.lease_json : null);
    if (next === null) {
      database.prepare("DELETE FROM workspace_leases WHERE workspace_key = ?").run(workspaceKey);
    } else if (next !== undefined) {
      database
        .prepare("INSERT INTO workspace_leases (workspace_key, lease_json) VALUES (?, ?) ON CONFLICT(workspace_key) DO UPDATE SET lease_json = excluded.lease_json")
        .run(workspaceKey, next);
    }
    database.exec("COMMIT");
    return next;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}`;

const REMOTE_QUIESCENCE_CONTROL_JS = String.raw`function freezeWorkspaceProcesses(input, frozen, refreshLease, initial = false) {
  let quietScans = 0;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const refresh = () => refreshLease([...frozen].map(([pid, start]) => ({ pid, start })));
  // Initial acquisition journals each candidate and counts its first quiet scan;
  // final renewal enrolls the whole scan and requires three subsequent quiet scans.
  for (let attempt = 0; attempt < 250 && quietScans < 3; attempt += 1) {
    const candidates = quiescenceCandidates(processes(), process.getuid(), new Set([input.watchdog.pid]), initial ? frozen : undefined);
    if (candidates.length + frozen.size > 4096) throw new Error("too many worker processes to quiesce safely");
    if (!initial) {
      for (const [pid, row] of candidates) frozen.set(pid, row.start);
      refresh();
    }
    for (const [pid, row] of candidates) {
      try {
        if (initial) { frozen.set(pid, row.start); refresh(); }
        else if (input.expiresAtMs - Date.now() < 5000) refresh();
        const start = initial ? processIdentity(pid) : processIdentity(pid, true)?.start;
        if (start !== row.start) {
          frozen.delete(pid);
          if (initial) refresh();
          continue;
        }
        if (!initial && input.expiresAtMs - Date.now() < 2500) refresh();
        process.kill(pid, "SIGSTOP");
      } catch (error) {
        if (!error || (error.code !== "ESRCH" && error.code !== "EPERM")) throw error;
        if (!initial || error.code === "EPERM") {
          frozen.delete(pid);
          if (initial) refresh();
        }
      }
    }
    if (!initial) refresh();
    Atomics.wait(sleeper, 0, 0, 20);
    const writable = quiescenceCandidates(processes(), process.getuid(), new Set([input.watchdog.pid])).length > 0;
    quietScans = writable || (!initial && candidates.length > 0) ? 0 : quietScans + 1;
  }
  if (quietScans < 3) throw new Error("worker processes did not " + (initial ? "reach" : "return to") + " a quiescent state");
}
function renewWorkspaceLease(timeoutMs, validationMode, isolationMode, watchdogReference) {
if (!/^[a-f0-9]{32}$/.test(nonce || "")) throw new Error("invalid workspace quiescence nonce");
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 * 1000) throw new Error("invalid watchdog timeout");
if (validationMode !== "heartbeat" && validationMode !== "final") throw new Error("invalid workspace quiescence validation mode");
if (isolationMode !== "dedicated" && isolationMode !== "shared-host") throw new Error("invalid workspace quiescence isolation mode");
const sharedHost = isolationMode === "shared-host";
if (process.platform === "win32" && sharedHost) {
  withWindowsWorkspaceLease(windowsLeaseDatabasePath, workspaceKey, (raw) => {
    if (raw === null) throw new Error("workspace quiescence lease is no longer active");
    const input = parseWindowsLease(raw, nonce, {
      minimumRemainingMs: 5000,
      errorMessage: "workspace quiescence lease is no longer active",
    });
    const renewed = { ...input, expiresAtMs: Date.now() + timeoutMs };
    return JSON.stringify(renewed);
  });
  return "renewed " + nonce + "\n";
}
if (typeof process.getuid !== "function") throw new Error("workspace quiescence requires POSIX");
const input = parseLease(fs.readFileSync(leasePath, "utf8"), nonce, {
  requireWatchdog: true,
  minimumRemainingMs: 5000,
  errorMessage: "workspace quiescence lease is no longer active",
});
if ((input.sharedHost === true) !== sharedHost) throw new Error("workspace quiescence isolation mode changed");
function assertWatchdogActive() {
  if (watchdogReference) {
    if (input.sharedHost !== true || input.processes.length !== 0 || input.watchdog.pid !== watchdogReference.pid || input.watchdog.start !== watchdogReference.start) {
      throw new Error("native quiescence lease changed its process scope or watchdog");
    }
    return;
  }
  const status = processIdentity(input.watchdog.pid, true);
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
  input.expiresAtMs = Date.now() + timeoutMs;
  // renewalQueue owns active leases; the watchdog records failures only after expiry.
  persistLease(leasePath, { ...input, processes }, (current) => {
    if (current.nonce !== nonce || current.watchdog?.pid !== input.watchdog.pid || current.watchdog?.start !== input.watchdog.start) {
      throw new Error("workspace quiescence lease changed during renewal");
    }
    if (current.expiresAtMs <= Date.now()) throw new Error("workspace quiescence lease expired during process probing");
  });
}
assertWatchdogActive();
for (const entry of input.processes) {
  const status = processIdentity(entry.pid, true);
  if (!status || status.start !== entry.start) continue;
  if (status.state && !status.state.startsWith("T")) throw new Error("workspace quiescence process resumed unexpectedly");
}
if (validationMode === "final" && !sharedHost) {
  refreshLease(input.processes);
  const frozen = new Map(input.processes.map((entry) => [entry.pid, entry.start]));
  // Reconnected control tunnels can introduce late processes before final acceptance.
  freezeWorkspaceProcesses(input, frozen, refreshLease);
  input.processes = [...frozen].map(([pid, start]) => ({ pid, start }));
}
refreshLease(input.processes);
const confirmed = JSON.parse(fs.readFileSync(leasePath, "utf8"));
if (confirmed.nonce !== nonce || confirmed.expiresAtMs !== input.expiresAtMs) {
  throw new Error("workspace quiescence renewal was not durable");
}
return "renewed " + nonce + "\n";
}
function resumeLeaseProcesses(input, ownedWatchdog, waitForExit = false) {
  // Thaw before retiring the last resumer; a bounded identity probe can still fail.
  resumeProcesses(input.processes);
  if (ownedWatchdog || input.watchdog === null) return;
  let matches;
  try { matches = processIdentity(input.watchdog.pid) === input.watchdog.start; } catch (error) {
    // An empty lease has nothing to strand, so ps cannot block its explicit release.
    if (waitForExit || input.processes.length > 0) throw error;
    return;
  }
  if (!matches) return;
  try { process.kill(input.watchdog.pid, "SIGTERM"); } catch (error) { if (!error || (error.code !== "ESRCH" && error.code !== "EPERM")) throw error; }
  if (!waitForExit) return;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100 && matches; attempt += 1) {
    Atomics.wait(sleeper, 0, 0, 10);
    matches = processIdentity(input.watchdog.pid) === input.watchdog.start;
  }
  if (matches) throw new Error("prior workspace quiescence watchdog did not retire");
}
function resumeWorkspaceLease(ownedWatchdog, watchdogReference) {
if (!/^[a-f0-9]{32}$/.test(nonce || "")) throw new Error("invalid workspace quiescence nonce");
if (process.platform === "win32") {
  withWindowsWorkspaceLease(windowsLeaseDatabasePath, workspaceKey, (raw) => {
    if (raw === null) return;
    parseWindowsLease(raw, nonce);
    return null;
  });
  return "";
}
if (typeof process.getuid !== "function") throw new Error("workspace quiescence requires POSIX");
let raw;
try { raw = fs.readFileSync(leasePath, "utf8"); } catch (error) {
  if (error && error.code === "ENOENT") return "";
  throw error;
}
const input = parseLease(raw, nonce);
if (ownedWatchdog && (input.sharedHost !== true || input.processes.length !== 0 ||
    (watchdogReference && (input.watchdog?.pid !== watchdogReference.pid || input.watchdog?.start !== watchdogReference.start)))) {
  throw new Error("native quiescence lease changed its process scope");
}
resumeLeaseProcesses(input, ownedWatchdog);
// The watchdog stays alive across the whole resume loop now, so it can win the unlink race.
// Everything is thawed either way; a missing lease must not fail the sync.
try { fs.unlinkSync(leasePath); } catch (error) { if (!error || error.code !== "ENOENT") throw error; }
return "";
}
`;

// Signal sites tolerate ESRCH (gone) without aborting the protocol. EPERM (exists but
// unsignalable, e.g. macOS SIP-protected same-uid processes on shared static-ssh dev hosts)
// must not crash cleanup/resume paths, but a freeze target that returns EPERM stays counted
// as live so quiescence fails closed instead of reporting a still-running process as frozen.
const REMOTE_WORKSPACE_QUIESCE_JS = String.raw`${REMOTE_QUIESCENCE_CONTEXT_JS}
const sleeper = new Int32Array(new SharedArrayBuffer(4));
fs.mkdirSync(leaseDirectory, { recursive: true, ...(process.platform === "win32" ? {} : { mode: 0o700 }) });
if (process.platform !== "win32") fs.chmodSync(leaseDirectory, 0o700);
const watchdogLifetime = process.argv[4] || "detached";
if (watchdogLifetime !== "detached" && watchdogLifetime !== "owned") throw new Error("invalid watchdog lifetime");
const ownedWatchdog = watchdogLifetime === "owned";
let nonce = ownedWatchdog ? process.argv[5] : crypto.randomBytes(16).toString("hex");
if (!/^[a-f0-9]{32}$/.test(nonce || "")) throw new Error("invalid workspace quiescence nonce");
let watchdogTimeoutMs = Number(process.argv[2] || 12 * 60 * 1000);
if (!Number.isSafeInteger(watchdogTimeoutMs) || watchdogTimeoutMs < 1) throw new Error("invalid watchdog timeout");
const isolationMode = process.argv[3] || "dedicated";
if (isolationMode !== "dedicated" && isolationMode !== "shared-host") throw new Error("invalid workspace quiescence isolation mode");
const sharedHost = isolationMode === "shared-host";
if (ownedWatchdog && !sharedHost) throw new Error("native quiescence requires a shared host");
let leasePath = path.join(leaseDirectory, workspaceKey + "." + nonce + ".json");
${REMOTE_QUIESCENCE_LEASE_JS}
${REMOTE_QUIESCENCE_PS_JS}
${REMOTE_QUIESCENCE_CONTROL_JS}
const frozen = new Map();
let watchdogReference = null;
function writeLease(processes = [...frozen].map(([pid, start]) => ({ pid, start }))) {
  persistLease(leasePath, {
    version: 1,
    nonce,
    sharedHost,
    processes,
    watchdog: watchdogReference,
    expiresAtMs: Date.now() + watchdogTimeoutMs,
  });
}
function acquireWorkspaceLease() {
if (process.platform === "win32" && sharedHost) {
  withWindowsWorkspaceLease(windowsLeaseDatabasePath, workspaceKey, (raw) => {
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (!/^[a-f0-9]{32}$/.test(parsed?.nonce || "")) {
        throw new Error("invalid Windows shared-host workspace quiescence lease");
      }
      const candidate = parseWindowsLease(raw, parsed.nonce);
      if (candidate.expiresAtMs > Date.now()) {
        throw new Error("workspace quiescence lease is already active");
      }
    }
    const lease = {
      version: 1,
      nonce,
      sharedHost: true,
      processes: [],
      watchdog: null,
      expiresAtMs: Date.now() + watchdogTimeoutMs,
    };
    return JSON.stringify(lease);
  });
  process.stderr.write("workspace quiescence: Windows shared host declared; using manifest fences without process freezing\n");
  return;
}
if (typeof process.getuid !== "function") throw new Error("workspace quiescence requires POSIX");
if (process.getuid() === 0) throw new Error("workspace quiescence refuses root-owned worker sessions");
processProbe = createProcessProbe();
const orphanNames = fs.readdirSync(leaseDirectory).filter((name) =>
  name.startsWith(workspaceKey + ".") && name.endsWith(".json"),
);
if (orphanNames.length > 16) throw new Error("too many workspace quiescence leases");
let sawUnverifiedEmptyLeaseWatchdog = false;
for (const name of orphanNames) {
  const match = name.match(/^[a-f0-9]{64}\.([a-f0-9]{32})\.json$/);
  if (!match) continue;
  const orphanPath = path.join(leaseDirectory, name);
  const lease = parseLease(fs.readFileSync(orphanPath, "utf8"), match[1]);
  if (ownedWatchdog) {
    if (lease.sharedHost !== true || lease.processes.length !== 0) {
      throw new Error("native quiescence cannot take over another process scope");
    }
    const prior = lease.watchdog && processIdentity(lease.watchdog.pid, true);
    if (prior && prior.start === lease.watchdog.start && !/^[ZX]/.test(prior.state)) {
      throw new Error("prior workspace quiescence watchdog is still active");
    }
    // A dead/reused reference cannot authorize a signal. Only its empty, stale lease is removed.
    try { fs.unlinkSync(orphanPath); } catch (error) { if (!error || error.code !== "ENOENT") throw error; }
    continue;
  }
  let retainLeaseForRetry = false;
  try {
    resumeLeaseProcesses(lease, false, true);
  } catch (error) {
    if (lease.processes.length > 0) throw error;
    sawUnverifiedEmptyLeaseWatchdog = true;
    retainLeaseForRetry = !sharedHost;
  }
  if (retainLeaseForRetry) continue;
  // The orphan's own watchdog can resume and unlink first; a lease that is already gone
  // is the outcome we wanted, so it must not fail this sweep.
  try { fs.unlinkSync(orphanPath); } catch (error) { if (!error || error.code !== "ENOENT") throw error; }
}
// Shared-host replacements can remove empty leases during a ps outage because they never sweep
// processes. Dedicated replacements retain the watchdog identity so a retry can exclude it.
if (!sharedHost && sawUnverifiedEmptyLeaseWatchdog) {
  throw new Error("could not verify prior workspace quiescence watchdog retirement; retry when ps is available");
}
writeLease();
const watchdog = ownedWatchdog ? { pid: process.pid } : childProcess.spawn(
  process.execPath,
  ["-e", createProcessProbe.toString() + "\nlet processProbe;\n" + persistLease.toString() + "\n" + reportPendingProcesses.toString() + "\n" + processIdentity.toString() + "\n(" + watchdogMain.toString() + ")(process.argv[1], process.argv[2])", leasePath, nonce],
  { detached: true, stdio: "ignore" },
);
if (!ownedWatchdog) watchdog.unref();
if (!Number.isSafeInteger(watchdog.pid) || watchdog.pid < 1) {
  fs.unlinkSync(leasePath);
  throw new Error("workspace quiescence watchdog did not start");
}
let watchdogStart = ownedWatchdog ? watchdogReference?.start : null;
try {
  for (let attempt = 0; attempt < 100 && !watchdogStart; attempt += 1) {
    watchdogStart = processIdentity(watchdog.pid);
    if (!watchdogStart) Atomics.wait(sleeper, 0, 0, 10);
  }
  if (!watchdogStart) {
    throw new Error("workspace quiescence watchdog identity was not observable");
  }
  watchdogReference = { pid: watchdog.pid, start: watchdogStart };
  writeLease();
} catch (error) {
  try { if (!ownedWatchdog) process.kill(watchdog.pid, "SIGTERM"); } catch (killError) { if (!killError || (killError.code !== "ESRCH" && killError.code !== "EPERM")) throw killError; }
  try { fs.unlinkSync(leasePath); } catch (unlinkError) { if (!unlinkError || unlinkError.code !== "ENOENT") throw unlinkError; }
  throw error;
}
try {
  if (sharedHost) {
    // Shared hosts use manifest fences because this lease does not own every uid process.
    process.stderr.write("workspace quiescence: shared host declared; skipping process freeze sweep\n");
  } else {
    freezeWorkspaceProcesses({ watchdog: watchdogReference }, frozen, writeLease, true);
  }
} catch (error) {
  // Thaw before retiring the watchdog: a bounded identity probe can throw here, and
  // retiring first would leave a stopped worker with no remaining resumer.
  resumeProcesses([...frozen].map(([pid, start]) => ({ pid, start })));
  if (processIdentity(watchdog.pid) === watchdogStart) {
    try { if (!ownedWatchdog) process.kill(watchdog.pid, "SIGTERM"); } catch (killError) { if (!killError || (killError.code !== "ESRCH" && killError.code !== "EPERM")) throw killError; }
  }
  try { fs.unlinkSync(leasePath); } catch (unlinkError) { if (!unlinkError || unlinkError.code !== "ENOENT") throw unlinkError; }
  throw error;
}
}
acquireWorkspaceLease();
function watchdogMain(watchedLeasePath, watchedNonce) {
  let retryDelayMs = 1000;
  // Four 30s passes plus 1+2+4s backoff allow slow hosts 127s of recovery work.
  // A total cap prevents endless fresh budgets from silently leaving workers stopped.
  let failedPasses = 0;
  // Keep unfinished references across exhausted passes: replaying a resumed prefix
  // can consume every budget and leave later workers stopped forever.
  let remainingProcesses;
  const check = () => {
    const watchdogFs = require("node:fs");
    let canResume;
    try {
      const lease = JSON.parse(watchdogFs.readFileSync(watchedLeasePath, "utf8"));
      if (
        !lease ||
        lease.version !== 1 ||
        lease.nonce !== watchedNonce ||
        !Array.isArray(lease.processes) ||
        !Number.isSafeInteger(lease.expiresAtMs)
      ) { return; }
      const remainingMs = lease.expiresAtMs - Date.now();
      if (remainingMs > 0) {
        remainingProcesses = undefined;
        processProbe = undefined;
        failedPasses = 0;
        retryDelayMs = 1000;
        setTimeout(check, Math.min(remainingMs, 60 * 1000));
        return;
      }
      // A renewal during a slow probe must win before either thaw or lease removal.
      canResume = () => {
        const current = JSON.parse(watchdogFs.readFileSync(watchedLeasePath, "utf8"));
        if (!current || current.version !== 1 || current.nonce !== watchedNonce || !Array.isArray(current.processes) || !Number.isSafeInteger(current.expiresAtMs)) return false;
        const remaining = current.expiresAtMs - Date.now();
        if (remaining <= 0) return current;
        remainingProcesses = undefined;
        processProbe = undefined;
        failedPasses = 0;
        retryDelayMs = 1000;
        setTimeout(check, Math.min(remaining, 60 * 1000));
        return false;
      };
      if (!canResume()) return;
      processProbe ??= createProcessProbe();
      remainingProcesses ??= lease.processes;
      while (remainingProcesses.length > 0) {
        const entry = remainingProcesses[0];
        if (
          !entry ||
          !Number.isSafeInteger(entry.pid) ||
          entry.pid < 1 ||
          typeof entry.start !== "string"
        ) { remainingProcesses.shift(); continue; }
        const start = processIdentity(entry.pid);
        if (!canResume()) return;
        if (start === entry.start) {
          try { process.kill(entry.pid, "SIGCONT"); } catch (error) { if (!error || (error.code !== "ESRCH" && error.code !== "EPERM")) throw error; }
        }
        remainingProcesses.shift();
      }
      if (canResume()) watchdogFs.unlinkSync(watchedLeasePath);
    } catch (error) {
      // A missing ps also throws ENOENT; only a missing lease means someone else finished.
      if (error && error.code === "ENOENT" && error.path === watchedLeasePath) { return; }
      // An unreadable lease is terminal: the pids to resume live in that file, so retrying
      // cannot recover them and would leave this detached process alive forever.
      if (error instanceof SyntaxError) { return; }
      const current = canResume?.();
      if (canResume && !current) return;
      failedPasses += 1;
      if (failedPasses >= 4) {
        if (!current || current.watchdog?.pid !== process.pid) throw error;
        const unfinished = remainingProcesses ?? current.processes;
        persistLease(watchedLeasePath, {
          ...current, processes: unfinished, recoveryError: reportPendingProcesses(unfinished, true),
        });
        process.exitCode = 1;
        return;
      }
      if (error && error.code === "WORKSPACE_PROBE_BUDGET_EXHAUSTED") {
        reportPendingProcesses(remainingProcesses);
        processProbe = undefined;
      }
      // Retry only unfinished work; terminal exhaustion remains available to Gateway callers.
      setTimeout(check, retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, 60000);
    }
  };
  check();
}
if (ownedWatchdog) {
  let active = true;
  let expiry;
  const scheduleExpiry = () => {
    clearTimeout(expiry);
    expiry = setTimeout(() => {
      resumeWorkspaceLease(true, watchdogReference);
      active = false;
      if (process.connected) process.send({ type: "workspace-quiescence-retired", nonce });
    }, watchdogTimeoutMs);
  };
  process.on("message", (message) => {
    if (message?.type === "workspace-quiescence-retire" && message.nonce === nonce && !active) process.exit(0);
    if (message?.type !== "workspace-quiescence-control") return;
    const { action } = message;
    let failure;
    try {
      if (action === "acquire" && !active) {
        if (!/^[a-f0-9]{32}$/.test(message.nonce || "") || !Number.isSafeInteger(message.timeoutMs) || message.timeoutMs < 1) throw new Error("invalid workspace quiescence acquisition");
        nonce = message.nonce;
        watchdogTimeoutMs = message.timeoutMs;
        leasePath = path.join(leaseDirectory, workspaceKey + "." + nonce + ".json");
        active = true;
        acquireWorkspaceLease();
      } else if (message.nonce !== nonce || !active) {
        throw new Error("workspace quiescence lease is no longer active");
      } else if (action === "renew") {
        renewWorkspaceLease(message.timeoutMs, message.validationMode, "shared-host", watchdogReference);
        watchdogTimeoutMs = message.timeoutMs;
      } else if (action === "release") {
        resumeWorkspaceLease(true, watchdogReference);
        active = false;
        clearTimeout(expiry);
      } else {
        throw new Error("workspace quiescence lease is already active");
      }
      if (active) scheduleExpiry();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    process.send({ type: "workspace-quiescence-result", id: message.id, nonce: message.nonce, action, ...(failure !== undefined ? { error: failure } : {}) });
  });
  process.send({ type: "workspace-quiescence-result", nonce, action: "acquire" });
  scheduleExpiry();
} else {
  process.stdout.write("quiesced " + nonce + "\n");
}
`;

const REMOTE_QUIESCENCE_CONTROL_CONTEXT_JS = String.raw`${REMOTE_QUIESCENCE_CONTEXT_JS}
const nonce = process.argv[2];
const leasePath = path.join(leaseDirectory, workspaceKey + "." + nonce + ".json");
${REMOTE_QUIESCENCE_LEASE_JS}
${REMOTE_QUIESCENCE_PS_JS}
${REMOTE_QUIESCENCE_CONTROL_JS}`;

const REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS = String.raw`${REMOTE_QUIESCENCE_CONTROL_CONTEXT_JS}
process.stdout.write(renewWorkspaceLease(Number(process.argv[3] || 12 * 60 * 1000), process.argv[4] || "final", process.argv[5] || "dedicated"));
`;

const REMOTE_WORKSPACE_RESUME_JS = String.raw`${REMOTE_QUIESCENCE_CONTROL_CONTEXT_JS}
process.stdout.write(resumeWorkspaceLease(process.argv[3] === "owned"));
`;

export function workspaceQuiescenceArgv(
  root: string,
  operation: NodeWorkerWorkspaceQuiescenceInput,
  hostMode: "shared-host" | "dedicated",
  watchdogLifetime?: "owned",
): string[] {
  const scripts = {
    acquire: REMOTE_WORKSPACE_QUIESCE_JS,
    renew: REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
    release: REMOTE_WORKSPACE_RESUME_JS,
  };
  const args =
    operation.action === "acquire"
      ? [String(operation.timeoutMs), hostMode]
      : operation.action === "renew"
        ? [operation.nonce, String(operation.timeoutMs), operation.validationMode, hostMode]
        : [operation.nonce];
  if (watchdogLifetime && operation.action !== "renew") {
    args.push(watchdogLifetime, ...(operation.action === "acquire" ? [operation.nonce] : []));
  }
  return ["node", "-e", scripts[operation.action], root, ...args];
}
