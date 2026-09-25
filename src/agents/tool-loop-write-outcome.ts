import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { normalizeFileToolPathParam } from "./agent-tools.params.js";
import { resolveContainerPathCandidate } from "./agent-tools.read.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { resolveLocalPathToCwd } from "./sessions/tools/path-utils.js";

export function isWriteNoProgressOutcome(details: Record<string, unknown>): boolean {
  // The built-in no-op result echoes the requested path in display text.
  // Its structured `changed: false` flag is the semantic no-progress contract.
  return details.changed === false;
}

function extractWritePath(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const rawPath = Reflect.get(params, "path");
  return typeof rawPath === "string" && rawPath.length > 0 ? rawPath : undefined;
}

function hashResolvedPath(path: string): string {
  return createHash("sha256").update(stableStringify({ path })).digest("hex");
}

export function hashWriteMutationTarget(
  toolName: string,
  params: unknown,
  cwd?: string,
): string | undefined {
  if (toolName !== "write") {
    return undefined;
  }
  const rawPath = extractWritePath(params);
  if (rawPath === undefined) {
    return undefined;
  }
  const path = cwd ? resolveLocalPathToCwd(rawPath, cwd) : rawPath;
  return hashResolvedPath(path);
}

export type WriteMutationTargetSandbox = {
  root: string;
  bridge: SandboxFsBridge;
};

/**
 * Compute the churn-streak target hash with the same resolution chain as the
 * active write backend. Sandboxed sessions resolve through the bridge's
 * container namespace (mirroring wrapSandboxFileToolPath), so remote-only
 * literal `@` files hash distinctly from their stripped counterparts. Falls
 * back to host cwd resolution when no sandbox is active or bridge resolution
 * fails; admission must never break on hashing.
 *
 */
export async function computeWriteMutationTargetHash(params: {
  toolName: string;
  toolParams: unknown;
  cwd?: string;
  sandbox?: WriteMutationTargetSandbox;
}): Promise<string | undefined> {
  if (params.toolName !== "write") {
    return undefined;
  }
  const rawPath = extractWritePath(params.toolParams);
  if (rawPath === undefined) {
    return undefined;
  }
  if (params.sandbox) {
    try {
      const normalized = await normalizeFileToolPathParam(
        rawPath,
        params.sandbox.root,
        params.sandbox.bridge,
      );
      if (normalized === "") {
        return undefined;
      }
      // Mirror the writer's container-candidate selection exactly: @-prefix
      // consumption plus file://-URL conversion (resolveContainerPathCandidate).
      const candidate = resolveContainerPathCandidate(normalized);
      if (candidate === null) {
        return undefined;
      }
      const resolved = params.sandbox.bridge.resolvePath({
        filePath: candidate,
        cwd: params.sandbox.root,
      });
      return hashResolvedPath(resolved.containerPath);
    } catch {
      // Bridge resolution must never break admission; hash on the host chain.
    }
  }
  return hashWriteMutationTarget(params.toolName, params.toolParams, params.cwd);
}

/**
 * Staged final-argument write-target hashes, run-scoped like the neighboring
 * batch-admission markers (same runId+toolCallId key convention), so
 * concurrent runs sharing a toolCallId cannot consume each other's hash.
 *
 * The before-tool-call wrapper resolves the writer-parity hash from the final
 * (hook-rewritten) execution arguments, but the pending-call record is only
 * committed later by the synchronous batch commit callback. Staging bridges
 * that ordering gap without widening the sync SDK contract.
 */
const stagedWriteTargetHashes = new Map<string, string>();

function stagedWriteTargetHashKey(params: { runId?: string; toolCallId: string }): string {
  return params.runId ? `${params.runId}:${params.toolCallId}` : params.toolCallId;
}

/** Stage the final-args write-target hash for a yet-uncommitted tool call. */
export function stageWriteTargetHashForToolCall(
  params: { runId?: string; toolCallId: string },
  hash: string | undefined,
): void {
  const key = stagedWriteTargetHashKey(params);
  if (hash === undefined) {
    stagedWriteTargetHashes.delete(key);
    return;
  }
  stagedWriteTargetHashes.set(key, hash);
}

/** Take (consume) the staged hash for a tool call, if any. */
export function takeStagedWriteTargetHash(params: {
  runId?: string;
  toolCallId: string;
}): string | undefined {
  const key = stagedWriteTargetHashKey(params);
  const hash = stagedWriteTargetHashes.get(key);
  if (hash !== undefined) {
    stagedWriteTargetHashes.delete(key);
  }
  return hash;
}

/** Drop staged hashes for calls that will never commit. */
export function releaseStagedWriteTargetHashes(
  toolCallIds: readonly string[],
  runId?: string,
): void {
  for (const id of toolCallIds) {
    stagedWriteTargetHashes.delete(stagedWriteTargetHashKey({ runId, toolCallId: id }));
  }
}
