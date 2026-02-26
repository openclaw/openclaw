import fs from "node:fs";
import path from "node:path";
import type { SystemRunApprovalPlanV2 } from "../infra/exec-approvals.js";
import { sameFileIdentity } from "../infra/file-identity.js";
import { resolveSystemRunCommand } from "../infra/system-run-command.js";

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isPathLikeExecutableToken(value: string): boolean {
  if (!value) {
    return false;
  }
  if (value.startsWith(".") || value.startsWith("/") || value.startsWith("\\")) {
    return true;
  }
  if (value.includes("/") || value.includes("\\")) {
    return true;
  }
  if (process.platform === "win32" && /^[a-zA-Z]:[\\/]/.test(value)) {
    return true;
  }
  return false;
}

function pathComponentsFromRootSync(targetPath: string): string[] {
  const absolute = path.resolve(targetPath);
  const parts: string[] = [];
  let cursor = absolute;
  while (true) {
    parts.unshift(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return parts;
    }
    cursor = parent;
  }
}

function isWritableByCurrentProcessSync(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function hasMutableSymlinkPathComponentSync(targetPath: string): boolean {
  for (const component of pathComponentsFromRootSync(targetPath)) {
    try {
      if (!fs.lstatSync(component).isSymbolicLink()) {
        continue;
      }
      const parentDir = path.dirname(component);
      if (isWritableByCurrentProcessSync(parentDir)) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

export function hardenApprovedExecutionPaths(params: {
  approvedByAsk: boolean;
  argv: string[];
  shellCommand: string | null;
  cwd: string | undefined;
}): { ok: true; argv: string[]; cwd: string | undefined } | { ok: false; message: string } {
  if (!params.approvedByAsk) {
    return { ok: true, argv: params.argv, cwd: params.cwd };
  }

  let hardenedCwd = params.cwd;
  if (hardenedCwd) {
    const requestedCwd = path.resolve(hardenedCwd);
    let cwdLstat: fs.Stats;
    let cwdStat: fs.Stats;
    let cwdReal: string;
    let cwdRealStat: fs.Stats;
    try {
      cwdLstat = fs.lstatSync(requestedCwd);
      cwdStat = fs.statSync(requestedCwd);
      cwdReal = fs.realpathSync(requestedCwd);
      cwdRealStat = fs.statSync(cwdReal);
    } catch {
      return {
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval requires an existing canonical cwd",
      };
    }
    if (!cwdStat.isDirectory()) {
      return {
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval requires cwd to be a directory",
      };
    }
    if (hasMutableSymlinkPathComponentSync(requestedCwd)) {
      return {
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval requires canonical cwd (no symlink path components)",
      };
    }
    if (cwdLstat.isSymbolicLink()) {
      return {
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval requires canonical cwd (no symlink cwd)",
      };
    }
    if (
      !sameFileIdentity(cwdStat, cwdLstat) ||
      !sameFileIdentity(cwdStat, cwdRealStat) ||
      !sameFileIdentity(cwdLstat, cwdRealStat)
    ) {
      return {
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cwd identity mismatch",
      };
    }
    hardenedCwd = cwdReal;
  }

  if (params.shellCommand !== null || params.argv.length === 0) {
    return { ok: true, argv: params.argv, cwd: hardenedCwd };
  }

  const argv = [...params.argv];
  const rawExecutable = argv[0] ?? "";
  if (!isPathLikeExecutableToken(rawExecutable)) {
    return { ok: true, argv, cwd: hardenedCwd };
  }

  const base = hardenedCwd ?? process.cwd();
  const candidate = path.isAbsolute(rawExecutable)
    ? rawExecutable
    : path.resolve(base, rawExecutable);
  try {
    argv[0] = fs.realpathSync(candidate);
  } catch {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires a stable executable path",
    };
  }
  return { ok: true, argv, cwd: hardenedCwd };
}

export function buildSystemRunApprovalPlanV2(params: {
  command?: unknown;
  rawCommand?: unknown;
  cwd?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
}): { ok: true; plan: SystemRunApprovalPlanV2; cmdText: string } | { ok: false; message: string } {
  const command = resolveSystemRunCommand({
    command: params.command,
    rawCommand: params.rawCommand,
  });
  if (!command.ok) {
    return { ok: false, message: command.message };
  }
  if (command.argv.length === 0) {
    return { ok: false, message: "command required" };
  }
  const hardening = hardenApprovedExecutionPaths({
    approvedByAsk: true,
    argv: command.argv,
    shellCommand: command.shellCommand,
    cwd: normalizeString(params.cwd) ?? undefined,
  });
  if (!hardening.ok) {
    return { ok: false, message: hardening.message };
  }
  return {
    ok: true,
    plan: {
      version: 2,
      argv: hardening.argv,
      cwd: hardening.cwd ?? null,
      rawCommand: command.cmdText.trim() || null,
      agentId: normalizeString(params.agentId),
      sessionKey: normalizeString(params.sessionKey),
    },
    cmdText: command.cmdText,
  };
}
