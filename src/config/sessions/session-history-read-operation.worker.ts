import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly-open.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import type {
  SessionTranscriptWorkerInput,
  SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";

const historyReadKinds = [
  "trajectory-events",
  "trajectory-retention",
  "board-snapshot",
  "board-widget-document",
  "transcript-match",
  "branch-summaries",
  "session-title-fields",
  "session-preview",
  "model-context",
  "context-messages",
  "transcript-watermark",
  "transcript-stats",
  "transcript-message-presence",
  "transcript-anchors",
  "transcript-raw-delta",
  "transcript-visible-delta",
  "transcript-latest-assistant",
  "session-memory-capture",
  "session-pending-input-receipts",
  "session-pending-input-source",
  "session-harness-completion-source",
] as const;
const historyReadKindSet: ReadonlySet<string> = new Set(historyReadKinds);

export type SessionHistoryReadOperationRequest = Extract<
  SessionTranscriptWorkerInput,
  { kind: (typeof historyReadKinds)[number] }
>;

export function isSessionHistoryReadOperation(
  request: SessionTranscriptWorkerInput,
): request is SessionHistoryReadOperationRequest {
  return historyReadKindSet.has(request.kind);
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
      const [{ assertOpenClawAgentDatabaseIdentity }, { prepareTrajectoryRuntimeRetention }] =
        await Promise.all([
          import("../../state/openclaw-agent-db-identity.js"),
          import("../../trajectory/runtime-retention.sqlite.js"),
        ]);
      const read = await prepareDatabaseRead(
        { ...request.database, env: request.env },
        (database) => {
          assertOpenClawAgentDatabaseIdentity(database, request.expectedIdentity);
          const plan = prepareTrajectoryRuntimeRetention(database.db, request.input, request.now);
          assertOpenClawAgentDatabaseIdentity(database, request.expectedIdentity);
          return plan;
        },
        (reason) => {
          throw new Error(`Trajectory retention cannot read its database: ${reason}`);
        },
      );
      return () => ({ kind: request.kind, plan: read() });
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
      const { readLatestAssistantTextFromDatabase } =
        await import("./session-accessor.sqlite-transcript-metadata-read.js");
      const read = await prepareDatabaseRead(
        { ...request.database, env: request.scope.env },
        (database) => readLatestAssistantTextFromDatabase(database, request.resolved),
        () => undefined,
        { snapshot: true, admission: request.admission },
      );
      return () => ({ kind: request.kind, result: read() });
    }
    case "transcript-raw-delta": {
      const { readTranscriptRawDeltaInDatabase } =
        await import("./session-accessor.sqlite-delta.js");
      const read = await prepareDatabaseRead(
        { ...request.database, env: request.scope.env },
        (database) => readTranscriptRawDeltaInDatabase(database, request.resolved, request.limits),
        () => ({ kind: "missing" as const }),
        { snapshot: true, admission: request.admission },
      );
      return () => ({ kind: request.kind, result: read() });
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
        { withScopedOpenClawAgentDatabaseReadOnly },
        { runSqliteDeferredTransactionSync },
        { readBoardSnapshotWithHtmlViewMetadata, readBoardWidgetDocument },
      ] = await Promise.all([
        import("../../state/openclaw-agent-db-readonly-scope.js"),
        import("../../infra/sqlite-transaction.js"),
        import("../../boards/sqlite-board-store.kernel.js"),
      ]);
      return () => {
        const read = withScopedOpenClawAgentDatabaseReadOnly(
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
      const {
        readSessionTranscriptAnchorFactsInDatabase,
        prepareSessionTranscriptAnchorMessageReader,
      } = await import("./session-transcript-anchor-read.kernel.js");
      const readMessage = await prepareSessionTranscriptAnchorMessageReader(request.selection);
      const read = await prepareDatabaseRead(
        { ...request.database, env: request.resolved.env },
        (database) =>
          readSessionTranscriptAnchorFactsInDatabase(
            database,
            request.resolved,
            request.selection,
            readMessage,
            undefined,
            request.preparedEntry,
          ),
        () => ({ anchors: [] }),
      );
      return () => {
        assertExistingDatabaseIdentity(
          request.database.path,
          request.expectedIdentity.key,
          request.expectedIdentity.birthtime,
        );
        return { kind: request.kind, facts: read() };
      };
    }
    case "session-harness-completion-source": {
      const [{ assertCapturedSessionEntryReadSource }, { readHarnessCompletionSourceInDatabase }] =
        await Promise.all([
          import("./session-entry-read-source.js"),
          import("./session-harness-completion-source.kernel.js"),
        ]);
      const read = await prepareDatabaseRead(
        { ...request.database, env: request.env },
        (database) => {
          assertCapturedSessionEntryReadSource(request.source, database);
          return runWithSessionTranscriptReadFence(request.admission, () =>
            readHarnessCompletionSourceInDatabase(database, request.claim, request.mode),
          );
        },
        () => ({ validInput: false }),
      );
      return () => ({ kind: request.kind, snapshot: read() });
    }
    case "session-pending-input-source": {
      const [{ assertCapturedSessionEntryReadSource }, { readPendingInputSourceInDatabase }] =
        await Promise.all([
          import("./session-entry-read-source.js"),
          import("./session-pending-input-source.kernel.js"),
        ]);
      const read = await prepareDatabaseRead(
        { ...request.database, env: request.env },
        (database) => {
          assertCapturedSessionEntryReadSource(request.source, database);
          return readPendingInputSourceInDatabase(database, request.input);
        },
        () => ({ kind: "source" as const, current: false }),
      );
      return () => ({ kind: request.kind, snapshot: read() });
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
        await import("./session-accessor.sqlite-branches.worker.js");
      if (retainedDatabase) {
        return () => ({
          kind: request.kind,
          result: readSessionBranchSnapshot(retainedDatabase, {
            sessionKey: request.request.sessionKey,
            previous: request.request.previous,
          }),
        });
      }
      return () => ({
        kind: request.kind,
        result: readSessionBranchSummariesInWorker({
          ...request.request,
          database: request.database,
        }),
      });
    }
    case "session-title-fields": {
      const { readSessionTitleFieldsFromTranscript } =
        await import("../../gateway/session-transcript-title-reader.worker.js");
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
    case "transcript-stats": {
      const { readTranscriptStatsFromDatabase } =
        await import("./session-accessor.sqlite-transcript-stats.js");
      const read = await prepareDatabaseRead(
        { ...request.database, env: request.scope.env },
        (database) => readTranscriptStatsFromDatabase(database, request.scope.sessionId),
        () => ({ eventCount: 0, maxSeq: 0, sizeBytes: 0 }),
      );
      return () => ({ kind: request.kind, stats: read() });
    }
    case "transcript-message-presence": {
      const { hasSessionTranscriptMessageInDatabase } =
        await import("./session-accessor.sqlite-transcript-metadata-read.js");
      const read = await prepareDatabaseRead(
        { ...request.database, env: request.scope.env },
        (database) => hasSessionTranscriptMessageInDatabase(database, request.scope.sessionId),
        () => false,
      );
      return () => ({ kind: request.kind, present: read() });
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

async function prepareDatabaseRead<Value, Missing>(
  databaseOptions: OpenClawAgentDatabaseOptions,
  read: (database: OpenClawAgentReadOnlyDatabase) => Value,
  missing: (reason: "database-missing" | "schema-missing") => Missing,
  options?: {
    snapshot?: true;
    admission?: Parameters<typeof runWithSessionTranscriptReadFence>[0];
  },
): Promise<() => Value | Missing> {
  const { withOpenClawAgentDatabaseReadOnly } =
    await import("../../state/openclaw-agent-db-readonly.js");
  return () =>
    runWithSessionTranscriptReadFence(options?.admission, () => {
      const result = withOpenClawAgentDatabaseReadOnly(read, databaseOptions, options);
      return result.found ? result.value : missing(result.reason);
    });
}
