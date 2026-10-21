import type { InternalSessionEntry } from "./types.js";

export type PriorWorkspaceRewriteRows = {
  previous: readonly { id: string | null; seq: number }[];
  next: readonly { id: string | null; seq: number; message: boolean }[];
  unchangedBeforeSeq: number;
};

/** Keep the one original-file prefix attached to surviving transcript identities. */
export function rewriteSessionPriorWorkspaceBoundary(
  entry: InternalSessionEntry,
  previousGeneration: string | null,
  generation: string | null,
  rows?: PriorWorkspaceRewriteRows,
): InternalSessionEntry {
  const prior = entry.priorWorkspace;
  if (!prior || prior.sessionId !== entry.sessionId || prior.worktreeId !== entry.worktree?.id) {
    return entry;
  }
  if (prior.through.generation !== previousGeneration) {
    return entry;
  }
  let maxSeq = prior.through.maxSeq;
  if (rows && maxSeq !== null) {
    const previousMaxSeq = maxSeq;
    const originalIds = new Set(
      rows.previous.flatMap((row) =>
        row.id !== null && row.seq <= previousMaxSeq ? [row.id] : [],
      ),
    );
    maxSeq = Math.min(maxSeq, rows.unchangedBeforeSeq - 1);
    let reachedCurrentWorkspace = false;
    for (const row of rows.next) {
      if (!row.message) {
        continue;
      }
      if (row.id !== null && originalIds.has(row.id)) {
        // Keep Files unresolved if a replacement cannot be represented by the one prefix.
        if (reachedCurrentWorkspace) {
          return entry;
        }
        maxSeq = row.seq;
      } else {
        reachedCurrentWorkspace = true;
      }
    }
    if (maxSeq < 0) {
      maxSeq = null;
    }
  }
  return {
    ...entry,
    priorWorkspace: { ...prior, through: { generation, maxSeq } },
  };
}
