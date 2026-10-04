import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly-open.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import type {
  SessionTranscriptWorkerInput,
  SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";

type DurableHistoryReadOperationRequest = Extract<
  SessionTranscriptWorkerInput,
  {
    kind:
      | "transcript-match"
      | "transcript-search"
      | "branch-summaries"
      | "session-title-fields"
      | "session-preview"
      | "model-context"
      | "transcript-watermark"
      | "transcript-anchors"
      | "session-pending-input-receipts"
      | "session-pending-input-source";
  }
>;

type BranchReadRequest = Extract<DurableHistoryReadOperationRequest, { kind: "branch-summaries" }>;
export type SessionHistoryReadOperationRequest =
  | Exclude<DurableHistoryReadOperationRequest, BranchReadRequest>
  | {
      kind: "branch-summaries";
      request: Omit<BranchReadRequest["request"], "databaseIdentity"> & {
        databaseIdentity?: string;
      };
    };

export function isSessionHistoryReadOperation(
  request: SessionTranscriptWorkerInput,
): request is DurableHistoryReadOperationRequest {
  switch (request.kind) {
    case "transcript-match":
    case "transcript-search":
    case "branch-summaries":
    case "session-title-fields":
    case "session-preview":
    case "model-context":
    case "transcript-watermark":
    case "transcript-anchors":
    case "session-pending-input-receipts":
    case "session-pending-input-source":
      return true;
    default:
      return false;
  }
}

/** Load dependencies before the owner enters its synchronous, admitted read scope. */
export function prepareSessionHistoryReadOperation<
  Request extends SessionHistoryReadOperationRequest,
>(
  request: Request,
  retainedDatabase?: OpenClawAgentReadOnlyDatabase,
): Promise<() => SessionTranscriptWorkerValues[Request["kind"]]>;
export async function prepareSessionHistoryReadOperation(
  request: SessionHistoryReadOperationRequest,
  retainedDatabase?: OpenClawAgentReadOnlyDatabase,
): Promise<() => SessionTranscriptWorkerValues[SessionHistoryReadOperationRequest["kind"]]> {
  switch (request.kind) {
    case "transcript-anchors": {
      const [
        { withOpenClawAgentDatabaseReadOnly },
        { readSessionTranscriptAnchorFactsInDatabase },
        { assertExistingDatabaseIdentity },
      ] = await Promise.all([
        import("../../state/openclaw-agent-db-readonly.js"),
        import("./session-transcript-anchor-read.kernel.js"),
        import("../../infra/sqlite-worker-identity.js"),
      ]);
      return () => {
        assertExistingDatabaseIdentity(
          request.database.path,
          request.expectedIdentity.key,
          request.expectedIdentity.birthtime,
        );
        const read = withOpenClawAgentDatabaseReadOnly(
          (database) =>
            readSessionTranscriptAnchorFactsInDatabase(
              database,
              request.resolved,
              request.selection,
            ),
          { ...request.database, env: request.resolved.env },
        );
        return { kind: request.kind, facts: read.found ? read.value : { anchors: [] } };
      };
    }
    case "session-pending-input-source": {
      const [
        { withOpenClawAgentDatabaseReadOnly },
        { assertCapturedSessionEntryReadSource },
        { readPendingInputSourceInDatabase },
      ] = await Promise.all([
        import("../../state/openclaw-agent-db-readonly.js"),
        import("./session-accessor.sqlite-exact-read.js"),
        import("./session-pending-input-source.kernel.js"),
      ]);
      return () => {
        const read = withOpenClawAgentDatabaseReadOnly(
          (database) => {
            assertCapturedSessionEntryReadSource(request.source, database);
            return readPendingInputSourceInDatabase(database, request.input);
          },
          { ...request.database, env: request.env },
        );
        return {
          kind: request.kind,
          snapshot: read.found ? read.value : { kind: "source", current: false },
        };
      };
    }
    case "transcript-match": {
      const [{ findTranscriptEventMatchingInDatabase }, { withOpenClawAgentDatabaseReadOnly }] =
        await Promise.all([
          import("./session-transcript-match.js"),
          import("../../state/openclaw-agent-db-readonly.js"),
        ]);
      return () => {
        if (retainedDatabase) {
          return {
            kind: request.kind,
            result: findTranscriptEventMatchingInDatabase(retainedDatabase, request.request),
          };
        }
        const opened = withOpenClawAgentDatabaseReadOnly(
          (database) => findTranscriptEventMatchingInDatabase(database, request.request),
          {
            ...request.database,
            env: cloneEnvWithPlatformSemantics(request.request.target.env ?? process.env),
          },
        );
        return { kind: request.kind, result: opened.found ? opened.value : undefined };
      };
    }
    case "transcript-search": {
      const { searchSessionTranscriptsReadOnlySync } =
        await import("./session-transcript-search.js");
      return () => ({
        kind: request.kind,
        result: searchSessionTranscriptsReadOnlySync(request.params, {
          ...request.database,
          env: cloneEnvWithPlatformSemantics(request.params.env ?? process.env),
        }),
      });
    }
    case "branch-summaries": {
      const { readSessionBranchSnapshot, readSessionBranchSummariesInWorker } =
        await import("./session-accessor.sqlite-branches.js");
      if (retainedDatabase) {
        return () =>
          readSessionBranchSnapshot(retainedDatabase, {
            sessionKey: request.request.sessionKey,
            sessionId: request.request.sessionId,
            lifecycleRevision: request.request.lifecycleRevision,
          });
      }
      const databaseIdentity = request.request.databaseIdentity;
      if (databaseIdentity === undefined) {
        throw new Error("Durable branch reads require their captured database identity");
      }
      return () => readSessionBranchSummariesInWorker({ ...request.request, databaseIdentity });
    }
    case "session-title-fields": {
      const { readSessionTitleFieldsFromTranscript } =
        await import("../../gateway/session-transcript-title-reader.js");
      return () =>
        runWithSessionTranscriptReadFence(request.admission, () => ({
          kind: request.kind,
          fields: readSessionTitleFieldsFromTranscript(request.scope, {
            includeInterSession: request.includeInterSession,
            readOnly: true,
          }),
        }));
    }
    case "session-preview": {
      const { readSessionPreviewItemsReadOnly } =
        await import("../../gateway/session-transcript-preview-reader.js");
      return () =>
        runWithSessionTranscriptReadFence(request.admission, () => ({
          kind: request.kind,
          items: readSessionPreviewItemsReadOnly(request, retainedDatabase),
        }));
    }
    case "model-context": {
      const { readSessionTranscriptModelContext } =
        await import("./session-accessor.sqlite-model-context.js");
      return () =>
        runWithSessionTranscriptReadFence(request.admission, () =>
          readSessionTranscriptModelContext(request.target, request.through, request.limits),
        );
    }
    case "transcript-watermark": {
      const { readSessionTranscriptWatermark } =
        await import("./session-accessor.sqlite-transcript-watermark.js");
      return () => ({
        kind: request.kind,
        watermark: readSessionTranscriptWatermark(request.scope),
      });
    }
    case "session-pending-input-receipts": {
      const { listSessionPendingInputReceipts } =
        await import("./session-accessor.sqlite-pending-input-receipts.js");
      return () => ({
        kind: request.kind,
        receipts: listSessionPendingInputReceipts(
          {
            agentId: request.agentId,
            sessionKey: request.sessionKey,
            sessionId: request.sessionId,
            storePath: request.database.path,
            env: cloneEnvWithPlatformSemantics(request.env),
          },
          { runIds: request.runIds },
        ),
      });
    }
  }
  throw new Error("Unsupported session history read operation");
}
