import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
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
      | "board-snapshot"
      | "board-widget-document"
      | "transcript-match"
      | "transcript-search"
      | "transcript-search-current"
      | "branch-summaries"
      | "session-title-fields"
      | "session-preview"
      | "model-context"
      | "context-messages"
      | "transcript-watermark"
      | "transcript-message-presence"
      | "transcript-anchors"
      | "session-pending-input-receipts"
      | "session-pending-input-source"
      | "session-harness-completion-source";
  }
>;

type BranchReadRequest = Extract<DurableHistoryReadOperationRequest, { kind: "branch-summaries" }>;
export type SessionHistoryReadOperationRequest =
  | Exclude<DurableHistoryReadOperationRequest, BranchReadRequest>
  | {
      kind: "branch-summaries";
      database: BranchReadRequest["database"];
      request: Omit<BranchReadRequest["request"], "databaseIdentity"> & {
        databaseIdentity?: string;
      };
    };

export function isSessionHistoryReadOperation(
  request: SessionTranscriptWorkerInput,
): request is DurableHistoryReadOperationRequest {
  switch (request.kind) {
    case "board-snapshot":
    case "board-widget-document":
    case "transcript-match":
    case "transcript-search":
    case "transcript-search-current":
    case "branch-summaries":
    case "session-title-fields":
    case "session-preview":
    case "model-context":
    case "context-messages":
    case "transcript-watermark":
    case "transcript-message-presence":
    case "transcript-anchors":
    case "session-pending-input-receipts":
    case "session-pending-input-source":
    case "session-harness-completion-source":
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
  const execute = await prepareHistoryRead(request, retainedDatabase);
  return () => {
    if (
      "expectedIdentity" in request &&
      request.expectedIdentity &&
      request.kind !== "transcript-anchors" &&
      request.kind !== "context-messages"
    ) {
      assertExistingDatabaseIdentity(
        request.kind === "model-context" ? request.target.storePath : request.database.path,
        request.expectedIdentity.key,
        request.expectedIdentity.birthtime,
      );
    }
    return execute();
  };
}

async function prepareHistoryRead(
  request: SessionHistoryReadOperationRequest,
  retainedDatabase?: OpenClawAgentReadOnlyDatabase,
): Promise<() => SessionTranscriptWorkerValues[SessionHistoryReadOperationRequest["kind"]]> {
  switch (request.kind) {
    case "board-snapshot":
    case "board-widget-document": {
      const [
        { withOpenClawAgentDatabaseReadOnly },
        { runSqliteDeferredTransactionSync },
        { readBoardSnapshotWithHtmlViewMetadata, readBoardWidgetDocument },
      ] = await Promise.all([
        import("../../state/openclaw-agent-db-readonly.js"),
        import("../../infra/sqlite-transaction.js"),
        import("../../boards/sqlite-board-store.kernel.js"),
      ]);
      return () => {
        const read = withOpenClawAgentDatabaseReadOnly(
          (database) =>
            runSqliteDeferredTransactionSync(database.db, () =>
              request.kind === "board-snapshot"
                ? {
                    kind: request.kind,
                    value: readBoardSnapshotWithHtmlViewMetadata(database, request.sessionKey),
                  }
                : {
                    kind: request.kind,
                    value: readBoardWidgetDocument(
                      database,
                      request.sessionKey,
                      request.name,
                      request.contentKind,
                    ),
                  },
            ),
          { ...request.database, env: request.env },
        );
        return read.found ? read.value : { kind: request.kind, value: undefined };
      };
    }
    case "transcript-anchors": {
      const [
        { withOpenClawAgentDatabaseReadOnly },
        { readSessionTranscriptAnchorFactsInDatabase },
      ] = await Promise.all([
        import("../../state/openclaw-agent-db-readonly.js"),
        import("./session-transcript-anchor-read.kernel.js"),
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
    case "session-harness-completion-source": {
      const [
        { withOpenClawAgentDatabaseReadOnly },
        { assertCapturedSessionEntryReadSource },
        { readHarnessCompletionSourceInDatabase },
      ] = await Promise.all([
        import("../../state/openclaw-agent-db-readonly.js"),
        import("./session-accessor.sqlite-exact-read.js"),
        import("./session-harness-completion-source.kernel.js"),
      ]);
      return () => {
        const read = withOpenClawAgentDatabaseReadOnly(
          (database) => {
            assertCapturedSessionEntryReadSource(request.source, database);
            return runWithSessionTranscriptReadFence(request.admission, () =>
              readHarnessCompletionSourceInDatabase(database, request.claim),
            );
          },
          { ...request.database, env: request.env },
        );
        return {
          kind: request.kind,
          snapshot: read.found ? read.value : { validInput: false },
        };
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
    case "transcript-search-current": {
      const { isSessionTranscriptSearchCurrentSync } =
        await import("./session-transcript-search.js");
      return () => ({
        kind: request.kind,
        current: isSessionTranscriptSearchCurrentSync(request.revision, {
          ...request.database,
          env: request.env,
        }),
      });
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
        return () => ({
          kind: request.kind,
          result: readSessionBranchSnapshot(retainedDatabase, {
            sessionKey: request.request.sessionKey,
            sessionId: request.request.sessionId,
            lifecycleRevision: request.request.lifecycleRevision,
            previous: request.request.previous,
          }),
        });
      }
      const databaseIdentity = request.request.databaseIdentity;
      if (databaseIdentity === undefined) {
        throw new Error("Durable branch reads require their captured database identity");
      }
      return () => ({
        kind: request.kind,
        result: readSessionBranchSummariesInWorker({
          ...request.request,
          database: request.database,
          databaseIdentity,
        }),
      });
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
    case "context-messages": {
      const [
        { readSessionTranscriptContextMessages },
        { resolveSqliteTranscriptReadScope, toDatabaseOptions },
        { resolveOpenClawAgentSqlitePath },
        { readDatabasePathIdentitySync },
      ] = await Promise.all([
        import("./session-accessor.sqlite-model-context.js"),
        import("./session-accessor.sqlite-scope.js"),
        import("../../state/openclaw-agent-db.paths.js"),
        import("../../infra/sqlite-worker-identity.js"),
      ]);
      return () =>
        runWithSessionTranscriptReadFence(request.admission, () => {
          const databasePath = resolveOpenClawAgentSqlitePath(
            toDatabaseOptions(resolveSqliteTranscriptReadScope(request.target)),
          );
          if (request.expectedIdentity) {
            assertExistingDatabaseIdentity(
              databasePath,
              request.expectedIdentity.key,
              request.expectedIdentity.birthtime,
            );
          } else if (readDatabasePathIdentitySync(databasePath).key.startsWith("file:")) {
            throw new Error("Session context changed its captured database owner");
          }
          return readSessionTranscriptContextMessages(
            request.target,
            (messages, header, version) => ({
              messages: [...messages],
              header,
              version,
            }),
          );
        });
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
      return () => {
        return { kind: request.kind, watermark: readSessionTranscriptWatermark(request.scope) };
      };
    }
    case "transcript-message-presence": {
      const [{ withOpenClawAgentDatabaseReadOnly }, { hasSessionTranscriptMessageInDatabase }] =
        await Promise.all([
          import("../../state/openclaw-agent-db-readonly.js"),
          import("./session-accessor.sqlite-read.js"),
        ]);
      return () => {
        const read = withOpenClawAgentDatabaseReadOnly(
          (database) => hasSessionTranscriptMessageInDatabase(database, request.scope.sessionId),
          { ...request.database, env: request.scope.env },
        );
        return { kind: request.kind, present: read.found && read.value };
      };
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
