import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  appendSessionTranscriptReport,
  readLatestSessionTranscriptReport,
  type SessionTranscriptWriteScope,
} from "../config/sessions/session-accessor.js";
import { withSessionTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import { boundedWorkerError } from "./worker-environments/worker-error.js";
import {
  formatWorkspaceConflictSummary,
  projectWorkspaceResultConflict,
  WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
  WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
  WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
  type WorkerWorkspaceConflictReport,
  type WorkspaceResultConflictLookup,
} from "./worker-environments/workspace-conflicts.js";

export function createWorkerWorkspaceConflictTranscriptHandlers(
  target: SessionTranscriptWriteScope,
  assertCurrent: () => void,
) {
  async function withWorkerTranscript<T>(
    run: () => Promise<Result<T, unknown>>,
    missingMessage?: string,
  ): Promise<Result<T, "session-unavailable">> {
    assertCurrent();
    const lostSession = (): Result<T, "session-unavailable"> => {
      if (missingMessage) {
        throw new Error(`${missingMessage} lost session ${target.sessionId}`);
      }
      return err("session-unavailable");
    };
    const result = await withSessionTranscriptWriteAssertion(target, assertCurrent, run);
    assertCurrent();
    return result.ok ? ok(result.value) : lostSession();
  }

  return {
    resolveConflict: async (): Promise<WorkspaceResultConflictLookup> => {
      const result = await withWorkerTranscript(() =>
        readLatestSessionTranscriptReport(target, [
          WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
          WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
        ]),
      );
      if (!result.ok) {
        return { kind: "unknown", reason: result.error };
      }
      const transcriptEntry = result.value;
      if (transcriptEntry?.customType !== WORKSPACE_CONFLICT_TRANSCRIPT_TYPE) {
        return { kind: "absent" };
      }
      const details = transcriptEntry.details as
        | { paths?: unknown; stagedResultRef?: unknown; totalCount?: unknown }
        | undefined;
      if (
        Array.isArray(details?.paths) &&
        details.paths.length > 0 &&
        details.paths.every(
          (entryPath): entryPath is string => typeof entryPath === "string" && entryPath.length > 0,
        ) &&
        typeof details.stagedResultRef === "string" &&
        (details.totalCount === undefined ||
          (Number.isSafeInteger(details.totalCount) &&
            (details.totalCount as number) >= details.paths.length)) &&
        /^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(details.stagedResultRef)
      ) {
        return {
          kind: "conflict",
          conflict: projectWorkspaceResultConflict(
            details.paths,
            details.stagedResultRef,
            details.totalCount as number | undefined,
          ),
        };
      }
      return { kind: "unknown", reason: "malformed-report" };
    },
    reportConflict: async (conflict: WorkerWorkspaceConflictReport) => {
      await withWorkerTranscript(
        () =>
          appendSessionTranscriptReport(target, {
            kind: "custom",
            customTypes: [
              WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
              WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
            ],
            selectReport: (latestConflictEntry) => {
              if ("cleared" in conflict) {
                if (
                  latestConflictEntry?.customType !== WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE
                ) {
                  return {
                    customType: WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
                    content: "A later cloud workspace result superseded the previous conflict.",
                    display: false,
                  };
                }
                return undefined;
              }
              const projectedConflict = projectWorkspaceResultConflict(
                conflict.paths,
                conflict.stagedResultRef,
                conflict.totalCount,
              );
              const details = latestConflictEntry?.details as
                | { paths?: unknown; stagedResultRef?: unknown; totalCount?: unknown }
                | undefined;
              const alreadyReported =
                latestConflictEntry?.customType === WORKSPACE_CONFLICT_TRANSCRIPT_TYPE &&
                details?.stagedResultRef === projectedConflict.stagedResultRef &&
                details.totalCount === projectedConflict.totalCount &&
                Array.isArray(details.paths) &&
                JSON.stringify(details.paths) === JSON.stringify(projectedConflict.paths);
              if (!alreadyReported) {
                return {
                  customType: WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
                  content: formatWorkspaceConflictSummary(
                    projectedConflict.paths,
                    projectedConflict.stagedResultRef,
                    projectedConflict.totalCount,
                  ),
                  display: true,
                  details: projectedConflict,
                };
              }
              return undefined;
            },
          }),
        "Recovered cloud workspace conflict",
      );
    },
    reportFailure: async (failure: string) => {
      await withWorkerTranscript(
        () =>
          appendSessionTranscriptReport(target, {
            kind: "custom",
            customTypes: [WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE],
            selectReport: (latestRecovery) => {
              const error = boundedWorkerError(failure, 768);
              const content = `Cloud workspace recovery attempt failed: ${error}. OpenClaw preserved the result and will retry.`;
              if (latestRecovery?.content !== content) {
                return {
                  customType: WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
                  content,
                  display: true,
                  details: { error },
                };
              }
              return undefined;
            },
          }),
        "Cloud workspace recovery",
      );
    },
  };
}
