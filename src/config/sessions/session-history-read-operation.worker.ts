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
      | "trajectory-events"
      | "trajectory-retention"
      | "board-snapshot"
      | "board-widget-document"
      | "transcript-match"
      | "branch-summaries"
      | "session-title-fields"
      | "session-preview"
      | "model-context"
      | "context-messages"
      | "transcript-watermark"
      | "transcript-message-presence"
      | "transcript-anchors"
      | "transcript-raw-delta"
      | "transcript-visible-delta"
      | "transcript-latest-assistant"
      | "session-memory-capture"
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
    case "transcript-page-read":
    case "trajectory-events":
    case "trajectory-retention":
    case "board-snapshot":
    case "board-widget-document":
    case "transcript-match":
    case "branch-summaries":
    case "session-title-fields":
    case "session-preview":
    case "model-context":
    case "context-messages":
    case "transcript-watermark":
    case "transcript-message-presence":
    case "transcript-anchors":
    case "transcript-raw-delta":
    case "transcript-visible-delta":
    case "transcript-latest-assistant":
    case "session-memory-capture":
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
        { withScopedOpenClawAgentDatabaseReadOnly },
        { createTranscriptReadMeter, readTranscriptPageInDatabase },
      ] = await Promise.all([
        // The page read must never borrow the process-held writable handle:
        // the scoped owner admits only native read-only connections.
        import("../../state/openclaw-agent-db-readonly-scope.js"),
        import("./session-transcript-page-read.kernel.js"),
      ]);
      const meter = createTranscriptReadMeter(request.request.limits);
      return () => {
        const fail = (error: "missing" | "read_failed" | "stale_session" | "forbidden") => ({
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
          const read = withScopedOpenClawAgentDatabaseReadOnly(
            (database) => readTranscriptPageInDatabase(database, request.request, meter),
            {
              agentId: request.database.agentId,
              path: request.database.path,
              env: request.request.scope.env,
            },
          );
          assertTranscriptPageIdentity(request.database.path, request.expectedIdentity);
          return read.found
            ? { kind: request.kind, result: read.value }
            : fail(read.reason === "database-missing" ? "missing" : "read_failed");
        } catch (error) {
          if (error instanceof TranscriptPageIdentityError) {
            return fail(error.reason);
          }
          throw error;
        }
      };
    }
    case "trajectory-events": {
      const { loadSqliteTrajectoryRuntimeEventRowsSync } =
        await import("../../trajectory/runtime-store.sqlite.js");
      return () => ({
        kind: request.kind,
        events: loadSqliteTrajectoryRuntimeEventRowsSync({
          ...request.scope,
          agentId: request.database.agentId,
          storePath: request.database.path,
        }).map((row) => row.event),
      });
    }
    case "trajectory-retention": {
      const [
        { withOpenClawAgentDatabaseReadOnly },
        { assertOpenClawAgentDatabaseIdentity },
        { prepareTrajectoryRuntimeRetention },
        { adoptPreparedCanonicalSessionValidationSchema },
      ] = await Promise.all([
        import("../../state/openclaw-agent-db-readonly.js"),
        import("../../state/openclaw-agent-db-identity.js"),
        import("../../trajectory/runtime-retention.sqlite.js"),
        import("../../state/openclaw-agent-canonical-validation-schema.js"),
      ]);
      if (request.schemaContract) {
        adoptPreparedCanonicalSessionValidationSchema(request.schemaContract);
      }
      return () => {
        const read = withOpenClawAgentDatabaseReadOnly(
          (database) => {
            assertOpenClawAgentDatabaseIdentity(database, request.expectedIdentity);
            const plan = prepareTrajectoryRuntimeRetention(database.db, request.input, request.now);
            assertOpenClawAgentDatabaseIdentity(database, request.expectedIdentity);
            return plan;
          },
          { ...request.database, env: request.env },
        );
        if (!read.found) {
          throw new Error(`Trajectory retention cannot read its database: ${read.reason}`);
        }
        return { kind: request.kind, plan: read.value };
      };
    }
    case "session-memory-capture": {
      const { readSessionMemoryCapture } =
        await import("../../hooks/bundled/session-memory/capture.worker.js");
      return () =>
        runWithSessionTranscriptReadFence(request.admission, () => ({
          kind: request.kind,
          result: readSessionMemoryCapture({
            scope: request.scope,
            resolvedScope: request.resolved,
            messageCount: request.messageCount,
          }),
        }));
    }
    case "transcript-latest-assistant": {
      const [{ readLatestAssistantTextFromDatabase }, { withOpenClawAgentDatabaseReadOnly }] =
        await Promise.all([
          import("./session-accessor.sqlite-transcript-metadata-read.js"),
          import("../../state/openclaw-agent-db-readonly.js"),
        ]);
      return () =>
        runWithSessionTranscriptReadFence(request.admission, () => {
          const read = withOpenClawAgentDatabaseReadOnly(
            (database) => readLatestAssistantTextFromDatabase(database, request.resolved),
            { ...request.database, env: request.scope.env },
            { snapshot: true },
          );
          return { kind: request.kind, result: read.found ? read.value : undefined };
        });
    }
    case "transcript-raw-delta": {
      const [{ readTranscriptRawDeltaInDatabase }, { withOpenClawAgentDatabaseReadOnly }] =
        await Promise.all([
          import("./session-accessor.sqlite-delta.js"),
          import("../../state/openclaw-agent-db-readonly.js"),
        ]);
      return () =>
        runWithSessionTranscriptReadFence(request.admission, () => {
          const read = withOpenClawAgentDatabaseReadOnly(
            (database) =>
              readTranscriptRawDeltaInDatabase(database, request.resolved, request.limits),
            { ...request.database, env: request.scope.env },
            { snapshot: true },
          );
          return { kind: request.kind, result: read.found ? read.value : { kind: "missing" } };
        });
    }
    case "transcript-visible-delta": {
      const { readSessionTranscriptVisibleMessageDeltaCore } =
        await import("./session-accessor.sqlite-active-events.js");
      return () =>
        runWithSessionTranscriptReadFence(request.admission, () => ({
          kind: request.kind,
          result: readSessionTranscriptVisibleMessageDeltaCore(request.scope, request.limits, {
            readOnly: true,
            resolvedScope: request.resolved,
          }),
        }));
    }
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
        { readSessionTranscriptAnchorFactsInDatabase, prepareSessionTranscriptAnchorMessageReader },
      ] = await Promise.all([
        import("../../state/openclaw-agent-db-readonly.js"),
        import("./session-transcript-anchor-read.kernel.js"),
      ]);
      const readMessage = await prepareSessionTranscriptAnchorMessageReader(request.selection);
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
              readMessage,
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
        import("./session-entry-read-source.js"),
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
        import("./session-entry-read-source.js"),
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
          import("./session-accessor.sqlite-transcript-metadata-read.js"),
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
