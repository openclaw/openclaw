import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly-open.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import {
  assertTranscriptPageIdentity,
  TranscriptPageIdentityError,
} from "./session-transcript-page-read-identity.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import type {
  SessionTranscriptWorkerInput,
  SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";

type DurableHistoryReadOperationRequest = Extract<
  SessionTranscriptWorkerInput,
  {
    kind:
      | "transcript-page-read"
      | "transcript-match"
      | "transcript-search"
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
      request: Omit<BranchReadRequest["request"], "databaseIdentity"> & {
        databaseIdentity?: string;
      };
    };

export function isSessionHistoryReadOperation(
  request: SessionTranscriptWorkerInput,
): request is DurableHistoryReadOperationRequest {
  switch (request.kind) {
    case "transcript-page-read":
    case "transcript-match":
    case "transcript-search":
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
      request.kind !== "transcript-page-read" &&
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
    case "transcript-page-read": {
      const [
        { withOpenClawAgentDatabaseReadOnly },
        { createTranscriptReadMeter, readTranscriptPageInDatabase },
      ] = await Promise.all([
        import("../../state/openclaw-agent-db-readonly.js"),
        import("./session-transcript-page-read.kernel.js"),
      ]);
      const meter = createTranscriptReadMeter(request.request.limits);
      return () => {
        const fail = (error: "missing" | "unsupported" | "stale_session" | "forbidden") => ({
          kind: request.kind,
          result: { ok: false as const, error, budget: meter.snapshot(true) },
        });
        if (
          request.request.scope.agentId !== request.database.agentId ||
          request.request.scope.path !== request.database.path
        ) {
          return fail("forbidden");
        }
        try {
          assertTranscriptPageIdentity(request.database.path, request.expectedIdentity);
          const read = withOpenClawAgentDatabaseReadOnly(
            (database) => readTranscriptPageInDatabase(database, request.request, meter),
            { ...request.database, env: request.request.scope.env },
          );
          assertTranscriptPageIdentity(request.database.path, request.expectedIdentity);
          return read.found
            ? { kind: request.kind, result: read.value }
            : fail(read.reason === "database-missing" ? "missing" : "unsupported");
        } catch (error) {
          if (error instanceof TranscriptPageIdentityError) {
            return fail(error.reason);
          }
          throw error;
        }
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
