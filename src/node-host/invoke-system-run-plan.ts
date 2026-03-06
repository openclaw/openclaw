import fs from "node:fs";
import path from "node:path";
import type { SystemRunApprovalPlan } from "../infra/exec-approvals.js";
import { resolveCommandResolutionFromArgv } from "../infra/exec-command-resolution.js";
import { sameFileIdentity } from "../infra/file-identity.js";
import { formatExecCommand, resolveSystemRunCommand } from "../infra/system-run-command.js";

export type ApprovedCwdSnapshot = {
  cwd: string;
  stat: fs.Stats;
};

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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

function shouldPinExecutableForApproval(params: {
  shellCommand: string | null;
  wrapperChain: string[] | undefined;
}): boolean {
  if (params.shellCommand !== null) {
    return false;
  }
  return (params.wrapperChain?.length ?? 0) === 0;
}

function resolveCanonicalApprovalCwdSync(cwd: string):
  | {
      ok: true;
      snapshot: ApprovedCwdSnapshot;
    }
  | { ok: false; message: string } {
  const requestedCwd = path.resolve(cwd);
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
  return {
    ok: true,
    snapshot: {
      cwd: cwdReal,
      stat: cwdStat,
    },
  };
}

export function revalidateApprovedCwdSnapshot(params: { snapshot: ApprovedCwdSnapshot }): boolean {
  const current = resolveCanonicalApprovalCwdSync(params.snapshot.cwd);
  if (!current.ok) {
    return false;
  }
  return sameFileIdentity(params.snapshot.stat, current.snapshot.stat);
}

export function hardenApprovedExecutionPaths(params: {
  approvedByAsk: boolean;
  argv: string[];
  shellCommand: string | null;
  cwd: string | undefined;
}):
  | {
      ok: true;
      argv: string[];
      argvChanged: boolean;
      cwd: string | undefined;
      approvedCwdSnapshot: ApprovedCwdSnapshot | undefined;
    }
  | { ok: false; message: string } {
  if (!params.approvedByAsk) {
    return {
      ok: true,
      argv: params.argv,
      argvChanged: false,
      cwd: params.cwd,
      approvedCwdSnapshot: undefined,
    };
  }

  let hardenedCwd = params.cwd;
  let approvedCwdSnapshot: ApprovedCwdSnapshot | undefined;
  if (hardenedCwd) {
    const canonicalCwd = resolveCanonicalApprovalCwdSync(hardenedCwd);
    if (!canonicalCwd.ok) {
      return canonicalCwd;
    }
    hardenedCwd = canonicalCwd.snapshot.cwd;
    approvedCwdSnapshot = canonicalCwd.snapshot;
  }

  if (params.argv.length === 0) {
    return {
      ok: true,
      argv: params.argv,
      argvChanged: false,
      cwd: hardenedCwd,
      approvedCwdSnapshot,
    };
  }

  const resolution = resolveCommandResolutionFromArgv(params.argv, hardenedCwd);
  if (
    !shouldPinExecutableForApproval({
      shellCommand: params.shellCommand,
      wrapperChain: resolution?.wrapperChain,
    })
  ) {
    // Preserve wrapper semantics for approval-based execution. Pinning the
    // effective executable while keeping wrapper argv shape can shift positional
    // arguments and execute a different command than approved.
    return {
      ok: true,
      argv: params.argv,
      argvChanged: false,
      cwd: hardenedCwd,
      approvedCwdSnapshot,
    };
  }

  const pinnedExecutable = resolution?.resolvedRealPath ?? resolution?.resolvedPath;
  if (!pinnedExecutable) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires a stable executable path",
    };
  }

  if (pinnedExecutable === params.argv[0]) {
    return {
      ok: true,
      argv: params.argv,
      argvChanged: false,
      cwd: hardenedCwd,
      approvedCwdSnapshot,
    };
  }

  const argv = [...params.argv];
  argv[0] = pinnedExecutable;
  return {
    ok: true,
    argv,
    argvChanged: true,
    cwd: hardenedCwd,
    approvedCwdSnapshot,
  };
}

export function buildSystemRunApprovalPlan(params: {
  command?: unknown;
  rawCommand?: unknown;
  cwd?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
}): { ok: true; plan: SystemRunApprovalPlan; cmdText: string } | { ok: false; message: string } {
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
  const rawCommand = hardening.argvChanged
    ? formatExecCommand(hardening.argv) || null
    : command.cmdText.trim() || null;
  return {
    ok: true,
    plan: {
      argv: hardening.argv,
      cwd: hardening.cwd ?? null,
      rawCommand,
      agentId: normalizeString(params.agentId),
      sessionKey: normalizeString(params.sessionKey),
    },
    cmdText: command.cmdText,
  };
}
