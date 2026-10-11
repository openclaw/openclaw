import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { logVerbose } from "../../globals.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { truncateMemoryFlushErrorMessage } from "./memory-flush-errors.js";
import type { ReplyOperation } from "./reply-run-registry.js";

const MAX_FLUSH_FAILURES = 3;

export async function recordMemoryFlushFailure(
  error: unknown,
  run: {
    sessionKey?: string;
    storePath?: string;
    sessionStore?: Record<string, SessionEntry>;
    replyOperation?: Pick<ReplyOperation, "abortSignal">;
    abortSignal?: AbortSignal;
  },
  initialSessionEntry?: SessionEntry,
): Promise<{ sessionEntry?: SessionEntry; outcome: "failed" | "exhausted" }> {
  let sessionEntry = initialSessionEntry;
  let outcome: "failed" | "exhausted" = "failed";
  // Caller cancellation may use any reason, not only an AbortError instance.
  if ((run.replyOperation?.abortSignal ?? run.abortSignal)?.aborted) {
    logVerbose("memory flush cancelled by its owner");
    return { sessionEntry, outcome };
  }
  const truncatedError = truncateMemoryFlushErrorMessage(error);
  const { sessionKey, storePath } = run;
  if (!isAbortError(error) && storePath && sessionKey) {
    try {
      const adoptEntry = (entry: SessionEntry | null) => {
        if (entry) {
          sessionEntry = entry;
          if (run.sessionStore) {
            run.sessionStore[sessionKey] = entry;
          }
        }
      };
      const updateEntry = (update: Parameters<typeof updateSessionEntry>[1]) =>
        updateSessionEntry({ storePath, sessionKey }, update, {
          skipMaintenance: true,
          takeCacheOwnership: true,
        });
      const failedEntry = await updateEntry(async (currentEntry) => ({
        memoryFlush: {
          kind: "failed",
          ...(currentEntry.memoryFlush?.compactionCount !== undefined
            ? { compactionCount: currentEntry.memoryFlush.compactionCount }
            : {}),
          failureCount:
            (currentEntry.memoryFlush?.kind === "failed"
              ? currentEntry.memoryFlush.failureCount
              : 0) + 1,
        },
      }));
      adoptEntry(failedEntry);
      const failureCount =
        failedEntry?.memoryFlush?.kind === "failed" ? failedEntry.memoryFlush.failureCount : 0;
      logVerbose(
        `memory flush failed (attempt ${failureCount}/${MAX_FLUSH_FAILURES}): ${truncatedError}`,
      );
      if (failedEntry && failureCount >= MAX_FLUSH_FAILURES) {
        outcome = "exhausted";
        logVerbose(
          `memory flush exhausted: skipping flush for this compaction cycle after ${failureCount} consecutive failures`,
        );
        const exhaustedEntry = await updateEntry(async (currentEntry) => ({
          memoryFlush: {
            kind: "succeeded",
            compactionCount: currentEntry.compactionCount ?? 0,
          },
        }));
        adoptEntry(exhaustedEntry);
      }
    } catch (persistError) {
      logVerbose(`failed to persist memory flush failure metadata: ${String(persistError)}`);
    }
  } else {
    logVerbose(`memory flush run failed: ${String(error)}`);
  }
  return { sessionEntry, outcome };
}
