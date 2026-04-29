// Gateway-level file-transfer policy gate.
//
// Runs at node.invoke dispatch BEFORE the request is forwarded to the
// node, so every code path (agent tools, CLI `nodes invoke`, plugin
// runtime, raw RPC) is bound by the same allow/deny policy. The agent
// tool's gatekeep() is still useful for richer UX (operator prompts,
// per-call audit context), but it is no longer the security boundary —
// the gateway is.
//
// Policy semantics mirror extensions/file-transfer/src/shared/policy.ts
// minus the operator-prompt flow. Prompts only happen at the agent-tool
// layer; the gateway's role is enforcement.
//
// Decision matrix:
//   - NO_POLICY (no fileTransfer config or no entry for this node) → deny
//   - denyPaths match → deny (always wins)
//   - allowPaths match → allow
//   - ask=on-miss / ask=always with no allow match → deny at the gateway
//     (the agent tool's prompt happens BEFORE node.invoke; if the operator
//     approved allow-always it has already been persisted to allowPaths,
//     so by the time we get here it'll match. allow-once approvals are
//     not honored at the gateway dispatch path — single-use approvals
//     only flow through the dedicated tool's pre-flight check.)

import path from "node:path";
import { minimatch } from "minimatch";
import type { GatewayNodeFileTransferEntry } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const FILE_TRANSFER_COMMANDS: ReadonlySet<string> = new Set([
  "file.fetch",
  "dir.list",
  "dir.fetch",
  "file.write",
]);

const READ_COMMANDS: ReadonlySet<string> = new Set(["file.fetch", "dir.list", "dir.fetch"]);
const WRITE_COMMANDS: ReadonlySet<string> = new Set(["file.write"]);

export type FileTransferDispatchDecision =
  | { ok: true }
  | { ok: false; code: "NO_POLICY" | "POLICY_DENIED" | "INVALID_PATH"; reason: string };

export function isFileTransferCommand(command: string): boolean {
  return FILE_TRANSFER_COMMANDS.has(command);
}

function expandTilde(p: string, home: string | undefined): string {
  if (home && (p === "~" || p.startsWith("~/"))) {
    return path.join(home, p.slice(p === "~" ? 1 : 2));
  }
  return p;
}

function normalizeGlobs(patterns: string[] | undefined, home: string | undefined): string[] {
  if (!Array.isArray(patterns)) {
    return [];
  }
  return patterns
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => expandTilde(p.trim(), home));
}

function matchesAny(target: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (minimatch(target, pattern, { dot: true })) {
      return true;
    }
  }
  return false;
}

// Reject literal ".." segments before any glob match; mirror the
// extension-side check so a path like "/allowed/../etc/passwd" never
// reaches the node even via raw nodes.invoke. Treat backslashes and
// forward slashes the same so a Windows node can't be hit with mixed
// separators.
function containsParentRefSegment(p: string): boolean {
  const unified = p.replace(/\\/gu, "/");
  return unified.split("/").includes("..");
}

function readNodeEntry(
  config: Record<string, GatewayNodeFileTransferEntry> | undefined,
  nodeId: string | undefined,
  nodeDisplayName: string | undefined,
): GatewayNodeFileTransferEntry | null {
  if (!config) {
    return null;
  }
  const candidates = [nodeId, nodeDisplayName].filter(
    (k): k is string => typeof k === "string" && k.length > 0,
  );
  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      return config[key];
    }
  }
  if (Object.prototype.hasOwnProperty.call(config, "*")) {
    return config["*"];
  }
  return null;
}

/**
 * Evaluate file-transfer dispatch policy. Returns `{ ok: true }` when
 * the operation should be forwarded to the node; `{ ok: false, ... }`
 * otherwise. Caller is responsible for `respond(...)` and audit.
 *
 * `params` is the raw node.invoke params. We extract `path` from it for
 * read commands, and `path` for write commands. Anything else is treated
 * as INVALID_PATH (the dedicated tools always set `path`).
 */
export function evaluateFileTransferDispatchPolicy(input: {
  cfg: OpenClawConfig;
  command: string;
  params: unknown;
  nodeId: string | undefined;
  nodeDisplayName: string | undefined;
  homedir: string | undefined;
}): FileTransferDispatchDecision {
  const { cfg, command, params, nodeId, nodeDisplayName, homedir } = input;
  if (!FILE_TRANSFER_COMMANDS.has(command)) {
    return { ok: true };
  }

  const targetPath =
    params && typeof params === "object" && !Array.isArray(params) && params !== null
      ? (params as Record<string, unknown>).path
      : undefined;
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    return { ok: false, code: "INVALID_PATH", reason: "path required" };
  }
  if (targetPath.includes("\0")) {
    return { ok: false, code: "INVALID_PATH", reason: "path contains NUL byte" };
  }
  if (!path.isAbsolute(targetPath)) {
    return { ok: false, code: "INVALID_PATH", reason: "path must be absolute" };
  }
  if (containsParentRefSegment(targetPath)) {
    return {
      ok: false,
      code: "POLICY_DENIED",
      reason: "path contains '..' segments; reject before glob match",
    };
  }

  const fileTransfer = cfg.gateway?.nodes?.fileTransfer;
  const entry = readNodeEntry(fileTransfer, nodeId, nodeDisplayName);
  if (!entry) {
    return {
      ok: false,
      code: "NO_POLICY",
      reason: `no gateway.nodes.fileTransfer policy for "${nodeDisplayName ?? nodeId ?? "<unknown>"}"`,
    };
  }

  // denyPaths always wins.
  const denyPatterns = normalizeGlobs(entry.denyPaths, homedir);
  if (matchesAny(targetPath, denyPatterns)) {
    return {
      ok: false,
      code: "POLICY_DENIED",
      reason: "path matches a denyPaths pattern",
    };
  }

  const isRead = READ_COMMANDS.has(command);
  const isWrite = WRITE_COMMANDS.has(command);
  if (!isRead && !isWrite) {
    // Defensive — FILE_TRANSFER_COMMANDS is the union of both sets.
    return { ok: false, code: "POLICY_DENIED", reason: `unknown file-transfer command ${command}` };
  }

  const allowPatterns = normalizeGlobs(
    isRead ? entry.allowReadPaths : entry.allowWritePaths,
    homedir,
  );

  if (allowPatterns.length > 0 && matchesAny(targetPath, allowPatterns)) {
    return { ok: true };
  }

  // No allow match: deny at the gateway. The agent tool's gatekeep is
  // expected to have prompted-and-persisted before calling node.invoke,
  // so by the time we get here a legitimate request matches allowPaths.
  // allow-once is not honored at this layer.
  return {
    ok: false,
    code: "POLICY_DENIED",
    reason:
      allowPatterns.length === 0
        ? `no allow${isRead ? "Read" : "Write"}Paths configured for this node`
        : `path does not match any allow${isRead ? "Read" : "Write"}Paths pattern`,
  };
}
