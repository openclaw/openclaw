// Parses and normalizes the persisted exec approval policy.
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { ExecApprovalsFile, ExecAsk, ExecSecurity } from "./exec-approvals-core.js";
import { normalizeExecApprovals } from "./exec-approvals.js";
import { expandHomePrefix, resolveHomeRelativePath } from "./home-dir.js";
import { isPlainObject } from "./plain-object.js";

function isExecSecurity(value: unknown): value is ExecSecurity {
  return value === "allowlist" || value === "full" || value === "deny";
}

function isExecAsk(value: unknown): value is ExecAsk {
  return value === "always" || value === "off" || value === "on-miss";
}

export const DEFAULT_SECURITY: ExecSecurity = "full";
export const DEFAULT_ASK: ExecAsk = "off";
export const DEFAULT_EXEC_APPROVAL_ASK_FALLBACK: ExecSecurity = "deny";
export const DEFAULT_AUTO_ALLOW_SKILLS = false;
const DEFAULT_EXEC_APPROVALS_STATE_DIR = "~/.openclaw";
const EXEC_APPROVALS_FILE = "exec-approvals.json";
const EXEC_APPROVALS_SOCKET = "exec-approvals.sock";
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

export function createFailClosedExecApprovalsFallback(): ExecApprovalsFile {
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

export function parsePersistedExecApprovals(raw: string): ExecApprovalsFile {
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

export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}
