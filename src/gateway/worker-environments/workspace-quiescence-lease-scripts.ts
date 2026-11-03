import type { NodeWorkerWorkspaceQuiescenceInput } from "../../worker/node-workspace-protocol.js";

export const REMOTE_QUIESCENCE_CONTEXT_JS = String.raw`const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.realpathSync(process.argv[1]);
const workspaceKey = crypto.createHash("sha256").update(root).digest("hex");
const leaseDirectory = path.join(os.homedir(), ".openclaw-worker", "quiescence");
const windowsLeaseDatabasePath = path.join(leaseDirectory, "windows-shared-host.sqlite");`;

export const REMOTE_QUIESCENCE_LEASE_JS = String.raw`function validProcessReference(value) {
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
  try {
    database.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_leases'").get()) {
      database.exec("CREATE TABLE IF NOT EXISTS workspace_leases (workspace_key TEXT PRIMARY KEY, lease_json TEXT NOT NULL)");
    }
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
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}`;

export const REMOTE_WINDOWS_ACQUIRE_WORKSPACE_LEASE_JS = String.raw`function acquireWindowsWorkspaceLease(nonce, watchdogTimeoutMs) {
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
}`;

const REMOTE_WINDOWS_WORKSPACE_QUIESCE_JS = String.raw`(() => {
${REMOTE_QUIESCENCE_CONTEXT_JS}
fs.mkdirSync(leaseDirectory, { recursive: true });
const nonce = crypto.randomBytes(16).toString("hex");
let watchdogTimeoutMs = Number(process.argv[2] || 12 * 60 * 1000);
if (!Number.isSafeInteger(watchdogTimeoutMs) || watchdogTimeoutMs < 1) throw new Error("invalid watchdog timeout");
if ((process.argv[3] || "dedicated") !== "shared-host") throw new Error("workspace quiescence requires POSIX");
${REMOTE_QUIESCENCE_LEASE_JS}
${REMOTE_WINDOWS_ACQUIRE_WORKSPACE_LEASE_JS}
acquireWindowsWorkspaceLease(nonce, watchdogTimeoutMs);
process.stdout.write("quiesced " + nonce + "\n");
})();
`;

export function legacyWindowsWorkspaceQuiescenceAcquireArgv(
  root: string,
  operation: Extract<NodeWorkerWorkspaceQuiescenceInput, { action: "acquire" }>,
  hostMode: "shared-host" | "dedicated",
): string[] {
  // The full acquire program exceeds the Windows command-line limit through node -e.
  return [
    "node",
    "-e",
    REMOTE_WINDOWS_WORKSPACE_QUIESCE_JS,
    root,
    String(operation.timeoutMs),
    hostMode,
  ];
}
