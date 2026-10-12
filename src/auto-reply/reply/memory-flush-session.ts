import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { resolveInternalSessionEffectsIdentity } from "../../config/sessions/internal-session-key.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import {
  MAX_VISIBLE_MESSAGE_MAX_BYTES,
  MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
} from "../../config/sessions/session-accessor.sqlite-visible-cursor.js";
import { withSessionContextAdmission } from "../../config/sessions/session-transcript-read-fence.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";

/**
 * Derive one UUID-shaped mutation identity from the source session incarnation
 * (session ID and lifecycle revision) and its pre-compaction count. The count
 * advances after each completed compaction, so retries within one cycle reuse
 * the ID and later cycles do not. A reset keeps the session ID and restarts the
 * count but rotates the lifecycle revision, so a new incarnation never reuses an ID.
 */
export function deriveMemoryFlushId(params: {
  sourceSessionId: string;
  sourceLifecycleRevision: string | undefined;
  compactionCount: number;
}): string {
  const bytes = crypto
    .createHash("sha256")
    .update(
      `openclaw-memory-flush\0${params.sourceSessionId}\0${params.sourceLifecycleRevision ?? ""}\0${params.compactionCount}`,
    )
    .digest()
    .subarray(0, 16);
  // UUIDv8 reserves application-defined hash layouts; SHA-256 is not UUIDv5's SHA-1.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Memory inference owns a detached view; an admission excludes its waiting user. */
export async function prepareMemoryFlushSession(params: {
  admission?: UserTurnTranscriptAdmissionReceipt;
  source: SessionTranscriptRuntimeTarget & { agentId: string; sessionKey: string };
  runId: string;
  workspaceDir: string;
  signal?: AbortSignal;
}) {
  params.signal?.throwIfAborted();
  await waitForSessionTranscriptProjection(params.source, params.signal);
  params.signal?.throwIfAborted();
  const sessionManager = await withSessionContextAdmission(params.source, params.admission, () =>
    SessionManager.openDetachedBoundedAsync(params.source, {
      signal: params.signal,
      cwd: params.workspaceDir,
      maxBytes: MAX_VISIBLE_MESSAGE_MAX_BYTES,
      maxEvents: MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
      onTruncated: () => {
        throw new Error("Memory flush exceeds the bounded conversation view.");
      },
    }),
  );
  const identity = resolveInternalSessionEffectsIdentity({
    agentId: params.source.agentId,
    runId: params.runId,
  });
  return {
    ...identity,
    sessionFile: identity.sessionKey,
    sessionTarget: {
      agentId: params.source.agentId,
      storePath: params.source.storePath,
      ...identity,
    },
    sessionManager,
    sessionPersistence: "detached",
    cleanupBundleMcpOnRunEnd: true,
  } satisfies Pick<
    RunEmbeddedAgentParams,
    | "cleanupBundleMcpOnRunEnd"
    | "sessionId"
    | "sessionKey"
    | "sessionTarget"
    | "sessionManager"
    | "sessionPersistence"
  > & { sessionFile: string };
}

export async function ensureMemoryFlushTargetFile(params: {
  workspaceDir: string;
  relativePath: string;
  assertCurrent: () => void;
}): Promise<void> {
  const workspaceDir = normalizeOptionalString(params.workspaceDir);
  const relativePath = normalizeOptionalString(params.relativePath);
  if (!workspaceDir || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Invalid memory flush target path");
  }
  const workspaceRoot = path.resolve(workspaceDir);
  const targetPath = path.resolve(workspaceRoot, relativePath);
  const targetRelativePath = path.relative(workspaceRoot, targetPath);
  if (
    !targetRelativePath ||
    targetRelativePath.startsWith("..") ||
    path.isAbsolute(targetRelativePath)
  ) {
    throw new Error("Memory flush target path must stay inside the workspace");
  }
  params.assertCurrent();
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  params.assertCurrent();
  const handle = await fs.promises.open(targetPath, "a");
  try {
    params.assertCurrent();
  } finally {
    await handle.close();
  }
}
