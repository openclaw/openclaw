import type { Result } from "@openclaw/normalization-core/result";
import { loadSessionEntry } from "../session-utils.js";

export type ChatAbortOrigin = "rpc" | "stop-command" | "placement-abandon";

export type ChatAbortSessionSnapshot = Result<
  Pick<
    ReturnType<typeof loadSessionEntry>,
    "cfg" | "storePath" | "entry" | "canonicalKey" | "agentId"
  >,
  unknown
>;

export type AbortedPartialSnapshot = ReturnType<typeof captureAbortedPartial>;

/** Capture before signaling cancellation, without loading asynchronous transcript writers. */
export function captureAbortedPartial(params: {
  runId: string;
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  text: string;
  abortOrigin: ChatAbortOrigin;
  session?: ChatAbortSessionSnapshot;
}) {
  const { runId, abortOrigin } = params;
  try {
    const session = params.session ?? {
      ok: true,
      value: loadSessionEntry(
        params.sessionKey,
        params.agentId ? { agentId: params.agentId } : undefined,
      ),
    };
    if (!session.ok) {
      throw session.error;
    }
    const { cfg, storePath, entry, canonicalKey, agentId } = session.value;
    if (entry?.sessionId !== params.sessionId) {
      throw new Error("Aborted partial transcript session changed before persistence");
    }
    // Snapshot the incarnation before signaling. Reset can keep the SID, and
    // the guarded writer rechecks both facts inside its commit transaction.
    return {
      runId,
      abortOrigin,
      ok: true,
      value: {
        sessionKey: canonicalKey,
        sessionId: params.sessionId,
        expectedSessionId: params.sessionId,
        expectedLifecycleRevision: entry.lifecycleRevision ?? null,
        agentId,
        storePath,
        cfg,
        message: params.text,
        createIfMissing: true,
        idempotencyKey: `${runId}:assistant`,
        abortMeta: { aborted: true, origin: abortOrigin, runId },
      },
    } as const;
  } catch (error) {
    // Preparation is fallible metadata I/O, never a prerequisite for cancellation.
    return { runId, abortOrigin, ok: false, error } as const;
  }
}
