// Manages exec approval policy, allowlist entries, and host targeting.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { hasTopLevelShellControlOperator, splitShellArgs } from "../utils/shell-argv.js";
import type { CommandExplanationSummary } from "./command-analysis/explain.js";
import { resolveCarrierCommandArgv } from "./command-carriers.js";
import { sha256Hex, sha256HexPrefix } from "./crypto-digest.js";
import {
  canonicalizeExecApprovalPolicyRules,
  type ExecApprovalPolicySnapshot,
} from "./exec-approval-policy-snapshot.js";
import {
  type AllowAlwaysPattern,
  resolveAllowAlwaysPatternEntries,
} from "./exec-approvals-allowlist.js";
import type { ExecCommandSegment } from "./exec-approvals-analysis.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";
import type { ExecAuthorizationPlan } from "./exec-authorization-plan.js";
import {
  extractBindableShellWrapperInlineCommand,
  isShellWrapperInvocation,
  unwrapKnownDispatchWrapperInvocation,
} from "./exec-wrapper-resolution.js";
import { withFileLock } from "./file-lock.js";
import { assertNoSymlinkParentsSync } from "./fs-safe-advanced.js";
import { expandHomePrefix, resolveHomeRelativePath, resolveRequiredHomeDir } from "./home-dir.js";
import { requestJsonlSocket } from "./jsonl-socket.js";
import { isPlainObject } from "./plain-object.js";
import {
  hasPosixInteractiveStartupBeforeInlineCommand,
  hasPosixLoginStartupBeforeInlineCommand,
  POSIX_INLINE_COMMAND_FLAGS,
} from "./shell-inline-command.js";
import { extractShellWrapperInlineCommand } from "./shell-wrapper-resolution.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";
export * from "./exec-approvals-analysis.js";
export * from "./exec-approvals-allowlist.js";
export type { ExecApprovalPolicySnapshot } from "./exec-approval-policy-snapshot.js";
export type { ExecAllowlistEntry } from "./exec-approvals.types.js";

export type ExecHost = "sandbox" | "gateway" | "node";
export type ExecTarget = "auto" | ExecHost;
export type ExecSecurity = "deny" | "allowlist" | "full";
export type ExecAsk = "off" | "on-miss" | "always";
export type ExecMode = "deny" | "allowlist" | "ask" | "auto" | "full";

export const EXEC_TARGET_VALUES: readonly ExecTarget[] = ["auto", "sandbox", "gateway", "node"];

export function normalizeExecHost(value?: string | null): ExecHost | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "sandbox" || normalized === "gateway" || normalized === "node") {
    return normalized;
  }
  return null;
}

export function normalizeExecTarget(value?: string | null): ExecTarget | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "auto") {
    return normalized;
  }
  return normalizeExecHost(normalized);
}

export function requireValidExecTarget(value?: unknown): ExecTarget | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(
      `Invalid exec host value type ${typeof value}. Allowed values: ${EXEC_TARGET_VALUES.join(
        ", ",
      )}.`,
    );
  }
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return null;
  }
  const target = normalizeExecTarget(normalized);
  if (target) {
    return target;
  }
  throw new Error(
    `Invalid exec host "${value}". Allowed values: ${EXEC_TARGET_VALUES.join(", ")}.`,
  );
}

/** Coerce a raw JSON field to string, returning undefined for non-string types. */
const toStringOrUndefined = readStringValue;

export function normalizeExecSecurity(value?: string | null): ExecSecurity | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return null;
}

export function normalizeExecAsk(value?: string | null): ExecAsk | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized;
  }
  return null;
}

export function normalizeExecMode(value?: string | null): ExecMode | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (
    normalized === "deny" ||
    normalized === "allowlist" ||
    normalized === "ask" ||
    normalized === "auto" ||
    normalized === "full"
  ) {
    return normalized;
  }
  return null;
}

export function resolveExecModeFromPolicy(params: {
  security: ExecSecurity;
  ask: ExecAsk;
}): ExecMode {
  if (params.security === "deny") {
    return "deny";
  }
  if (params.security === "allowlist" && params.ask === "off") {
    return "allowlist";
  }
  if (params.security === "full" && params.ask !== "always") {
    return "full";
  }
  return "ask";
}

export function resolveExecPolicyForMode(mode: ExecMode): {
  security: ExecSecurity;
  ask: ExecAsk;
  autoReview: boolean;
} {
  switch (mode) {
    case "deny":
      return { security: "deny", ask: "off", autoReview: false };
    case "allowlist":
      return { security: "allowlist", ask: "off", autoReview: false };
    case "ask":
      return { security: "allowlist", ask: "on-miss", autoReview: false };
    case "auto":
      return { security: "allowlist", ask: "on-miss", autoReview: true };
    case "full":
      return { security: "full", ask: "off", autoReview: false };
  }
  const exhaustiveMode: never = mode;
  throw new Error(`Unsupported exec mode: ${String(exhaustiveMode)}`);
}

export function resolveExecModePolicy(params: {
  mode?: ExecMode | null;
  security: ExecSecurity;
  ask: ExecAsk;
}): {
  mode: ExecMode;
  security: ExecSecurity;
  ask: ExecAsk;
  autoReview: boolean;
} {
  if (!params.mode) {
    return {
      mode: resolveExecModeFromPolicy({ security: params.security, ask: params.ask }),
      security: params.security,
      ask: params.ask,
      autoReview: false,
    };
  }
  return {
    mode: params.mode,
    ...resolveExecPolicyForMode(params.mode),
  };
}

export type SystemRunApprovalBinding = {
  argv: string[];
  cwd: string | null;
  agentId: string | null;
  sessionKey: string | null;
  envHash: string | null;
};

export type SystemRunApprovalFileOperand = {
  argvIndex: number;
  path: string;
  sha256: string;
};

export type SystemRunApprovalPlan = {
  argv: string[];
  cwd: string | null;
  commandText: string;
  commandPreview?: string | null;
  agentId: string | null;
  sessionKey: string | null;
  policySnapshot?: ExecApprovalPolicySnapshot;
  mutableFileOperand?: SystemRunApprovalFileOperand | null;
};

export type ExecApprovalCommandSpan = {
  startIndex: number;
  endIndex: number;
};

export type ExecApprovalRequestPayload = {
  command: string;
  commandPreview?: string | null;
  commandArgv?: string[];
  // Optional UI-safe env key preview for approval prompts.
  envKeys?: string[];
  systemRunBinding?: SystemRunApprovalBinding | null;
  systemRunPlan?: SystemRunApprovalPlan | null;
  cwd?: string | null;
  nodeId?: string | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  warningText?: string | null;
  commandAnalysis?: CommandExplanationSummary | null;
  commandSpans?: ExecApprovalCommandSpan[];
  unavailableDecisions?: readonly ExecApprovalUnavailableDecision[];
  allowedDecisions?: readonly ExecApprovalDecision[];
  agentId?: string | null;
  resolvedPath?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  toolCallId?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};

export type ExecApprovalRequest = {
  id: string;
  request: ExecApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

export type ExecApprovalResolved = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
  request?: ExecApprovalRequest["request"];
};

export type ExecApprovalsDefaults = {
  security?: ExecSecurity;
  ask?: ExecAsk;
  askFallback?: ExecSecurity;
  autoAllowSkills?: boolean;
};

export type ExecApprovalsAgent = ExecApprovalsDefaults & {
  allowlist?: ExecAllowlistEntry[];
};

export type ExecApprovalsFile = {
  version: 1;
  socket?: {
    path?: string;
    token?: string;
  };
  defaults?: ExecApprovalsDefaults;
  agents?: Record<string, ExecApprovalsAgent>;
};

export type ExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  file: ExecApprovalsFile;
  hash: string;
};

export type ExecApprovalsResolved = {
  path: string;
  socketPath: string;
  token: string;
  defaults: Required<ExecApprovalsDefaults>;
  agent: Required<ExecApprovalsDefaults>;
  agentSources: {
    security: string | null;
    ask: string | null;
    askFallback: string | null;
  };
  allowlist: ExecAllowlistEntry[];
  file: ExecApprovalsFile;
};

// Keep CLI + gateway defaults in sync.
export const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 1_800_000;

const DEFAULT_SECURITY: ExecSecurity = "full";
const DEFAULT_ASK: ExecAsk = "off";
export const DEFAULT_EXEC_APPROVAL_ASK_FALLBACK: ExecSecurity = "deny";
const DEFAULT_AUTO_ALLOW_SKILLS = false;
const DEFAULT_EXEC_APPROVALS_STATE_DIR = "~/.openclaw";
const EXEC_APPROVALS_FILE = "exec-approvals.json";
const EXEC_APPROVALS_SOCKET = "exec-approvals.sock";
const EXEC_APPROVALS_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 25,
    maxTimeout: 500,
    randomize: true,
  },
  stale: 30_000,
  // Approval policy is an authorization boundary. A pathname recheck followed
  // by stale-lock unlink cannot prove that a fresh owner was not substituted.
  staleRecovery: "fail-closed",
} as const;
const EXEC_APPROVALS_LOCK_QUEUE = resolveGlobalMap<string, Promise<unknown>>(
  Symbol.for("openclaw.execApprovalsLockQueue"),
);
let execApprovalsProcessStartTime: number | null | undefined;

function getExecApprovalsProcessStartTime(): number | null {
  if (execApprovalsProcessStartTime === undefined) {
    execApprovalsProcessStartTime = getFileLockProcessStartTime(process.pid);
  }
  return execApprovalsProcessStartTime;
}
const EXEC_APPROVALS_SYNC_LOCK_RETRIES = 10;
const EXEC_APPROVALS_SYNC_LOCK_RETRY_MS = 20;

function hashExecApprovalsRaw(raw: string | null): string {
  // Preserve existing hashes for present files so mixed-version native/CLI
  // clients can still compare snapshots; only missing needs its own domain.
  return raw === null ? `missing:${sha256Hex("")}` : sha256Hex(raw);
}

function hashExecApprovalsFile(file: ExecApprovalsFile): string {
  return hashExecApprovalsRaw(`${JSON.stringify(file, null, 2)}\n`);
}

function isExecApprovalsTargetMissing(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw err;
  }
}

function isExecApprovalsLockMissing(filePath: string): boolean {
  try {
    const dir = fs.realpathSync(path.dirname(filePath));
    return isExecApprovalsTargetMissing(`${path.join(dir, path.basename(filePath))}.lock`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw err;
  }
}

function resolveExecApprovalsStateDir(env: NodeJS.ProcessEnv = process.env): {
  path: string;
  displayPath: string;
} {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    const resolved = resolveHomeRelativePath(override, { env });
    return {
      path: resolved,
      displayPath: resolved,
    };
  }
  return {
    path: expandHomePrefix(DEFAULT_EXEC_APPROVALS_STATE_DIR, { env }),
    displayPath: DEFAULT_EXEC_APPROVALS_STATE_DIR,
  };
}

export function resolveExecApprovalsPath(): string {
  return path.join(resolveExecApprovalsStateDir().path, EXEC_APPROVALS_FILE);
}

export function resolveExecApprovalsSocketPath(): string {
  return path.join(resolveExecApprovalsStateDir().path, EXEC_APPROVALS_SOCKET);
}

export function resolveExecApprovalsDisplayPath(): string {
  const stateDir = resolveExecApprovalsStateDir().displayPath;
  return stateDir === DEFAULT_EXEC_APPROVALS_STATE_DIR
    ? `${stateDir}/${EXEC_APPROVALS_FILE}`
    : path.join(stateDir, EXEC_APPROVALS_FILE);
}

export function resolveExecApprovalsTranscriptPath(): string {
  return process.env.OPENCLAW_STATE_DIR?.trim()
    ? `$OPENCLAW_STATE_DIR/${EXEC_APPROVALS_FILE}`
    : `${DEFAULT_EXEC_APPROVALS_STATE_DIR}/${EXEC_APPROVALS_FILE}`;
}

function createFailClosedExecApprovalsFallback(): ExecApprovalsFile {
  return normalizeExecApprovals({
    version: 1,
    defaults: {
      security: "deny",
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    agents: {},
  });
}

function hasValidExecApprovalPolicyFields(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    return false;
  }
  return (
    (value.security === undefined || isExecSecurity(value.security)) &&
    (value.ask === undefined || isExecAsk(value.ask)) &&
    (value.askFallback === undefined || isExecSecurity(value.askFallback)) &&
    (value.autoAllowSkills === undefined || typeof value.autoAllowSkills === "boolean")
  );
}

function isValidPersistedExecAllowlistEntry(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (!isPlainObject(value) || typeof value.pattern !== "string" || !value.pattern.trim()) {
    return false;
  }
  return (
    (value.id === undefined || typeof value.id === "string") &&
    (value.source === undefined || typeof value.source === "string") &&
    (value.commandText === undefined || typeof value.commandText === "string") &&
    (value.argPattern === undefined || typeof value.argPattern === "string") &&
    (value.lastUsedAt === undefined ||
      (typeof value.lastUsedAt === "number" && Number.isFinite(value.lastUsedAt))) &&
    (value.lastUsedCommand === undefined || typeof value.lastUsedCommand === "string") &&
    (value.lastResolvedPath === undefined || typeof value.lastResolvedPath === "string")
  );
}

function isValidPersistedExecApprovals(value: unknown): value is ExecApprovalsFile {
  if (!isPlainObject(value) || value.version !== 1) {
    return false;
  }
  if (value.socket !== undefined) {
    if (
      !isPlainObject(value.socket) ||
      (value.socket.path !== undefined && typeof value.socket.path !== "string") ||
      (value.socket.token !== undefined && typeof value.socket.token !== "string")
    ) {
      return false;
    }
  }
  if (value.defaults !== undefined && !hasValidExecApprovalPolicyFields(value.defaults)) {
    return false;
  }
  if (value.agents !== undefined) {
    if (!isPlainObject(value.agents)) {
      return false;
    }
    for (const agent of Object.values(value.agents)) {
      if (
        !hasValidExecApprovalPolicyFields(agent) ||
        (agent.allowlist !== undefined &&
          (!Array.isArray(agent.allowlist) ||
            !agent.allowlist.every(isValidPersistedExecAllowlistEntry)))
      ) {
        return false;
      }
    }
  }
  return true;
}

function parsePersistedExecApprovals(raw: string): ExecApprovalsFile {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isValidPersistedExecApprovals(parsed)) {
      return normalizeExecApprovals(parsed);
    }
  } catch {
    // A partial Windows fallback write is existing state, not a missing policy.
  }
  // Never let malformed persisted state inherit permissive product defaults.
  return createFailClosedExecApprovalsFallback();
}

function normalizeAllowlistPattern(value: string | undefined): string | null {
  const trimmed = normalizeOptionalString(value) ?? "";
  return trimmed ? normalizeLowercaseStringOrEmpty(trimmed) : null;
}

function mergeLegacyAgent(
  current: ExecApprovalsAgent,
  legacy: ExecApprovalsAgent,
): ExecApprovalsAgent {
  const allowlist: ExecAllowlistEntry[] = [];
  const seen = new Set<string>();
  const pushEntry = (entry: ExecAllowlistEntry) => {
    const patternKey = normalizeAllowlistPattern(entry.pattern);
    if (!patternKey) {
      return;
    }
    const key = `${patternKey}\x00${entry.argPattern?.trim() ?? ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    allowlist.push(entry);
  };
  for (const entry of current.allowlist ?? []) {
    pushEntry(entry);
  }
  for (const entry of legacy.allowlist ?? []) {
    pushEntry(entry);
  }

  return {
    security: current.security ?? legacy.security,
    ask: current.ask ?? legacy.ask,
    askFallback: current.askFallback ?? legacy.askFallback,
    autoAllowSkills: current.autoAllowSkills ?? legacy.autoAllowSkills,
    allowlist: allowlist.length > 0 ? allowlist : undefined,
  };
}

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  assertNoExecApprovalsSymlinkParents(dir, resolveRequiredHomeDir());
  fs.mkdirSync(dir, { recursive: true });
  const dirStat = fs.lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error(`Refusing to use unsafe exec approvals directory: ${dir}`);
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    if (process.platform !== "win32") {
      throw err;
    }
  }
  return dir;
}

function resolveCanonicalExecApprovalsTarget(filePath: string): string {
  const dir = ensureDir(filePath);
  return path.join(fs.realpathSync(dir), path.basename(filePath));
}

function assertNoExecApprovalsSymlinkParents(targetPath: string, trustedRoot: string): void {
  try {
    assertNoSymlinkParentsSync({
      rootDir: trustedRoot,
      targetPath,
      allowOutsideRoot: true,
      messagePrefix: "Refusing to traverse symlink in exec approvals path",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UnsafeExecApprovalsPathError(message, { cause: err });
  }
}

class UnsafeExecApprovalsPathError extends Error {}

function assertSafeExecApprovalsStat(filePath: string, stat: fs.Stats): void {
  if (stat.isSymbolicLink()) {
    throw new UnsafeExecApprovalsPathError(
      `Refusing to write exec approvals via symlink: ${filePath}`,
    );
  }
  if (!stat.isFile()) {
    throw new UnsafeExecApprovalsPathError(
      `Refusing to use non-file exec approvals path: ${filePath}`,
    );
  }
}

function assertSafeExecApprovalsDestination(filePath: string): void {
  try {
    assertSafeExecApprovalsStat(filePath, fs.lstatSync(filePath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

function assertSafeExecApprovalsOverwriteFallback(filePath: string): void {
  assertSafeExecApprovalsDestination(filePath);
  try {
    const stat = fs.statSync(filePath);
    if (stat.nlink > 1) {
      throw new Error(`Refusing copy fallback for hard-linked exec approvals file: ${filePath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

type ExecApprovalsFallbackDestination = {
  existed: boolean;
  fd: number;
  snapshot: Buffer | null;
};

function sameFilesystemEntry(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

type ExecApprovalsRawState = { exists: false; raw: null } | { exists: true; raw: string };

function readExecApprovalsRawState(filePath: string): ExecApprovalsRawState {
  assertNoExecApprovalsSymlinkParents(path.dirname(filePath), resolveRequiredHomeDir());
  // Anchor policy bytes to one inode; otherwise a path swap can make the CAS
  // hash describe a different file than the guarded approvals destination.
  let before: fs.Stats;
  try {
    before = fs.lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, raw: null };
    }
    throw err;
  }
  assertSafeExecApprovalsStat(filePath, before);

  const noFollowFlag = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new UnsafeExecApprovalsPathError(
        `Refusing to read changed exec approvals path: ${filePath}`,
        { cause: err },
      );
    }
    if (code === "ELOOP") {
      throw new UnsafeExecApprovalsPathError(
        `Refusing to write exec approvals via symlink: ${filePath}`,
        { cause: err },
      );
    }
    throw err;
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameFilesystemEntry(before, opened)) {
      throw new UnsafeExecApprovalsPathError(
        `Refusing to read changed exec approvals path: ${filePath}`,
      );
    }
    const raw = fs.readFileSync(fd, "utf8");
    let after: fs.Stats;
    try {
      after = fs.lstatSync(filePath);
    } catch (err) {
      throw new UnsafeExecApprovalsPathError(
        `Refusing to read changed exec approvals path: ${filePath}`,
        { cause: err },
      );
    }
    assertSafeExecApprovalsStat(filePath, after);
    if (!sameFilesystemEntry(opened, after)) {
      throw new UnsafeExecApprovalsPathError(
        `Refusing to read changed exec approvals path: ${filePath}`,
      );
    }
    return { exists: true, raw };
  } finally {
    fs.closeSync(fd);
  }
}

function readExecApprovalsSnapshotFromPath(filePath: string): ExecApprovalsSnapshot {
  const state = readExecApprovalsRawState(filePath);
  if (!state.exists) {
    return {
      path: filePath,
      exists: false,
      raw: null,
      file: normalizeExecApprovals({ version: 1, agents: {} }),
      hash: hashExecApprovalsRaw(null),
    };
  }
  return {
    path: filePath,
    exists: true,
    raw: state.raw,
    file: parsePersistedExecApprovals(state.raw),
    hash: hashExecApprovalsRaw(state.raw),
  };
}

function readExecApprovalsFallbackSnapshotFromFd(fd: number): Buffer {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  while (true) {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    position += bytesRead;
  }
  return Buffer.concat(chunks);
}

function validateExecApprovalsFallbackFd(filePath: string, fd: number): fs.Stats {
  const linkStat = fs.lstatSync(filePath);
  if (linkStat.isSymbolicLink()) {
    throw new Error(`Refusing to write exec approvals via symlink: ${filePath}`);
  }
  const pathStat = fs.statSync(filePath);
  const fdStat = fs.fstatSync(fd);
  if (!fdStat.isFile()) {
    throw new Error(`Refusing copy fallback for non-file exec approvals path: ${filePath}`);
  }
  if (fdStat.nlink > 1) {
    throw new Error(`Refusing copy fallback for hard-linked exec approvals file: ${filePath}`);
  }
  if (!sameFilesystemEntry(pathStat, fdStat)) {
    throw new Error(`Refusing copy fallback after exec approvals path changed: ${filePath}`);
  }
  return fdStat;
}

function openExistingExecApprovalsFallbackDestination(
  filePath: string,
): ExecApprovalsFallbackDestination {
  const noFollowFlag = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(filePath, fs.constants.O_RDWR | noFollowFlag, 0o600);
  try {
    validateExecApprovalsFallbackFd(filePath, fd);
    return {
      existed: true,
      fd,
      snapshot: readExecApprovalsFallbackSnapshotFromFd(fd),
    };
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // best-effort after validation failure
    }
    throw err;
  }
}

function createExecApprovalsFallbackDestination(
  filePath: string,
): ExecApprovalsFallbackDestination {
  const noFollowFlag = fs.constants.O_NOFOLLOW ?? 0;
  try {
    const fd = fs.openSync(
      filePath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag,
      0o600,
    );
    try {
      validateExecApprovalsFallbackFd(filePath, fd);
      return { existed: false, fd, snapshot: null };
    } catch (err) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort after validation failure
      }
      throw err;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return openExistingExecApprovalsFallbackDestination(filePath);
    }
    throw err;
  }
}

function openExecApprovalsFallbackDestination(filePath: string): ExecApprovalsFallbackDestination {
  try {
    return openExistingExecApprovalsFallbackDestination(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return createExecApprovalsFallbackDestination(filePath);
    }
    throw err;
  }
}

function writeExecApprovalsFallbackBuffer(fd: number, contents: Buffer): void {
  fs.ftruncateSync(fd, 0);
  let written = 0;
  while (written < contents.length) {
    written += fs.writeSync(fd, contents, written, contents.length - written, written);
  }
  fs.ftruncateSync(fd, contents.length);
  try {
    fs.fchmodSync(fd, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
}

function restoreExecApprovalsFallbackDestination(
  filePath: string,
  destination: ExecApprovalsFallbackDestination,
): void {
  if (!destination.existed) {
    try {
      const pathStat = fs.statSync(filePath);
      const fdStat = fs.fstatSync(destination.fd);
      if (sameFilesystemEntry(pathStat, fdStat)) {
        fs.rmSync(filePath, { force: true });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    return;
  }
  writeExecApprovalsFallbackBuffer(destination.fd, destination.snapshot ?? Buffer.alloc(0));
}

function copyExecApprovalsFallback(tempPath: string, filePath: string): void {
  const contents = fs.readFileSync(tempPath);
  const destination = openExecApprovalsFallbackDestination(filePath);
  try {
    writeExecApprovalsFallbackBuffer(destination.fd, contents);
    validateExecApprovalsFallbackFd(filePath, destination.fd);
  } catch (copyErr) {
    try {
      restoreExecApprovalsFallbackDestination(filePath, destination);
    } catch (restoreErr) {
      throw new Error(
        `Failed to restore exec approvals after copy fallback failure for ${filePath}: ${String(
          copyErr,
        )}`,
        { cause: restoreErr },
      );
    }
    throw copyErr;
  } finally {
    fs.closeSync(destination.fd);
  }
}

function renameExecApprovalsWithFallback(tempPath: string, filePath: string): void {
  try {
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Windows can reject rename-overwrite when another process has a transient
    // handle on the target approvals file.
    if (code !== "EPERM" && code !== "EEXIST") {
      throw err;
    }
    assertSafeExecApprovalsOverwriteFallback(filePath);
    copyExecApprovalsFallback(tempPath, filePath);
    fs.rmSync(tempPath, { force: true });
  }
}

// Coerce legacy/corrupted allowlists into `ExecAllowlistEntry[]` before we spread
// entries to add ids (spreading strings creates {"0":"l","1":"s",...}).
function coerceAllowlistEntries(allowlist: unknown): ExecAllowlistEntry[] | undefined {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return Array.isArray(allowlist) ? (allowlist as ExecAllowlistEntry[]) : undefined;
  }
  let changed = false;
  const result: ExecAllowlistEntry[] = [];
  for (const item of allowlist) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) {
        result.push({ pattern: trimmed });
        changed = true;
      } else {
        changed = true; // dropped empty string
      }
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const pattern = (item as { pattern?: unknown }).pattern;
      if (typeof pattern === "string" && pattern.trim().length > 0) {
        result.push(item as ExecAllowlistEntry);
      } else {
        changed = true; // dropped invalid entry
      }
    } else {
      changed = true; // dropped invalid entry
    }
  }
  return changed ? (result.length > 0 ? result : undefined) : (allowlist as ExecAllowlistEntry[]);
}

function ensureAllowlistIds(
  allowlist: ExecAllowlistEntry[] | undefined,
): ExecAllowlistEntry[] | undefined {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return allowlist;
  }
  let changed = false;
  const next = allowlist.map((entry) => {
    if (entry.id) {
      return entry;
    }
    changed = true;
    return { ...entry, id: crypto.randomUUID() };
  });
  return changed ? next : allowlist;
}

function stripAllowlistCommandText(
  allowlist: ExecAllowlistEntry[] | undefined,
): ExecAllowlistEntry[] | undefined {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return allowlist;
  }
  let changed = false;
  const next = allowlist.map((entry) => {
    if (typeof entry.commandText !== "string") {
      return entry;
    }
    changed = true;
    const { commandText: _commandText, ...rest } = entry;
    return rest;
  });
  return changed ? next : allowlist;
}

function sanitizeExecApprovalPolicy(
  policy: ExecApprovalsDefaults | ExecApprovalsAgent | undefined,
): ExecApprovalsDefaults {
  const security = toStringOrUndefined(policy?.security)?.trim();
  const ask = toStringOrUndefined(policy?.ask)?.trim();
  const askFallback = toStringOrUndefined(policy?.askFallback)?.trim();
  return {
    security:
      security === "deny" || security === "allowlist" || security === "full" ? security : undefined,
    ask: ask === "off" || ask === "on-miss" || ask === "always" ? ask : undefined,
    askFallback:
      askFallback === "deny" || askFallback === "allowlist" || askFallback === "full"
        ? askFallback
        : undefined,
    autoAllowSkills: policy?.autoAllowSkills,
  };
}

export function normalizeExecApprovals(file: ExecApprovalsFile): ExecApprovalsFile {
  const socketPath = file.socket?.path?.trim();
  const token = file.socket?.token?.trim();
  const agents = { ...file.agents };
  const legacyDefault = agents.default;
  if (legacyDefault) {
    const main = agents[DEFAULT_AGENT_ID];
    agents[DEFAULT_AGENT_ID] = main ? mergeLegacyAgent(main, legacyDefault) : legacyDefault;
    delete agents.default;
  }
  for (const [key, agent] of Object.entries(agents)) {
    const coerced = coerceAllowlistEntries(agent.allowlist);
    const withIds = ensureAllowlistIds(coerced);
    const allowlist = stripAllowlistCommandText(withIds);
    const sanitizedPolicy = sanitizeExecApprovalPolicy(agent);
    const agentChanged =
      allowlist !== agent.allowlist ||
      sanitizedPolicy.security !== agent.security ||
      sanitizedPolicy.ask !== agent.ask ||
      sanitizedPolicy.askFallback !== agent.askFallback;
    if (agentChanged) {
      agents[key] = {
        ...agent,
        allowlist,
        security: sanitizedPolicy.security,
        ask: sanitizedPolicy.ask,
        askFallback: sanitizedPolicy.askFallback,
      };
    }
  }
  const sanitizedDefaults = sanitizeExecApprovalPolicy(file.defaults);
  const normalized: ExecApprovalsFile = {
    version: 1,
    socket: {
      path: socketPath && socketPath.length > 0 ? socketPath : undefined,
      token: token && token.length > 0 ? token : undefined,
    },
    defaults: {
      ...sanitizedDefaults,
    },
    agents,
  };
  return normalized;
}

export function mergeExecApprovalsSocketDefaults(params: {
  normalized: ExecApprovalsFile;
  current?: ExecApprovalsFile;
}): ExecApprovalsFile {
  const currentSocketPath = params.current?.socket?.path?.trim();
  const currentToken = params.current?.socket?.token?.trim();
  const socketPath =
    params.normalized.socket?.path?.trim() ?? currentSocketPath ?? resolveExecApprovalsSocketPath();
  const token = params.normalized.socket?.token?.trim() ?? currentToken ?? generateToken();
  return {
    ...params.normalized,
    socket: {
      path: socketPath,
      token,
    },
  };
}

function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

function readExecApprovalsSnapshotUnlocked(): ExecApprovalsSnapshot {
  const filePath = resolveExecApprovalsPath();
  return readExecApprovalsSnapshotFromPath(filePath);
}

export function readExecApprovalsSnapshot(): ExecApprovalsSnapshot {
  // Windows' overwrite fallback updates the destination inode in place. Readers
  // must share its lock so they observe either the old policy or the new one.
  return withExecApprovalsReadLockSync(
    resolveExecApprovalsPath(),
    readExecApprovalsSnapshotUnlocked,
  );
}

function loadExecApprovalsUnlocked(): ExecApprovalsFile {
  const filePath = resolveExecApprovalsPath();
  try {
    return readExecApprovalsSnapshotFromPath(filePath).file;
  } catch {
    return createFailClosedExecApprovalsFallback();
  }
}

export function loadExecApprovals(): ExecApprovalsFile {
  try {
    return withExecApprovalsReadLockSync(resolveExecApprovalsPath(), loadExecApprovalsUnlocked);
  } catch {
    // A busy, malformed, or unreadable approvals store must never restore the
    // permissive defaults while another process is revoking access.
    return createFailClosedExecApprovalsFallback();
  }
}

export async function loadExecApprovalsAsync(): Promise<ExecApprovalsFile> {
  try {
    return await withExecApprovalsReadLock(resolveExecApprovalsPath(), async () =>
      loadExecApprovalsUnlocked(),
    );
  } catch {
    // Match the synchronous reader's fail-closed contract while allowing
    // same-process async writers to finish instead of rejecting valid state.
    return createFailClosedExecApprovalsFallback();
  }
}

type ExecApprovalsSyncLock = {
  descriptor: number;
  lockPath: string;
  device: number;
  inode: number;
  raw: string;
};

function readLockPayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readExecApprovalsLockState(lockPath: string): {
  ownerPid: number | null;
  definitelyStale: boolean;
} {
  try {
    const payload = readLockPayload(fs.readFileSync(lockPath, "utf8"));
    const ownerPid =
      typeof payload?.pid === "number" && Number.isInteger(payload.pid) && payload.pid > 0
        ? payload.pid
        : null;
    return {
      ownerPid,
      definitelyStale: isLockOwnerDefinitelyStale({ payload }),
    };
  } catch {
    return { ownerPid: null, definitelyStale: false };
  }
}

function sleepExecApprovalsSyncLockRetry(): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, EXEC_APPROVALS_SYNC_LOCK_RETRY_MS);
  } catch {
    const deadline = Date.now() + EXEC_APPROVALS_SYNC_LOCK_RETRY_MS;
    while (Date.now() < deadline) {
      // Best-effort fallback when Atomics.wait is unavailable.
    }
  }
}

function removeOwnedExecApprovalsLock(
  lock: ExecApprovalsSyncLock,
  options: { requirePayloadMatch: boolean },
): void {
  try {
    const current = fs.lstatSync(lock.lockPath);
    if (
      current.dev === lock.device &&
      current.ino === lock.inode &&
      (!options.requirePayloadMatch || fs.readFileSync(lock.lockPath, "utf8") === lock.raw)
    ) {
      fs.rmSync(lock.lockPath, { force: true });
    }
  } catch {
    // Best-effort release; a changed path belongs to another lock owner.
  }
}

function acquireExecApprovalsLockSync(filePath: string): ExecApprovalsSyncLock {
  const normalizedTarget = resolveCanonicalExecApprovalsTarget(filePath);
  const lockPath = `${normalizedTarget}.lock`;
  const payload: Record<string, unknown> = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    nonce: crypto.randomUUID(),
  };
  const starttime = getExecApprovalsProcessStartTime();
  if (starttime !== null) {
    payload.starttime = starttime;
  }
  const raw = `${JSON.stringify(payload, null, 2)}\n`;
  for (let attempt = 0; attempt <= EXEC_APPROVALS_SYNC_LOCK_RETRIES; attempt += 1) {
    let descriptor: number;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      const state = readExecApprovalsLockState(lockPath);
      if (state.definitelyStale) {
        throw Object.assign(new Error(`Exec approvals lock has a stale owner: ${lockPath}`), {
          code: "file_lock_stale",
          lockPath,
        });
      }
      if (
        state.ownerPid !== null &&
        state.ownerPid !== process.pid &&
        attempt < EXEC_APPROVALS_SYNC_LOCK_RETRIES
      ) {
        sleepExecApprovalsSyncLockRetry();
        continue;
      }
      throw Object.assign(new Error(`Exec approvals are locked: ${lockPath}`), {
        code: "file_lock_timeout",
        lockPath,
      });
    }
    let stat: fs.Stats;
    try {
      stat = fs.fstatSync(descriptor);
    } catch (err) {
      fs.closeSync(descriptor);
      throw err;
    }
    const lock: ExecApprovalsSyncLock = {
      descriptor,
      lockPath,
      device: stat.dev,
      inode: stat.ino,
      raw,
    };
    try {
      fs.writeFileSync(descriptor, raw, "utf8");
      return lock;
    } catch (err) {
      fs.closeSync(descriptor);
      removeOwnedExecApprovalsLock(lock, { requirePayloadMatch: false });
      throw err;
    }
  }
  throw new Error(`Failed to acquire exec approvals lock: ${lockPath}`);
}

function withExecApprovalsLockSync<T>(fn: () => T): T {
  const lock = acquireExecApprovalsLockSync(resolveExecApprovalsPath());
  try {
    return fn();
  } finally {
    fs.closeSync(lock.descriptor);
    removeOwnedExecApprovalsLock(lock, { requirePayloadMatch: true });
  }
}

function withExecApprovalsReadLockSync<T>(filePath: string, fn: () => T): T {
  if (!isExecApprovalsTargetMissing(filePath) || !isExecApprovalsLockMissing(filePath)) {
    return withExecApprovalsLockSync(fn);
  }
  // Avoid creating a missing state directory for an uncontended read. Recheck
  // after reading: a writer can create the lock or target between the probes.
  const result = fn();
  // Probe the lock first so the target probe is the final linearization check.
  // A writer that finishes after the lock probe must make the target visible.
  return isExecApprovalsLockMissing(filePath) && isExecApprovalsTargetMissing(filePath)
    ? result
    : withExecApprovalsLockSync(fn);
}

function saveExecApprovalsUnlocked(file: ExecApprovalsFile): void {
  const filePath = resolveExecApprovalsPath();
  const raw = `${JSON.stringify(file, null, 2)}\n`;
  writeExecApprovalsRaw(filePath, raw);
}

type ExecApprovalsUpdate = {
  baseHash?: string;
  update: (file: ExecApprovalsFile) => ExecApprovalsFile | null;
};

function updateExecApprovalsUnlocked(params: ExecApprovalsUpdate): ExecApprovalsSnapshot | null {
  // Both sync and async entry points hold the sidecar lock across this full CAS transaction.
  const current = readExecApprovalsSnapshotUnlocked();
  if (params.baseHash !== undefined && current.hash !== params.baseHash) {
    return null;
  }
  const next = params.update(current.file);
  if (next === null) {
    return current;
  }
  if (
    current.exists &&
    current.hash === hashExecApprovalsFile(next) &&
    hardenUnchangedExecApprovals(current.path)
  ) {
    return current;
  }
  saveExecApprovalsUnlocked(next);
  return readExecApprovalsSnapshotUnlocked();
}

function updateExecApprovalsSync(params: ExecApprovalsUpdate): ExecApprovalsSnapshot | null {
  return withExecApprovalsLockSync(() => updateExecApprovalsUnlocked(params));
}

export function saveExecApprovals(file: ExecApprovalsFile): void {
  updateExecApprovalsSync({ update: () => file });
}

function enqueueExecApprovalsLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  // Queue process-local holders before taking the re-entrant shared lock;
  // otherwise concurrent callbacks could both mutate stale state.
  const previous = EXEC_APPROVALS_LOCK_QUEUE.get(filePath) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  EXEC_APPROVALS_LOCK_QUEUE.set(filePath, next);
  void next
    .finally(() => {
      if (EXEC_APPROVALS_LOCK_QUEUE.get(filePath) === next) {
        EXEC_APPROVALS_LOCK_QUEUE.delete(filePath);
      }
    })
    .catch(() => {});
  return next;
}

async function withExecApprovalsLock<T>(fn: () => Promise<T>): Promise<T> {
  // Harden and canonicalize before entering either lock layer. This prevents a
  // symlinked state component from redirecting the sidecar and secures the
  // directory even when the guarded update becomes a no-op or loses its CAS.
  const filePath = resolveCanonicalExecApprovalsTarget(resolveExecApprovalsPath());
  return await enqueueExecApprovalsLock(filePath, async () =>
    withFileLock(filePath, EXEC_APPROVALS_LOCK_OPTIONS, fn),
  );
}

async function withExecApprovalsReadLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  if (!isExecApprovalsTargetMissing(filePath) || !isExecApprovalsLockMissing(filePath)) {
    return await withExecApprovalsLock(fn);
  }
  const result = await fn();
  // Keep the target probe last for the same missing-file race as the sync path.
  return isExecApprovalsLockMissing(filePath) && isExecApprovalsTargetMissing(filePath)
    ? result
    : await withExecApprovalsLock(fn);
}

export async function updateExecApprovals(
  params: ExecApprovalsUpdate,
): Promise<ExecApprovalsSnapshot | null> {
  return await withExecApprovalsLock(async () => updateExecApprovalsUnlocked(params));
}

function hardenUnchangedExecApprovals(filePath: string): boolean {
  ensureDir(filePath);
  assertSafeExecApprovalsDestination(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
  if (stat.nlink > 1) {
    return false;
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
  return true;
}

function writeExecApprovalsRaw(filePath: string, raw: string) {
  const dir = ensureDir(filePath);
  assertSafeExecApprovalsDestination(filePath);
  const tempPath = path.join(dir, `.exec-approvals.${process.pid}.${crypto.randomUUID()}.tmp`);
  let tempWritten = false;
  try {
    fs.writeFileSync(tempPath, raw, { mode: 0o600, flag: "wx" });
    try {
      fs.chmodSync(tempPath, 0o600);
    } catch {
      // best-effort on platforms without chmod
    }
    tempWritten = true;
    renameExecApprovalsWithFallback(tempPath, filePath);
  } finally {
    if (tempWritten && fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
}

function restoreExecApprovalsSnapshotUnlocked(snapshot: ExecApprovalsSnapshot): void {
  if (!snapshot.exists) {
    fs.rmSync(snapshot.path, { force: true });
  } else if (snapshot.raw !== null) {
    writeExecApprovalsRaw(snapshot.path, snapshot.raw);
  } else {
    saveExecApprovalsUnlocked(snapshot.file);
  }
}

export function restoreExecApprovalsSnapshot(snapshot: ExecApprovalsSnapshot): void {
  withExecApprovalsLockSync(() => restoreExecApprovalsSnapshotUnlocked(snapshot));
}

export async function restoreExecApprovalsSnapshotLocked(
  snapshot: ExecApprovalsSnapshot,
  baseHash: string,
): Promise<boolean> {
  return await withExecApprovalsLock(async () => {
    if (readExecApprovalsSnapshotUnlocked().hash !== baseHash) {
      return false;
    }
    restoreExecApprovalsSnapshotUnlocked(snapshot);
    return true;
  });
}

function ensureExecApprovalsSocket(file: ExecApprovalsFile): ExecApprovalsFile {
  const next = normalizeExecApprovals(file);
  const socketPath = next.socket?.path?.trim();
  const token = next.socket?.token?.trim();
  return {
    ...next,
    socket: {
      path: socketPath || resolveExecApprovalsSocketPath(),
      token: token || generateToken(),
    },
  };
}

function requireInitializedExecApprovals(
  snapshot: ExecApprovalsSnapshot | null,
): ExecApprovalsSnapshot {
  if (!snapshot) {
    throw new Error("Failed to initialize exec approvals");
  }
  return snapshot;
}

export async function ensureExecApprovalsSnapshot(): Promise<ExecApprovalsSnapshot> {
  return requireInitializedExecApprovals(
    await updateExecApprovals({ update: ensureExecApprovalsSocket }),
  );
}

export function ensureExecApprovals(): ExecApprovalsFile {
  return requireInitializedExecApprovals(
    updateExecApprovalsSync({ update: ensureExecApprovalsSocket }),
  ).file;
}

function readExecApprovalsForNoPersistenceUnlocked(filePath: string): ExecApprovalsFile {
  try {
    return readExecApprovalsSnapshotFromPath(filePath).file;
  } catch (err) {
    if (err instanceof UnsafeExecApprovalsPathError) {
      throw err;
    }
    return createFailClosedExecApprovalsFallback();
  }
}

function isExecSecurity(value: unknown): value is ExecSecurity {
  return value === "allowlist" || value === "full" || value === "deny";
}

function isExecAsk(value: unknown): value is ExecAsk {
  return value === "always" || value === "off" || value === "on-miss";
}

function normalizeSecurity(value: unknown, fallback: ExecSecurity): ExecSecurity {
  return isExecSecurity(value) ? value : fallback;
}

function normalizeAsk(value: unknown, fallback: ExecAsk): ExecAsk {
  return isExecAsk(value) ? value : fallback;
}

type ResolvedExecPolicyField<TValue extends ExecSecurity | ExecAsk> = {
  value: TValue;
  source: string | null;
};

function resolveDefaultSecurityField(params: {
  field: "security" | "askFallback";
  defaults: ExecApprovalsDefaults;
  fallback: ExecSecurity;
}): ResolvedExecPolicyField<ExecSecurity> {
  const defaultValue = params.defaults[params.field];
  if (isExecSecurity(defaultValue)) {
    return {
      value: defaultValue,
      source: `defaults.${params.field}`,
    };
  }
  return {
    value: params.fallback,
    source: null,
  };
}

function resolveDefaultAskField(params: {
  defaults: ExecApprovalsDefaults;
  fallback: ExecAsk;
}): ResolvedExecPolicyField<ExecAsk> {
  if (isExecAsk(params.defaults.ask)) {
    return {
      value: params.defaults.ask,
      source: "defaults.ask",
    };
  }
  return {
    value: params.fallback,
    source: null,
  };
}

function resolveAgentSecurityField(params: {
  field: "security" | "askFallback";
  defaults: ExecApprovalsDefaults;
  agent: ExecApprovalsAgent;
  rawAgent: ExecApprovalsAgent;
  wildcard: ExecApprovalsAgent;
  rawWildcard: ExecApprovalsAgent;
  agentKey: string;
  fallback: ExecSecurity;
}): ResolvedExecPolicyField<ExecSecurity> {
  const fallbackField = resolveDefaultSecurityField({
    field: params.field,
    defaults: params.defaults,
    fallback: params.fallback,
  });
  const rawAgentValue = params.rawAgent[params.field];
  if (rawAgentValue != null) {
    if (isExecSecurity(params.agent[params.field])) {
      return {
        value: params.agent[params.field] as ExecSecurity,
        source: `agents.${params.agentKey}.${params.field}`,
      };
    }
    return fallbackField;
  }
  const rawWildcardValue = params.rawWildcard[params.field];
  if (rawWildcardValue != null) {
    if (isExecSecurity(params.wildcard[params.field])) {
      return {
        value: params.wildcard[params.field] as ExecSecurity,
        source: `agents.*.${params.field}`,
      };
    }
    return fallbackField;
  }
  return fallbackField;
}

function resolveAgentAskField(params: {
  defaults: ExecApprovalsDefaults;
  agent: ExecApprovalsAgent;
  rawAgent: ExecApprovalsAgent;
  wildcard: ExecApprovalsAgent;
  rawWildcard: ExecApprovalsAgent;
  agentKey: string;
  fallback: ExecAsk;
}): ResolvedExecPolicyField<ExecAsk> {
  const fallbackField = resolveDefaultAskField({
    defaults: params.defaults,
    fallback: params.fallback,
  });
  if (params.rawAgent.ask != null) {
    if (isExecAsk(params.agent.ask)) {
      return {
        value: params.agent.ask,
        source: `agents.${params.agentKey}.ask`,
      };
    }
    return fallbackField;
  }
  if (params.rawWildcard.ask != null) {
    if (isExecAsk(params.wildcard.ask)) {
      return {
        value: params.wildcard.ask,
        source: "agents.*.ask",
      };
    }
    return fallbackField;
  }
  return fallbackField;
}

export type ExecApprovalsDefaultOverrides = {
  security?: ExecSecurity;
  ask?: ExecAsk;
  askFallback?: ExecSecurity;
  autoAllowSkills?: boolean;
  requireSocket?: boolean;
};

function shapeResolvedExecApprovals(params: {
  file: ExecApprovalsFile;
  filePath: string;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  socket: "none" | "persisted";
}): ExecApprovalsResolved {
  const defaultSocketPath = resolveExecApprovalsSocketPath();
  return resolveExecApprovalsFromFile({
    file: params.file,
    agentId: params.agentId,
    overrides: params.overrides,
    path: params.filePath,
    socketPath:
      params.socket === "persisted"
        ? expandHomePrefix(params.file.socket?.path ?? defaultSocketPath)
        : defaultSocketPath,
    token: params.socket === "persisted" ? (params.file.socket?.token ?? "") : "",
  });
}

function resolveExecApprovalsWithoutSocket(params: {
  file: ExecApprovalsFile;
  filePath: string;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
}): ExecApprovalsResolved | null {
  const resolved = shapeResolvedExecApprovals({ ...params, socket: "none" });
  const noPrompt =
    (resolved.agent.security === "full" || resolved.agent.security === "deny") &&
    resolved.agent.ask === "off";
  return noPrompt && !params.file.socket?.token?.trim() ? resolved : null;
}

export function resolveExecApprovals(
  agentId?: string,
  overrides?: ExecApprovalsDefaultOverrides,
): ExecApprovalsResolved {
  const filePath = resolveExecApprovalsPath();
  if (!overrides?.requireSocket) {
    const file = withExecApprovalsReadLockSync(filePath, () =>
      readExecApprovalsForNoPersistenceUnlocked(filePath),
    );
    const resolved = resolveExecApprovalsWithoutSocket({
      file,
      filePath,
      agentId,
      overrides,
    });
    if (resolved) {
      return resolved;
    }
  }
  const file = ensureExecApprovals();
  return shapeResolvedExecApprovals({
    file,
    filePath,
    agentId,
    overrides,
    socket: "persisted",
  });
}

export async function resolveExecApprovalsLocked(
  agentId?: string,
  overrides?: ExecApprovalsDefaultOverrides,
): Promise<ExecApprovalsResolved> {
  const filePath = resolveExecApprovalsPath();
  if (!overrides?.requireSocket) {
    const file = await withExecApprovalsReadLock(filePath, async () =>
      readExecApprovalsForNoPersistenceUnlocked(filePath),
    );
    const resolved = resolveExecApprovalsWithoutSocket({
      file,
      filePath,
      agentId,
      overrides,
    });
    if (resolved) {
      return resolved;
    }
  }
  return shapeResolvedExecApprovals({
    file: (await ensureExecApprovalsSnapshot()).file,
    filePath: resolveExecApprovalsPath(),
    agentId,
    overrides,
    socket: "persisted",
  });
}

export function resolveExecApprovalsFromFile(params: {
  file: ExecApprovalsFile;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  path?: string;
  socketPath?: string;
  token?: string;
}): ExecApprovalsResolved {
  const rawFile = params.file;
  const file = normalizeExecApprovals(params.file);
  const defaults = file.defaults ?? {};
  const agentKey = params.agentId ?? DEFAULT_AGENT_ID;
  const agent = file.agents?.[agentKey] ?? {};
  const wildcard = file.agents?.["*"] ?? {};
  const rawAgent = rawFile.agents?.[agentKey] ?? {};
  const rawWildcard = rawFile.agents?.["*"] ?? {};
  const fallbackSecurity = params.overrides?.security ?? DEFAULT_SECURITY;
  const fallbackAsk = params.overrides?.ask ?? DEFAULT_ASK;
  const fallbackAskFallback = params.overrides?.askFallback ?? DEFAULT_EXEC_APPROVAL_ASK_FALLBACK;
  const fallbackAutoAllowSkills = params.overrides?.autoAllowSkills ?? DEFAULT_AUTO_ALLOW_SKILLS;
  const resolvedDefaults: Required<ExecApprovalsDefaults> = {
    security: normalizeSecurity(defaults.security, fallbackSecurity),
    ask: normalizeAsk(defaults.ask, fallbackAsk),
    askFallback: normalizeSecurity(
      defaults.askFallback ?? fallbackAskFallback,
      fallbackAskFallback,
    ),
    autoAllowSkills: defaults.autoAllowSkills ?? fallbackAutoAllowSkills,
  };
  const resolvedAgentSecurity = resolveAgentSecurityField({
    field: "security",
    defaults,
    agent,
    rawAgent,
    wildcard,
    rawWildcard,
    agentKey,
    fallback: resolvedDefaults.security,
  });
  const resolvedAgentAsk = resolveAgentAskField({
    defaults,
    agent,
    rawAgent,
    wildcard,
    rawWildcard,
    agentKey,
    fallback: resolvedDefaults.ask,
  });
  const resolvedAgentAskFallback = resolveAgentSecurityField({
    field: "askFallback",
    defaults,
    agent,
    rawAgent,
    wildcard,
    rawWildcard,
    agentKey,
    fallback: resolvedDefaults.askFallback,
  });
  const resolvedAgent: Required<ExecApprovalsDefaults> = {
    security: resolvedAgentSecurity.value,
    ask: resolvedAgentAsk.value,
    askFallback: resolvedAgentAskFallback.value,
    autoAllowSkills:
      agent.autoAllowSkills ?? wildcard.autoAllowSkills ?? resolvedDefaults.autoAllowSkills,
  };
  const allowlist = [
    ...(Array.isArray(wildcard.allowlist) ? wildcard.allowlist : []),
    ...(Array.isArray(agent.allowlist) ? agent.allowlist : []),
  ];
  return {
    path: params.path ?? resolveExecApprovalsPath(),
    socketPath: expandHomePrefix(
      params.socketPath ?? file.socket?.path ?? resolveExecApprovalsSocketPath(),
    ),
    token: params.token ?? file.socket?.token ?? "",
    defaults: resolvedDefaults,
    agent: resolvedAgent,
    agentSources: {
      security: resolvedAgentSecurity.source,
      ask: resolvedAgentAsk.source,
      askFallback: resolvedAgentAskFallback.source,
    },
    allowlist,
    file,
  };
}

export function requiresExecApproval(params: {
  ask: ExecAsk;
  security: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied?: boolean;
}): boolean {
  if (params.ask === "always") {
    return true;
  }
  if (params.durableApprovalSatisfied === true) {
    return false;
  }
  return (
    params.ask === "on-miss" &&
    params.security === "allowlist" &&
    (!params.analysisOk || !params.allowlistSatisfied)
  );
}

function normalizeCommandName(value: string | undefined): string {
  return ((value ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "").replace(
    /\.(?:bat|cjs|cmd|exe|js|mjs|ps1)$/,
    "",
  );
}

function textMentionsSecurityAuditSuppressions(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("security.audit.suppressions") ||
    /["']?security["']?[\s\S]{0,200}["']?audit["']?[\s\S]{0,200}["']?suppressions["']?/.test(
      normalized,
    )
  );
}

function isReadOnlySecurityAuditSuppressionInspection(argv: string[]): boolean {
  const command = normalizeCommandName(argv[0]);
  let offset = command === "pnpm" && argv[1] === "openclaw" ? 1 : 0;
  if (normalizeCommandName(argv[offset]) !== "openclaw") {
    return false;
  }
  offset += 1;
  while (offset < argv.length) {
    const arg = argv[offset];
    if (["--dev", "--no-color"].includes(arg ?? "")) {
      offset += 1;
      continue;
    }
    if (["--profile", "--container", "--log-level"].includes(arg ?? "")) {
      offset += 2;
      continue;
    }
    if (
      arg?.startsWith("--profile=") ||
      arg?.startsWith("--container=") ||
      arg?.startsWith("--log-level=")
    ) {
      offset += 1;
      continue;
    }
    break;
  }
  return (
    argv[offset] === "config" && ["get", "schema", "validate"].includes(argv[offset + 1] ?? "")
  );
}

const OPENCLAW_LIFECYCLE_TARGET_RE =
  /\b(?:openclaw|com\.openclaw|ai\.openclaw|io\.openclaw|openclaw[-_.]gateway|openclaw[-_.]daemon)\b/i;
const OPENCLAW_PROCESS_PATTERN_CANDIDATES = [
  "openclaw",
  "openclaw-gateway",
  "openclaw-daemon",
  "com.openclaw.gateway",
  "ai.openclaw",
  "io.openclaw",
];
const OPENCLAW_SYSTEMD_UNIT_CANDIDATES = [
  "openclaw.service",
  "openclaw-daemon.service",
  "openclaw-gateway.service",
];
const OPENCLAW_WINDOWS_SERVICE_CANDIDATES = [
  "openclaw",
  "openclaw gateway",
  "openclaw-gateway",
  "openclawgateway",
];
const MAX_LIFECYCLE_CARRIER_UNWRAP_DEPTH = 32;
const PROCESS_LIFECYCLE_COMMANDS = new Set([
  "kill",
  "pkill",
  "killall",
  "spps",
  "taskkill",
  "stop-process",
]);
const POWERSHELL_STOP_PROCESS_COMMANDS = new Set(["kill", "spps", "stop-process"]);
const KILL_OPTIONS_WITH_VALUE = new Set(["-s", "--signal", "-n", "--queue"]);
const PKILL_OPTIONS_WITH_VALUE = new Set([
  "-g",
  "--pgroup",
  "-G",
  "--group",
  "-P",
  "--parent",
  "-s",
  "--session",
  "-t",
  "--terminal",
  "-u",
  "--euid",
  "-U",
  "--uid",
  "--signal",
]);
const KILLALL_OPTIONS_WITH_VALUE = new Set([
  "-s",
  "--signal",
  "-u",
  "--user",
  "-o",
  "--older-than",
  "-y",
  "--younger-than",
]);
const OPENCLAW_CLI_LIFECYCLE_ACTIONS = new Set([
  "install",
  "kill",
  "restart",
  "start",
  "stop",
  "uninstall",
]);
const OPENCLAW_GATEWAY_RUN_VALUE_FLAGS = new Set([
  "--auth",
  "--bind",
  "--password",
  "--password-file",
  "--port",
  "--raw-stream-path",
  "--tailscale",
  "--token",
  "--token-file",
  "--ws-log",
]);
const OPENCLAW_GATEWAY_RUN_BOOLEAN_FLAGS = new Set([
  "--allow-unconfigured",
  "--claude-cli-logs",
  "--cli-backend-logs",
  "--compact",
  "--dev",
  "--force",
  "--raw-stream",
  "--reset",
  "--tailscale-reset-on-exit",
  "--verbose",
]);
const OPENCLAW_GATEWAY_CALL_LIFECYCLE_METHODS = new Set(["gateway.restart.request", "update.run"]);
const OPENCLAW_GATEWAY_CALL_VALUE_FLAGS = new Set([
  "--params",
  "--password",
  "--timeout",
  "--token",
  "--url",
]);
const OPENCLAW_GATEWAY_CALL_BOOLEAN_FLAGS = new Set(["--expect-final", "--json"]);
const OPENCLAW_GATEWAY_READ_ONLY_SUBCOMMANDS = new Set([
  "diagnostics",
  "discover",
  "probe",
  "stability",
  "status",
  "usage-cost",
]);
const OPENCLAW_GATEWAY_NON_EXEC_TOKENS = new Set(["-h", "--help", "--version", "help"]);
const OPENCLAW_UPDATE_READ_ONLY_SUBCOMMANDS = new Set(["status"]);
const OPENCLAW_UPDATE_MUTATING_SUBCOMMANDS = new Set(["finalize", "repair", "wizard"]);
const OPENCLAW_UPDATE_NON_EXEC_TOKENS = new Set(["-h", "--help", "--version", "help"]);
const OPENCLAW_UPDATE_OPTIONS_WITH_VALUE = new Set(["--channel", "--tag", "--timeout"]);
const OPENCLAW_UPDATE_DRY_RUN_OPTIONS = new Set(["--dry-run"]);
const OPENCLAW_UNINSTALL_NON_EXEC_TOKENS = new Set(["-h", "--help", "--version", "help"]);
const OPENCLAW_UNINSTALL_DRY_RUN_OPTIONS = new Set(["--dry-run"]);
const OPENCLAW_DAEMON_INSTALL_OPTIONS = new Set(["--install-daemon"]);
const OPENCLAW_GLOBAL_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
const OPENCLAW_GLOBAL_VALUE_FLAGS = new Set(["--container", "--log-level", "--profile"]);
const OPENCLAW_CLI_CARRIER_COMMANDS = new Set([
  "bun",
  "bunx",
  "corepack",
  "node",
  "npx",
  "npm",
  "pnpm",
  "yarn",
]);
const OPENCLAW_PACKAGE_RUNNER_COMMANDS = new Set([
  "bun",
  "bunx",
  "corepack",
  "npx",
  "npm",
  "pnpm",
  "yarn",
]);
const PACKAGE_RUNNER_EXEC_SUBCOMMANDS = new Set(["dlx", "exec", "x"]);
const PACKAGE_RUNNER_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-F",
  "-p",
  "-w",
  "--cache",
  "--call",
  "--color",
  "--config",
  "--cwd",
  "--dir",
  "--filter",
  "--install-directory",
  "--loglevel",
  "--package",
  "--prefix",
  "--registry",
  "--userconfig",
  "--workspace",
]);
const PACKAGE_RUNNER_STANDALONE_OPTIONS = new Set([
  "-y",
  "--ignore-scripts",
  "--no-install",
  "--offline",
  "--prefer-offline",
  "--quiet",
  "--silent",
  "--verbose",
  "--yes",
]);
const LAUNCHCTL_LIFECYCLE_ACTIONS = new Set([
  "attach",
  "bootstrap",
  "bootout",
  "debug",
  "disable",
  "enable",
  "kickstart",
  "kill",
  "load",
  "remove",
  "start",
  "stop",
  "submit",
  "unload",
]);
const SYSTEMCTL_LIFECYCLE_ACTIONS = new Set([
  "add-requires",
  "add-wants",
  "bind",
  "clean",
  "condrestart",
  "disable",
  "edit",
  "enable",
  "freeze",
  "isolate",
  "kill",
  "link",
  "mask",
  "force-reload",
  "reload",
  "reload-or-try-restart",
  "reload-or-restart",
  "preset",
  "reenable",
  "reset-failed",
  "restart",
  "revert",
  "set-property",
  "start",
  "stop",
  "thaw",
  "try-reload-or-restart",
  "try-restart",
  "unmask",
]);
const SYSTEMCTL_OPTIONS_WITH_VALUE = new Set([
  "-H",
  "-M",
  "-n",
  "-o",
  "-p",
  "-s",
  "-t",
  "--host",
  "--image",
  "--image-policy",
  "--job-mode",
  "--kill-who",
  "--lines",
  "--machine",
  "--message",
  "--output",
  "--preset-mode",
  "--property",
  "--root",
  "--signal",
  "--state",
  "--timestamp",
  "--transport",
  "--type",
  "--when",
]);
const SYSTEMCTL_INLINE_OPTIONS_WITH_VALUE =
  /^(?:-[HMnopst].+|--(?:host|image|image-policy|job-mode|kill-who|lines|machine|message|output|preset-mode|property|root|signal|state|timestamp|transport|type|when)=)/;
const SYSTEMCTL_NON_EXEC_OPTIONS = new Set(["-h", "--help", "--version"]);
const SYSTEMCTL_SHORT_OPTIONS_WITH_VALUE = new Set(["H", "M", "n", "o", "p", "s", "t"]);
const SERVICE_LIFECYCLE_ACTIONS = new Set([
  "force-reload",
  "reload",
  "restart",
  "start",
  "stop",
  "try-restart",
]);
const POWERSHELL_SERVICE_LIFECYCLE_COMMANDS = new Set([
  "new-service",
  "remove-service",
  "restart-service",
  "resume-service",
  "set-service",
  "sasv",
  "spsv",
  "start-service",
  "stop-service",
  "suspend-service",
]);
const POWERSHELL_SERVICE_TARGET_OPTIONS = new Set([
  "-displayname",
  "-inputobject",
  "-name",
  "-servicename",
]);
const POWERSHELL_SERVICE_OPTIONS_WITH_VALUE = new Set([
  ...POWERSHELL_SERVICE_TARGET_OPTIONS,
  "-binarypathname",
  "-credential",
  "-dependson",
  "-description",
  "-exclude",
  "-include",
  "-status",
  "-startuptype",
]);
const POWERSHELL_COMMON_OPTIONS = new Set([
  "-confirm",
  "-debug",
  "-erroraction",
  "-errorvariable",
  "-informationaction",
  "-informationvariable",
  "-outbuffer",
  "-outvariable",
  "-pipelinevariable",
  "-progressaction",
  "-verbose",
  "-warningaction",
  "-warningvariable",
  "-whatif",
]);
const POWERSHELL_SERVICE_KNOWN_OPTIONS = new Set([
  ...POWERSHELL_SERVICE_OPTIONS_WITH_VALUE,
  ...POWERSHELL_COMMON_OPTIONS,
]);
const POWERSHELL_SELECTOR_TARGET_OPTIONS = new Set([
  "-displayname",
  "-inputobject",
  "-name",
  "-servicename",
]);
const POWERSHELL_SELECTOR_NON_TARGET_OPTIONS_WITH_VALUE = new Set([
  "-computername",
  "-id",
  "-includeusername",
]);
const POWERSHELL_SELECTOR_KNOWN_OPTIONS = new Set([
  ...POWERSHELL_SELECTOR_TARGET_OPTIONS,
  ...POWERSHELL_SELECTOR_NON_TARGET_OPTIONS_WITH_VALUE,
  ...POWERSHELL_COMMON_OPTIONS,
]);
const WINDOWS_SC_LIFECYCLE_ACTIONS = new Set([
  "config",
  "continue",
  "control",
  "create",
  "delete",
  "description",
  "failure",
  "failureflag",
  "pause",
  "privs",
  "sdset",
  "sidtype",
  "start",
  "stop",
  "triggerinfo",
]);
const WINDOWS_NET_SERVICE_LIFECYCLE_ACTIONS = new Set(["continue", "pause", "start", "stop"]);
const SCHTASKS_LIFECYCLE_ACTIONS = new Set(["/change", "/create", "/delete", "/end", "/run"]);
const TRANSPARENT_LIFECYCLE_CARRIERS = new Set(["command", "doas", "env", "exec", "nohup", "sudo"]);
const XARGS_OPTIONS_WITH_VALUE = new Set([
  "-a",
  "--arg-file",
  "-d",
  "--delimiter",
  "-E",
  "-e",
  "--eof",
  "-I",
  "-i",
  "--replace",
  "-L",
  "-l",
  "--max-lines",
  "-n",
  "--max-args",
  "-P",
  "--max-procs",
  "--process-slot-var",
  "-s",
  "--max-chars",
]);
const XARGS_STANDALONE_OPTIONS = new Set([
  "-0",
  "--null",
  "-o",
  "--open-tty",
  "-p",
  "--interactive",
  "-r",
  "--no-run-if-empty",
  "-t",
  "--verbose",
  "-x",
  "--exit",
]);
const XARGS_NON_EXEC_OPTIONS = new Set(["--help", "--show-limits", "--version"]);
const XARGS_REPLACEMENT_OPTIONS = new Set(["-I", "-i", "--replace"]);
const ENV_OPTIONS_WITH_VALUE = new Set([
  "-a",
  "-C",
  "-P",
  "--argv0",
  "--chdir",
  "-S",
  "-s",
  "-u",
  "--split-string",
  "--unset",
]);
const ENV_NON_EXEC_OPTIONS = new Set(["--help", "--version"]);
const ENV_SPLIT_STRING_OPTIONS = new Set(["-S", "-s", "--split-string"]);
const ENV_STANDALONE_OPTIONS = new Set([
  "-",
  "-0",
  "-i",
  "-v",
  "--debug",
  "--block-signal",
  "--default-signal",
  "--ignore-environment",
  "--ignore-signal",
  "--list-signal-handling",
  "--null",
]);
const GENERIC_WRAPPER_NON_EXEC_OPTIONS = new Set(["-h", "--help", "-V", "--version"]);
const SETSID_STANDALONE_OPTIONS = new Set(["-c", "--ctty", "-f", "--fork", "-w", "--wait"]);
const SETSID_NON_EXEC_OPTIONS = new Set(["-h", "--help", "-V", "--version"]);
const TASKSET_STANDALONE_OPTIONS = new Set(["-a", "--all-tasks", "-c", "--cpu-list"]);
const TASKSET_NON_EXEC_OPTIONS = new Set(["-h", "--help", "-p", "--pid", "-V", "--version"]);
const IONICE_STANDALONE_OPTIONS = new Set(["-t", "--ignore"]);
const IONICE_OPTIONS_WITH_VALUE = new Set(["-c", "--class", "-n", "--classdata"]);
const IONICE_NON_EXEC_OPTIONS = new Set([
  "-h",
  "--help",
  "-p",
  "--pid",
  "-P",
  "--pgid",
  "-u",
  "--uid",
  "-V",
  "--version",
]);
const CHRT_STANDALONE_OPTIONS = new Set([
  "-a",
  "--all-tasks",
  "-b",
  "--batch",
  "-d",
  "--deadline",
  "-e",
  "--ext",
  "-f",
  "--fifo",
  "-G",
  "--reclaim-grub",
  "-i",
  "--idle",
  "-o",
  "--other",
  "-O",
  "--deadline-overrun",
  "-r",
  "--rr",
  "-R",
  "--reset-on-fork",
  "-v",
  "--verbose",
]);
const CHRT_OPTIONS_WITH_VALUE = new Set([
  "-D",
  "--sched-deadline",
  "-P",
  "--sched-period",
  "-T",
  "--sched-runtime",
]);
const CHRT_NON_EXEC_OPTIONS = new Set([
  "-h",
  "--help",
  "-m",
  "--max",
  "-p",
  "--pid",
  "-V",
  "--version",
]);
const NOHUP_NON_EXEC_OPTIONS = new Set(["--help", "--version"]);
const STDBUF_OPTIONS_WITH_VALUE = new Set(["-e", "--error", "-i", "--input", "-o", "--output"]);
const STDBUF_NON_EXEC_OPTIONS = new Set(["--help", "--version"]);
const TIME_STANDALONE_OPTIONS = new Set([
  "-a",
  "--append",
  "-h",
  "-l",
  "-p",
  "--portability",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
]);
const TIME_OPTIONS_WITH_VALUE = new Set(["-f", "--format", "-o", "--output"]);
const TIME_NON_EXEC_OPTIONS = new Set(["--help", "-V", "--version"]);
const TIMEOUT_STANDALONE_OPTIONS = new Set([
  "-f",
  "--foreground",
  "-p",
  "--preserve-status",
  "-v",
  "--verbose",
]);
const TIMEOUT_OPTIONS_WITH_VALUE = new Set(["-k", "--kill-after", "-s", "--signal"]);
const TIMEOUT_NON_EXEC_OPTIONS = new Set(["--help", "--version"]);
const WATCH_OPTIONS_WITH_VALUE = new Set(["-n", "--interval"]);
const WATCH_NON_EXEC_OPTIONS = new Set(["-h", "--help", "-v", "--version"]);
const STRACE_NON_EXEC_OPTIONS = new Set(["-h", "--help", "-V", "--version"]);
const STRACE_OPTIONS_WITH_VALUE = new Set([
  "-a",
  "-b",
  "-E",
  "-e",
  "-I",
  "-l",
  "-o",
  "-O",
  "-p",
  "-P",
  "-s",
  "-S",
  "-u",
  "-U",
  "-X",
  "--abbrev",
  "--argv0",
  "--attach",
  "--color",
  "--const-print-style",
  "--decode-pids",
  "--detach-on",
  "--env",
  "--fault",
  "--inject",
  "--interruptible",
  "--kvm",
  "--output",
  "--raw",
  "--read",
  "--signals",
  "--stack-trace-frame-limit",
  "--status",
  "--string-limit",
  "--summary-columns",
  "--summary-sort-by",
  "--summary-syscall-overhead",
  "--syscall-limit",
  "--trace",
  "--trace-fds",
  "--trace-path",
  "--user",
  "--verbose",
  "--write",
]);
const VARIABLE_EXECUTABLE_LIFECYCLE_CANDIDATES = [
  "openclaw",
  ...OPENCLAW_CLI_CARRIER_COMMANDS,
  "launchctl",
  "service",
  "systemctl",
  "schtasks",
  "sc",
  "net",
  ...POWERSHELL_SERVICE_LIFECYCLE_COMMANDS,
  ...PROCESS_LIFECYCLE_COMMANDS,
  "chrt",
  "command",
  "doas",
  "env",
  "exec",
  "flock",
  "ionice",
  "ash",
  "bash",
  "busybox",
  "cmd",
  "dash",
  "fish",
  "ksh",
  "nice",
  "nohup",
  "powershell",
  "pwsh",
  "setsid",
  "sh",
  "stdbuf",
  "sudo",
  "taskset",
  "time",
  "timeout",
  "toybox",
  "zsh",
] as const;
const ENV_SPLIT_DOUBLE_QUOTE_ESCAPES = new Set(["\\", '"', "$", "`", "\n", "\r"]);
const ENV_SPLIT_LITERAL_DOLLAR_MARKER = "\uE000";
const ENV_SPLIT_LITERAL_BACKSLASH_MARKER = "\uE001";
const ENV_SPLIT_UNKNOWN_ASSIGNMENT_VALUE = "\uE002";
const SHELL_LITERAL_BACKTICK_MARKER = "\uE003";
const SHELL_LITERAL_PROCESS_SUBSTITUTION_MARKER = "\uE004";
const SHELL_VARIABLE_REFERENCE_SOURCE = String.raw`\$\{[A-Za-z_][A-Za-z0-9_]*(?:(?::?[-+?=])[^}]*)?\}|\$[A-Za-z_][A-Za-z0-9_]*`;
const SHELL_VARIABLE_REFERENCE_PATTERN = new RegExp(SHELL_VARIABLE_REFERENCE_SOURCE);
const SHELL_VARIABLE_REFERENCE_GLOBAL_PATTERN = new RegExp(
  String.raw`\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?=])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)`,
  "g",
);
const ENV_SPLIT_CONTROL_ESCAPES: Record<string, string> = {
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};
const SUDO_OPTIONS_WITH_VALUE = new Set([
  "-a",
  "-C",
  "-D",
  "-g",
  "-h",
  "-p",
  "-R",
  "-r",
  "-t",
  "-T",
  "-u",
  "--chdir",
  "--chroot",
  "--close-from",
  "--command-timeout",
  "--group",
  "--host",
  "--login-class",
  "--prompt",
  "--role",
  "--type",
  "--user",
]);

function tokenMentionsOpenClawLifecycleTarget(token: string | undefined): boolean {
  return typeof token === "string" && OPENCLAW_LIFECYCLE_TARGET_RE.test(token);
}

function argvMentionsOpenClawLifecycleTarget(argv: readonly string[]): boolean {
  return argv.some((token) => tokenMentionsOpenClawLifecycleTarget(token));
}

function processPatternMayMatchOpenClaw(pattern: string): boolean {
  if (tokenMentionsOpenClawLifecycleTarget(pattern)) {
    return true;
  }
  if (pattern.length > 512 || /\[\[:[A-Za-z]+:\]\]/.test(pattern)) {
    return true;
  }
  try {
    const matcher = new RegExp(pattern, "i");
    return OPENCLAW_PROCESS_PATTERN_CANDIDATES.some((candidate) => matcher.test(candidate));
  } catch {
    return true;
  }
}

function expandSimpleShellBracePatterns(pattern: string, limit = 64): string[] | null {
  let searchOffset = 0;
  while (searchOffset < pattern.length) {
    const open = pattern.indexOf("{", searchOffset);
    if (open === -1) {
      return [pattern];
    }
    const close = pattern.indexOf("}", open + 1);
    if (close === -1) {
      return [pattern];
    }
    const body = pattern.slice(open + 1, close);
    if (body.includes("{") || body.includes("}")) {
      return null;
    }
    if (!body.includes(",")) {
      if (body.includes("..")) {
        return null;
      }
      searchOffset = close + 1;
      continue;
    }
    const alternatives = body.split(",");
    if (alternatives.length > limit) {
      return null;
    }
    const expanded: string[] = [];
    for (const alternative of alternatives) {
      const nested = expandSimpleShellBracePatterns(
        `${pattern.slice(0, open)}${alternative}${pattern.slice(close + 1)}`,
        limit - expanded.length,
      );
      if (!nested || expanded.length + nested.length > limit) {
        return null;
      }
      expanded.push(...nested);
    }
    return expanded;
  }
  return [pattern];
}

function shellGlobPatternMayMatchCandidates(
  pattern: string,
  candidates: readonly string[],
): boolean {
  if (candidates.includes(pattern)) {
    return true;
  }
  if (!/[*?[]/.test(pattern)) {
    return false;
  }
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      source += ".*";
      continue;
    }
    if (char === "?") {
      source += ".";
      continue;
    }
    if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close === -1) {
        return true;
      }
      let content = pattern.slice(index + 1, close);
      if (!content || content.includes("[:")) {
        return true;
      }
      if (content.startsWith("!")) {
        content = `^${content.slice(1)}`;
      }
      source += `[${content.replaceAll("\\", "\\\\")}]`;
      index = close;
      continue;
    }
    source += /[\\^$+.|(){}]/.test(char ?? "") ? `\\${char}` : char;
  }
  try {
    const matcher = new RegExp(`${source}$`, "i");
    return candidates.some((candidate) => matcher.test(candidate));
  } catch {
    return true;
  }
}

function shellGlobMayMatchCandidates(pattern: string, candidates: readonly string[]): boolean {
  const expanded = expandSimpleShellBracePatterns(pattern);
  if (!expanded) {
    return true;
  }
  return expanded.some((candidatePattern) =>
    shellGlobPatternMayMatchCandidates(candidatePattern, candidates),
  );
}

function tokenEqualsOrGlobsCandidate(
  token: string | undefined,
  candidates: readonly string[],
): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(token);
  return candidates.includes(normalized) || shellGlobMayMatchCandidates(normalized, candidates);
}

function systemdGlobMayMatchOpenClawUnit(pattern: string): boolean {
  return (
    tokenMentionsOpenClawLifecycleTarget(pattern) ||
    shellGlobMayMatchCandidates(pattern, OPENCLAW_SYSTEMD_UNIT_CANDIDATES)
  );
}

function powershellPatternMayMatchOpenClawService(pattern: string): boolean {
  const normalized = normalizePowerShellBacktickEscapes(pattern);
  return (
    tokenMentionsOpenClawLifecycleTarget(normalized) ||
    shellGlobMayMatchCandidates(normalized, OPENCLAW_WINDOWS_SERVICE_CANDIDATES)
  );
}

function powershellPatternMayMatchOpenClawProcess(pattern: string): boolean {
  const normalized = normalizePowerShellBacktickEscapes(pattern);
  return (
    tokenMentionsOpenClawLifecycleTarget(normalized) ||
    shellGlobMayMatchCandidates(normalized, OPENCLAW_PROCESS_PATTERN_CANDIDATES)
  );
}

function normalizePowerShellBacktickEscapes(value: string): string {
  return value.replaceAll(/`(?:\r\n|[\r\n])/g, "").replaceAll(/`(.)/gs, "$1");
}

function resolvePowerShellLiteralConcatExpression(expression: string): string | null {
  const terms: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "`") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "+") {
      terms.push(expression.slice(start, index).trim());
      start = index + 1;
    }
  }
  terms.push(expression.slice(start).trim());
  if (quote || escaped || terms.length < 2) {
    return null;
  }
  const literals: string[] = [];
  for (const term of terms) {
    const match = /^(['"])([\s\S]*)\1$/u.exec(term);
    if (!match) {
      return null;
    }
    literals.push(normalizePowerShellBacktickEscapes(match[2] ?? ""));
  }
  return literals.join("");
}

function normalizePowerShellLifecycleTarget(target: string): string {
  const normalized = normalizePowerShellBacktickEscapes(target);
  if (!normalized.startsWith("(") || !normalized.endsWith(")")) {
    return normalized;
  }
  const expression = normalized.slice(1, -1).trim();
  const quoted = resolvePowerShellLiteralConcatExpression(expression);
  if (quoted !== null) {
    return quoted;
  }
  if (/^[A-Za-z0-9_.*?-]+(?:\+[A-Za-z0-9_.*?-]+)+$/u.test(expression)) {
    return expression.split("+").join("");
  }
  return normalized;
}

function resolvePowerShellAssignedString(
  expression: string,
  variables: ReadonlyMap<string, string>,
): string | null {
  const trimmed = expression.trim();
  const concatenated = resolvePowerShellLiteralConcatExpression(trimmed);
  if (concatenated !== null) {
    return concatenated;
  }
  const quoted = /^(['"])([\s\S]*)\1$/u.exec(trimmed);
  if (!quoted) {
    return null;
  }
  const body = normalizePowerShellBacktickEscapes(quoted[2] ?? "");
  if (quoted[1] === "'") {
    return body;
  }
  let unresolved = false;
  const expanded = body.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu,
    (match, bracedName: string | undefined, bareName: string | undefined) => {
      const resolved = variables.get((bracedName ?? bareName ?? "").toLowerCase());
      if (resolved === undefined) {
        unresolved = true;
        return match;
      }
      return resolved;
    },
  );
  return unresolved ? null : expanded;
}

function collectPowerShellStringAssignments(value: string): Map<string, string> {
  const variables = new Map<string, string>();
  for (const match of value.matchAll(
    /(?:^|[;\r\n])\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;\r\n]+)/gu,
  )) {
    const resolved = resolvePowerShellAssignedString(match[2] ?? "", variables);
    if (resolved !== null) {
      variables.set((match[1] ?? "").toLowerCase(), resolved);
    }
  }
  return variables;
}

function commandHasPowerShellVariableCallOperator(value: string): boolean {
  return /(?:^|[;|\r\n])\s*&\s*\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)(?=\s|$)/u.test(
    value,
  );
}

function powershellDynamicCommandMentionsOpenClawLifecycleMutation(value: string): boolean {
  for (const match of value.matchAll(
    /(?:^|[;|])\s*&\s*\(([^()\r\n]{1,512})\)\s+([^;|\r\n]{1,512})/gu,
  )) {
    const executable = resolvePowerShellLiteralConcatExpression(match[1] ?? "");
    if (!executable) {
      continue;
    }
    const argv = splitShellArgs(`${executable} ${match[2] ?? ""}`);
    if (argv && segmentIsOpenClawLifecycleMutation(argv)) {
      return true;
    }
  }
  const variables = collectPowerShellStringAssignments(value);
  for (const match of value.matchAll(
    /(?:^|[;|\r\n])\s*&\s*\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))\s+([^;|\r\n]{1,512})/gu,
  )) {
    const targetArgv = splitShellArgs(match[3] ?? "");
    if (!targetArgv || !argvMentionsOpenClawLifecycleTarget(targetArgv)) {
      continue;
    }
    const commandName = variables.get((match[1] ?? match[2] ?? "").toLowerCase());
    if (!commandName) {
      return true;
    }
    const argv = splitShellArgs(`${commandName} ${match[3] ?? ""}`);
    if (argv && segmentIsOpenClawLifecycleMutation(argv)) {
      return true;
    }
  }
  return false;
}

function resolvePowerShellOptionAbbreviation(
  option: string,
  candidates: ReadonlySet<string>,
): string | null {
  const normalized = normalizeLowercaseStringOrEmpty(option);
  if (candidates.has(normalized)) {
    return normalized;
  }
  const matches = Array.from(candidates).filter((candidate) => candidate.startsWith(normalized));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function skipOpenClawGlobalOptions(argv: readonly string[], offset: number): number {
  let next = offset;
  while (next < argv.length) {
    const consumed = consumeOpenClawGlobalOptionToken(argv, next);
    if (consumed === 0) {
      break;
    }
    next += consumed;
  }
  return next;
}

function consumeOpenClawGlobalOptionToken(argv: readonly string[], offset: number): number {
  const arg = argv[offset];
  if (!arg || arg === "--" || !arg.startsWith("-")) {
    return 0;
  }
  const equalsIndex = arg.indexOf("=");
  const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
  if (OPENCLAW_GLOBAL_BOOLEAN_FLAGS.has(flag)) {
    return equalsIndex === -1 ? 1 : 0;
  }
  if (!OPENCLAW_GLOBAL_VALUE_FLAGS.has(flag)) {
    return 0;
  }
  if (equalsIndex !== -1) {
    return arg.slice(equalsIndex + 1).trim() ? 1 : 0;
  }
  return offset + 1 < argv.length ? 2 : 1;
}

function skipOpenClawArgvSeparator(argv: readonly string[], offset: number): number {
  return argv[offset] === "--" ? offset + 1 : offset;
}

function splitCommandPathSegments(value: string | undefined): string[] {
  return (value ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

function pathSegmentsIncludeOpenClawPackage(segments: readonly string[]): boolean {
  return segments.includes("openclaw");
}

function tokenPathLooksAbsolute(value: string | undefined): boolean {
  return typeof value === "string" && /^(?:[A-Za-z]:[\\/]|[\\/])/.test(value);
}

function tokenLooksLikeOpenClawPackageSpec(value: string | undefined): boolean {
  return typeof value === "string" && /^openclaw@[^\\/\s]+$/i.test(value);
}

function tokenLooksLikeOpenClawNodeEntrypoint(value: string | undefined, cwd?: string): boolean {
  const segments = splitCommandPathSegments(value);
  if (segments.length < 2) {
    return false;
  }
  const file = segments.at(-1);
  if (
    !["entry.js", "entry.cjs", "entry.mjs", "index.js", "index.cjs", "index.mjs"].includes(
      file ?? "",
    )
  ) {
    return false;
  }
  const parent = segments.at(-2);
  if (parent !== "dist") {
    return false;
  }
  if (pathSegmentsIncludeOpenClawPackage(segments.slice(0, -2))) {
    return true;
  }
  return (
    !tokenPathLooksAbsolute(value) &&
    pathSegmentsIncludeOpenClawPackage(splitCommandPathSegments(cwd))
  );
}

const NODE_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-e",
  "-p",
  "-r",
  "--conditions",
  "--env-file",
  "--env-file-if-exists",
  "--experimental-config-file",
  "--eval",
  "--import",
  "--loader",
  "--print",
  "--require",
]);

function nodeOptionConsumesValue(arg: string): boolean {
  if (arg === "-e" || arg === "-p" || arg === "-r" || arg === "-C") {
    return true;
  }
  if (/^-[eprC].+/u.test(arg)) {
    return false;
  }
  const equalsIndex = arg.indexOf("=");
  const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
  return NODE_OPTIONS_WITH_VALUE.has(flag) && equalsIndex === -1;
}

function nodeOptionDisablesScriptPath(arg: string): boolean {
  return (
    arg === "-e" ||
    arg === "-p" ||
    arg.startsWith("-e") ||
    arg.startsWith("-p") ||
    arg === "--eval" ||
    arg.startsWith("--eval=") ||
    arg === "--print" ||
    arg.startsWith("--print=")
  );
}

function findOpenClawNodeCliOffset(argv: readonly string[], cwd?: string): number | null {
  let index = 1;
  let sawUnknownOption = false;
  while (index < argv.length) {
    const arg = argv[index];
    if (!arg) {
      index += 1;
      continue;
    }
    if (arg === "--") {
      index += 1;
      break;
    }
    if (!arg.startsWith("-")) {
      break;
    }
    if (nodeOptionDisablesScriptPath(arg)) {
      return null;
    }
    const consumesValue = nodeOptionConsumesValue(arg);
    sawUnknownOption ||= !consumesValue;
    index += consumesValue ? 2 : 1;
  }
  const script = argv[index];
  if (
    normalizeCommandName(script) === "openclaw" ||
    tokenLooksLikeOpenClawNodeEntrypoint(script, cwd)
  ) {
    return index;
  }
  if (sawUnknownOption) {
    for (let candidate = index + 1; candidate < argv.length; candidate += 1) {
      if (tokenLooksLikeOpenClawNodeEntrypoint(argv[candidate], cwd)) {
        return candidate;
      }
    }
  }
  return null;
}

function packageRunnerOptionConsumesValue(arg: string): boolean {
  const equalsIndex = arg.indexOf("=");
  const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
  return PACKAGE_RUNNER_OPTIONS_WITH_VALUE.has(flag) && equalsIndex === -1;
}

function firstPackageRunnerOperandIndex(argv: readonly string[], offset: number): number | null {
  let index = offset;
  while (index < argv.length) {
    const arg = argv[index];
    if (!arg) {
      index += 1;
      continue;
    }
    if (arg === "--") {
      return index + 1 < argv.length ? index + 1 : null;
    }
    if (!arg.startsWith("-")) {
      return index;
    }
    index += packageRunnerOptionConsumesValue(arg) ? 2 : 1;
  }
  return null;
}

function findPackageRunnerExecutableOffset(argv: readonly string[]): number | null {
  const command = normalizeCommandName(argv[0]);
  if (!OPENCLAW_PACKAGE_RUNNER_COMMANDS.has(command) || command === "corepack") {
    return null;
  }
  const firstOperand = firstPackageRunnerOperandIndex(argv, 1);
  if (firstOperand === null) {
    return null;
  }
  const subcommand = normalizeLowercaseStringOrEmpty(argv[firstOperand]);
  if (command === "npm" && !PACKAGE_RUNNER_EXEC_SUBCOMMANDS.has(subcommand)) {
    return null;
  }
  if (PACKAGE_RUNNER_EXEC_SUBCOMMANDS.has(subcommand)) {
    return firstPackageRunnerOperandIndex(argv, firstOperand + 1);
  }
  return firstOperand;
}

function tokenLooksLikeOpenClawCli(value: string | undefined, cwd?: string): boolean {
  return (
    normalizeCommandName(value) === "openclaw" ||
    shellGlobMayMatchCandidates(normalizeCommandName(value), ["openclaw"]) ||
    tokenLooksLikeOpenClawPackageSpec(value) ||
    tokenLooksLikeOpenClawNodeEntrypoint(value, cwd)
  );
}

function findOpenClawCliOffsets(argv: readonly string[], cwd?: string): number[] {
  const command = normalizeCommandName(argv[0]);
  if (command === "openclaw" || shellGlobMayMatchCandidates(command, ["openclaw"])) {
    return [0];
  }
  if (command === "node") {
    const offset = findOpenClawNodeCliOffset(argv, cwd);
    return offset === null ? [] : [offset];
  }
  if (!OPENCLAW_CLI_CARRIER_COMMANDS.has(command)) {
    return [];
  }
  if (command === "corepack") {
    const managerOffset = firstPackageRunnerOperandIndex(argv, 1);
    if (managerOffset === null) {
      return [];
    }
    return findOpenClawCliOffsets(argv.slice(managerOffset), cwd).map(
      (offset) => managerOffset + offset,
    );
  }
  const executableOffset = findPackageRunnerExecutableOffset(argv);
  if (executableOffset !== null && tokenLooksLikeOpenClawCli(argv[executableOffset], cwd)) {
    return [executableOffset];
  }
  if (executableOffset !== null && argv[executableOffset - 1]?.startsWith("-")) {
    const boundaryOffset = argv.indexOf("--", executableOffset + 1);
    const boundaryExecutableOffset = boundaryOffset === -1 ? null : boundaryOffset + 1;
    if (
      boundaryExecutableOffset !== null &&
      tokenLooksLikeOpenClawCli(argv[boundaryExecutableOffset], cwd)
    ) {
      return [boundaryExecutableOffset];
    }
  }
  return [];
}

function packageRunnerPrefixHasUnknownOption(
  argv: readonly string[],
  endExclusive: number,
): boolean {
  for (let index = 1; index < endExclusive; index += 1) {
    const arg = argv[index];
    if (!arg || arg === "--" || !arg.startsWith("-")) {
      continue;
    }
    if (PACKAGE_RUNNER_STANDALONE_OPTIONS.has(arg) || arg.includes("=")) {
      continue;
    }
    if (packageRunnerOptionConsumesValue(arg)) {
      index += 1;
      continue;
    }
    return true;
  }
  return false;
}

function packageRunnerArgvMayHideOpenClawLifecycle(argv: readonly string[], cwd?: string): boolean {
  if (!OPENCLAW_PACKAGE_RUNNER_COMMANDS.has(normalizeCommandName(argv[0]))) {
    return false;
  }
  for (let index = 1; index < argv.length; index += 1) {
    if (
      !tokenLooksLikeOpenClawCli(argv[index], cwd) ||
      !packageRunnerPrefixHasUnknownOption(argv, index)
    ) {
      continue;
    }
    if (segmentIsOpenClawCliLifecycleMutation(argv.slice(index), cwd)) {
      return true;
    }
  }
  return false;
}

function consumeOpenClawGatewayRunOptionToken(argv: readonly string[], offset: number): number {
  const arg = argv[offset];
  if (!arg || arg === "--" || !arg.startsWith("-")) {
    return 0;
  }
  const equalsIndex = arg.indexOf("=");
  const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
  if (OPENCLAW_GATEWAY_RUN_BOOLEAN_FLAGS.has(flag)) {
    return equalsIndex === -1 ? 1 : 0;
  }
  if (!OPENCLAW_GATEWAY_RUN_VALUE_FLAGS.has(flag)) {
    return 0;
  }
  if (equalsIndex !== -1) {
    return arg.slice(equalsIndex + 1).trim() ? 1 : 0;
  }
  return offset + 1 < argv.length ? 2 : 1;
}

function consumeOpenClawGatewayCallOptionToken(argv: readonly string[], offset: number): number {
  const arg = argv[offset];
  if (!arg || arg === "--" || !arg.startsWith("-")) {
    return 0;
  }
  const equalsIndex = arg.indexOf("=");
  const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
  if (OPENCLAW_GATEWAY_CALL_BOOLEAN_FLAGS.has(flag)) {
    return equalsIndex === -1 ? 1 : 0;
  }
  if (!OPENCLAW_GATEWAY_CALL_VALUE_FLAGS.has(flag)) {
    return 0;
  }
  if (equalsIndex !== -1) {
    return arg.slice(equalsIndex + 1).trim() ? 1 : 0;
  }
  return offset + 1 < argv.length ? 2 : 1;
}

function findOpenClawGatewayCallMethod(
  argv: readonly string[],
  offset: number,
): string | undefined {
  let index = offset;
  while (index < argv.length) {
    const arg = argv[index];
    if (!arg) {
      index += 1;
      continue;
    }
    if (arg === "--") {
      return argv[index + 1];
    }
    const globalConsumed = consumeOpenClawGlobalOptionToken(argv, index);
    if (globalConsumed > 0) {
      index += globalConsumed;
      continue;
    }
    const consumed = consumeOpenClawGatewayCallOptionToken(argv, index);
    if (consumed > 0) {
      index += consumed;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

function segmentIsOpenClawGatewayCallLifecycleMutation(
  argv: readonly string[],
  offset: number,
): boolean {
  const method = findOpenClawGatewayCallMethod(argv, offset);
  return (
    OPENCLAW_GATEWAY_CALL_LIFECYCLE_METHODS.has(normalizeLowercaseStringOrEmpty(method)) ||
    textContainsCommandSubstitution(method)
  );
}

function openClawGatewayArgvHasNonExecToken(argv: readonly string[], offset: number): boolean {
  const callMode = normalizeLowercaseStringOrEmpty(argv[offset]) === "call";
  for (let index = offset; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      return false;
    }
    const globalConsumed = consumeOpenClawGlobalOptionToken(argv, index);
    if (globalConsumed > 0) {
      index += globalConsumed - 1;
      continue;
    }
    if (OPENCLAW_GATEWAY_NON_EXEC_TOKENS.has(normalizeLowercaseStringOrEmpty(arg))) {
      return true;
    }
    const consumed = callMode
      ? consumeOpenClawGatewayCallOptionToken(argv, index)
      : consumeOpenClawGatewayRunOptionToken(argv, index);
    if (consumed > 0) {
      index += consumed - 1;
    }
  }
  return false;
}

function segmentIsOpenClawGatewayForegroundLifecycleMutation(
  argv: readonly string[],
  offset: number,
): boolean {
  let index = offset;
  let sawRun = false;
  let sawRuntimeSurface = false;
  while (index < argv.length) {
    const arg = argv[index];
    if (!arg) {
      index += 1;
      continue;
    }
    const normalized = normalizeLowercaseStringOrEmpty(arg);
    if (OPENCLAW_GATEWAY_NON_EXEC_TOKENS.has(normalized)) {
      return false;
    }
    if (arg === "--") {
      return sawRun || sawRuntimeSurface || index === offset;
    }
    const globalConsumed = consumeOpenClawGlobalOptionToken(argv, index);
    if (globalConsumed > 0) {
      index += globalConsumed;
      continue;
    }
    if (!sawRun && normalized === "run") {
      sawRun = true;
      sawRuntimeSurface = true;
      index += 1;
      continue;
    }
    if (!sawRun && normalized === "call") {
      return segmentIsOpenClawGatewayCallLifecycleMutation(argv, index + 1);
    }
    if (!sawRun && OPENCLAW_GATEWAY_READ_ONLY_SUBCOMMANDS.has(normalized)) {
      return false;
    }
    if (OPENCLAW_CLI_LIFECYCLE_ACTIONS.has(normalized) || textContainsCommandSubstitution(arg)) {
      return true;
    }
    const consumed = consumeOpenClawGatewayRunOptionToken(argv, index);
    if (consumed > 0) {
      sawRuntimeSurface = true;
      index += consumed;
      continue;
    }
    if (arg.startsWith("-")) {
      sawRuntimeSurface = true;
      index += 1;
      continue;
    }
    return false;
  }
  return sawRun || sawRuntimeSurface || index === offset;
}

function consumeOpenClawUpdateOptionToken(argv: readonly string[], offset: number): number {
  const arg = argv[offset];
  if (!arg || arg === "--" || !arg.startsWith("-")) {
    return 0;
  }
  const equalsIndex = arg.indexOf("=");
  const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
  if (OPENCLAW_UPDATE_DRY_RUN_OPTIONS.has(flag)) {
    return equalsIndex === -1 ? 1 : 0;
  }
  if (!OPENCLAW_UPDATE_OPTIONS_WITH_VALUE.has(flag)) {
    return 0;
  }
  if (equalsIndex !== -1) {
    return arg.slice(equalsIndex + 1).trim() ? 1 : 0;
  }
  return offset + 1 < argv.length ? 2 : 1;
}

function segmentIsOpenClawUpdateLifecycleMutation(
  argv: readonly string[],
  offset: number,
): boolean {
  for (let scanIndex = offset; scanIndex < argv.length; scanIndex += 1) {
    const arg = argv[scanIndex];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      break;
    }
    const globalConsumed = consumeOpenClawGlobalOptionToken(argv, scanIndex);
    if (globalConsumed > 0) {
      scanIndex += globalConsumed - 1;
      continue;
    }
    if (OPENCLAW_UPDATE_NON_EXEC_TOKENS.has(normalizeLowercaseStringOrEmpty(arg))) {
      return false;
    }
    const updateConsumed = consumeOpenClawUpdateOptionToken(argv, scanIndex);
    if (updateConsumed > 0) {
      scanIndex += updateConsumed - 1;
    }
  }
  let index = offset;
  let sawDryRun = false;
  while (index < argv.length) {
    const arg = argv[index];
    if (!arg) {
      index += 1;
      continue;
    }
    const normalized = normalizeLowercaseStringOrEmpty(arg);
    const globalConsumed = consumeOpenClawGlobalOptionToken(argv, index);
    if (globalConsumed > 0) {
      index += globalConsumed;
      continue;
    }
    if (OPENCLAW_UPDATE_NON_EXEC_TOKENS.has(normalized)) {
      return false;
    }
    if (arg === "--") {
      return !sawDryRun;
    }
    if (OPENCLAW_UPDATE_READ_ONLY_SUBCOMMANDS.has(normalized)) {
      return false;
    }
    if (OPENCLAW_UPDATE_MUTATING_SUBCOMMANDS.has(normalized)) {
      return true;
    }
    const consumed = consumeOpenClawUpdateOptionToken(argv, index);
    if (consumed > 0) {
      if (OPENCLAW_UPDATE_DRY_RUN_OPTIONS.has(normalized)) {
        sawDryRun = true;
      }
      index += consumed;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    return !sawDryRun;
  }
  return !sawDryRun;
}

function segmentIsOpenClawUninstallLifecycleMutation(
  argv: readonly string[],
  offset: number,
): boolean {
  for (let index = offset; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    const globalConsumed = consumeOpenClawGlobalOptionToken(argv, index);
    if (globalConsumed > 0) {
      index += globalConsumed - 1;
      continue;
    }
    const normalized = normalizeLowercaseStringOrEmpty(arg);
    if (OPENCLAW_UNINSTALL_NON_EXEC_TOKENS.has(normalized)) {
      return false;
    }
    if (OPENCLAW_UNINSTALL_DRY_RUN_OPTIONS.has(normalized)) {
      return false;
    }
  }
  return true;
}

function segmentIsOpenClawCliLifecycleMutation(argv: readonly string[], cwd?: string): boolean {
  if (packageRunnerArgvMayHideOpenClawLifecycle(argv, cwd)) {
    return true;
  }
  for (const cliOffset of findOpenClawCliOffsets(argv, cwd)) {
    const offset = skipOpenClawArgvSeparator(argv, skipOpenClawGlobalOptions(argv, cliOffset + 1));
    const areaArg = argv[offset];
    const area = normalizeLowercaseStringOrEmpty(areaArg);
    const actionOffset = skipOpenClawGlobalOptions(argv, offset + 1);
    if (tokenEqualsOrGlobsCandidate(areaArg, ["gateway"])) {
      if (openClawGatewayArgvHasNonExecToken(argv, actionOffset)) {
        continue;
      }
      if (
        tokenEqualsOrGlobsCandidate(argv[actionOffset], [...OPENCLAW_CLI_LIFECYCLE_ACTIONS]) ||
        textContainsCommandSubstitution(argv[actionOffset]) ||
        segmentIsOpenClawGatewayForegroundLifecycleMutation(argv, actionOffset)
      ) {
        return true;
      }
      continue;
    }
    if (
      tokenEqualsOrGlobsCandidate(areaArg, ["daemon"]) &&
      !argv
        .slice(actionOffset)
        .some((token) =>
          OPENCLAW_GATEWAY_NON_EXEC_TOKENS.has(normalizeLowercaseStringOrEmpty(token)),
        ) &&
      (tokenEqualsOrGlobsCandidate(argv[actionOffset], [...OPENCLAW_CLI_LIFECYCLE_ACTIONS]) ||
        textContainsCommandSubstitution(argv[actionOffset]))
    ) {
      return true;
    }
    if (
      tokenEqualsOrGlobsCandidate(areaArg, ["onboard", "setup"]) &&
      argv.slice(actionOffset).some((token) => OPENCLAW_DAEMON_INSTALL_OPTIONS.has(token)) &&
      !argv
        .slice(actionOffset)
        .some((token) =>
          OPENCLAW_GATEWAY_NON_EXEC_TOKENS.has(normalizeLowercaseStringOrEmpty(token)),
        )
    ) {
      return true;
    }
    if (
      textContainsCommandSubstitution(argv[offset]) &&
      tokenCouldBeOpenClawLifecycleAction(argv[actionOffset])
    ) {
      return true;
    }
    if (
      tokenEqualsOrGlobsCandidate(areaArg, ["update"]) &&
      segmentIsOpenClawUpdateLifecycleMutation(argv, actionOffset)
    ) {
      return true;
    }
    if (area === "--update" && segmentIsOpenClawUpdateLifecycleMutation(argv, offset + 1)) {
      return true;
    }
    if (
      tokenEqualsOrGlobsCandidate(areaArg, ["uninstall"]) &&
      segmentIsOpenClawUninstallLifecycleMutation(argv, actionOffset)
    ) {
      return true;
    }
  }
  return false;
}

function firstNonOptionArgIndex(argv: readonly string[], offset: number): number | null {
  let next = offset;
  while (next < argv.length) {
    const arg = argv[next];
    if (!arg) {
      next += 1;
      continue;
    }
    if (arg === "--") {
      return next + 1 < argv.length ? next + 1 : null;
    }
    if (!arg.startsWith("-")) {
      return next;
    }
    next += 1;
  }
  return null;
}

function firstSystemctlActionArgIndex(argv: readonly string[], offset: number): number | null {
  let next = offset;
  while (next < argv.length) {
    const arg = argv[next];
    if (!arg) {
      next += 1;
      continue;
    }
    if (arg === "--") {
      return next + 1 < argv.length ? next + 1 : null;
    }
    if (SYSTEMCTL_NON_EXEC_OPTIONS.has(arg)) {
      return null;
    }
    if (!arg.startsWith("-")) {
      return next;
    }
    if (SYSTEMCTL_OPTIONS_WITH_VALUE.has(arg)) {
      next += 2;
      continue;
    }
    const shortOptions = analyzeSystemctlShortOptionCluster(arg);
    if (shortOptions === "non-exec") {
      return null;
    }
    if (shortOptions === "consume-next") {
      next += 2;
      continue;
    }
    if (shortOptions === "self-contained") {
      next += 1;
      continue;
    }
    if (SYSTEMCTL_INLINE_OPTIONS_WITH_VALUE.test(arg)) {
      next += 1;
      continue;
    }
    next += 1;
  }
  return null;
}

function analyzeSystemctlShortOptionCluster(
  arg: string,
): "consume-next" | "non-exec" | "self-contained" | null {
  if (!arg.startsWith("-") || arg.startsWith("--") || arg.length < 3) {
    return null;
  }
  const cluster = arg.slice(1);
  for (let index = 0; index < cluster.length; index += 1) {
    const option = cluster[index] ?? "";
    if (option === "h") {
      return "non-exec";
    }
    if (SYSTEMCTL_SHORT_OPTIONS_WITH_VALUE.has(option)) {
      return index === cluster.length - 1 ? "consume-next" : "self-contained";
    }
  }
  return "self-contained";
}

function systemctlArgIsNonExecOption(arg: string): boolean {
  return (
    SYSTEMCTL_NON_EXEC_OPTIONS.has(arg) || analyzeSystemctlShortOptionCluster(arg) === "non-exec"
  );
}

function argvTargetsMayMentionOpenClaw(
  argv: readonly string[],
  actionIndex: number | null,
): boolean {
  if (actionIndex === null) {
    return false;
  }
  const targetArgv = argv.slice(actionIndex + 1);
  return (
    argvMentionsOpenClawLifecycleTarget(targetArgv) ||
    targetArgv.some(textContainsVariableReference)
  );
}

function argvSystemctlTargetsMayMentionOpenClaw(
  argv: readonly string[],
  actionIndex: number | null,
): boolean {
  if (actionIndex === null) {
    return false;
  }
  const targets: string[] = [];
  for (let index = actionIndex + 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      targets.push(...argv.slice(index + 1));
      break;
    }
    if (SYSTEMCTL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (SYSTEMCTL_INLINE_OPTIONS_WITH_VALUE.test(arg) || arg.startsWith("-")) {
      continue;
    }
    targets.push(arg);
  }
  return targets.some(
    (target) =>
      textContainsActiveVariableReference(target) ||
      textContainsCommandSubstitution(target) ||
      systemdGlobMayMatchOpenClawUnit(target),
  );
}

function argvProcessTargetsMayMentionOpenClaw(argv: readonly string[]): boolean {
  const command = normalizeCommandName(normalizePowerShellBacktickEscapes(argv[0] ?? ""));
  const targets: Array<{ allowLiteralName: boolean; value: string }> = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      if (command !== "spps" && command !== "stop-process" && command !== "taskkill") {
        targets.push(
          ...argv.slice(index + 1).map((value) => ({
            allowLiteralName: command === "pkill" || command === "killall",
            value,
          })),
        );
      }
      break;
    }
    if (command === "spps" || command === "stop-process") {
      const colonIndex = arg.indexOf(":");
      const option = resolvePowerShellOptionAbbreviation(
        colonIndex === -1 ? arg : arg.slice(0, colonIndex),
        POWERSHELL_SELECTOR_KNOWN_OPTIONS,
      );
      if (option === "-name") {
        const inlineTarget = colonIndex === -1 ? undefined : arg.slice(colonIndex + 1);
        if (inlineTarget) {
          targets.push({
            allowLiteralName: true,
            value: normalizePowerShellLifecycleTarget(inlineTarget),
          });
        } else if (argv[index + 1]) {
          targets.push({
            allowLiteralName: true,
            value: normalizePowerShellLifecycleTarget(argv[index + 1] ?? ""),
          });
          index += 1;
        }
        continue;
      }
      if (option === "-inputobject") {
        const inlineTarget = colonIndex === -1 ? undefined : arg.slice(colonIndex + 1);
        const target = inlineTarget || argv[index + 1];
        if (target) {
          targets.push({ allowLiteralName: false, value: target });
          if (!inlineTarget) {
            index += 1;
          }
        }
        continue;
      }
      if (
        option !== null &&
        POWERSHELL_SELECTOR_NON_TARGET_OPTIONS_WITH_VALUE.has(option) &&
        colonIndex === -1
      ) {
        index += 1;
        continue;
      }
      if (!arg.startsWith("-")) {
        continue;
      }
    }
    if (command === "taskkill") {
      const normalized = normalizeLowercaseStringOrEmpty(arg);
      const inlineTarget = arg.match(/^\/(?:im|pid|fi)(?::|=)(.*)$/i);
      if (inlineTarget?.[1]) {
        targets.push({
          allowLiteralName: normalized.startsWith("/im") || normalized.startsWith("/fi"),
          value: inlineTarget[1],
        });
        continue;
      }
      if (["/im", "/pid", "/fi"].includes(normalized)) {
        const target = argv[index + 1];
        if (target) {
          targets.push({
            allowLiteralName: normalized === "/im" || normalized === "/fi",
            value: target,
          });
          index += 1;
        }
        continue;
      }
      if (arg.startsWith("/")) {
        continue;
      }
    }
    if (processLifecycleOptionConsumesValue(command, arg)) {
      index += 1;
      continue;
    }
    if (processLifecycleInlineOptionConsumesValue(command, arg)) {
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    targets.push({
      allowLiteralName: command === "pkill" || command === "killall",
      value: arg,
    });
  }
  return targets.some(
    (target) =>
      textContainsActiveVariableReference(target.value) ||
      processTargetCommandSubstitutionMayMentionOpenClaw(target.value) ||
      (target.allowLiteralName &&
        (command === "spps" || command === "stop-process"
          ? powershellPatternMayMatchOpenClawProcess(target.value)
          : command === "pkill" ||
              (command === "killall" && argv.some((arg) => arg === "-r" || arg === "--regexp"))
            ? processPatternMayMatchOpenClaw(target.value)
            : tokenMentionsOpenClawLifecycleTarget(target.value))),
  );
}

function processTargetCommandSubstitutionMayMentionOpenClaw(target: string): boolean {
  for (const match of target.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const payload = match[1] ?? match[2];
    const lookupArgv = payload ? splitShellArgs(payload) : null;
    if (!lookupArgv || lookupArgv.length < 2) {
      continue;
    }
    const lookupCommand = normalizeCommandName(lookupArgv[0]);
    if (
      (lookupCommand === "pgrep" &&
        argvProcessTargetsMayMentionOpenClaw(["pkill", ...lookupArgv.slice(1)])) ||
      (lookupCommand === "pidof" && argvMentionsOpenClawLifecycleTarget(lookupArgv.slice(1))) ||
      (lookupCommand === "cat" &&
        lookupArgv.slice(1).some((arg) => /(?:^|[\\/])openclaw[^\\/]*\.pid$/iu.test(arg))) ||
      (lookupCommand === "ps" &&
        shellTextTopLevelPipelines(payload ?? "").some((pipeline) =>
          pipeline.slice(1).some((part) => processFilterTextMayMentionOpenClaw(part)),
        ))
    ) {
      return true;
    }
  }
  return false;
}

function processLifecycleCommandUsesSignalZero(argv: readonly string[]): boolean {
  const command = normalizeCommandName(argv[0]);
  if (command !== "kill" && command !== "pkill" && command !== "killall") {
    return false;
  }
  const signals: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = normalizeLowercaseStringOrEmpty(argv[index]);
    if (arg === "--") {
      break;
    }
    if (arg === "-0") {
      signals.push("0");
      continue;
    }
    if (arg.startsWith("--signal=")) {
      signals.push(arg.slice("--signal=".length));
      continue;
    }
    if ((command === "kill" || command === "killall") && /^-s.+/.test(arg)) {
      signals.push(arg.slice(2));
      continue;
    }
    if (
      ((command === "kill" || command === "killall") && arg === "-s") ||
      arg === "--signal" ||
      (command === "kill" && arg === "-n")
    ) {
      signals.push(normalizeLowercaseStringOrEmpty(argv[index + 1]));
      index += 1;
    }
  }
  return signals.length === 1 && signals[0] === "0";
}

function systemctlKillUsesSignalZero(argv: readonly string[]): boolean {
  if (normalizeCommandName(argv[0]) !== "systemctl") {
    return false;
  }
  const actionIndex = firstSystemctlActionArgIndex(argv, 1);
  if (normalizeLowercaseStringOrEmpty(argv[actionIndex ?? -1]) !== "kill") {
    return false;
  }
  const signals: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = normalizeLowercaseStringOrEmpty(argv[index]);
    if (arg === "--") {
      break;
    }
    if (arg.startsWith("--signal=")) {
      signals.push(arg.slice("--signal=".length));
      continue;
    }
    if (/^-s.+/.test(arg)) {
      signals.push(arg.slice(2));
      continue;
    }
    if (arg === "-s" || arg === "--signal") {
      signals.push(normalizeLowercaseStringOrEmpty(argv[index + 1]));
      index += 1;
    }
  }
  return signals.length === 1 && signals[0] === "0";
}

function powershellCommandIsWhatIfPreview(argv: readonly string[]): boolean {
  return argv.some((arg) => {
    const colonIndex = arg.indexOf(":");
    const option = resolvePowerShellOptionAbbreviation(
      colonIndex === -1 ? arg : arg.slice(0, colonIndex),
      POWERSHELL_COMMON_OPTIONS,
    );
    if (option !== "-whatif") {
      return false;
    }
    const normalized = normalizeLowercaseStringOrEmpty(arg);
    return colonIndex === -1 || normalized.endsWith(":$true") || normalized.endsWith(":true");
  });
}

function processLifecycleOptionConsumesValue(command: string, token: string): boolean {
  if (command === "kill") {
    return KILL_OPTIONS_WITH_VALUE.has(token);
  }
  if (command === "pkill") {
    return PKILL_OPTIONS_WITH_VALUE.has(token);
  }
  if (command === "killall") {
    return KILLALL_OPTIONS_WITH_VALUE.has(token);
  }
  return false;
}

function processLifecycleInlineOptionConsumesValue(command: string, token: string): boolean {
  if (command === "kill") {
    return /^-(?:[A-Za-z]+|\d+)$/.test(token) || /^--(?:signal|queue)=/.test(token);
  }
  if (command === "pkill") {
    return /^--(?:pgroup|group|parent|session|terminal|euid|uid|signal)=/.test(token);
  }
  if (command === "killall") {
    return /^--(?:signal|user|older-than|younger-than)=/.test(token);
  }
  return false;
}

function launchctlNestedCommandArgv(
  argv: readonly string[],
  actionIndex: number,
  action: string,
): readonly string[] | null {
  if (action === "asuser" || action === "bsexec") {
    const nestedOffset = actionIndex + 2;
    return nestedOffset < argv.length ? argv.slice(nestedOffset) : null;
  }
  if (action === "submit") {
    const boundaryIndex = argv.indexOf("--", actionIndex + 1);
    return boundaryIndex !== -1 && boundaryIndex + 1 < argv.length
      ? argv.slice(boundaryIndex + 1)
      : null;
  }
  return null;
}

function launchctlSubmitLabel(argv: readonly string[], actionIndex: number): string | undefined {
  for (let index = actionIndex + 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || arg === "--") {
      break;
    }
    if (arg === "-l") {
      return argv[index + 1];
    }
    if (arg.startsWith("-l") && arg.length > 2) {
      return arg.slice(2);
    }
  }
  return undefined;
}

function segmentIsLaunchctlLifecycleMutation(argv: readonly string[]): boolean {
  if (normalizeCommandName(argv[0]) !== "launchctl") {
    return false;
  }
  const actionIndex = firstNonOptionArgIndex(argv, 1);
  const action = normalizeLowercaseStringOrEmpty(
    actionIndex === null ? undefined : argv[actionIndex],
  );
  if (actionIndex !== null) {
    const nestedArgv = launchctlNestedCommandArgv(argv, actionIndex, action);
    if (nestedArgv && segmentIsOpenClawLifecycleMutation(nestedArgv)) {
      return true;
    }
    if (action === "submit") {
      const label = launchctlSubmitLabel(argv, actionIndex);
      return (
        textContainsActiveVariableReference(label) || tokenMentionsOpenClawLifecycleTarget(label)
      );
    }
  }
  return LAUNCHCTL_LIFECYCLE_ACTIONS.has(action) && argvMentionsOpenClawLifecycleTarget(argv);
}

function segmentIsSystemctlLifecycleMutation(argv: readonly string[]): boolean {
  if (normalizeCommandName(argv[0]) !== "systemctl") {
    return false;
  }
  const actionIndex = firstSystemctlActionArgIndex(argv, 1);
  const action = normalizeLowercaseStringOrEmpty(
    actionIndex === null ? undefined : argv[actionIndex],
  );
  if (actionIndex !== null) {
    if (action === "kill" && systemctlKillUsesSignalZero(argv)) {
      return false;
    }
    return (
      SYSTEMCTL_LIFECYCLE_ACTIONS.has(action) &&
      argvSystemctlTargetsMayMentionOpenClaw(argv, actionIndex)
    );
  }
  if (argv.some(systemctlArgIsNonExecOption)) {
    return false;
  }
  for (let index = 1; index < argv.length; index += 1) {
    if (
      SYSTEMCTL_LIFECYCLE_ACTIONS.has(normalizeLowercaseStringOrEmpty(argv[index])) &&
      argvSystemctlTargetsMayMentionOpenClaw(argv, index)
    ) {
      return true;
    }
    const arg = argv[index];
    if (arg && SYSTEMCTL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
    }
  }
  return false;
}

function segmentIsServiceLifecycleMutation(argv: readonly string[]): boolean {
  if (normalizeCommandName(argv[0]) !== "service") {
    return false;
  }
  const unitIndex = firstNonOptionArgIndex(argv, 1);
  const actionIndex = unitIndex === null ? null : firstNonOptionArgIndex(argv, unitIndex + 1);
  const action = normalizeLowercaseStringOrEmpty(
    actionIndex === null ? undefined : argv[actionIndex],
  );
  const unit = unitIndex === null ? undefined : argv[unitIndex];
  return (
    SERVICE_LIFECYCLE_ACTIONS.has(action) &&
    (textContainsActiveVariableReference(unit) || systemdGlobMayMatchOpenClawUnit(unit ?? ""))
  );
}

function segmentIsPowerShellServiceLifecycleMutation(argv: readonly string[]): boolean {
  const command = normalizeCommandName(normalizePowerShellBacktickEscapes(argv[0] ?? ""));
  if (
    !POWERSHELL_SERVICE_LIFECYCLE_COMMANDS.has(command) ||
    powershellCommandIsWhatIfPreview(argv)
  ) {
    return false;
  }
  const targets: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (!arg.startsWith("-")) {
      targets.push(normalizePowerShellLifecycleTarget(arg));
      continue;
    }
    const colonIndex = arg.indexOf(":");
    const option = resolvePowerShellOptionAbbreviation(
      colonIndex === -1 ? arg : arg.slice(0, colonIndex),
      POWERSHELL_SERVICE_KNOWN_OPTIONS,
    );
    if (option !== null && POWERSHELL_SERVICE_TARGET_OPTIONS.has(option)) {
      const inlineTarget = colonIndex === -1 ? undefined : arg.slice(colonIndex + 1);
      if (inlineTarget) {
        targets.push(normalizePowerShellLifecycleTarget(inlineTarget));
      } else if (argv[index + 1]) {
        targets.push(normalizePowerShellLifecycleTarget(argv[index + 1] ?? ""));
        index += 1;
      }
      continue;
    }
    if (option !== null && POWERSHELL_SERVICE_OPTIONS_WITH_VALUE.has(option) && colonIndex === -1) {
      index += 1;
    }
  }
  return targets.some(
    (target) =>
      textContainsActiveVariableReference(target) ||
      powershellPatternMayMatchOpenClawService(target),
  );
}

function segmentIsWindowsScServiceLifecycleMutation(argv: readonly string[]): boolean {
  if (normalizeCommandName(argv[0]) !== "sc") {
    return false;
  }
  let actionIndex = 1;
  if (argv[actionIndex]?.startsWith("\\\\")) {
    actionIndex += 1;
  }
  const action = normalizeLowercaseStringOrEmpty(argv[actionIndex]);
  const target = argv[actionIndex + 1];
  return (
    WINDOWS_SC_LIFECYCLE_ACTIONS.has(action) &&
    (textContainsActiveVariableReference(target) || tokenMentionsOpenClawLifecycleTarget(target))
  );
}

function segmentIsWindowsNetServiceLifecycleMutation(argv: readonly string[]): boolean {
  if (normalizeCommandName(argv[0]) !== "net") {
    return false;
  }
  const action = normalizeLowercaseStringOrEmpty(argv[1]);
  const target = argv[2];
  return (
    WINDOWS_NET_SERVICE_LIFECYCLE_ACTIONS.has(action) &&
    (textContainsActiveVariableReference(target) || tokenMentionsOpenClawLifecycleTarget(target))
  );
}

function schtasksTaskTarget(argv: readonly string[]): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const normalized = normalizeLowercaseStringOrEmpty(arg);
    if (normalized === "/tn") {
      return argv[index + 1];
    }
    const inlineTarget = arg?.match(/^\/tn(?::|=)(.*)$/i)?.[1];
    if (inlineTarget !== undefined) {
      return inlineTarget;
    }
  }
  return undefined;
}

function segmentIsSchtasksLifecycleMutation(argv: readonly string[]): boolean {
  if (normalizeCommandName(argv[0]) !== "schtasks") {
    return false;
  }
  const target = schtasksTaskTarget(argv);
  return (
    argv.some((arg) => SCHTASKS_LIFECYCLE_ACTIONS.has(normalizeLowercaseStringOrEmpty(arg))) &&
    (textContainsActiveVariableReference(target) || tokenMentionsOpenClawLifecycleTarget(target))
  );
}

function processLifecycleCommandIsNonExecuting(argv: readonly string[]): boolean {
  const command = normalizeCommandName(argv[0]);
  if (!PROCESS_LIFECYCLE_COMMANDS.has(command)) {
    return false;
  }
  const optionBoundary = argv.indexOf("--", 1);
  const optionArgv = argv.slice(1, optionBoundary === -1 ? undefined : optionBoundary);
  const args = optionArgv.map(normalizeLowercaseStringOrEmpty);
  if (
    args.some((arg) => ["-?", "-h", "--help", "--version"].includes(arg)) ||
    optionArgv.includes("-V")
  ) {
    return true;
  }
  if (command === "taskkill" && args.includes("/?")) {
    return true;
  }
  return (
    (command === "kill" || command === "killall") &&
    args.some((arg) => ["-l", "--list", "-L", "--table"].includes(arg))
  );
}

function segmentIsProcessLifecycleMutation(argv: readonly string[]): boolean {
  const command = normalizeCommandName(argv[0]);
  return (
    PROCESS_LIFECYCLE_COMMANDS.has(command) &&
    !processLifecycleCommandIsNonExecuting(argv) &&
    !processLifecycleCommandUsesSignalZero(argv) &&
    !powershellCommandIsWhatIfPreview(argv) &&
    argvProcessTargetsMayMentionOpenClaw(argv)
  );
}

function segmentHasLifecycleStringPayload(argv: readonly string[]): boolean {
  const command = normalizeCommandName(argv[0]);
  if (command === "eval") {
    return commandTextMentionsOpenClawLifecycleMutation(argv.slice(1).join(" "));
  }
  if (argv.length === 1) {
    return commandTextMentionsOpenClawLifecycleMutation(argv[0] ?? "");
  }
  const inlineCommand =
    extractBindableShellWrapperInlineCommand([...argv]) ??
    extractShellWrapperInlineCommand([...argv]);
  const dialect: ShellCommandDialect =
    command === "cmd"
      ? "cmd"
      : command === "powershell" || command === "pwsh"
        ? "powershell"
        : "posix";
  if (
    inlineCommand !== null &&
    commandTextMentionsOpenClawLifecycleMutation(inlineCommand, dialect)
  ) {
    return true;
  }
  const carrierPayload = extractNpmExecCallPayload(argv);
  return carrierPayload !== null && commandTextMentionsOpenClawLifecycleMutation(carrierPayload);
}

function argvOnlyReadsLifecycleText(argv: readonly string[]): boolean {
  const command = normalizeCommandName(argv[0]);
  return (
    ["echo", "logger", "printf"].includes(command) ||
    (command === "git" && normalizeLowercaseStringOrEmpty(argv[1]) === "grep")
  );
}

function extractNpmExecCallPayload(argv: readonly string[]): string | null {
  const command = normalizeCommandName(argv[0]);
  let offset = 1;
  if (command === "npm") {
    const subcommand = normalizeLowercaseStringOrEmpty(argv[1]);
    if (subcommand !== "exec" && subcommand !== "x") {
      return null;
    }
    offset = 2;
  } else if (command !== "npx") {
    return null;
  }
  for (let index = offset; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "-c" || arg === "--call") {
      return argv[index + 1] ?? null;
    }
    if (arg.startsWith("--call=")) {
      return arg.slice("--call=".length);
    }
    if (arg.startsWith("-c") && arg.length > 2) {
      return arg.slice(2);
    }
  }
  return null;
}

function isEnvAssignmentToken(token: string | undefined): boolean {
  return typeof token === "string" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function isEnvOperandAssignmentToken(token: string | undefined, optionParsing = true): boolean {
  return (
    typeof token === "string" && token.includes("=") && (!optionParsing || !token.startsWith("-"))
  );
}

function expandShellVariableReferencesInText(
  value: string,
  env: NodeJS.ProcessEnv | undefined,
  envComplete: boolean,
  state: { sawVariable: boolean; sawUnknownVariable: boolean },
  depth = 0,
): string {
  if (depth > 4) {
    return value;
  }
  return value.replace(
    new RegExp(SHELL_VARIABLE_REFERENCE_GLOBAL_PATTERN.source, "g"),
    (
      _match,
      bracedName: string | undefined,
      operator: string | undefined,
      word: string | undefined,
      bareName: string | undefined,
    ) => {
      state.sawVariable = true;
      const name = bracedName ?? bareName ?? "";
      const hasValue = Object.hasOwn(env ?? {}, name);
      const rawValue = env?.[name];
      if (rawValue === ENV_SPLIT_UNKNOWN_ASSIGNMENT_VALUE) {
        state.sawUnknownVariable = true;
        return "";
      }
      const resolvedValue = hasValue ? restoreEnvSplitBackslashMarkers(rawValue ?? "") : undefined;
      if (operator && bracedName !== undefined) {
        const op = operator.at(-1);
        const hasUsableValue = operator.startsWith(":")
          ? resolvedValue !== undefined && resolvedValue !== ""
          : hasValue;
        const expandWord = () =>
          expandShellVariableReferencesInText(word ?? "", env, envComplete, state, depth + 1);
        if (op === "-" || op === "=") {
          if (hasUsableValue) {
            return resolvedValue ?? "";
          }
          if (!envComplete) {
            state.sawUnknownVariable = true;
          }
          return expandWord();
        }
        if (op === "+") {
          if (!hasUsableValue) {
            if (!envComplete) {
              state.sawUnknownVariable = true;
            }
            return "";
          }
          return expandWord();
        }
        if (op === "?") {
          if (hasUsableValue) {
            return resolvedValue ?? "";
          }
          if (!envComplete) {
            state.sawUnknownVariable = true;
          }
          return "";
        }
      }
      if (hasValue) {
        return resolvedValue ?? "";
      }
      if (!envComplete) {
        state.sawUnknownVariable = true;
      }
      return "";
    },
  );
}

function resolveShellExpandedAssignmentValue(
  value: string,
  env?: NodeJS.ProcessEnv,
): string | null {
  const state = { sawVariable: false, sawUnknownVariable: false };
  const resolved = expandShellVariableReferencesInText(value, env, false, state);
  if (state.sawUnknownVariable || /(^|[^\\])\$/.test(resolved)) {
    return null;
  }
  return resolved;
}

function collectShellPrefixAssignmentsFromRaw(
  raw: string | undefined,
  env?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | undefined {
  if (!raw) {
    return env;
  }
  const argv = splitShellArgs(raw);
  if (!argv) {
    return env;
  }
  return collectShellPrefixAssignmentsFromArgv(argv, env);
}

function collectShellPrefixAssignmentsFromArgv(
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | undefined {
  let nextEnv: NodeJS.ProcessEnv | undefined;
  for (const token of argv) {
    if (!isEnvAssignmentToken(token)) {
      break;
    }
    nextEnv ??= { ...env };
    const delimiter = token.indexOf("=");
    const key = token.slice(0, delimiter);
    const value = resolveShellExpandedAssignmentValue(token.slice(delimiter + 1), env);
    nextEnv[key] = value ?? ENV_SPLIT_UNKNOWN_ASSIGNMENT_VALUE;
  }
  return nextEnv ?? env;
}

function dropShellPrefixAssignments(argv: readonly string[]): readonly string[] {
  let offset = 0;
  while (offset < argv.length && isEnvAssignmentToken(argv[offset])) {
    offset += 1;
  }
  return argv.slice(offset);
}

function collectStandaloneShellAssignmentsFromArgv(
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | undefined {
  if (argv.length === 0) {
    return env;
  }
  if (normalizeCommandName(argv[0]) === "export") {
    let nextEnv: NodeJS.ProcessEnv | undefined;
    for (const token of argv.slice(1)) {
      if (!token || token === "--") {
        continue;
      }
      if (token.startsWith("-") || !isEnvAssignmentToken(token)) {
        return env;
      }
      nextEnv ??= { ...env };
      const delimiter = token.indexOf("=");
      const key = token.slice(0, delimiter);
      const value = resolveShellExpandedAssignmentValue(token.slice(delimiter + 1), env);
      nextEnv[key] = value ?? ENV_SPLIT_UNKNOWN_ASSIGNMENT_VALUE;
    }
    return nextEnv ?? env;
  }
  let nextEnv: NodeJS.ProcessEnv | undefined;
  for (const token of argv) {
    if (!isEnvAssignmentToken(token)) {
      return env;
    }
    nextEnv ??= { ...env };
    const delimiter = token.indexOf("=");
    const key = token.slice(0, delimiter);
    const value = resolveShellExpandedAssignmentValue(token.slice(delimiter + 1), env);
    nextEnv[key] = value ?? ENV_SPLIT_UNKNOWN_ASSIGNMENT_VALUE;
  }
  return nextEnv ?? env;
}

function removeShellVariableReferences(value: string): string {
  return value.replace(new RegExp(SHELL_VARIABLE_REFERENCE_SOURCE, "g"), "");
}

function fieldSplitExpandedShellArgv(
  argv: readonly string[],
  splitFlags?: readonly boolean[],
): string[] {
  return argv.flatMap((token, index) => {
    if (splitFlags?.[index] === false || !/\s/.test(token)) {
      return [token];
    }
    const split = token.trim().split(/\s+/).filter(Boolean);
    return split.length > 0 ? split : [token];
  });
}

function shellArgvUnquotedVariableFlags(value: string): boolean[] | null {
  const variableAtStart = new RegExp(`^(?:${SHELL_VARIABLE_REFERENCE_SOURCE})`);
  const flags: boolean[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let inToken = false;
  let tokenHasUnquotedVariable = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      inToken = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      inToken = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      inToken = true;
      continue;
    }
    if (/\s/.test(char ?? "")) {
      if (inToken) {
        flags.push(tokenHasUnquotedVariable);
        inToken = false;
        tokenHasUnquotedVariable = false;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inToken = true;
      continue;
    }
    if (char === "$" && variableAtStart.test(value.slice(index))) {
      tokenHasUnquotedVariable = true;
    }
    inToken = true;
  }
  if (quote || escaped) {
    return null;
  }
  if (inToken) {
    flags.push(tokenHasUnquotedVariable);
  }
  return flags;
}

function shellArgvActiveExpansionFlags(value: string): boolean[] | null {
  const flags: boolean[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let inToken = false;
  let tokenHasActiveExpansion = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      inToken = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      inToken = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (quote === '"' && (char === "$" || char === "`")) {
        tokenHasActiveExpansion = true;
      }
      inToken = true;
      continue;
    }
    if (/\s/u.test(char ?? "")) {
      if (inToken) {
        flags.push(tokenHasActiveExpansion);
        inToken = false;
        tokenHasActiveExpansion = false;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inToken = true;
      continue;
    }
    if (
      char === "$" ||
      char === "`" ||
      ((char === "<" || char === ">" || char === "=") && value[index + 1] === "(")
    ) {
      tokenHasActiveExpansion = true;
    }
    inToken = true;
  }
  if (quote || escaped) {
    return null;
  }
  if (inToken) {
    flags.push(tokenHasActiveExpansion);
  }
  return flags;
}

function maskInactiveShellExpansions(token: string): string {
  return token
    .replaceAll("$", ENV_SPLIT_LITERAL_DOLLAR_MARKER)
    .replaceAll("`", SHELL_LITERAL_BACKTICK_MARKER)
    .replaceAll(/([<>=])(?=\()/gu, SHELL_LITERAL_PROCESS_SUBSTITUTION_MARKER);
}

function collectSudoAssignmentsFromArgv(
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  let nextEnv: NodeJS.ProcessEnv | undefined;
  let offset = 1;
  while (offset < argv.length) {
    const arg = argv[offset];
    if (!arg) {
      offset += 1;
      continue;
    }
    if (arg === "--") {
      break;
    }
    if (isEnvAssignmentToken(arg)) {
      nextEnv ??= { ...env };
      const delimiter = arg.indexOf("=");
      const key = arg.slice(0, delimiter);
      const value = resolveShellExpandedAssignmentValue(arg.slice(delimiter + 1), env);
      nextEnv[key] = value ?? ENV_SPLIT_UNKNOWN_ASSIGNMENT_VALUE;
      offset += 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      break;
    }
    if (SUDO_OPTIONS_WITH_VALUE.has(arg)) {
      offset += 2;
      continue;
    }
    if (
      Array.from(SUDO_OPTIONS_WITH_VALUE).some(
        (option) => option.startsWith("--") && arg.startsWith(`${option}=`),
      )
    ) {
      offset += 1;
      continue;
    }
    offset += 1;
  }
  return nextEnv ?? { ...env };
}

type ParsedLifecycleWrapperOption = {
  hasInlineValue: boolean;
  inlineValue?: string;
  name: string;
};

function parseLifecycleWrapperOptionToken(
  token: string,
  optionsWithValue: ReadonlySet<string> = new Set(),
): ParsedLifecycleWrapperOption[] | null {
  const delimiter = token.indexOf("=");
  if (token.startsWith("--")) {
    return [
      {
        hasInlineValue: delimiter !== -1,
        inlineValue: delimiter === -1 ? undefined : token.slice(delimiter + 1),
        name: delimiter === -1 ? token : token.slice(0, delimiter),
      },
    ];
  }
  if (!/^-[A-Za-z0-9]/u.test(token)) {
    return null;
  }
  const options: ParsedLifecycleWrapperOption[] = [];
  for (let index = 1; index < token.length; index += 1) {
    const shortName = `-${token[index] ?? ""}`;
    if (optionsWithValue.has(shortName)) {
      options.push({
        hasInlineValue: index < token.length - 1,
        inlineValue: index < token.length - 1 ? token.slice(index + 1) : undefined,
        name: shortName,
      });
      return options;
    }
    options.push({ hasInlineValue: false, name: shortName });
  }
  return options.length > 0 ? options : null;
}

function readEnvSplitVariableReference(
  value: string,
  offset: number,
): { braced: boolean; endOffset: number; name: string; raw: string } | null {
  if (value[offset] !== "$") {
    return null;
  }
  const braced = value[offset + 1] === "{";
  const match = braced
    ? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(value.slice(offset))
    : /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(value.slice(offset));
  if (!match?.[1]) {
    return null;
  }
  return {
    braced,
    endOffset: offset + match[0].length,
    name: match[1],
    raw: match[0],
  };
}

function isEnvSplitDoubleQuoteEscape(next: string | undefined): next is string {
  return Boolean(next && ENV_SPLIT_DOUBLE_QUOTE_ESCAPES.has(next));
}

function splitEnvSplitStringPayload(
  payload: string,
  env?: NodeJS.ProcessEnv,
  envComplete = false,
): string[] | null {
  const effectivePayload = payload;
  const tokens: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let tokenStarted = false;

  const pushToken = () => {
    if (tokenStarted) {
      tokens.push(buf);
      buf = "";
      tokenStarted = false;
    }
  };

  const appendVariableReference = (
    reference: { braced: boolean; endOffset: number; name: string; raw: string },
    fallback: string,
  ): boolean => {
    if (Object.hasOwn(env ?? {}, reference.name)) {
      const rawValue = env?.[reference.name] ?? "";
      if (rawValue === ENV_SPLIT_UNKNOWN_ASSIGNMENT_VALUE) {
        buf += reference.raw;
        tokenStarted = true;
        return true;
      }
      const value = rawValue
        .replaceAll("\\", ENV_SPLIT_LITERAL_BACKSLASH_MARKER)
        .replaceAll("$", `${ENV_SPLIT_LITERAL_DOLLAR_MARKER}$`);
      buf += value;
      tokenStarted ||= value.length > 0;
      return true;
    }
    if (!reference.braced) {
      if (envComplete) {
        return true;
      }
      return false;
    }
    if (envComplete) {
      return true;
    }
    buf += fallback;
    tokenStarted = true;
    return true;
  };

  for (let index = 0; index < effectivePayload.length; index += 1) {
    const ch = effectivePayload[index];
    if (ch === undefined) {
      return null;
    }
    if (escaped) {
      buf += ch === "$" ? `${ENV_SPLIT_LITERAL_DOLLAR_MARKER}$` : ch;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else if (
        ch === "\\" &&
        (effectivePayload[index + 1] === "'" || effectivePayload[index + 1] === "\\")
      ) {
        buf += effectivePayload[index + 1] ?? "";
        tokenStarted = true;
        index += 1;
      } else {
        buf += ch === "$" ? `${ENV_SPLIT_LITERAL_DOLLAR_MARKER}$` : ch;
        tokenStarted = true;
      }
      continue;
    }
    if (ch === "\\") {
      const next = effectivePayload[index + 1];
      if (next === "c" && !inDouble) {
        break;
      }
      if (next === "_") {
        if (inDouble) {
          buf += " ";
          tokenStarted = true;
        } else {
          pushToken();
        }
        index += 1;
        continue;
      }
      if (next && Object.hasOwn(ENV_SPLIT_CONTROL_ESCAPES, next)) {
        buf += ENV_SPLIT_CONTROL_ESCAPES[next] ?? "";
        tokenStarted = true;
        index += 1;
        continue;
      }
      if (!inDouble || isEnvSplitDoubleQuoteEscape(next)) {
        escaped = true;
        tokenStarted = true;
        continue;
      }
      buf += ch;
      tokenStarted = true;
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
        continue;
      }
      const reference = readEnvSplitVariableReference(effectivePayload, index);
      if (reference) {
        if (!appendVariableReference(reference, reference.raw)) {
          return null;
        }
        index = reference.endOffset - 1;
        continue;
      }
      if (ch === "$") {
        return null;
      }
      buf += ch;
      tokenStarted = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      tokenStarted = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      tokenStarted = true;
      continue;
    }
    if (ch === "#" && !tokenStarted) {
      break;
    }
    const reference = readEnvSplitVariableReference(effectivePayload, index);
    if (reference) {
      if (!appendVariableReference(reference, reference.raw)) {
        return null;
      }
      index = reference.endOffset - 1;
      continue;
    }
    if (ch === "$") {
      return null;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    buf += ch;
    tokenStarted = true;
  }

  if (escaped || inSingle || inDouble) {
    return null;
  }
  pushToken();
  return tokens;
}

function textContainsVariableReference(value: string | undefined): boolean {
  return typeof value === "string" && SHELL_VARIABLE_REFERENCE_PATTERN.test(value);
}

function textContainsActiveVariableReference(value: string | undefined): boolean {
  return textContainsVariableReference(
    value?.replaceAll(`${ENV_SPLIT_LITERAL_DOLLAR_MARKER}$`, ""),
  );
}

function textContainsCommandSubstitution(value: string | undefined): boolean {
  return typeof value === "string" && (/[$<>]\(/u.test(value) || value.includes("`"));
}

function textContainsPotentialPosixShellExpansion(value: string | undefined): boolean {
  return (
    typeof value === "string" &&
    /(^|[^\\])\$(?:\{|[A-Za-z_(])/.test(value.replaceAll(`${ENV_SPLIT_LITERAL_DOLLAR_MARKER}$`, ""))
  );
}

function findShellCommandSubstitutionEnd(value: string, startOffset: number): number | null {
  let depth = 1;
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  for (let index = startOffset; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (quote !== "'" && char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      } else if (quote === '"' && char === "$" && value[index + 1] === "(") {
        depth += 1;
        index += 1;
      }
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "$" && value[index + 1] === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return null;
}

function activeShellCommandSubstitutions(value: string): string[] {
  const payloads: string[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" && quote === undefined) {
      quote = char;
      continue;
    }
    if (char === '"') {
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    const startsCommandSubstitution = char === "$" && value[index + 1] === "(";
    const startsProcessSubstitution =
      quote === undefined &&
      (char === "<" || char === ">" || char === "=") &&
      value[index + 1] === "(";
    if (startsCommandSubstitution || startsProcessSubstitution) {
      const endOffset = findShellCommandSubstitutionEnd(value, index + 2);
      if (endOffset === null) {
        continue;
      }
      payloads.push(value.slice(index + 2, endOffset));
      index = endOffset;
      continue;
    }
    if (char === "`") {
      let endOffset = index + 1;
      let backtickEscaped = false;
      for (; endOffset < value.length; endOffset += 1) {
        const nestedChar = value[endOffset];
        if (backtickEscaped) {
          backtickEscaped = false;
        } else if (nestedChar === "\\") {
          backtickEscaped = true;
        } else if (nestedChar === "`") {
          break;
        }
      }
      if (endOffset < value.length) {
        payloads.push(value.slice(index + 1, endOffset));
        index = endOffset;
      }
    }
  }
  return payloads;
}

function commandTextHasOpenClawLifecycleCommandSubstitution(value: string): boolean {
  return activeShellCommandSubstitutions(value).some((payload) =>
    commandTextMentionsOpenClawLifecycleMutation(payload),
  );
}

function commandTextHasOpenClawLifecycleCommandSubstitutionForDialect(
  value: string,
  dialect: ShellCommandDialect,
): boolean {
  if (dialect !== "powershell") {
    return commandTextHasOpenClawLifecycleCommandSubstitution(value);
  }
  const wrapperArgv = splitShellArgs(value);
  const wrapperCommand = normalizeCommandName(wrapperArgv?.[0]);
  const inlineCommand =
    wrapperArgv && (wrapperCommand === "powershell" || wrapperCommand === "pwsh")
      ? (extractBindableShellWrapperInlineCommand(wrapperArgv) ??
        extractShellWrapperInlineCommand(wrapperArgv))
      : null;
  return commandTextHasOpenClawLifecycleCommandSubstitution(
    stripPowerShellLineComments(inlineCommand ?? value),
  );
}

function textContainsDynamicShellExpansion(value: string | undefined): boolean {
  return textContainsPotentialPosixShellExpansion(value) || textContainsCommandSubstitution(value);
}

const CMD_VARIABLE_REFERENCE_PATTERN =
  /%([A-Za-z_][A-Za-z0-9_]*)(?::([^%]*))?%|!([A-Za-z_][A-Za-z0-9_]*)(?::([^!]*))?!/g;

function applyCmdVariableModifier(value: string, modifier: string | undefined): string | null {
  if (modifier === undefined) {
    return value;
  }
  const substring = modifier.match(/^~(-?\d+)(?:,(-?\d+))?$/);
  if (substring) {
    const rawStart = Number.parseInt(substring[1] ?? "0", 10);
    const start = rawStart < 0 ? Math.max(0, value.length + rawStart) : rawStart;
    if (substring[2] === undefined) {
      return value.slice(start);
    }
    const length = Number.parseInt(substring[2], 10);
    return length < 0
      ? value.slice(start, value.length + length)
      : value.slice(start, start + length);
  }
  const equalsIndex = modifier.indexOf("=");
  if (equalsIndex > 0) {
    const search = modifier.slice(0, equalsIndex);
    const replacement = modifier.slice(equalsIndex + 1);
    return value.replaceAll(search, replacement);
  }
  return null;
}

function expandCmdVariableReferences(
  value: string,
  percentEnv: NodeJS.ProcessEnv | undefined,
  envComplete: boolean,
  delayedEnv: NodeJS.ProcessEnv | undefined = percentEnv,
): { expanded: string; sawUnknownVariable: boolean } {
  let sawUnknownVariable = false;
  CMD_VARIABLE_REFERENCE_PATTERN.lastIndex = 0;
  const expanded = value.replace(
    CMD_VARIABLE_REFERENCE_PATTERN,
    (
      _match,
      percentName: string | undefined,
      percentModifier: string | undefined,
      delayedName: string | undefined,
      delayedModifier: string | undefined,
    ) => {
      const name = percentName ?? delayedName ?? "";
      const modifier = percentName === undefined ? delayedModifier : percentModifier;
      const referenceEnv = percentName === undefined ? delayedEnv : percentEnv;
      const envKey = Object.keys(referenceEnv ?? {}).find(
        (key) => key.toLowerCase() === name.toLowerCase(),
      );
      if (envKey !== undefined) {
        const envValue = referenceEnv?.[envKey];
        if (envValue === ENV_SPLIT_UNKNOWN_ASSIGNMENT_VALUE) {
          sawUnknownVariable = true;
          return "";
        }
        const modified = applyCmdVariableModifier(envValue ?? "", modifier);
        if (modified === null) {
          sawUnknownVariable = true;
          return "";
        }
        return modified;
      }
      sawUnknownVariable ||= !envComplete;
      return "";
    },
  );
  return { expanded, sawUnknownVariable };
}

function cmdPayloadWithLocalAssignmentsMayReachLifecycle(
  payload: string,
  env: NodeJS.ProcessEnv | undefined,
  envComplete: boolean,
): boolean {
  const percentEnv = env ? { ...env } : {};
  const visibleEnv = env ? { ...env } : {};
  let sawLocalAssignment = false;
  for (const group of splitCmdCommandGroups(normalizeCmdCaretEscapedWordCharacters(payload))) {
    const groupText = group.text.trim();
    const argv = splitShellArgs(groupText);
    if (!argv || argv.length === 0) {
      continue;
    }
    if (normalizeCommandName(argv[0]) === "set" && argv[1] && !argv[1].startsWith("/")) {
      const assignment = argv.slice(1).join(" ");
      const equalsIndex = assignment.indexOf("=");
      const name = equalsIndex > 0 ? assignment.slice(0, equalsIndex).trim() : "";
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        const result = expandCmdVariableReferences(
          assignment.slice(equalsIndex + 1),
          percentEnv,
          envComplete,
          visibleEnv,
        );
        visibleEnv[name] = result.sawUnknownVariable
          ? ENV_SPLIT_UNKNOWN_ASSIGNMENT_VALUE
          : result.expanded;
        sawLocalAssignment = true;
      }
      continue;
    }
    if (!sawLocalAssignment) {
      continue;
    }
    const result = expandCmdVariableReferences(groupText, percentEnv, envComplete, visibleEnv);
    if (commandTextMentionsOpenClawLifecycleMutation(result.expanded, "cmd")) {
      return true;
    }
    if (result.sawUnknownVariable) {
      CMD_VARIABLE_REFERENCE_PATTERN.lastIndex = 0;
      const conservativeArgv = splitShellArgs(
        groupText.replace(CMD_VARIABLE_REFERENCE_PATTERN, "$CMD"),
      );
      if (conservativeArgv !== null && argvMayExpandToLifecycleMutation(conservativeArgv)) {
        return true;
      }
    }
  }
  return false;
}

function cmdWrapperPayloadMayExpandWithEnvToLifecycle(
  argv: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
  envComplete: boolean,
): boolean {
  if (normalizeCommandName(argv[0]) !== "cmd") {
    return false;
  }
  const payload =
    extractBindableShellWrapperInlineCommand([...argv]) ??
    extractShellWrapperInlineCommand([...argv]);
  if (payload === null) {
    return false;
  }
  if (cmdPayloadWithLocalAssignmentsMayReachLifecycle(payload, env, envComplete)) {
    return true;
  }
  CMD_VARIABLE_REFERENCE_PATTERN.lastIndex = 0;
  if (!CMD_VARIABLE_REFERENCE_PATTERN.test(payload)) {
    CMD_VARIABLE_REFERENCE_PATTERN.lastIndex = 0;
    return false;
  }
  CMD_VARIABLE_REFERENCE_PATTERN.lastIndex = 0;
  const { expanded, sawUnknownVariable } = expandCmdVariableReferences(payload, env, envComplete);
  if (commandTextMentionsOpenClawLifecycleMutation(expanded, "cmd")) {
    return true;
  }
  if (!sawUnknownVariable) {
    return false;
  }
  CMD_VARIABLE_REFERENCE_PATTERN.lastIndex = 0;
  const conservativePayload = payload.replace(CMD_VARIABLE_REFERENCE_PATTERN, "$CMD");
  const conservativeArgv = splitShellArgs(conservativePayload);
  return conservativeArgv !== null && argvMayExpandToLifecycleMutation(conservativeArgv);
}

function textContainsEnvSplitVariableReference(value: string | undefined): boolean {
  return typeof value === "string" && /(^|[^\\\uE000])\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value);
}

function removeEnvSplitVariableReferences(value: string): string {
  return value.replace(/(^|[^\\\uE000])\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "$1");
}

function argvContainsEnvSplitVariableReference(argv: readonly string[]): boolean {
  return argv.some((token) => textContainsEnvSplitVariableReference(token));
}

function stripEnvSplitLiteralDollarMarkers(value: string): string {
  return value
    .replaceAll(ENV_SPLIT_LITERAL_DOLLAR_MARKER, "")
    .replaceAll(ENV_SPLIT_LITERAL_BACKSLASH_MARKER, "\\");
}

function restoreEnvSplitBackslashMarkers(value: string): string {
  return value.replaceAll(ENV_SPLIT_LITERAL_BACKSLASH_MARKER, "\\");
}

function restoreEnvSplitBackslashMarkersInArgv(argv: readonly string[]): string[] {
  return argv.map(restoreEnvSplitBackslashMarkers);
}

function argvContainsRestoredEnvSplitVariableReference(argv: readonly string[]): boolean {
  return argv.some((token) =>
    textContainsEnvSplitVariableReference(stripEnvSplitLiteralDollarMarkers(token)),
  );
}

function shellWrapperPayloadMayExpandWithEnvToLifecycle(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  envComplete: boolean,
): boolean {
  if (!isShellWrapperInvocation([...argv])) {
    return false;
  }
  const inlineCommand =
    extractBindableShellWrapperInlineCommand([...argv]) ??
    extractShellWrapperInlineCommand([...argv]);
  if (inlineCommand === null) {
    return false;
  }
  const payload = stripEnvSplitLiteralDollarMarkers(inlineCommand);
  const payloadIndex = argv.findIndex((token, index) => index > 0 && token === inlineCommand);
  if (payloadIndex !== -1 && /\$(?:\d+|[@*]|\{(?:\d+|[@*])\})/.test(payload)) {
    const positional = argv.slice(payloadIndex + 1).map((arg) => {
      const state = { sawVariable: false, sawUnknownVariable: false };
      return expandShellVariableReferencesInText(arg, env, envComplete, state);
    });
    const expandedPositional = expandPosixShellPositionalParameters(payload, positional, argv[0]);
    if (commandTextMentionsOpenClawLifecycleMutation(expandedPositional)) {
      return true;
    }
  }
  const state = { sawVariable: false, sawUnknownVariable: false };
  const expanded = expandShellVariableReferencesInText(payload, env, envComplete, state);
  if (!state.sawVariable) {
    return false;
  }
  if (commandTextMentionsOpenClawLifecycleMutation(expanded)) {
    return true;
  }
  return state.sawUnknownVariable && commandTextMentionsOpenClawLifecycleMutation(payload);
}

function expandPosixShellPositionalParameters(
  payload: string,
  positional: readonly string[],
  fallbackZero: string | undefined,
): string {
  let result = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < payload.length; index += 1) {
    const char = payload[index] ?? "";
    if (char === "\\" && quote !== "'") {
      result += char;
      if (index + 1 < payload.length) {
        result += payload[index + 1];
        index += 1;
      }
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? undefined : "'";
      result += char;
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? undefined : '"';
      result += char;
      continue;
    }
    if (char !== "$" || quote === "'") {
      result += char;
      continue;
    }
    const tail = payload.slice(index);
    const match = tail.match(/^\$(?:\{(\d+|[@*])\}|(\d+|[@*]))/);
    const parameter = match?.[1] ?? match?.[2];
    if (!match || !parameter) {
      result += char;
      continue;
    }
    if (parameter === "0") {
      result += positional[0] ?? fallbackZero ?? "";
    } else if (parameter === "@" || parameter === "*") {
      result += positional.slice(1).join(" ");
    } else {
      result += positional[Number.parseInt(parameter, 10)] ?? "";
    }
    index += match[0].length - 1;
  }
  return result;
}

function shellWrapperPayloadUnknownEnvMayExpandToLifecycle(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): boolean {
  if (!envContainsUnknownAssignmentValue(env) || !isShellWrapperInvocation([...argv])) {
    return false;
  }
  const inlineCommand =
    extractBindableShellWrapperInlineCommand([...argv]) ??
    extractShellWrapperInlineCommand([...argv]);
  if (inlineCommand === null) {
    return false;
  }
  const payload = stripEnvSplitLiteralDollarMarkers(inlineCommand);
  const expanded = payload.replace(
    new RegExp(SHELL_VARIABLE_REFERENCE_GLOBAL_PATTERN.source, "g"),
    (
      match,
      bracedName: string | undefined,
      _operator: string | undefined,
      _word: string | undefined,
      bareName: string | undefined,
    ) => {
      const name = bracedName ?? bareName ?? "";
      return env[name] === ENV_SPLIT_UNKNOWN_ASSIGNMENT_VALUE ? "openclaw" : match;
    },
  );
  return commandTextMentionsOpenClawLifecycleMutation(expanded);
}

function envSplitArgvIsLifecycleMutation(argv: readonly string[]): boolean {
  if (argv.length === 1 && /\s/.test(argv[0] ?? "")) {
    return false;
  }
  return segmentIsOpenClawLifecycleMutation(argv);
}

function argvHasDynamicExecutableLifecycleShape(argv: readonly string[]): boolean {
  if (!textContainsDynamicShellExpansion(argv[0])) {
    return false;
  }
  const tail = argv.slice(1);
  const emptyExpandedExecutable = removeShellVariableReferences(argv[0] ?? "");
  if (
    emptyExpandedExecutable.length > 0 &&
    segmentIsOpenClawLifecycleMutation([emptyExpandedExecutable, ...tail])
  ) {
    return true;
  }
  for (const command of VARIABLE_EXECUTABLE_LIFECYCLE_CANDIDATES) {
    const candidate = [command, ...tail];
    if (segmentIsOpenClawLifecycleMutation(candidate)) {
      return true;
    }
  }
  const envTailArgv = unwrapLifecycleEnvArgv(["env", ...tail]);
  if (envTailArgv && segmentIsOpenClawLifecycleMutation(envTailArgv)) {
    return true;
  }
  return segmentIsOpenClawLifecycleMutation(tail);
}

function tokenCouldBeOpenClawLifecycleArea(token: string | undefined): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(token);
  return (
    normalized === "gateway" ||
    normalized === "daemon" ||
    normalized === "update" ||
    normalized === "uninstall" ||
    normalized === "onboard" ||
    normalized === "setup" ||
    shellGlobMayMatchCandidates(normalized, [
      "gateway",
      "daemon",
      "update",
      "uninstall",
      "onboard",
      "setup",
    ]) ||
    textContainsDynamicShellExpansion(token)
  );
}

function tokenCouldBeOpenClawLifecycleAction(token: string | undefined): boolean {
  return (
    OPENCLAW_CLI_LIFECYCLE_ACTIONS.has(normalizeLowercaseStringOrEmpty(token)) ||
    shellGlobMayMatchCandidates(normalizeLowercaseStringOrEmpty(token), [
      ...OPENCLAW_CLI_LIFECYCLE_ACTIONS,
    ]) ||
    OPENCLAW_DAEMON_INSTALL_OPTIONS.has(normalizeLowercaseStringOrEmpty(token)) ||
    textContainsDynamicShellExpansion(token)
  );
}

function argvCouldBeOpenClawLifecycleFromAreaOffset(
  argv: readonly string[],
  areaOffset: number,
): boolean {
  if (areaOffset >= argv.length) {
    return false;
  }
  const normalizedAreaOffset = skipOpenClawGlobalOptions(argv, areaOffset);
  const actionOffset = skipOpenClawGlobalOptions(argv, normalizedAreaOffset + 1);
  return (
    tokenCouldBeOpenClawLifecycleArea(argv[normalizedAreaOffset]) &&
    tokenCouldBeOpenClawLifecycleAction(argv[actionOffset])
  );
}

function argvCouldBeOpenClawGatewayCallLifecycleFromActionOffset(
  argv: readonly string[],
  actionOffset: number,
): boolean {
  if (normalizeLowercaseStringOrEmpty(argv[actionOffset]) !== "call") {
    return false;
  }
  const method = findOpenClawGatewayCallMethod(argv, actionOffset + 1);
  return (
    OPENCLAW_GATEWAY_CALL_LIFECYCLE_METHODS.has(normalizeLowercaseStringOrEmpty(method)) ||
    textContainsDynamicShellExpansion(method)
  );
}

function argvMayExpandToLifecycleMutationOnce(argv: readonly string[]): boolean {
  if (argvHasDynamicExecutableLifecycleShape(argv)) {
    return true;
  }
  const command = normalizeCommandName(argv[0]);
  if (command === "openclaw" || OPENCLAW_CLI_CARRIER_COMMANDS.has(command)) {
    const offsets = findOpenClawCliOffsets(argv);
    if (offsets.length === 0) {
      if (OPENCLAW_CLI_CARRIER_COMMANDS.has(command)) {
        if (command === "node" || command === "corepack") {
          return argv.some(
            (arg, index) =>
              index > 0 &&
              textContainsDynamicShellExpansion(arg) &&
              segmentIsOpenClawCliLifecycleMutation(["openclaw", ...argv.slice(index + 1)]),
          );
        }
        const executableOffset = findPackageRunnerExecutableOffset(argv);
        return (
          executableOffset !== null &&
          textContainsDynamicShellExpansion(argv[executableOffset]) &&
          segmentIsOpenClawCliLifecycleMutation(["openclaw", ...argv.slice(executableOffset + 1)])
        );
      }
      return false;
    }
    for (const cliOffset of offsets) {
      const offset = skipOpenClawGlobalOptions(argv, cliOffset + 1);
      if (
        textContainsDynamicShellExpansion(argv[offset]) &&
        (argvCouldBeOpenClawLifecycleFromAreaOffset(argv, offset + 1) ||
          argvCouldBeOpenClawLifecycleFromAreaOffset(argv, offset + 2))
      ) {
        return true;
      }
      const actionOffset = skipOpenClawGlobalOptions(argv, offset + 1);
      if (
        (textContainsDynamicShellExpansion(argv[offset]) ||
          textContainsDynamicShellExpansion(argv[actionOffset])) &&
        tokenCouldBeOpenClawLifecycleArea(argv[offset]) &&
        tokenCouldBeOpenClawLifecycleAction(argv[actionOffset])
      ) {
        return true;
      }
      if (
        normalizeLowercaseStringOrEmpty(argv[offset]) === "gateway" &&
        argvCouldBeOpenClawGatewayCallLifecycleFromActionOffset(argv, actionOffset)
      ) {
        return true;
      }
    }
    return false;
  }
  if (command === "systemctl" || command === "launchctl") {
    const actionIndex =
      command === "systemctl"
        ? firstSystemctlActionArgIndex(argv, 1)
        : firstNonOptionArgIndex(argv, 1);
    const action = actionIndex === null ? undefined : argv[actionIndex];
    return (
      (textContainsDynamicShellExpansion(action) || argv.some(textContainsDynamicShellExpansion)) &&
      (textContainsDynamicShellExpansion(action) ||
        SYSTEMCTL_LIFECYCLE_ACTIONS.has(normalizeLowercaseStringOrEmpty(action)) ||
        LAUNCHCTL_LIFECYCLE_ACTIONS.has(normalizeLowercaseStringOrEmpty(action))) &&
      argvTargetsMayMentionOpenClaw(argv, actionIndex)
    );
  }
  if (command === "service") {
    const unitIndex = firstNonOptionArgIndex(argv, 1);
    const actionIndex = unitIndex === null ? null : firstNonOptionArgIndex(argv, unitIndex + 1);
    const unit = unitIndex === null ? undefined : argv[unitIndex];
    const action = actionIndex === null ? undefined : argv[actionIndex];
    return (
      (textContainsActiveVariableReference(unit) || systemdGlobMayMatchOpenClawUnit(unit ?? "")) &&
      (textContainsActiveVariableReference(action) ||
        SERVICE_LIFECYCLE_ACTIONS.has(normalizeLowercaseStringOrEmpty(action)))
    );
  }
  if (command === "schtasks") {
    const action = argv.slice(1).find((arg) => {
      const normalized = normalizeLowercaseStringOrEmpty(arg);
      return SCHTASKS_LIFECYCLE_ACTIONS.has(normalized) || textContainsDynamicShellExpansion(arg);
    });
    const target = schtasksTaskTarget(argv);
    return (
      action !== undefined &&
      (textContainsDynamicShellExpansion(target) || tokenMentionsOpenClawLifecycleTarget(target))
    );
  }
  if (PROCESS_LIFECYCLE_COMMANDS.has(command)) {
    return (
      argv.some(textContainsDynamicShellExpansion) && argvProcessTargetsMayMentionOpenClaw(argv)
    );
  }
  return false;
}

function argvMayExpandToLifecycleMutation(argv: readonly string[]): boolean {
  let current: readonly string[] | null = argv;
  for (
    let depth = 0;
    current && current.length > 0 && depth < MAX_LIFECYCLE_CARRIER_UNWRAP_DEPTH;
    depth += 1
  ) {
    if (argvMayExpandToLifecycleMutationOnce(current)) {
      return true;
    }
    current = unwrapLifecycleCarrierArgv(current);
  }
  return false;
}

function expandShellVariableReferencesInArgv(
  argv: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
  envComplete: boolean,
): { argv: readonly string[]; sawVariable: boolean; sawUnknownVariable: boolean } {
  const state = { sawVariable: false, sawUnknownVariable: false };
  const expanded = argv.map((token) =>
    expandShellVariableReferencesInText(token, env, envComplete, state),
  );
  return { argv: expanded, ...state };
}

function envArgvHasSplitStringOption(argv: readonly string[]): boolean {
  if (normalizeCommandName(argv[0]) !== "env") {
    return false;
  }
  let sawAssignmentOperand = false;
  let optionParsing = true;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      break;
    }
    if (arg === "--" && optionParsing) {
      optionParsing = false;
      continue;
    }
    if (isEnvOperandAssignmentToken(arg, optionParsing && !sawAssignmentOperand)) {
      sawAssignmentOperand = true;
      continue;
    }
    if (sawAssignmentOperand || !optionParsing || !arg.startsWith("-")) {
      break;
    }
    const options = parseLifecycleWrapperOptionToken(arg, ENV_OPTIONS_WITH_VALUE);
    if (!options) {
      break;
    }
    for (const option of options) {
      if (ENV_SPLIT_STRING_OPTIONS.has(option.name)) {
        return true;
      }
      if (ENV_OPTIONS_WITH_VALUE.has(option.name) && !option.hasInlineValue) {
        index += 1;
        break;
      }
    }
  }
  return false;
}

function textContainsShellParameterExpansionOperator(value: string | undefined): boolean {
  return typeof value === "string" && /\$\{[A-Za-z_][A-Za-z0-9_]*(?::?[-+?=])[^}]*\}/.test(value);
}

function textContainsUnknownPlusExpansionToLifecycle(value: string | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const expandedIfSet = value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*(?::?\+)([^}]*)\}/g, "$1");
  return expandedIfSet !== value && commandTextMentionsOpenClawLifecycleMutation(expandedIfSet);
}

function envArgvHasShellParameterExpansionInSplitString(argv: readonly string[]): boolean {
  if (normalizeCommandName(argv[0]) !== "env") {
    return false;
  }
  let sawAssignmentOperand = false;
  let optionParsing = true;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      break;
    }
    if (arg === "--" && optionParsing) {
      optionParsing = false;
      continue;
    }
    if (isEnvOperandAssignmentToken(arg, optionParsing && !sawAssignmentOperand)) {
      sawAssignmentOperand = true;
      continue;
    }
    if (sawAssignmentOperand || !optionParsing || !arg.startsWith("-")) {
      break;
    }
    const options = parseLifecycleWrapperOptionToken(arg, ENV_OPTIONS_WITH_VALUE);
    if (!options) {
      break;
    }
    for (const option of options) {
      if (ENV_SPLIT_STRING_OPTIONS.has(option.name)) {
        const payload = option.hasInlineValue ? option.inlineValue : argv[index + 1];
        return textContainsShellParameterExpansionOperator(payload);
      }
      if (ENV_OPTIONS_WITH_VALUE.has(option.name) && !option.hasInlineValue) {
        index += 1;
        break;
      }
    }
  }
  return false;
}

function envArgvHasUnknownPlusExpansionToLifecycleInSplitString(argv: readonly string[]): boolean {
  if (normalizeCommandName(argv[0]) !== "env") {
    return false;
  }
  let sawAssignmentOperand = false;
  let optionParsing = true;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      break;
    }
    if (arg === "--" && optionParsing) {
      optionParsing = false;
      continue;
    }
    if (isEnvOperandAssignmentToken(arg, optionParsing && !sawAssignmentOperand)) {
      sawAssignmentOperand = true;
      continue;
    }
    if (sawAssignmentOperand || !optionParsing || !arg.startsWith("-")) {
      break;
    }
    const options = parseLifecycleWrapperOptionToken(arg, ENV_OPTIONS_WITH_VALUE);
    if (!options) {
      break;
    }
    for (const option of options) {
      if (ENV_SPLIT_STRING_OPTIONS.has(option.name)) {
        const payload = option.hasInlineValue ? option.inlineValue : argv[index + 1];
        return textContainsUnknownPlusExpansionToLifecycle(payload);
      }
      if (ENV_OPTIONS_WITH_VALUE.has(option.name) && !option.hasInlineValue) {
        index += 1;
        break;
      }
    }
  }
  return false;
}

function envContainsUnknownAssignmentValue(env: NodeJS.ProcessEnv | undefined): boolean {
  return Object.values(env ?? {}).includes(ENV_SPLIT_UNKNOWN_ASSIGNMENT_VALUE);
}

function argvMayExpandWithShellVariablesToLifecycle(
  argv: readonly string[],
  shellEnv: NodeJS.ProcessEnv | undefined,
  envComplete: boolean,
  cwd?: string,
  rawCommand?: string,
  commandEnv?: NodeJS.ProcessEnv,
): boolean {
  const executableArgv = dropShellPrefixAssignments(argv);
  const nestedEnv = commandEnv ?? shellEnv;
  if (cmdWrapperPayloadMayExpandWithEnvToLifecycle(executableArgv, nestedEnv, envComplete)) {
    return true;
  }
  const hasEnvSplitStringWithKnownEnv =
    envArgvHasSplitStringOption(executableArgv) && !envContainsUnknownAssignmentValue(nestedEnv);
  if (
    hasEnvSplitStringWithKnownEnv &&
    !envArgvHasShellParameterExpansionInSplitString(executableArgv)
  ) {
    return false;
  }
  const prefixAssignmentCount = argv.length - executableArgv.length;
  const rawExpansionFlags =
    rawCommand === undefined ? null : shellArgvActiveExpansionFlags(rawCommand);
  const expansionFlags =
    rawExpansionFlags?.length === argv.length
      ? rawExpansionFlags.slice(prefixAssignmentCount)
      : undefined;
  const expansionArgv = executableArgv.map((token, index) =>
    expansionFlags?.[index] === false ? maskInactiveShellExpansions(token) : token,
  );
  const expansionEnv = envArgvHasSplitStringOption(executableArgv) ? nestedEnv : shellEnv;
  const expanded = expandShellVariableReferencesInArgv(expansionArgv, expansionEnv, envComplete);
  if (!expanded.sawVariable) {
    return (
      expansionArgv.some(textContainsDynamicShellExpansion) &&
      argvMayExpandToLifecycleMutation(expansionArgv)
    );
  }
  const rawSplitFlags =
    rawCommand === undefined ? null : shellArgvUnquotedVariableFlags(rawCommand);
  const splitFlags =
    rawSplitFlags?.length === argv.length ? rawSplitFlags.slice(prefixAssignmentCount) : undefined;
  if (
    segmentIsOpenClawLifecycleMutation(expanded.argv, cwd) ||
    segmentIsOpenClawLifecycleMutation(fieldSplitExpandedShellArgv(expanded.argv, splitFlags), cwd)
  ) {
    return true;
  }
  if (!expanded.sawUnknownVariable) {
    return false;
  }
  if (
    !envComplete &&
    hasEnvSplitStringWithKnownEnv &&
    envArgvHasUnknownPlusExpansionToLifecycleInSplitString(executableArgv)
  ) {
    return true;
  }
  if (hasEnvSplitStringWithKnownEnv && envComplete) {
    return false;
  }
  return argvMayExpandToLifecycleMutation(expansionArgv);
}

function envSplitPayloadMayExpandToLifecycleCommand(
  payload: string | undefined,
  trailingArgv: readonly string[] = [],
  env?: NodeJS.ProcessEnv,
  expansionDepth = 0,
  envComplete = false,
): boolean {
  if (expansionDepth > MAX_LIFECYCLE_CARRIER_UNWRAP_DEPTH) {
    return false;
  }
  if (typeof payload !== "string") {
    return false;
  }
  if (
    envSplitPayloadLeadingBareVariableMayExpandToLifecycleCommand(
      payload,
      trailingArgv,
      env,
      expansionDepth,
      envComplete,
    )
  ) {
    return true;
  }
  const splitArgv = splitEnvSplitStringPayload(payload, env, envComplete);
  if (!splitArgv) {
    return false;
  }
  const carriedEnv = collectEnvAssignmentsFromEnvArgv(["env", ...splitArgv], { ...env });
  const shellExpandedTrailing = expandShellVariableReferencesInArgv(trailingArgv, env, envComplete);
  const trailingArgvCandidates: readonly (readonly string[])[] = shellExpandedTrailing.sawVariable
    ? [
        shellExpandedTrailing.argv,
        fieldSplitExpandedShellArgv(shellExpandedTrailing.argv),
        shellExpandedTrailing.sawUnknownVariable ? trailingArgv : [],
      ].filter((candidate) => candidate.length > 0)
    : [trailingArgv];
  const carriedArgv = unwrapLifecycleEnvArgv(["env", ...splitArgv, ...trailingArgv]);
  const lifecycleCarriedArgv = carriedArgv
    ? restoreEnvSplitBackslashMarkersInArgv(carriedArgv)
    : null;
  if (lifecycleCarriedArgv && envSplitArgvIsLifecycleMutation(lifecycleCarriedArgv)) {
    return true;
  }
  for (const candidateTrailingArgv of trailingArgvCandidates) {
    const shellExpandedCarriedArgv = unwrapLifecycleEnvArgv([
      "env",
      ...splitArgv,
      ...candidateTrailingArgv,
    ]);
    const lifecycleShellExpandedCarriedArgv = shellExpandedCarriedArgv
      ? restoreEnvSplitBackslashMarkersInArgv(shellExpandedCarriedArgv)
      : null;
    if (
      lifecycleShellExpandedCarriedArgv &&
      envSplitArgvIsLifecycleMutation(lifecycleShellExpandedCarriedArgv)
    ) {
      return true;
    }
    if (
      lifecycleShellExpandedCarriedArgv &&
      shellWrapperPayloadMayExpandWithEnvToLifecycle(
        lifecycleShellExpandedCarriedArgv,
        carriedEnv,
        envComplete,
      )
    ) {
      return true;
    }
    if (
      lifecycleShellExpandedCarriedArgv &&
      shellWrapperPayloadUnknownEnvMayExpandToLifecycle(
        lifecycleShellExpandedCarriedArgv,
        carriedEnv,
      )
    ) {
      return true;
    }
    if (
      lifecycleShellExpandedCarriedArgv &&
      shellExpandedTrailing.sawUnknownVariable &&
      argvMayExpandToLifecycleMutation(lifecycleShellExpandedCarriedArgv)
    ) {
      return true;
    }
  }
  if (
    lifecycleCarriedArgv &&
    shellWrapperPayloadMayExpandWithEnvToLifecycle(lifecycleCarriedArgv, carriedEnv, envComplete)
  ) {
    return true;
  }
  if (
    lifecycleCarriedArgv &&
    shellWrapperPayloadUnknownEnvMayExpandToLifecycle(lifecycleCarriedArgv, carriedEnv)
  ) {
    return true;
  }
  if (
    carriedArgv &&
    (argvContainsEnvSplitVariableReference(carriedArgv) ||
      (normalizeCommandName(carriedArgv[0]) === "env" &&
        argvContainsRestoredEnvSplitVariableReference(carriedArgv))) &&
    (argvHasPotentialEnvSplitLifecycleExpansion(
      carriedArgv,
      carriedEnv,
      expansionDepth + 1,
      envComplete,
    ) ||
      argvMayExpandToLifecycleMutation(lifecycleCarriedArgv ?? carriedArgv))
  ) {
    return true;
  }
  if (splitArgv.includes("")) {
    return false;
  }
  const emptyExpandedArgv = splitArgv
    .map(removeEnvSplitVariableReferences)
    .filter((token) => token !== "");
  const emptyExpandedCarriedArgv = unwrapLifecycleEnvArgv([
    "env",
    ...emptyExpandedArgv,
    ...trailingArgv,
  ]);
  if (emptyExpandedCarriedArgv && envSplitArgvIsLifecycleMutation(emptyExpandedCarriedArgv)) {
    return true;
  }
  return (
    carriedArgv !== null &&
    argvContainsEnvSplitVariableReference(carriedArgv) &&
    argvMayExpandToLifecycleMutation(carriedArgv)
  );
}

function envSplitPayloadLeadingBareVariableMayExpandToLifecycleCommand(
  payload: string,
  trailingArgv: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
  expansionDepth: number,
  envComplete: boolean,
): boolean {
  if (envComplete || expansionDepth > 4) {
    return false;
  }
  const match = /^\s*\$([A-Za-z_][A-Za-z0-9_]*)([\s\S]*)$/u.exec(payload);
  const name = match?.[1];
  if (!name || Object.hasOwn(env ?? {}, name)) {
    return false;
  }
  const suffix = match?.[2] ?? "";
  return VARIABLE_EXECUTABLE_LIFECYCLE_CANDIDATES.some((candidate) =>
    envSplitPayloadMayExpandToLifecycleCommand(
      `${candidate}${suffix}`,
      trailingArgv,
      env,
      expansionDepth + 1,
      envComplete,
    ),
  );
}

function envArgvHasPotentialEnvSplitLifecycleExpansion(
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
  expansionDepth = 0,
  envComplete = false,
): boolean {
  if (normalizeCommandName(argv[0]) !== "env") {
    return false;
  }
  let sawAssignmentOperand = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || arg === "--") {
      break;
    }
    if (isEnvOperandAssignmentToken(arg, !sawAssignmentOperand)) {
      sawAssignmentOperand = true;
      continue;
    }
    if (sawAssignmentOperand) {
      break;
    }
    if (!arg.startsWith("-")) {
      break;
    }
    const options = parseLifecycleWrapperOptionToken(arg, ENV_OPTIONS_WITH_VALUE);
    if (!options) {
      break;
    }
    let consumedValue = false;
    for (const option of options) {
      if (ENV_NON_EXEC_OPTIONS.has(option.name)) {
        return false;
      }
      if (!ENV_SPLIT_STRING_OPTIONS.has(option.name)) {
        if (ENV_OPTIONS_WITH_VALUE.has(option.name)) {
          index += option.hasInlineValue ? 0 : 1;
          consumedValue = true;
          break;
        }
        continue;
      }
      const rawPayload = option.hasInlineValue ? option.inlineValue : argv[index + 1];
      const payload =
        typeof rawPayload === "string" ? stripEnvSplitLiteralDollarMarkers(rawPayload) : rawPayload;
      const trailingArgv = argv.slice(index + (option.hasInlineValue ? 1 : 2));
      if (
        envSplitPayloadMayExpandToLifecycleCommand(
          payload,
          trailingArgv,
          env,
          expansionDepth,
          envComplete,
        )
      ) {
        return true;
      }
      index += option.hasInlineValue ? 0 : 1;
      consumedValue = true;
      break;
    }
    if (consumedValue) {
      continue;
    }
  }
  return false;
}

function collectEnvAssignmentsFromEnvArgv(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (normalizeCommandName(argv[0]) !== "env") {
    return env;
  }
  let nextEnv: NodeJS.ProcessEnv = { ...env };
  let sawAssignmentOperand = false;
  let optionParsing = true;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      break;
    }
    if (arg === "--" && optionParsing) {
      optionParsing = false;
      continue;
    }
    if (isEnvOperandAssignmentToken(arg, optionParsing && !sawAssignmentOperand)) {
      sawAssignmentOperand = true;
      const delimiter = arg.indexOf("=");
      const key = arg.slice(0, delimiter);
      const value = resolveShellExpandedAssignmentValue(arg.slice(delimiter + 1), env);
      nextEnv[key] = value ?? ENV_SPLIT_UNKNOWN_ASSIGNMENT_VALUE;
      continue;
    }
    if (sawAssignmentOperand) {
      break;
    }
    if (arg === "-") {
      nextEnv = {};
      continue;
    }
    if (!optionParsing || !arg.startsWith("-")) {
      break;
    }
    const options = parseLifecycleWrapperOptionToken(arg, ENV_OPTIONS_WITH_VALUE);
    if (!options) {
      break;
    }
    for (const option of options) {
      if (option.name === "-" || option.name === "-i" || option.name === "--ignore-environment") {
        nextEnv = {};
        continue;
      }
      if (option.name === "-u" || option.name === "--unset") {
        const key = option.hasInlineValue ? option.inlineValue : argv[index + 1];
        if (key) {
          delete nextEnv[key];
        }
      }
      if (ENV_OPTIONS_WITH_VALUE.has(option.name) && !option.hasInlineValue) {
        index += 1;
        break;
      }
    }
  }
  return nextEnv;
}

function collectLifecycleCarrierAssignmentsFromArgv(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const command = normalizeCommandName(argv[0]);
  if (command === "env") {
    return collectEnvAssignmentsFromEnvArgv(argv, env);
  }
  if (command === "sudo" || command === "doas") {
    return collectSudoAssignmentsFromArgv(argv, env);
  }
  return env;
}

function argvHasPotentialEnvSplitLifecycleExpansion(
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
  expansionDepth = 0,
  envComplete = env !== undefined,
): boolean {
  if (expansionDepth > MAX_LIFECYCLE_CARRIER_UNWRAP_DEPTH) {
    return false;
  }
  if (normalizeCommandName(argv[0]) === "flock") {
    const shellPayload = extractFlockShellCommandPayload(argv);
    const shellArgv = shellPayload === null ? null : splitShellArgs(shellPayload);
    const shellEnv = collectShellPrefixAssignmentsFromRaw(shellPayload ?? undefined, env);
    const commandArgv = shellArgv ? dropShellPrefixAssignments(shellArgv) : null;
    if (
      commandArgv &&
      (argvHasPotentialEnvSplitLifecycleExpansion(
        commandArgv,
        shellEnv,
        expansionDepth + 1,
        envComplete,
      ) ||
        segmentIsOpenClawLifecycleMutation(commandArgv))
    ) {
      return true;
    }
  }
  let current: readonly string[] | null = argv;
  let visibleEnv: NodeJS.ProcessEnv = { ...env };
  for (
    let depth = 0;
    current && current.length > 0 && depth < MAX_LIFECYCLE_CARRIER_UNWRAP_DEPTH;
    depth += 1
  ) {
    if (shellWrapperPayloadMayExpandWithEnvToLifecycle(current, visibleEnv, envComplete)) {
      return true;
    }
    if (shellWrapperPayloadUnknownEnvMayExpandToLifecycle(current, visibleEnv)) {
      return true;
    }
    if (
      envArgvHasPotentialEnvSplitLifecycleExpansion(
        current,
        visibleEnv,
        expansionDepth,
        envComplete,
      )
    ) {
      return true;
    }
    visibleEnv = collectLifecycleCarrierAssignmentsFromArgv(current, visibleEnv);
    current = unwrapLifecycleCarrierArgv(current);
  }
  return false;
}

function unwrapLifecycleEnvArgv(argv: readonly string[], depth = 0): readonly string[] | null {
  if (depth > 32) {
    return null;
  }
  let offset = 1;
  let sawAssignmentOperand = false;
  let optionParsing = true;
  while (offset < argv.length) {
    const arg = argv[offset];
    if (arg === undefined || arg === "") {
      return null;
    }
    if (arg === "--" && optionParsing) {
      optionParsing = false;
      offset += 1;
      continue;
    }
    if (isEnvOperandAssignmentToken(arg, optionParsing && !sawAssignmentOperand)) {
      sawAssignmentOperand = true;
      offset += 1;
      continue;
    }
    if (sawAssignmentOperand) {
      return argv.slice(offset);
    }
    if (arg === "-") {
      offset += 1;
      continue;
    }
    if (!optionParsing || !arg.startsWith("-")) {
      return argv.slice(offset);
    }
    const options = parseLifecycleWrapperOptionToken(arg, ENV_OPTIONS_WITH_VALUE);
    if (!options) {
      return null;
    }
    let consumedValue = false;
    for (const option of options) {
      if (ENV_NON_EXEC_OPTIONS.has(option.name)) {
        return null;
      }
      if (ENV_STANDALONE_OPTIONS.has(option.name)) {
        continue;
      }
      if (!ENV_OPTIONS_WITH_VALUE.has(option.name)) {
        return null;
      }
      const value = option.hasInlineValue ? option.inlineValue : argv[offset + 1];
      if (typeof value !== "string") {
        return null;
      }
      const nextOffset = offset + (option.hasInlineValue ? 1 : 2);
      if (ENV_SPLIT_STRING_OPTIONS.has(option.name)) {
        const splitArgv = splitEnvSplitStringPayload(stripEnvSplitLiteralDollarMarkers(value));
        if (splitArgv?.length === 1 && /\s/.test(splitArgv[0] ?? "")) {
          return null;
        }
        return splitArgv
          ? unwrapLifecycleEnvArgv(["env", ...splitArgv, ...argv.slice(nextOffset)], depth + 1)
          : null;
      }
      offset = nextOffset;
      consumedValue = true;
      break;
    }
    if (!consumedValue) {
      offset += 1;
    }
  }
  return null;
}

function skipLifecycleWrapperOptions(
  argv: readonly string[],
  params: {
    standaloneOptions?: ReadonlySet<string>;
    optionsWithValue?: ReadonlySet<string>;
    nonExecOptions?: ReadonlySet<string>;
  },
): number | null {
  let offset = 1;
  while (offset < argv.length) {
    const arg = argv[offset];
    if (!arg) {
      offset += 1;
      continue;
    }
    if (arg === "--") {
      return offset + 1;
    }
    if (!arg.startsWith("-") || arg === "-") {
      return offset;
    }
    const options = parseLifecycleWrapperOptionToken(arg, params.optionsWithValue);
    if (!options) {
      return null;
    }
    let consumesNextValue = false;
    for (const option of options) {
      const optionName = option.name;
      if (params.nonExecOptions?.has(optionName)) {
        return null;
      }
      if (params.standaloneOptions?.has(optionName)) {
        continue;
      }
      if (params.optionsWithValue?.has(optionName)) {
        consumesNextValue = !option.hasInlineValue;
        break;
      }
      return null;
    }
    offset += consumesNextValue ? 2 : 1;
  }
  return null;
}

function lifecycleWrapperHasNonExecOptionBeforeCommand(
  argv: readonly string[],
  params: {
    nonExecOptions: ReadonlySet<string>;
    optionsWithValue?: ReadonlySet<string>;
  },
): boolean {
  let offset = 1;
  while (offset < argv.length) {
    const arg = argv[offset];
    if (!arg || arg === "--") {
      return false;
    }
    if (!arg.startsWith("-") || arg === "-") {
      return false;
    }
    const options = parseLifecycleWrapperOptionToken(arg, params.optionsWithValue);
    if (!options) {
      return false;
    }
    let consumesNextValue = false;
    for (const option of options) {
      if (params.nonExecOptions.has(option.name)) {
        return true;
      }
      if (params.optionsWithValue?.has(option.name)) {
        consumesNextValue = !option.hasInlineValue;
        break;
      }
    }
    offset += consumesNextValue ? 2 : 1;
  }
  return false;
}

function dispatchWrapperInvocationIsNonExecuting(
  wrapper: string,
  argv: readonly string[],
): boolean {
  if (wrapper === "nohup") {
    return lifecycleWrapperHasNonExecOptionBeforeCommand(argv, {
      nonExecOptions: NOHUP_NON_EXEC_OPTIONS,
    });
  }
  if (wrapper === "stdbuf") {
    return lifecycleWrapperHasNonExecOptionBeforeCommand(argv, {
      nonExecOptions: STDBUF_NON_EXEC_OPTIONS,
      optionsWithValue: STDBUF_OPTIONS_WITH_VALUE,
    });
  }
  if (wrapper === "time") {
    return lifecycleWrapperHasNonExecOptionBeforeCommand(argv, {
      nonExecOptions: TIME_NON_EXEC_OPTIONS,
      optionsWithValue: TIME_OPTIONS_WITH_VALUE,
    });
  }
  if (wrapper === "timeout") {
    return lifecycleWrapperHasNonExecOptionBeforeCommand(argv, {
      nonExecOptions: TIMEOUT_NON_EXEC_OPTIONS,
      optionsWithValue: TIMEOUT_OPTIONS_WITH_VALUE,
    });
  }
  return lifecycleWrapperHasNonExecOptionBeforeCommand(argv, {
    nonExecOptions: GENERIC_WRAPPER_NON_EXEC_OPTIONS,
  });
}

function isChrtPriorityToken(token: string | undefined): boolean {
  return typeof token === "string" && /^\d+$/.test(token);
}

function extractFlockShellCommandPayload(argv: readonly string[]): string | null {
  let offset = 1;
  while (offset < argv.length) {
    const arg = argv[offset];
    if (!arg) {
      offset += 1;
      continue;
    }
    if (arg === "-c" || arg === "--command") {
      return argv[offset + 1] ?? null;
    }
    if (arg.startsWith("--command=")) {
      return arg.slice("--command=".length);
    }
    if (arg.startsWith("-c") && arg.length > 2) {
      return arg.slice(2);
    }
    if (!arg.startsWith("-") || arg === "-") {
      offset += 1;
      break;
    }
    if (
      arg === "-E" ||
      arg === "-w" ||
      arg === "--conflict-exit-code" ||
      arg === "--timeout" ||
      arg === "--wait"
    ) {
      offset += 2;
      continue;
    }
    offset += 1;
  }
  const afterLock = argv[offset];
  if (afterLock === "-c" || afterLock === "--command") {
    return argv[offset + 1] ?? null;
  }
  if (afterLock?.startsWith("--command=")) {
    return afterLock.slice("--command=".length);
  }
  if (afterLock?.startsWith("-c") && afterLock.length > 2) {
    return afterLock.slice(2);
  }
  return null;
}

function parseXargsCommandTemplate(
  argv: readonly string[],
): { commandArgv: readonly string[]; replacementMarker?: string } | null {
  let replacementMarker: string | undefined;
  for (let offset = 1; offset < argv.length; offset += 1) {
    const arg = argv[offset];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      return offset + 1 < argv.length
        ? { commandArgv: argv.slice(offset + 1), replacementMarker }
        : null;
    }
    if (!arg.startsWith("-") || arg === "-") {
      return { commandArgv: argv.slice(offset), replacementMarker };
    }
    const options = parseLifecycleWrapperOptionToken(arg, XARGS_OPTIONS_WITH_VALUE);
    if (!options) {
      return null;
    }
    let consumesNextValue = false;
    for (const option of options) {
      if (XARGS_NON_EXEC_OPTIONS.has(option.name)) {
        return null;
      }
      if (XARGS_STANDALONE_OPTIONS.has(option.name)) {
        continue;
      }
      if (XARGS_REPLACEMENT_OPTIONS.has(option.name)) {
        if (option.hasInlineValue) {
          replacementMarker = option.inlineValue || undefined;
        } else if (option.name === "-I") {
          replacementMarker = argv[offset + 1];
          consumesNextValue = true;
        } else {
          replacementMarker = "{}";
        }
        continue;
      }
      if (XARGS_OPTIONS_WITH_VALUE.has(option.name)) {
        consumesNextValue = !option.hasInlineValue;
        continue;
      }
      return null;
    }
    if (consumesNextValue) {
      offset += 1;
    }
  }
  return null;
}

function xargsReplacementMayProduceLifecycleMutation(argv: readonly string[]): boolean {
  if (normalizeCommandName(argv[0]) !== "xargs") {
    return false;
  }
  const template = parseXargsCommandTemplate(argv);
  if (!template) {
    return false;
  }
  let appendedCommand = template.commandArgv;
  if (!template.replacementMarker) {
    for (let depth = 0; depth < MAX_LIFECYCLE_CARRIER_UNWRAP_DEPTH; depth += 1) {
      const unwrapped = unwrapLifecycleCarrierArgv(appendedCommand);
      if (!unwrapped) {
        break;
      }
      appendedCommand = unwrapped;
    }
    if (PROCESS_LIFECYCLE_COMMANDS.has(normalizeCommandName(appendedCommand[0]))) {
      return false;
    }
  }
  const dynamicArgv = template.replacementMarker
    ? template.commandArgv.map((arg) =>
        arg.replaceAll(template.replacementMarker ?? "", "$XARGS_REPLACEMENT"),
      )
    : [...template.commandArgv, "$XARGS_REPLACEMENT", "$XARGS_REPLACEMENT"];
  if (!template.replacementMarker && isShellWrapperInvocation([...dynamicArgv])) {
    const payload =
      extractBindableShellWrapperInlineCommand([...dynamicArgv]) ??
      extractShellWrapperInlineCommand([...dynamicArgv]);
    if (payload?.includes("$XARGS_REPLACEMENT")) {
      return true;
    }
  }
  return argvMayExpandToLifecycleMutation(dynamicArgv);
}

function unwrapXargsCarrierArgv(argv: readonly string[]): readonly string[] | null {
  return parseXargsCommandTemplate(argv)?.commandArgv ?? null;
}

function segmentStartsWithLifecycleCommand(argv: readonly string[]): boolean {
  return (
    segmentIsOpenClawCliLifecycleMutation(argv) ||
    segmentIsLaunchctlLifecycleMutation(argv) ||
    segmentIsSystemctlLifecycleMutation(argv) ||
    segmentIsSchtasksLifecycleMutation(argv) ||
    segmentIsProcessLifecycleMutation(argv) ||
    (isShellWrapperInvocation([...argv]) && segmentHasLifecycleStringPayload(argv))
  );
}

function findLifecycleCommandStartOffset(argv: readonly string[]): number | null {
  for (let offset = 1; offset < argv.length; offset += 1) {
    if (segmentStartsWithLifecycleCommand(argv.slice(offset))) {
      return offset;
    }
  }
  return null;
}

function unwrapBlockedLifecycleDispatchWrapperArgv(
  wrapper: string,
  argv: readonly string[],
  allowGenericScan = true,
): readonly string[] | null {
  if (dispatchWrapperInvocationIsNonExecuting(wrapper, argv)) {
    return null;
  }
  if (wrapper === "setsid") {
    const commandOffset = skipLifecycleWrapperOptions(argv, {
      standaloneOptions: SETSID_STANDALONE_OPTIONS,
      nonExecOptions: SETSID_NON_EXEC_OPTIONS,
    });
    return commandOffset !== null && commandOffset < argv.length ? argv.slice(commandOffset) : null;
  }
  if (wrapper === "taskset") {
    const maskOffset = skipLifecycleWrapperOptions(argv, {
      standaloneOptions: TASKSET_STANDALONE_OPTIONS,
      nonExecOptions: TASKSET_NON_EXEC_OPTIONS,
    });
    return maskOffset !== null && maskOffset + 1 < argv.length ? argv.slice(maskOffset + 1) : null;
  }
  if (wrapper === "ionice") {
    const commandOffset = skipLifecycleWrapperOptions(argv, {
      standaloneOptions: IONICE_STANDALONE_OPTIONS,
      optionsWithValue: IONICE_OPTIONS_WITH_VALUE,
      nonExecOptions: IONICE_NON_EXEC_OPTIONS,
    });
    return commandOffset !== null && commandOffset < argv.length ? argv.slice(commandOffset) : null;
  }
  if (wrapper === "stdbuf") {
    const commandOffset = skipLifecycleWrapperOptions(argv, {
      optionsWithValue: STDBUF_OPTIONS_WITH_VALUE,
      nonExecOptions: STDBUF_NON_EXEC_OPTIONS,
    });
    return commandOffset !== null && commandOffset < argv.length ? argv.slice(commandOffset) : null;
  }
  if (wrapper === "time") {
    const commandOffset = skipLifecycleWrapperOptions(argv, {
      standaloneOptions: TIME_STANDALONE_OPTIONS,
      optionsWithValue: TIME_OPTIONS_WITH_VALUE,
      nonExecOptions: TIME_NON_EXEC_OPTIONS,
    });
    return commandOffset !== null && commandOffset < argv.length ? argv.slice(commandOffset) : null;
  }
  if (wrapper === "timeout") {
    const durationOffset = skipLifecycleWrapperOptions(argv, {
      standaloneOptions: TIMEOUT_STANDALONE_OPTIONS,
      optionsWithValue: TIMEOUT_OPTIONS_WITH_VALUE,
      nonExecOptions: TIMEOUT_NON_EXEC_OPTIONS,
    });
    return durationOffset !== null && durationOffset + 1 < argv.length
      ? argv.slice(durationOffset + 1)
      : null;
  }
  if (wrapper === "chrt") {
    const priorityOffset = skipLifecycleWrapperOptions(argv, {
      standaloneOptions: CHRT_STANDALONE_OPTIONS,
      optionsWithValue: CHRT_OPTIONS_WITH_VALUE,
      nonExecOptions: CHRT_NON_EXEC_OPTIONS,
    });
    if (priorityOffset === null || priorityOffset >= argv.length) {
      return null;
    }
    return isChrtPriorityToken(argv[priorityOffset]) && priorityOffset + 1 < argv.length
      ? argv.slice(priorityOffset + 1)
      : argv.slice(priorityOffset);
  }
  if (wrapper === "flock") {
    const shellPayload = extractFlockShellCommandPayload(argv);
    if (shellPayload !== null && commandTextMentionsOpenClawLifecycleMutation(shellPayload)) {
      return ["sh", "-c", shellPayload];
    }
  }
  const commandOffset = allowGenericScan ? findLifecycleCommandStartOffset(argv) : null;
  if (commandOffset !== null) {
    return argv.slice(commandOffset);
  }
  return null;
}

function unwrapFindExecLifecycleArgv(argv: readonly string[]): readonly string[] | null {
  for (let offset = 1; offset < argv.length; offset += 1) {
    const arg = normalizeLowercaseStringOrEmpty(argv[offset]);
    if (arg !== "-exec" && arg !== "-execdir") {
      continue;
    }
    const startOffset = offset + 1;
    let endOffset = startOffset;
    while (endOffset < argv.length && argv[endOffset] !== ";" && argv[endOffset] !== "+") {
      endOffset += 1;
    }
    const execArgv = argv.slice(startOffset, endOffset);
    if (execArgv.length > 0 && segmentStartsWithLifecycleCommand(execArgv)) {
      return execArgv;
    }
    offset = endOffset;
  }
  return null;
}

function unwrapExecCarrierArgv(argv: readonly string[]): readonly string[] | null {
  let offset = 1;
  while (offset < argv.length) {
    const arg = argv[offset];
    if (!arg) {
      offset += 1;
      continue;
    }
    if (arg === "--") {
      return argv.slice(offset + 1);
    }
    if (!arg.startsWith("-") || arg === "-") {
      return argv.slice(offset);
    }
    if (arg === "-a") {
      return offset + 2 <= argv.length ? argv.slice(offset + 2) : null;
    }
    if (arg.startsWith("-a") && arg.length > 2) {
      offset += 1;
      continue;
    }
    if (/^-[cl]+$/.test(arg)) {
      offset += 1;
      continue;
    }
    const commandOffset = findLifecycleCommandStartOffset(argv);
    return commandOffset === null ? null : argv.slice(commandOffset);
  }
  return null;
}

function unwrapObservedCommandCarrierArgv(argv: readonly string[]): readonly string[] | null {
  const command = normalizeCommandName(argv[0]);
  const optionsWithValue =
    command === "watch" ? WATCH_OPTIONS_WITH_VALUE : STRACE_OPTIONS_WITH_VALUE;
  const nonExecOptions = command === "watch" ? WATCH_NON_EXEC_OPTIONS : STRACE_NON_EXEC_OPTIONS;
  if (lifecycleWrapperHasNonExecOptionBeforeCommand(argv, { nonExecOptions, optionsWithValue })) {
    return null;
  }
  let offset = 1;
  while (offset < argv.length) {
    const arg = argv[offset];
    if (!arg) {
      offset += 1;
      continue;
    }
    if (arg === "--") {
      return offset + 1 < argv.length ? argv.slice(offset + 1) : null;
    }
    if (!arg.startsWith("-")) {
      return argv.slice(offset);
    }
    const option = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    offset += optionsWithValue.has(option) && !arg.includes("=") ? 2 : 1;
  }
  return null;
}

function unwrapLifecycleCarrierArgv(argv: readonly string[]): readonly string[] | null {
  const command = normalizeCommandName(argv[0]);
  if (command === "strace" || command === "watch") {
    return unwrapObservedCommandCarrierArgv(argv);
  }
  if (command === "env") {
    return unwrapLifecycleEnvArgv(argv);
  }
  if (command === "find") {
    return unwrapFindExecLifecycleArgv(argv);
  }
  if (command === "command" || command === "sudo" || command === "doas") {
    return resolveCarrierCommandArgv([...argv]);
  }
  if (command === "exec") {
    return unwrapExecCarrierArgv(argv);
  }
  if (command === "xargs") {
    return unwrapXargsCarrierArgv(argv);
  }
  if (command === "corepack") {
    const managerOffset = firstPackageRunnerOperandIndex(argv, 1);
    return managerOffset === null ? null : argv.slice(managerOffset);
  }
  const packageExecutableOffset = findPackageRunnerExecutableOffset(argv);
  if (packageExecutableOffset !== null) {
    return argv.slice(packageExecutableOffset);
  }
  const unwrap = unwrapKnownDispatchWrapperInvocation([...argv]);
  if (unwrap.kind === "unwrapped" && unwrap.argv.length > 0) {
    if (dispatchWrapperInvocationIsNonExecuting(unwrap.wrapper, argv)) {
      return null;
    }
    const lifecycleUnwrap = unwrapBlockedLifecycleDispatchWrapperArgv(unwrap.wrapper, argv, false);
    if (lifecycleUnwrap && lifecycleUnwrap.length > 0) {
      return lifecycleUnwrap;
    }
    return unwrap.argv;
  }
  if (unwrap.kind === "blocked") {
    return unwrapBlockedLifecycleDispatchWrapperArgv(unwrap.wrapper, argv);
  }
  if (!TRANSPARENT_LIFECYCLE_CARRIERS.has(command)) {
    return null;
  }
  let offset = 1;
  while (offset < argv.length && argv[offset]?.startsWith("-")) {
    offset += 1;
  }
  return argv.slice(offset);
}

function argvDirectlyIsOpenClawLifecycleMutation(
  argv: readonly string[],
  cwd?: string,
  includeStringPayload = true,
): boolean {
  return (
    segmentIsOpenClawCliLifecycleMutation(argv, cwd) ||
    segmentIsLaunchctlLifecycleMutation(argv) ||
    segmentIsSystemctlLifecycleMutation(argv) ||
    segmentIsServiceLifecycleMutation(argv) ||
    segmentIsPowerShellServiceLifecycleMutation(argv) ||
    segmentIsWindowsScServiceLifecycleMutation(argv) ||
    segmentIsWindowsNetServiceLifecycleMutation(argv) ||
    segmentIsSchtasksLifecycleMutation(argv) ||
    segmentIsProcessLifecycleMutation(argv) ||
    xargsReplacementMayProduceLifecycleMutation(argv) ||
    (includeStringPayload && segmentHasLifecycleStringPayload(argv))
  );
}

function segmentIsOpenClawLifecycleMutation(
  argv: readonly string[],
  cwd?: string,
  includeStringPayload = true,
): boolean {
  let current: readonly string[] | null = argv;
  for (
    let depth = 0;
    current && current.length > 0 && depth < MAX_LIFECYCLE_CARRIER_UNWRAP_DEPTH;
    depth += 1
  ) {
    if (argvDirectlyIsOpenClawLifecycleMutation(current, cwd, includeStringPayload)) {
      return true;
    }
    current = unwrapLifecycleCarrierArgv(current);
  }
  if (!current || current.length === 0) {
    return false;
  }
  if (argvDirectlyIsOpenClawLifecycleMutation(current, cwd, includeStringPayload)) {
    return true;
  }
  if (unwrapLifecycleCarrierArgv(current) !== null) {
    return true;
  }
  return false;
}

function commandTextRegexMentionsOpenClawLifecycleMutation(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    /\b(?:kill|pkill|killall|taskkill|stop-process)\b[\s\S]{0,200}\b(?:pidof|pgrep)?[\s\S]{0,120}\bopenclaw\b/.test(
      normalized,
    ) ||
    /\b(?:pidof|pgrep)\b[\s\S]{0,120}\bopenclaw\b[\s\S]{0,200}\|[\s\S]{0,200}\bxargs\b[\s\S]{0,120}\b(?:kill|pkill|killall|taskkill|stop-process)\b/.test(
      normalized,
    ) ||
    /\blaunchctl\b(?:[^\S\r\n]+-\S+)*[^\S\r\n]+(?:attach|bootstrap|bootout|debug|disable|enable|kickstart|kill|load|remove|start|stop|unload)\b[\s\S]{0,200}\bopenclaw\b/.test(
      normalized,
    ) ||
    /\bsystemctl\b[\s\S]{0,120}\b(?:add-requires|add-wants|bind|clean|condrestart|disable|edit|enable|force-reload|freeze|kill|link|mask|preset|reenable|reload|reload-or-restart|reload-or-try-restart|reset-failed|restart|revert|set-property|start|stop|thaw|try-reload-or-restart|try-restart|unmask)\b[\s\S]{0,200}\bopenclaw\b/.test(
      normalized,
    ) ||
    /\bservice\b[\s\S]{0,120}\bopenclaw\b[\s\S]{0,120}\b(?:force-reload|reload|restart|start|stop|try-restart)\b/.test(
      normalized,
    ) ||
    /\b(?:(?:new|remove|restart|resume|set|start|stop|suspend)-service|sasv|spsv)\b[\s\S]{0,200}\bopenclaw\b/.test(
      normalized,
    ) ||
    /\bsc(?:\.exe)?\b[\s\S]{0,80}\b(?:config|continue|control|create|delete|description|failure|failureflag|pause|privs|sdset|sidtype|start|stop|triggerinfo)\b[\s\S]{0,120}\bopenclaw\b/.test(
      normalized,
    ) ||
    /\bnet(?:\.exe)?\b[\s\S]{0,80}\b(?:continue|pause|start|stop)\b[\s\S]{0,120}\bopenclaw\b/.test(
      normalized,
    ) ||
    /\bschtasks(?:\.exe)?\b(?=[\s\S]{0,320}\/(?:change|create|delete|end|run)\b)(?=[\s\S]{0,320}\/tn(?:[\s:=]+)(?:"[^"]*\bopenclaw\b[^"]*"|[^\s;&|]*\bopenclaw\b))/.test(
      normalized,
    ) ||
    /\b(?:pnpm(?:\.(?:bat|cmd|exe|ps1))?[^\S\r\n]+)?openclaw(?:\.(?:bat|cjs|cmd|exe|js|mjs|ps1))?\b[\s\S]{0,160}\b(?:gateway|daemon)\b[\s\S]{0,160}\b(?:install|kill|restart|run(?![^\S\r\n]+(?:-h|--help)\b)|start|stop|uninstall)\b/.test(
      normalized,
    ) ||
    /\b(?:pnpm(?:\.(?:bat|cmd|exe|ps1))?[^\S\r\n]+)?openclaw(?:\.(?:bat|cjs|cmd|exe|js|mjs|ps1))?\b[\s\S]{0,160}\bgateway\b(?:[^\S\r\n]+(?:(?:--(?:auth|bind|password|password-file|port|raw-stream-path|tailscale|token|token-file|ws-log)(?:=(?!\s)[^\s;&|]+|[^\S\r\n]+[^\s;&|]+)?)|--(?:allow-unconfigured|claude-cli-logs|cli-backend-logs|compact|dev|force|raw-stream|reset|tailscale-reset-on-exit|verbose))){0,12}(?:[^\S\r\n]*(?:$|[;&|]))/.test(
      normalized,
    )
  );
}

function splitShellTextAtTopLevel(value: string, mode: "command-groups" | "pipeline"): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (quote === '"' && char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const isLogicalOr = char === "|" && value[index + 1] === "|";
    const isCommandBoundary =
      mode === "command-groups" &&
      (char === ";" ||
        char === "\n" ||
        char === "\r" ||
        isLogicalOr ||
        (char === "&" && value[index - 1] !== ">" && value[index - 1] !== "<"));
    const isPipelineBoundary = mode === "pipeline" && char === "|" && !isLogicalOr;
    if (!isCommandBoundary && !isPipelineBoundary) {
      continue;
    }
    parts.push(value.slice(start, index));
    if (
      (char === "&" && value[index + 1] === "&") ||
      isLogicalOr ||
      (char === "\r" && value[index + 1] === "\n")
    ) {
      index += 1;
    }
    start = index + 1;
  }
  parts.push(value.slice(start));
  return parts;
}

type ShellCommandGroup = {
  separatorBefore?: "background" | "conditional" | "sequential";
  text: string;
};

function splitCmdCommandGroups(value: string): ShellCommandGroup[] {
  const groups: ShellCommandGroup[] = [];
  let start = 0;
  let separatorBefore: ShellCommandGroup["separatorBefore"];
  let inDoubleQuote = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "^") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inDoubleQuote) {
      continue;
    }
    const isLogicalAnd = char === "&" && value[index + 1] === "&";
    const isLogicalOr = char === "|" && value[index + 1] === "|";
    const isBackground = char === "&" && !isLogicalAnd;
    const isPipeline = char === "|" && !isLogicalOr;
    const isSequential = char === "\n" || char === "\r";
    if (!isLogicalAnd && !isLogicalOr && !isBackground && !isPipeline && !isSequential) {
      continue;
    }
    groups.push({ separatorBefore, text: value.slice(start, index) });
    separatorBefore =
      isLogicalAnd || isLogicalOr ? "conditional" : isPipeline ? "background" : "sequential";
    if (isLogicalAnd || isLogicalOr || (char === "\r" && value[index + 1] === "\n")) {
      index += 1;
    }
    start = index + 1;
  }
  groups.push({ separatorBefore, text: value.slice(start) });
  return groups;
}

function splitShellCommandGroups(value: string): ShellCommandGroup[] {
  const groups: ShellCommandGroup[] = [];
  let start = 0;
  let separatorBefore: ShellCommandGroup["separatorBefore"];
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (quote === '"' && char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const isLogicalAnd = char === "&" && value[index + 1] === "&";
    const isLogicalOr = char === "|" && value[index + 1] === "|";
    const isBackground = char === "&" && !isLogicalAnd;
    const isSequential = char === ";" || char === "\n" || char === "\r";
    if (!isLogicalAnd && !isLogicalOr && !isBackground && !isSequential) {
      continue;
    }
    groups.push({ separatorBefore, text: value.slice(start, index) });
    separatorBefore =
      isLogicalAnd || isLogicalOr ? "conditional" : isBackground ? "background" : "sequential";
    if (isLogicalAnd || isLogicalOr || (char === "\r" && value[index + 1] === "\n")) {
      index += 1;
    }
    start = index + 1;
  }
  groups.push({ separatorBefore, text: value.slice(start) });
  return groups;
}

function mergePossibleShellEnvironments(
  unchanged: NodeJS.ProcessEnv | undefined,
  updated: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  if (unchanged === updated) {
    return unchanged;
  }
  const merged: NodeJS.ProcessEnv = { ...unchanged };
  for (const key of new Set([...Object.keys(unchanged ?? {}), ...Object.keys(updated ?? {})])) {
    if (unchanged?.[key] !== updated?.[key]) {
      merged[key] = ENV_SPLIT_UNKNOWN_ASSIGNMENT_VALUE;
    }
  }
  return merged;
}

function shellTextTopLevelPipelines(value: string): string[][] {
  return splitShellTextAtTopLevel(value, "command-groups").map((group) =>
    splitShellTextAtTopLevel(group, "pipeline"),
  );
}

function commandTextMentionsOpenClawProcessKillPipeline(value: string): boolean {
  for (const pipeline of shellTextTopLevelPipelines(value)) {
    for (let index = 0; index < pipeline.length - 1; index += 1) {
      const sourceArgv = splitShellArgs(pipeline[index]?.trim() ?? "");
      if (!sourceArgv || sourceArgv.length < 2) {
        continue;
      }
      const sourceCommand = normalizeCommandName(sourceArgv[0]);
      const downstream = pipeline.slice(index + 1);
      const psFilterMayTargetOpenClaw =
        sourceCommand === "ps" &&
        downstream.slice(0, -1).some((part) => processFilterTextMayMentionOpenClaw(part));
      const sourceMayTargetOpenClaw =
        sourceCommand === "pgrep"
          ? argvProcessTargetsMayMentionOpenClaw(["pkill", ...sourceArgv.slice(1)])
          : sourceCommand === "pidof"
            ? argvMentionsOpenClawLifecycleTarget(sourceArgv.slice(1))
            : sourceCommand === "echo" || sourceCommand === "printf"
              ? argvMentionsOpenClawLifecycleTarget(sourceArgv.slice(1))
              : psFilterMayTargetOpenClaw;
      if (!sourceMayTargetOpenClaw) {
        continue;
      }
      const sink = downstream.join("|").toLowerCase();
      if (/\bxargs\b[\s\S]{0,120}\b(?:kill|pkill|killall|taskkill|stop-process)\b/.test(sink)) {
        return true;
      }
    }
  }
  return false;
}

function processFilterTextMayMentionOpenClaw(value: string): boolean {
  const normalized = normalizePowerShellBacktickEscapes(value);
  if (tokenMentionsOpenClawLifecycleTarget(normalized)) {
    return true;
  }
  const normalizedArgv = splitShellArgs(normalized)?.map((arg) =>
    normalizePowerShellLifecycleTarget(arg),
  );
  if (normalizedArgv?.some((arg) => tokenMentionsOpenClawLifecycleTarget(arg))) {
    return true;
  }
  const collapsedLiteralClasses = normalized.replaceAll(/\[([A-Za-z0-9])\]/g, "$1");
  return tokenMentionsOpenClawLifecycleTarget(collapsedLiteralClasses);
}

function normalizePowerShellSelectorKind(command: string): "process" | "service" | null {
  if (["get-process", "gps", "ps"].includes(command)) {
    return "process";
  }
  if (["get-service", "gsv"].includes(command)) {
    return "service";
  }
  return null;
}

function powershellSelectorTargetsMayMentionOpenClaw(
  argv: readonly string[],
  matcher: (target: string) => boolean,
): boolean {
  const targets: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (!arg.startsWith("-")) {
      targets.push(normalizePowerShellLifecycleTarget(arg));
      continue;
    }
    const colonIndex = arg.indexOf(":");
    const option = resolvePowerShellOptionAbbreviation(
      colonIndex === -1 ? arg : arg.slice(0, colonIndex),
      POWERSHELL_SELECTOR_KNOWN_OPTIONS,
    );
    if (option !== null && POWERSHELL_SELECTOR_TARGET_OPTIONS.has(option)) {
      const inlineTarget = colonIndex === -1 ? undefined : arg.slice(colonIndex + 1);
      if (inlineTarget) {
        targets.push(normalizePowerShellLifecycleTarget(inlineTarget));
      } else if (argv[index + 1]) {
        targets.push(normalizePowerShellLifecycleTarget(argv[index + 1] ?? ""));
        index += 1;
      }
      continue;
    }
    if (
      option !== null &&
      POWERSHELL_SELECTOR_NON_TARGET_OPTIONS_WITH_VALUE.has(option) &&
      colonIndex === -1
    ) {
      index += 1;
    }
  }
  return targets.some((target) => textContainsActiveVariableReference(target) || matcher(target));
}

function powershellForEachScriptblockMutatesPipelineInput(
  value: string,
  selectorKind: "process" | "service",
): boolean {
  const argv = splitShellArgs(value.trim());
  const command = normalizeCommandName(normalizePowerShellBacktickEscapes(argv?.[0] ?? ""));
  if (!["%", "foreach-object"].includes(command)) {
    return false;
  }
  const bodyStart = value.indexOf("{");
  const bodyEnd = value.lastIndexOf("}");
  if (bodyStart === -1 || bodyEnd <= bodyStart) {
    return false;
  }
  const body = stripPowerShellLineComments(value.slice(bodyStart + 1, bodyEnd));
  for (const group of splitShellCommandGroups(body)) {
    for (const pipeline of shellTextTopLevelPipelines(group.text)) {
      let carriesPipelineInput = false;
      for (const stage of pipeline) {
        const stageArgv = splitShellArgs(stage.trim());
        if (!stageArgv) {
          continue;
        }
        carriesPipelineInput ||= stageArgv.some((arg) => /\$(?:_|psitem)\b/i.test(arg));
        if (!carriesPipelineInput) {
          continue;
        }
        const stageCommand = normalizeCommandName(
          normalizePowerShellBacktickEscapes(stageArgv[0] ?? ""),
        );
        if (powershellCommandIsWhatIfPreview(stageArgv)) {
          continue;
        }
        if (
          (selectorKind === "process" && POWERSHELL_STOP_PROCESS_COMMANDS.has(stageCommand)) ||
          (selectorKind === "service" && POWERSHELL_SERVICE_LIFECYCLE_COMMANDS.has(stageCommand))
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function stripPowerShellPipelineStageGrouping(value: string): string {
  let normalized = value.trim();
  let closingGroups = 0;
  while (normalized.startsWith("$(") || normalized.startsWith("(")) {
    normalized = normalized.slice(normalized.startsWith("$(") ? 2 : 1).trimStart();
    closingGroups += 1;
  }
  while (closingGroups > 0 && normalized.endsWith(")")) {
    normalized = normalized.slice(0, -1).trimEnd();
    closingGroups -= 1;
  }
  return normalized;
}

function commandTextMentionsOpenClawPowerShellLifecyclePipeline(value: string): boolean {
  for (const pipeline of shellTextTopLevelPipelines(value)) {
    for (let index = 0; index < pipeline.length - 1; index += 1) {
      const sourceArgv = splitShellArgs(
        stripPowerShellPipelineStageGrouping(pipeline[index] ?? ""),
      );
      if (!sourceArgv) {
        continue;
      }
      const sourceCommand = normalizeCommandName(
        normalizePowerShellBacktickEscapes(sourceArgv[0] ?? ""),
      );
      const selectorKind = normalizePowerShellSelectorKind(sourceCommand);
      const directlySelectsOpenClaw =
        selectorKind === "process"
          ? powershellSelectorTargetsMayMentionOpenClaw(
              sourceArgv,
              powershellPatternMayMatchOpenClawProcess,
            )
          : selectorKind === "service" &&
            powershellSelectorTargetsMayMentionOpenClaw(
              sourceArgv,
              powershellPatternMayMatchOpenClawService,
            );
      if (!selectorKind) {
        continue;
      }
      for (let sinkIndex = index + 1; sinkIndex < pipeline.length; sinkIndex += 1) {
        const sinkText = pipeline[sinkIndex] ?? "";
        const sinkArgv = splitShellArgs(sinkText.trim());
        const sinkCommand = normalizeCommandName(
          normalizePowerShellBacktickEscapes(sinkArgv?.[0] ?? ""),
        );
        const filteredToOpenClaw = pipeline.slice(index + 1, sinkIndex).some((stageText) => {
          const stageArgv = splitShellArgs(stageText.trim());
          const stageCommand = normalizeCommandName(
            normalizePowerShellBacktickEscapes(stageArgv?.[0] ?? ""),
          );
          return (
            ["?", "where", "where-object"].includes(stageCommand) &&
            processFilterTextMayMentionOpenClaw(stageText)
          );
        });
        const mutatesThroughScriptblock = powershellForEachScriptblockMutatesPipelineInput(
          sinkText,
          selectorKind,
        );
        if (
          (directlySelectsOpenClaw || filteredToOpenClaw) &&
          (mutatesThroughScriptblock ||
            (!powershellCommandIsWhatIfPreview(sinkArgv ?? []) &&
              ((selectorKind === "process" && POWERSHELL_STOP_PROCESS_COMMANDS.has(sinkCommand)) ||
                (selectorKind === "service" &&
                  POWERSHELL_SERVICE_LIFECYCLE_COMMANDS.has(sinkCommand)))))
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

type ShellCommandDialect = "cmd" | "posix" | "powershell";

function normalizeCmdCaretEscapedWordCharacters(value: string): string {
  return value.replaceAll(/\^([A-Za-z0-9_.-])/g, "$1");
}

function stripPowerShellLineComments(value: string): string {
  let result = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (char === "`") {
      result += char;
      escaped = true;
      continue;
    }
    if (quote) {
      result += char;
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      result += char;
      quote = char;
      continue;
    }
    if (char === "#") {
      while (index + 1 < value.length && !/[\r\n]/u.test(value[index + 1] ?? "")) {
        index += 1;
      }
      continue;
    }
    result += char;
  }
  return result;
}

function cmdTextGroupsMentionOpenClawLifecycleMutation(value: string): boolean {
  for (const group of splitCmdCommandGroups(value)) {
    const activeGroup = normalizeCmdCaretEscapedWordCharacters(group.text.trimStart());
    if (!activeGroup || activeGroup.startsWith("::")) {
      continue;
    }
    const argv = splitShellArgs(activeGroup);
    const command = normalizeCommandName(argv?.[0]);
    if (["echo", "rem", "set"].includes(command)) {
      continue;
    }
    if (argv && segmentIsOpenClawLifecycleMutation(argv)) {
      return true;
    }
    if (commandTextRegexMentionsOpenClawLifecycleMutation(activeGroup)) {
      return true;
    }
  }
  return false;
}

function posixTextGroupsRegexMentionOpenClawLifecycleMutation(value: string): boolean {
  for (const group of splitShellCommandGroups(value)) {
    for (const stage of splitShellTextAtTopLevel(group.text, "pipeline")) {
      const activeStage = stripLeadingPosixCompoundGroup(stage);
      const argv = splitShellArgs(activeStage);
      if (argv) {
        const commandArgv = unwrapPosixShellReservedCommandPrefix(argv);
        if (
          argvOnlyReadsLifecycleText(commandArgv) ||
          argvOnlyPreviewsLifecycleMutation(commandArgv)
        ) {
          continue;
        }
      }
      if (commandTextRegexMentionsOpenClawLifecycleMutation(activeStage)) {
        return true;
      }
    }
  }
  return false;
}

function commandTextProcessSubstitutionMayTargetOpenClaw(
  value: string,
  parsedArgv: readonly string[],
): boolean {
  const command = normalizeCommandName(parsedArgv[0]);
  if (
    !PROCESS_LIFECYCLE_COMMANDS.has(command) ||
    processLifecycleCommandIsNonExecuting(parsedArgv) ||
    processLifecycleCommandUsesSignalZero(parsedArgv) ||
    powershellCommandIsWhatIfPreview(parsedArgv)
  ) {
    return false;
  }
  return activeShellCommandSubstitutions(value).some((payload) =>
    processTargetCommandSubstitutionMayMentionOpenClaw(`$(${payload})`),
  );
}

function argvOnlyPreviewsLifecycleMutation(argv: readonly string[]): boolean {
  return (
    processLifecycleCommandIsNonExecuting(argv) ||
    processLifecycleCommandUsesSignalZero(argv) ||
    systemctlKillUsesSignalZero(argv) ||
    powershellCommandIsWhatIfPreview(argv)
  );
}

function commandTextMentionsOpenClawLifecycleMutation(
  value: string,
  dialect: ShellCommandDialect = "posix",
): boolean {
  if (dialect === "powershell") {
    const wrapperArgv = splitShellArgs(value);
    const wrapperCommand = normalizeCommandName(wrapperArgv?.[0]);
    if (wrapperArgv && (wrapperCommand === "powershell" || wrapperCommand === "pwsh")) {
      const inlineCommand =
        extractBindableShellWrapperInlineCommand(wrapperArgv) ??
        extractShellWrapperInlineCommand(wrapperArgv);
      if (inlineCommand !== null) {
        return commandTextMentionsOpenClawLifecycleMutation(inlineCommand, "powershell");
      }
    }
  }
  const activeValue =
    dialect === "cmd"
      ? normalizeCmdCaretEscapedWordCharacters(value.trimStart())
      : dialect === "powershell"
        ? stripPowerShellLineComments(value).trimStart()
        : stripLeadingPosixCompoundGroup(stripUnquotedShellComments(value));
  if (dialect === "cmd" && activeValue.startsWith("::")) {
    return false;
  }
  if (dialect === "cmd") {
    return cmdTextGroupsMentionOpenClawLifecycleMutation(activeValue);
  }
  if (dialect === "posix" && commandTextHasInvokedPosixFunctionLifecycleMutation(activeValue)) {
    return true;
  }
  if (
    dialect === "powershell" &&
    powershellDynamicCommandMentionsOpenClawLifecycleMutation(activeValue)
  ) {
    return true;
  }
  const hasControlOperator =
    dialect === "powershell"
      ? /[;|&]/u.test(activeValue)
      : hasTopLevelShellControlOperator(activeValue);
  if (commandTextHasOpenClawLifecycleCommandSubstitution(activeValue)) {
    return true;
  }
  const parsedArgv = splitShellArgs(activeValue);
  if (parsedArgv && !hasControlOperator && argvOnlyPreviewsLifecycleMutation(parsedArgv)) {
    return false;
  }
  if (parsedArgv && !hasControlOperator && argvOnlyReadsLifecycleText(parsedArgv)) {
    return false;
  }
  if (
    (dialect === "posix" &&
      parsedArgv &&
      commandTextProcessSubstitutionMayTargetOpenClaw(activeValue, parsedArgv)) ||
    (dialect === "posix" && commandTextMentionsOpenClawProcessKillPipeline(activeValue)) ||
    (dialect === "powershell" &&
      commandTextMentionsOpenClawPowerShellLifecyclePipeline(activeValue))
  ) {
    return true;
  }
  if (parsedArgv && parsedArgv.length > 1 && segmentIsOpenClawLifecycleMutation(parsedArgv)) {
    return true;
  }
  if (dialect === "posix" && shellTextSegmentsMentionOpenClawLifecycleMutation(activeValue)) {
    return true;
  }
  return dialect === "posix"
    ? posixTextGroupsRegexMentionOpenClawLifecycleMutation(activeValue)
    : commandTextRegexMentionsOpenClawLifecycleMutation(activeValue);
}

function stripLeadingPosixCompoundGroup(value: string): string {
  let active = value.trimStart();
  while (active.startsWith("(") || /^\{\s/u.test(active)) {
    active = active.slice(1).trimStart();
  }
  return active;
}

function findPosixFunctionBodyEnd(value: string, bodyStart: number): number | null {
  let depth = 1;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = bodyStart; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? undefined : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    if (quote) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return null;
}

type PosixFunctionDefinition = {
  body: string;
  endOffset: number;
  name: string;
  startOffset: number;
};

function posixTextInvokedFunctionNames(
  value: string,
  functionNames: ReadonlySet<string>,
): Set<string> {
  const invoked = new Set<string>();
  for (const group of splitShellCommandGroups(value)) {
    for (const stage of splitShellTextAtTopLevel(group.text, "pipeline")) {
      const argv = splitShellArgs(stripLeadingPosixCompoundGroup(stage));
      if (!argv) {
        continue;
      }
      const commandArgv = unwrapPosixShellReservedCommandPrefix(argv);
      const command = commandArgv[0];
      if (command && functionNames.has(command)) {
        invoked.add(command);
      }
    }
  }
  return invoked;
}

function commandTextHasInvokedPosixFunctionLifecycleMutation(value: string): boolean {
  const definitionPattern =
    /(?:^|[;&|\r\n]\s*)(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?\s*\{/g;
  const definitions = new Map<string, PosixFunctionDefinition>();
  for (const match of value.matchAll(definitionPattern)) {
    const name = match[1];
    if (!name || match.index === undefined) {
      continue;
    }
    const bodyStart = match.index + match[0].length;
    const bodyEnd = findPosixFunctionBodyEnd(value, bodyStart);
    if (bodyEnd === null) {
      continue;
    }
    definitions.set(name, {
      body: value.slice(bodyStart, bodyEnd),
      endOffset: bodyEnd + 1,
      name,
      startOffset: match.index,
    });
  }
  if (definitions.size === 0) {
    return false;
  }
  let topLevelText = value;
  const definitionRanges = [...definitions.values()].toSorted(
    (left, right) => right.startOffset - left.startOffset,
  );
  for (const definition of definitionRanges) {
    topLevelText =
      topLevelText.slice(0, definition.startOffset) +
      " ".repeat(definition.endOffset - definition.startOffset) +
      topLevelText.slice(definition.endOffset);
  }
  const functionNames = new Set(definitions.keys());
  const pending = [...posixTextInvokedFunctionNames(topLevelText, functionNames)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop();
    if (!name || visited.has(name)) {
      continue;
    }
    visited.add(name);
    const definition = definitions.get(name);
    if (!definition) {
      continue;
    }
    if (commandTextMentionsOpenClawLifecycleMutation(definition.body)) {
      return true;
    }
    for (const calledName of posixTextInvokedFunctionNames(definition.body, functionNames)) {
      if (!visited.has(calledName)) {
        pending.push(calledName);
      }
    }
  }
  return false;
}

const POSIX_SHELL_RESERVED_COMMAND_PREFIXES = new Set([
  "!",
  "do",
  "elif",
  "else",
  "if",
  "then",
  "until",
  "while",
]);

function unwrapPosixShellReservedCommandPrefix(argv: readonly string[]): readonly string[] {
  let current = argv;
  for (let depth = 0; current.length > 0 && depth < 16; depth += 1) {
    const first = normalizeLowercaseStringOrEmpty(current[0]);
    if (POSIX_SHELL_RESERVED_COMMAND_PREFIXES.has(first)) {
      current = current.slice(1);
      continue;
    }
    if (first === "case") {
      const labelIndex = current.findIndex(
        (token, index) => index > 1 && token.trimEnd().endsWith(")"),
      );
      return labelIndex === -1 ? current : current.slice(labelIndex + 1);
    }
    if (current[0]?.trimEnd().endsWith(")")) {
      current = current.slice(1);
      continue;
    }
    break;
  }
  return current;
}

function posixShellCommandEnvironmentIsConditional(argv: readonly string[]): boolean {
  const first = normalizeLowercaseStringOrEmpty(argv[0]);
  return (
    first === "then" ||
    first === "elif" ||
    first === "else" ||
    first === "do" ||
    first === "case" ||
    Boolean(argv[0]?.trimEnd().endsWith(")"))
  );
}

function stripUnquotedShellComments(value: string): string {
  let result = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let wordStart = true;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (escaped) {
      result += char;
      escaped = false;
      wordStart = false;
      continue;
    }
    if (quote) {
      result += char;
      if (quote === '"' && char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "\\") {
      result += char;
      escaped = true;
      wordStart = false;
      continue;
    }
    if (char === "'" || char === '"') {
      result += char;
      quote = char;
      wordStart = false;
      continue;
    }
    if (char === "#" && wordStart) {
      while (index + 1 < value.length && !/[\r\n]/u.test(value[index + 1] ?? "")) {
        index += 1;
      }
      continue;
    }
    result += char;
    wordStart = /\s/u.test(char) || char === ";" || char === "&" || char === "|";
  }
  return result;
}

function shellTextSegmentsMentionOpenClawLifecycleMutation(
  value: string,
  initialEnv?: NodeJS.ProcessEnv,
  envComplete = false,
): boolean {
  let visibleEnv = initialEnv;
  for (const group of splitShellCommandGroups(value)) {
    const pipeline = splitShellTextAtTopLevel(group.text, "pipeline");
    for (const shellSegment of pipeline) {
      const segmentText = stripLeadingPosixCompoundGroup(shellSegment);
      if (!segmentText) {
        continue;
      }
      const parsedArgv = splitShellArgs(segmentText);
      if (!parsedArgv || parsedArgv.length === 0) {
        continue;
      }
      const lifecycleArgv = unwrapPosixShellReservedCommandPrefix(parsedArgv);
      const segmentEnv = collectShellPrefixAssignmentsFromArgv(lifecycleArgv, visibleEnv);
      const nextVisibleEnv = collectStandaloneShellAssignmentsFromArgv(lifecycleArgv, visibleEnv);
      if (
        argvMayExpandWithShellVariablesToLifecycle(
          lifecycleArgv,
          visibleEnv,
          envComplete,
          undefined,
          segmentText,
          segmentEnv,
        ) ||
        argvHasPotentialEnvSplitLifecycleExpansion(lifecycleArgv, segmentEnv, 0, envComplete) ||
        segmentIsOpenClawLifecycleMutation(lifecycleArgv, undefined, false)
      ) {
        return true;
      }
      if (pipeline.length === 1) {
        visibleEnv =
          group.separatorBefore === "conditional" ||
          posixShellCommandEnvironmentIsConditional(parsedArgv)
            ? mergePossibleShellEnvironments(visibleEnv, nextVisibleEnv)
            : group.separatorBefore === "background"
              ? visibleEnv
              : nextVisibleEnv;
      }
    }
  }
  return false;
}

export function commandRequiresOpenClawLifecycleApproval(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  envComplete?: boolean;
  segments: Array<
    Pick<ExecCommandSegment, "argv"> &
      Partial<Pick<ExecCommandSegment, "raw" | "resolution" | "sourceArgv">>
  >;
}): boolean {
  const envComplete = params.envComplete ?? params.env !== undefined;
  let visibleEnv = params.env;
  const segmentCommands = params.segments.map((segment) =>
    normalizeCommandName(segment.sourceArgv?.[0] ?? segment.argv[0]),
  );
  const commandStageCommands = shellTextTopLevelPipelines(params.command)
    .flat()
    .map((stage) => {
      const argv = splitShellArgs(stage.trim());
      return normalizeCommandName(normalizePowerShellBacktickEscapes(argv?.[0] ?? ""));
    });
  const usesPowerShellLifecycleSyntax =
    [...segmentCommands, ...commandStageCommands].some(
      (command) =>
        command === "get-process" ||
        command === "get-service" ||
        command === "gps" ||
        command === "gsv" ||
        command === "spps" ||
        command === "stop-process" ||
        POWERSHELL_SERVICE_LIFECYCLE_COMMANDS.has(command),
    ) || commandHasPowerShellVariableCallOperator(params.command);
  const commandDialect: ShellCommandDialect = segmentCommands.includes("cmd")
    ? "cmd"
    : segmentCommands.some((command) => command === "powershell" || command === "pwsh") ||
        usesPowerShellLifecycleSyntax
      ? "powershell"
      : "posix";
  const activeCommand =
    commandDialect === "cmd"
      ? params.command
      : commandDialect === "powershell"
        ? stripPowerShellLineComments(params.command)
        : stripUnquotedShellComments(params.command);
  if (
    commandDialect === "powershell" &&
    powershellDynamicCommandMentionsOpenClawLifecycleMutation(activeCommand)
  ) {
    return true;
  }
  const activeCommandArgv = splitShellArgs(activeCommand);
  const activeCommandOnlyPreviewsLifecycle =
    activeCommandArgv !== null &&
    !hasTopLevelShellControlOperator(activeCommand) &&
    argvOnlyPreviewsLifecycleMutation(activeCommandArgv);
  if (
    (commandDialect !== "cmd" &&
      commandTextHasOpenClawLifecycleCommandSubstitutionForDialect(
        activeCommand,
        commandDialect,
      )) ||
    (!activeCommandOnlyPreviewsLifecycle &&
      ((commandDialect === "posix" &&
        commandTextHasInvokedPosixFunctionLifecycleMutation(activeCommand)) ||
        (commandDialect === "posix" &&
          commandTextMentionsOpenClawProcessKillPipeline(activeCommand)) ||
        (commandDialect === "powershell" &&
          commandTextMentionsOpenClawPowerShellLifecyclePipeline(activeCommand)) ||
        (commandDialect === "posix" &&
          shellTextSegmentsMentionOpenClawLifecycleMutation(
            activeCommand,
            params.env,
            envComplete,
          ))))
  ) {
    return true;
  }
  for (const segment of params.segments) {
    const lifecycleArgv = segment.sourceArgv?.length ? segment.sourceArgv : segment.argv;
    const segmentEnv = collectShellPrefixAssignmentsFromRaw(segment.raw, visibleEnv);
    const nextVisibleEnv = collectStandaloneShellAssignmentsFromArgv(lifecycleArgv, visibleEnv);
    const segmentText = segment.raw?.trim() || lifecycleArgv.join(" ");
    const segmentCommand = normalizeCommandName(lifecycleArgv[0]);
    const segmentDialect: ShellCommandDialect =
      segmentCommand === "cmd"
        ? "cmd"
        : segmentCommand === "powershell" || segmentCommand === "pwsh"
          ? "powershell"
          : "posix";
    if (
      segmentDialect !== "cmd" &&
      commandTextHasOpenClawLifecycleCommandSubstitutionForDialect(segmentText, segmentDialect)
    ) {
      return true;
    }
    if (argvOnlyPreviewsLifecycleMutation(lifecycleArgv)) {
      visibleEnv = nextVisibleEnv;
      continue;
    }
    if (
      segmentDialect === "posix" &&
      commandTextProcessSubstitutionMayTargetOpenClaw(segmentText, lifecycleArgv)
    ) {
      return true;
    }
    if (
      argvMayExpandWithShellVariablesToLifecycle(
        lifecycleArgv,
        visibleEnv,
        envComplete,
        params.cwd,
        segment.raw,
        segmentEnv,
      )
    ) {
      return true;
    }
    if (argvHasPotentialEnvSplitLifecycleExpansion(lifecycleArgv, segmentEnv, 0, envComplete)) {
      return true;
    }
    if (segmentIsOpenClawLifecycleMutation(lifecycleArgv, params.cwd)) {
      return true;
    }
    const resolvedExecutable =
      segment.resolution?.execution.resolvedRealPath?.trim() ||
      segment.resolution?.execution.resolvedPath?.trim();
    const resolvedBaseArgv = segment.resolution?.effectiveArgv?.length
      ? segment.resolution.effectiveArgv
      : segment.argv;
    if (
      resolvedExecutable &&
      tokenLooksLikeOpenClawCli(resolvedExecutable, params.cwd) &&
      segmentIsOpenClawLifecycleMutation(["openclaw", ...resolvedBaseArgv.slice(1)], params.cwd)
    ) {
      return true;
    }
    if (!commandTextMentionsOpenClawLifecycleMutation(segmentText, segmentDialect)) {
      visibleEnv = nextVisibleEnv;
      continue;
    }
    visibleEnv = nextVisibleEnv;
  }
  if (params.segments.length > 0) {
    return false;
  }
  return commandTextMentionsOpenClawLifecycleMutation(activeCommand, commandDialect);
}

function removeParsedSegmentText(
  command: string,
  segments: Array<{ argv?: string[]; raw?: string }>,
): string {
  let remaining = command;
  for (const segment of segments) {
    const raw = (segment.raw ?? segment.argv?.join(" "))?.trim();
    if (!raw) {
      continue;
    }
    remaining = remaining.replace(raw, " ");
  }
  return remaining;
}

export function commandRequiresSecurityAuditSuppressionApproval(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  segments: Array<{ argv: string[]; raw?: string }>;
}): boolean {
  let sawSegmentMention = false;
  for (const segment of params.segments) {
    const segmentText = `${segment.raw ?? ""} ${segment.argv.join(" ")}`;
    if (!textMentionsSecurityAuditSuppressions(segmentText)) {
      continue;
    }
    sawSegmentMention = true;
    if (!isReadOnlySecurityAuditSuppressionInspection(segment.argv)) {
      return true;
    }
  }
  if (sawSegmentMention) {
    const unparsedText = removeParsedSegmentText(params.command, params.segments);
    if (textMentionsSecurityAuditSuppressions(unparsedText)) {
      return true;
    }
    return false;
  }
  return textMentionsSecurityAuditSuppressions(params.command);
}

export function hasDurableExecApproval(params: {
  analysisOk: boolean;
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
  allowlist?: readonly ExecAllowlistEntry[];
  commandText?: string | null;
}): boolean {
  return (
    hasExactCommandDurableExecApproval({
      allowlist: params.allowlist,
      commandText: params.commandText,
    }) ||
    hasSegmentDurableExecApproval({
      analysisOk: params.analysisOk,
      segmentAllowlistEntries: params.segmentAllowlistEntries,
    })
  );
}

// Digest input is the trimmed command text only. Shipped approvals files
// already hold `=command:` entries in this format; changing the input
// silently orphans every persisted exact-command grant.
function buildDurableCommandApprovalPattern(commandText: string): string {
  return `=command:${sha256HexPrefix(commandText, 16)}`;
}

function buildNodeCommandApprovalPattern(commandText: string): string {
  return `=node-command:${sha256HexPrefix(commandText, 16)}`;
}

export function hasNodeCommandAllowAlwaysMarker(params: {
  allowlist?: readonly ExecAllowlistEntry[];
  commandText?: string | null;
}): boolean {
  const normalizedCommand = params.commandText?.trim();
  if (!normalizedCommand) {
    return false;
  }
  const commandPattern = buildNodeCommandApprovalPattern(normalizedCommand);
  return (params.allowlist ?? []).some(
    (entry) => entry.source === "allow-always" && entry.pattern === commandPattern,
  );
}

export function hasExactCommandDurableExecApproval(params: {
  allowlist?: readonly ExecAllowlistEntry[];
  commandText?: string | null;
}): boolean {
  const normalizedCommand = params.commandText?.trim();
  if (!normalizedCommand) {
    return false;
  }
  const commandPattern = buildDurableCommandApprovalPattern(normalizedCommand);
  return (params.allowlist ?? []).some(
    (entry) =>
      entry.source === "allow-always" &&
      (entry.pattern === commandPattern ||
        (typeof entry.commandText === "string" && entry.commandText.trim() === normalizedCommand)),
  );
}

type DurableExecApprovalRequirement = "exact-command" | "segment-allowlist";

/** Callers pass whether their final, post-gate authorization depends on a durable grant. */
export function resolveDurableExecApprovalRequirement(params: {
  durableApprovalRequired: boolean;
  allowlist?: readonly ExecAllowlistEntry[];
  commandText?: string | null;
}): DurableExecApprovalRequirement | null {
  if (!params.durableApprovalRequired) {
    return null;
  }
  return hasExactCommandDurableExecApproval({
    allowlist: params.allowlist,
    commandText: params.commandText,
  })
    ? "exact-command"
    : "segment-allowlist";
}

function hasSegmentDurableExecApproval(params: {
  analysisOk: boolean;
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
}): boolean {
  return (
    params.analysisOk &&
    params.segmentAllowlistEntries.length > 0 &&
    params.segmentAllowlistEntries.every((entry) => entry?.source === "allow-always")
  );
}

function buildAllowlistEntryMatchKey(
  entry: Pick<ExecAllowlistEntry, "pattern" | "argPattern">,
): string {
  return JSON.stringify([entry.pattern, entry.argPattern ?? null]);
}

function buildExecApprovalPolicyRuleKey(
  entry: Pick<ExecAllowlistEntry, "pattern" | "argPattern" | "source">,
): string {
  // A JSON tuple preserves exact regex bytes without delimiter collisions.
  return JSON.stringify([entry.pattern, entry.argPattern ?? null, entry.source ?? null]);
}

function buildAllowAlwaysUpgradeRuleKey(
  rule: Pick<ExecAllowlistEntry, "pattern" | "argPattern" | "source">,
): string | null {
  if (rule.source !== undefined) {
    return null;
  }
  return buildExecApprovalPolicyRuleKey({ ...rule, source: "allow-always" });
}

/** Captures effective file policy while excluding ids and mutable usage metadata. */
export function createExecApprovalPolicySnapshot(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
}): ExecApprovalPolicySnapshot {
  // Runtime overrides are deliberately absent: the snapshot protects the
  // persisted policy that may change while a human approval is pending.
  const resolved = resolveExecApprovalsFromFile({
    file: params.file,
    agentId: params.agentId,
  });
  const allowlistRulesByKey = new Map(
    resolved.allowlist.map((entry) => {
      const rule = {
        pattern: entry.pattern,
        ...(entry.argPattern !== undefined ? { argPattern: entry.argPattern } : {}),
        ...(entry.source === "allow-always" ? { source: entry.source } : {}),
      };
      return [buildExecApprovalPolicyRuleKey(rule), rule] as const;
    }),
  );
  return {
    security: resolved.agent.security,
    ask: resolved.agent.ask,
    askFallback: resolved.agent.askFallback,
    autoAllowSkills: resolved.agent.autoAllowSkills,
    allowlistRules: canonicalizeExecApprovalPolicyRules([...allowlistRulesByKey.values()]),
  };
}

export function isExecApprovalPolicySnapshotCurrent(
  expected: ExecApprovalPolicySnapshot,
  current: ExecApprovalPolicySnapshot,
): boolean {
  const currentRuleKeys = new Set(current.allowlistRules.map(buildExecApprovalPolicyRuleKey));
  return (
    expected.security === current.security &&
    expected.ask === current.ask &&
    expected.askFallback === current.askFallback &&
    expected.autoAllowSkills === current.autoAllowSkills &&
    // Concurrent operator-approved grants are additive. Preserve them while
    // accepting an in-place allow-always upgrade of the same rule. Revocations
    // and reverse source downgrades still remove an expected authority.
    expected.allowlistRules.every((rule) => {
      const key = buildExecApprovalPolicyRuleKey(rule);
      if (currentRuleKeys.has(key)) {
        return true;
      }
      const upgradedKey = buildAllowAlwaysUpgradeRuleKey(rule);
      return upgradedKey !== null && currentRuleKeys.has(upgradedKey);
    })
  );
}

export type ExecApprovalUsageAuthorization = {
  source: "current-policy" | "ask-fallback" | "explicit-approval" | "auto-review";
  security: ExecSecurity;
  ask: ExecAsk;
  allowlistSatisfied: boolean;
  policySnapshot?: ExecApprovalPolicySnapshot;
  requireAutoAllowSkills?: boolean;
  requireExactCommandApproval?: boolean;
  requireDurableAllowlistApproval?: boolean;
};

function assertCurrentUsageAuthorization(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
  command: string;
  matchKeys: ReadonlySet<string>;
  authorization: ExecApprovalUsageAuthorization;
}): void {
  const current = resolveExecApprovalsFromFile({
    file: params.file,
    agentId: params.agentId,
    overrides: {
      security: params.authorization.security,
      ask: params.authorization.ask,
    },
  });
  const security = minSecurity(params.authorization.security, current.agent.security);
  const ask = maxAsk(params.authorization.ask, current.agent.ask);
  if (security === "deny") {
    throw new Error("Exec approval changed before execution");
  }
  // Human and model decisions are delayed authority. Bind both one-shot and
  // persistent decisions to the persisted policy they were evaluated against.
  const delayedAuthorization =
    params.authorization.source === "explicit-approval" ||
    params.authorization.source === "auto-review";
  if (delayedAuthorization) {
    const expectedPolicy = params.authorization.policySnapshot;
    if (
      !expectedPolicy ||
      !isExecApprovalPolicySnapshotCurrent(
        expectedPolicy,
        createExecApprovalPolicySnapshot({ file: params.file, agentId: params.agentId }),
      )
    ) {
      throw new Error("Exec approval changed before execution");
    }
  }
  if (params.authorization.source === "explicit-approval") {
    return;
  }
  if (params.authorization.source === "auto-review") {
    if (ask === "always") {
      throw new Error("Exec approval changed before execution");
    }
    return;
  }
  let authorizationSecurity = security;
  if (params.authorization.source === "ask-fallback") {
    const askFallback = minSecurity(security, current.agent.askFallback);
    // The execution plan was built for the evaluated fallback mode. If policy
    // tightened, fail closed instead of reusing a broader argv plan.
    if (askFallback === "deny" || askFallback !== params.authorization.security) {
      throw new Error("Exec approval changed before execution");
    }
    if (askFallback === "full") {
      return;
    }
    authorizationSecurity = askFallback;
  } else if (
    // A current-policy plan may only survive policy broadening. Tightening from
    // full to allowlist requires a newly bound command, not the stale raw plan.
    security !== params.authorization.security ||
    ask !== params.authorization.ask
  ) {
    throw new Error("Exec approval changed before execution");
  }
  if (authorizationSecurity !== "allowlist") {
    return;
  }
  if (params.authorization.requireExactCommandApproval) {
    if (
      !hasExactCommandDurableExecApproval({
        allowlist: current.allowlist,
        commandText: params.command,
      })
    ) {
      throw new Error("Exec approval changed before execution");
    }
    return;
  }
  if (params.authorization.requireDurableAllowlistApproval) {
    const durableKeys = new Set(
      current.allowlist
        .filter((entry) => entry.source === "allow-always")
        .map(buildAllowlistEntryMatchKey),
    );
    if (params.matchKeys.size === 0 || [...params.matchKeys].some((key) => !durableKeys.has(key))) {
      throw new Error("Exec approval changed before execution");
    }
  }
  if (!params.authorization.allowlistSatisfied) {
    throw new Error("Exec approval changed before execution");
  }
  const currentKeys = new Set(current.allowlist.map(buildAllowlistEntryMatchKey));
  if ([...params.matchKeys].some((key) => !currentKeys.has(key))) {
    throw new Error("Exec approval changed before execution");
  }
  if (params.authorization.requireAutoAllowSkills && !current.agent.autoAllowSkills) {
    throw new Error("Exec approval changed before execution");
  }
}

function replaceExecApprovalsSnapshot(target: ExecApprovalsFile, source: ExecApprovalsFile): void {
  target.version = source.version;
  if (source.socket === undefined) {
    delete target.socket;
  } else {
    target.socket = source.socket;
  }
  if (source.defaults === undefined) {
    delete target.defaults;
  } else {
    target.defaults = source.defaults;
  }
  if (source.agents === undefined) {
    delete target.agents;
  } else {
    target.agents = source.agents;
  }
}

export function recordAllowlistUse(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  entry: ExecAllowlistEntry,
  command: string,
  resolvedPath?: string,
): void {
  recordAllowlistMatchesUse({
    approvals,
    agentId,
    matches: [entry],
    command,
    resolvedPath,
  });
}

export function recordAllowlistMatchesUse(params: {
  approvals: ExecApprovalsFile;
  agentId: string | undefined;
  matches: readonly ExecAllowlistEntry[];
  command: string;
  resolvedPath?: string;
  authorization?: ExecApprovalUsageAuthorization;
}): void {
  if (params.matches.length === 0 && !params.authorization) {
    return;
  }
  const snapshot = updateExecApprovalsSync({
    update: (file) => applyRecordedAllowlistUse({ ...params, file }),
  });
  if (snapshot) {
    replaceExecApprovalsSnapshot(params.approvals, snapshot.file);
  }
}

function applyRecordedAllowlistUse(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
  matches: readonly ExecAllowlistEntry[];
  command: string;
  resolvedPath?: string;
  authorization?: ExecApprovalUsageAuthorization;
}): ExecApprovalsFile | null {
  const keys = new Set(
    params.matches.filter((entry) => entry.pattern).map(buildAllowlistEntryMatchKey),
  );
  if (params.authorization) {
    assertCurrentUsageAuthorization({
      file: params.file,
      agentId: params.agentId,
      command: params.command,
      matchKeys: keys,
      authorization: params.authorization,
    });
  }
  return applyRecordedAllowlistMetadata(params);
}

function applyRecordedAllowlistMetadata(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
  matches: readonly ExecAllowlistEntry[];
  command: string;
  resolvedPath?: string;
}): ExecApprovalsFile | null {
  const keys = new Set(
    params.matches.filter((entry) => entry.pattern).map(buildAllowlistEntryMatchKey),
  );
  if (keys.size === 0) {
    return null;
  }
  const target = params.agentId ?? DEFAULT_AGENT_ID;
  const agents = params.file.agents ?? {};
  let changed = false;
  const nextAgents = { ...agents };
  for (const key of target === "*" ? [target] : ["*", target]) {
    const existing = agents[key];
    if (!existing?.allowlist) {
      continue;
    }
    let entryChanged = false;
    const nextAllowlist = existing.allowlist.map((entry) => {
      if (!keys.has(buildAllowlistEntryMatchKey(entry))) {
        return entry;
      }
      changed = true;
      entryChanged = true;
      return Object.assign({}, entry, {
        id: entry.id ?? crypto.randomUUID(),
        lastUsedAt: Date.now(),
        lastUsedCommand: params.command,
        lastResolvedPath: params.resolvedPath,
      });
    });
    if (entryChanged) {
      nextAgents[key] = { ...existing, allowlist: nextAllowlist };
    }
  }
  return changed
    ? {
        ...params.file,
        agents: nextAgents,
      }
    : null;
}
export async function commitExecAuthorizationLocked(params: {
  agentId: string | undefined;
  matches: readonly ExecAllowlistEntry[];
  command: string;
  resolvedPath?: string;
  authorization: ExecApprovalUsageAuthorization;
  allowAlwaysDecision?: AllowAlwaysPersistenceDecision;
}): Promise<void> {
  if (
    (params.authorization.source === "explicit-approval" ||
      params.authorization.source === "auto-review") &&
    !params.authorization.policySnapshot
  ) {
    throw new Error("Delayed exec authorization requires a policy snapshot");
  }
  if (params.allowAlwaysDecision && params.allowAlwaysDecision.kind !== "one-shot") {
    if (params.authorization.source !== "explicit-approval") {
      throw new Error("Allow-always persistence requires explicit approval");
    }
  }
  await updateExecApprovals({
    update: (file) => {
      const matchKeys = new Set(
        params.matches.filter((entry) => entry.pattern).map(buildAllowlistEntryMatchKey),
      );
      assertCurrentUsageAuthorization({
        file,
        agentId: params.agentId,
        command: params.command,
        matchKeys,
        authorization: params.authorization,
      });

      let next = file;
      let changed = false;
      if (params.allowAlwaysDecision && params.allowAlwaysDecision.kind !== "one-shot") {
        const granted = applyAllowAlwaysDecision({
          file: next,
          agentId: params.agentId,
          decision: params.allowAlwaysDecision,
        });
        if (granted) {
          next = granted;
          changed = true;
        }
      }
      const recorded = applyRecordedAllowlistMetadata({ ...params, file: next });
      return recorded ?? (changed ? next : null);
    },
  });
}

function applyAllowlistEntryUpdate(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
  pattern: string;
  options?: {
    argPattern?: string;
    source?: ExecAllowlistEntry["source"];
  };
}): ExecApprovalsFile | null {
  const target = params.agentId ?? DEFAULT_AGENT_ID;
  const agents = params.file.agents ?? {};
  const existing = agents[target] ?? {};
  const allowlist = Array.isArray(existing.allowlist) ? existing.allowlist : [];
  const trimmed = params.pattern.trim();
  if (!trimmed) {
    return null;
  }
  const argPattern = params.options?.argPattern === "" ? undefined : params.options?.argPattern;
  const existingEntry = allowlist.find(
    (entry) => entry.pattern === trimmed && (entry.argPattern ?? undefined) === argPattern,
  );
  if (
    existingEntry &&
    (!params.options?.source || existingEntry.source === params.options.source)
  ) {
    return null;
  }
  const now = Date.now();
  const nextAllowlist = existingEntry
    ? allowlist.map((entry) =>
        entry.pattern === trimmed && (entry.argPattern ?? undefined) === argPattern
          ? {
              ...entry,
              argPattern,
              source: params.options?.source ?? entry.source,
              lastUsedAt: now,
            }
          : entry,
      )
    : [
        ...allowlist,
        {
          id: crypto.randomUUID(),
          pattern: trimmed,
          argPattern,
          source: params.options?.source,
          lastUsedAt: now,
        },
      ];
  return {
    ...params.file,
    agents: { ...agents, [target]: { ...existing, allowlist: nextAllowlist } },
  };
}

export function addAllowlistEntry(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  pattern: string,
  options?: {
    argPattern?: string;
    source?: ExecAllowlistEntry["source"];
  },
): void {
  const snapshot = updateExecApprovalsSync({
    update: (file) =>
      applyAllowlistEntryUpdate({
        file,
        agentId,
        pattern,
        options,
      }),
  });
  if (snapshot) {
    replaceExecApprovalsSnapshot(approvals, snapshot.file);
  }
}

export function addDurableCommandApproval(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  commandText: string,
): void {
  const normalized = commandText.trim();
  if (!normalized) {
    return;
  }
  addAllowlistEntry(approvals, agentId, buildDurableCommandApprovalPattern(normalized), {
    source: "allow-always",
  });
}

export function resolveAllowAlwaysPatternCoverage(params: {
  segments: ExecCommandSegment[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
}): {
  complete: boolean;
  patterns: ReturnType<typeof resolveAllowAlwaysPatternEntries>;
} {
  const byKey = new Map<string, ReturnType<typeof resolveAllowAlwaysPatternEntries>[number]>();
  let representedSegmentCount = 0;
  for (const segment of params.segments) {
    if (isShellWrapperInvocation(segment.argv)) {
      const segmentPatterns = resolveAllowAlwaysPatternEntries({
        segments: [segment],
        cwd: params.cwd,
        env: params.env,
        platform: params.platform,
        strictInlineEval: params.strictInlineEval,
      });
      for (const pattern of segmentPatterns) {
        byKey.set(`${pattern.pattern}\x00${pattern.argPattern ?? ""}`, pattern);
      }
      continue;
    }
    const segmentPatterns = resolveAllowAlwaysPatternEntries({
      segments: [segment],
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      strictInlineEval: params.strictInlineEval,
    });
    if (segmentPatterns.length === 0) {
      continue;
    }
    representedSegmentCount += 1;
    for (const pattern of segmentPatterns) {
      byKey.set(`${pattern.pattern}\x00${pattern.argPattern ?? ""}`, pattern);
    }
  }
  return {
    complete: params.segments.length > 0 && representedSegmentCount === params.segments.length,
    patterns: [...byKey.values()],
  };
}

export function persistAllowAlwaysPatterns(params: {
  approvals: ExecApprovalsFile;
  agentId: string | undefined;
  segments: ExecCommandSegment[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  commandText?: string;
  strictInlineEval?: boolean;
}): ReturnType<typeof resolveAllowAlwaysPatternEntries> {
  const coverage = resolveAllowAlwaysPatternCoverage(params);
  const commandText = params.commandText?.trim();
  persistAllowAlwaysDecision({
    approvals: params.approvals,
    agentId: params.agentId,
    decision: {
      kind: "patterns",
      patterns: coverage.patterns,
      ...(commandText && coverage.complete && coverage.patterns.length > 0 ? { commandText } : {}),
    },
  });
  return coverage.patterns;
}

export type AllowAlwaysPersistenceReason =
  | "no-reusable-pattern"
  | "prompt-only"
  | "runtime-payload"
  | "unplanned";

export type AllowAlwaysPersistenceDecision =
  | { kind: "patterns"; patterns: readonly AllowAlwaysPattern[]; commandText?: string }
  | { kind: "exact-command"; commandText: string }
  | { kind: "one-shot"; reasons: AllowAlwaysPersistenceReason[] };

function hasRuntimeShellPayload(argv: readonly string[]): boolean {
  const inlineCommand = extractBindableShellWrapperInlineCommand([...argv]);
  return Boolean(
    inlineCommand &&
    (/(?:\$[A-Za-z0-9_@*?#$!-]|\$\{|`|\$\()/u.test(inlineCommand) ||
      hasPosixInteractiveStartupBeforeInlineCommand(argv, POSIX_INLINE_COMMAND_FLAGS) ||
      hasPosixLoginStartupBeforeInlineCommand(argv, POSIX_INLINE_COMMAND_FLAGS)),
  );
}

function resolvePlanPersistenceState(plan: ExecAuthorizationPlan | undefined): {
  reusablePatternsAllowed: boolean;
  reasons: AllowAlwaysPersistenceReason[];
} {
  if (!plan) {
    return { reusablePatternsAllowed: true, reasons: [] };
  }
  if (!plan.ok) {
    return { reusablePatternsAllowed: false, reasons: ["unplanned"] };
  }
  const reasons = new Set<AllowAlwaysPersistenceReason>();
  let reusablePatternsAllowed = true;
  const candidates = plan.groups.flatMap((group) => group.candidates);
  for (const candidate of candidates) {
    if (candidate.trustMode === "prompt-only") {
      reasons.add("prompt-only");
    }
    if (candidate.trustMode === "exact-command") {
      // Durable `=command:` entries are command-text-only and cannot bind
      // cwd, env, or PATH, so planner exact-command candidates stay one-shot.
      reasons.add("no-reusable-pattern");
    }
    if (candidate.trustMode === "executable" && !candidate.allowAlways) {
      reasons.add("no-reusable-pattern");
    }
    reusablePatternsAllowed = reusablePatternsAllowed && candidate.allowAlways;
    if (hasRuntimeShellPayload(candidate.sourceSegment.argv)) {
      reasons.add("runtime-payload");
    }
    if (
      candidate.transport.kind === "shell-wrapper" &&
      hasRuntimeShellPayload(candidate.transport.wrapperArgv)
    ) {
      reasons.add("runtime-payload");
    }
  }
  return {
    reusablePatternsAllowed,
    reasons: [...reasons],
  };
}

export function resolveAllowAlwaysPersistenceDecision(params: {
  segments: ExecCommandSegment[];
  commandText?: string | null;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
  authorizationPlan?: ExecAuthorizationPlan;
  runtimePayload?: boolean;
  preparedCoverage?: ReturnType<typeof resolveAllowAlwaysPatternCoverage> | null;
}): AllowAlwaysPersistenceDecision {
  const planPersistence = resolvePlanPersistenceState(params.authorizationPlan);
  const reasons = new Set<AllowAlwaysPersistenceReason>(planPersistence.reasons);
  if (params.runtimePayload === true) {
    reasons.add("runtime-payload");
  }
  const commandText = params.commandText?.trim();
  const hardReasons = [...reasons].filter((reason) => reason !== "no-reusable-pattern");
  if (hardReasons.length > 0) {
    return { kind: "one-shot", reasons: hardReasons };
  }

  if (params.preparedCoverage?.complete === true && params.preparedCoverage.patterns.length > 0) {
    return {
      kind: "patterns",
      patterns: params.preparedCoverage.patterns,
      ...(commandText ? { commandText } : {}),
    };
  }

  if (planPersistence.reusablePatternsAllowed) {
    const coverage = resolveAllowAlwaysPatternCoverage({
      segments: params.segments,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      strictInlineEval: params.strictInlineEval,
    });
    if (coverage.patterns.length > 0) {
      return {
        kind: "patterns",
        patterns: coverage.patterns,
        ...(commandText && coverage.complete ? { commandText } : {}),
      };
    }
  }

  reasons.add("no-reusable-pattern");
  return { kind: "one-shot", reasons: [...reasons] };
}

export function persistAllowAlwaysDecision(params: {
  approvals: ExecApprovalsFile;
  agentId: string | undefined;
  decision: AllowAlwaysPersistenceDecision;
}): void {
  const decision = params.decision;
  if (decision.kind === "one-shot") {
    return;
  }
  const snapshot = updateExecApprovalsSync({
    update: (file) =>
      applyAllowAlwaysDecision({
        file,
        agentId: params.agentId,
        decision,
      }),
  });
  if (snapshot) {
    replaceExecApprovalsSnapshot(params.approvals, snapshot.file);
  }
}

function applyAllowAlwaysDecision(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
  decision: Exclude<AllowAlwaysPersistenceDecision, { kind: "one-shot" }>;
}): ExecApprovalsFile | null {
  const entries: Array<{
    pattern: string;
    argPattern?: string;
    source: "allow-always";
  }> =
    params.decision.kind === "exact-command"
      ? params.decision.commandText.trim()
        ? [
            {
              pattern: buildDurableCommandApprovalPattern(params.decision.commandText.trim()),
              source: "allow-always" as const,
            },
          ]
        : []
      : [
          ...params.decision.patterns.map((pattern) => ({
            pattern: pattern.pattern,
            argPattern: pattern.argPattern,
            source: "allow-always" as const,
          })),
          ...(params.decision.commandText?.trim()
            ? [
                {
                  pattern: buildNodeCommandApprovalPattern(params.decision.commandText.trim()),
                  source: "allow-always" as const,
                },
              ]
            : []),
        ];
  let next = params.file;
  let changed = false;
  for (const entry of entries) {
    const updated = applyAllowlistEntryUpdate({
      file: next,
      agentId: params.agentId,
      pattern: entry.pattern,
      options: { argPattern: entry.argPattern, source: entry.source },
    });
    if (updated) {
      next = updated;
      changed = true;
    }
  }
  return changed ? next : null;
}
export function minSecurity(a: ExecSecurity, b: ExecSecurity): ExecSecurity {
  const order: Record<ExecSecurity, number> = { deny: 0, allowlist: 1, full: 2 };
  return order[a] <= order[b] ? a : b;
}

export function maxAsk(a: ExecAsk, b: ExecAsk): ExecAsk {
  const order: Record<ExecAsk, number> = { off: 0, "on-miss": 1, always: 2 };
  return order[a] >= order[b] ? a : b;
}

export type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";
export const DEFAULT_EXEC_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];
export const OPTIONAL_EXEC_APPROVAL_DECISIONS = [
  "allow-always",
] as const satisfies readonly ExecApprovalDecision[];
export type ExecApprovalUnavailableDecision = (typeof OPTIONAL_EXEC_APPROVAL_DECISIONS)[number];

const OPTIONAL_EXEC_APPROVAL_DECISION_SET: ReadonlySet<string> = new Set(
  OPTIONAL_EXEC_APPROVAL_DECISIONS,
);

function isOptionalExecApprovalDecision(
  decision: string,
): decision is ExecApprovalUnavailableDecision {
  return OPTIONAL_EXEC_APPROVAL_DECISION_SET.has(decision);
}

function collectExecApprovalUnavailableDecisionSet(
  decisions?: readonly string[] | readonly ExecApprovalUnavailableDecision[] | null,
): ReadonlySet<ExecApprovalUnavailableDecision> {
  const unavailable = new Set<ExecApprovalUnavailableDecision>();
  if (!Array.isArray(decisions)) {
    return unavailable;
  }
  for (const decision of decisions) {
    if (isOptionalExecApprovalDecision(decision)) {
      unavailable.add(decision);
    }
  }
  return unavailable;
}

export function normalizeExecApprovalUnavailableDecisions(
  decisions?: readonly string[] | readonly ExecApprovalUnavailableDecision[] | null,
): readonly ExecApprovalUnavailableDecision[] {
  const unavailable = collectExecApprovalUnavailableDecisionSet(decisions);
  return OPTIONAL_EXEC_APPROVAL_DECISIONS.filter((decision) => unavailable.has(decision));
}

export function resolveExecApprovalAllowedDecisions(params?: {
  ask?: string | null;
  allowAlwaysPersistence?: AllowAlwaysPersistenceDecision | null;
}): readonly ExecApprovalDecision[] {
  const ask = normalizeExecAsk(params?.ask);
  if (ask === "always" || params?.allowAlwaysPersistence?.kind === "one-shot") {
    return ["allow-once", "deny"];
  }
  return DEFAULT_EXEC_APPROVAL_DECISIONS;
}

export function resolveExecApprovalUnavailableDecisions(params?: {
  ask?: string | null;
  allowAlwaysPersistence?: AllowAlwaysPersistenceDecision | null;
}): readonly ExecApprovalUnavailableDecision[] {
  const allowed = new Set(resolveExecApprovalAllowedDecisions(params));
  return OPTIONAL_EXEC_APPROVAL_DECISIONS.filter((decision) => !allowed.has(decision));
}

export function resolveExecApprovalRequestAllowedDecisions(params?: {
  ask?: string | null;
  unavailableDecisions?: readonly ExecApprovalUnavailableDecision[] | readonly string[] | null;
}): readonly ExecApprovalDecision[] {
  const policyDecisions = resolveExecApprovalAllowedDecisions({ ask: params?.ask });
  const unavailableDecisions = collectExecApprovalUnavailableDecisionSet(
    params?.unavailableDecisions,
  );
  if (unavailableDecisions.size === 0) {
    return policyDecisions;
  }
  return policyDecisions.filter(
    (decision) => !isOptionalExecApprovalDecision(decision) || !unavailableDecisions.has(decision),
  );
}

export function isExecApprovalDecisionAllowed(params: {
  decision: ExecApprovalDecision;
  ask?: string | null;
}): boolean {
  return resolveExecApprovalAllowedDecisions({ ask: params.ask }).includes(params.decision);
}

export async function requestExecApprovalViaSocket(params: {
  socketPath: string;
  token: string;
  request: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<ExecApprovalDecision | null> {
  const { socketPath, token, request } = params;
  if (!socketPath || !token) {
    return null;
  }
  const timeoutMs = params.timeoutMs ?? 15_000;
  const payload = JSON.stringify({
    type: "request",
    token,
    id: crypto.randomUUID(),
    request,
  });

  return await requestJsonlSocket({
    socketPath,
    requestLine: payload,
    timeoutMs,
    accept: (value) => {
      const msg = value as { type?: string; decision?: ExecApprovalDecision };
      if (msg?.type === "decision" && msg.decision) {
        return msg.decision;
      }
      return undefined;
    },
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
