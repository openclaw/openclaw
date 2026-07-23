export const REMOTE_WATCHDOG_PROCESS_PROBE_TIMEOUT_MS = 1_000;
export const REMOTE_WATCHDOG_PROCESS_RECOVERY_TIMEOUT_MS = 5_000;
const REMOTE_QUIESCENCE_LEASE_LOCK_TIMEOUT_MS = 7_000;
export const REMOTE_QUIESCENCE_PROCESS_PROBE_CONCURRENCY = 8;

export const REMOTE_QUIESCENCE_PS_JS = String.raw`function processes() {
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
      settled = true; child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); try { child.kill("SIGKILL"); } catch {} resolve({ kind: "timeout" });
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
    else if (outcomes[index].kind === "timeout" || outcomes[index].kind === "failed") timedOut.push(references[index]);
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
    await new Promise((resolve) => setTimeout(resolve, Math.min(${REMOTE_WATCHDOG_PROCESS_PROBE_TIMEOUT_MS}, deadlineMs - Date.now())));
  }
  return { remaining, failed };
}
function processStatus(pid) {
  try {
    const output = childProcess.execFileSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 4096, timeout: 2000, killSignal: "SIGKILL" }).trim();
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

export const REMOTE_QUIESCENCE_LEASE_JS = String.raw`function validProcessReference(value) {
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
function leaseMutationOwnerTitle(token) {
  return "openclaw-qlease-" + token;
}
function leaseMutationOwnerCommand(pid) {
  try {
    const command = childProcess.execFileSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 4096, timeout: 2000, killSignal: "SIGKILL" }).trim();
    return command || null;
  } catch (error) {
    if (error && error.status === 1) return null;
    throw error;
  }
}
function leaseMutationOwnerDefinitelyStale(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
  let command;
  try { command = leaseMutationOwnerCommand(owner.pid); } catch { return false; }
  return command === null || command !== leaseMutationOwnerTitle(owner.token);
}
// The random owner token is published in both ps-visible process identity and the atomic entry.
function leaseMutationOwnerName(owner) {
  return "owner." + owner.pid + "." + owner.token;
}
function parseLeaseMutationOwnerName(name) {
  const match = /^owner\.(\d+)\.([a-f0-9]{32})$/.exec(name);
  if (!match) return null;
  const owner = { pid: Number(match[1]), token: match[2] };
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
  const ownerName = leaseMutationOwnerName(owner);
  const previousTitle = process.title;
  const ownerTitle = leaseMutationOwnerTitle(token);
  process.title = ownerTitle;
  if (process.title !== ownerTitle) {
    process.title = previousTitle;
    throw new Error("workspace quiescence lease mutation owner token was not publishable");
  }
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadlineMs = Date.now() + timeoutMs;
  let contentionDelayMs = 10;
  try {
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
            return { lockPath, ownerName, previousTitle };
          }
        } finally {
          if (!acquired) removeLeaseMutationOwner(lockPath, ownerName);
        }
      } catch (error) {
        if (!error || (error.code !== "EEXIST" && error.code !== "ENOENT")) throw error;
      }
      if (clearStaleLeaseMutation(lockPath)) continue;
      if (Date.now() >= deadlineMs) throw leaseMutationTimeout();
      Atomics.wait(sleeper, 0, 0, contentionDelayMs);
      contentionDelayMs = Math.min(contentionDelayMs * 2, 100);
    }
  } catch (error) {
    process.title = previousTitle;
    throw error;
  }
}
function releaseLeaseMutation(mutation) {
  try { removeLeaseMutationOwner(mutation.lockPath, mutation.ownerName); } finally { process.title = mutation.previousTitle; }
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
