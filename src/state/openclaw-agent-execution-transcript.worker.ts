import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.sqlite-contract.js";
import type { SessionTranscriptInitializationPublication } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import type { ResolvedTranscriptReadScope } from "../config/sessions/session-accessor.sqlite-scope-helpers.js";
import type {
  SessionTranscriptExecutionReadInputs,
  SessionTranscriptExecutionReadResult,
} from "../config/sessions/session-transcript-execution-read.types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db-contract.js";
import type { AgentWorkerOperationContext } from "./openclaw-agent-operation-context.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

type Handlers = WorkerOperationHandlers<AgentWorkerOperationContext>;
export type TranscriptInitialization = { sessionKey: string; sessionId: string; cwd?: string };

let transcript:
  | {
      initialize: typeof import("../config/sessions/session-accessor.sqlite-transcript-header.js").ensureTranscriptHeader;
      assertIdentity: typeof import("../config/sessions/session-accessor.sqlite-scope.js").assertSqliteTranscriptWriteIdentity;
      readPublication: typeof import("../config/sessions/session-transcript-authority.js").readStagedSessionTranscriptAuthority;
    }
  | undefined;

export function prepareAgentTranscript() {
  return Promise.all([
    import("../config/sessions/session-accessor.sqlite-transcript-header.js"),
    import("../config/sessions/session-accessor.sqlite-scope.js"),
    import("../config/sessions/session-transcript-authority.js"),
  ]).then(([header, scope, authority]) => {
    transcript = {
      initialize: header.ensureTranscriptHeader,
      assertIdentity: scope.assertSqliteTranscriptWriteIdentity,
      readPublication: authority.readStagedSessionTranscriptAuthority,
    };
  });
}

export async function loadAgentTranscriptOperations() {
  await prepareAgentTranscript();
  return {
    "session.transcript.initialize": (input: TranscriptInitialization, context) => {
      if (!transcript) {
        throw new Error("Session transcript initialization was not prepared");
      }
      const { initialize, readPublication } = transcript;
      const assertIdentity: typeof transcript.assertIdentity = transcript.assertIdentity;
      assertIdentity(input);
      return context.writeTransaction(
        "session.entry.create-with-transcript",
        "Session transcript",
        (current) => {
          const publication: SessionTranscriptInitializationPublication = {
            kind: "session-transcript-initialized",
            sessionKey: input.sessionKey,
          };
          initialize(
            current,
            { agentId: context.options.agentId, path: context.options.path, ...input },
            input.cwd,
            {
              onPlaceholderInserted: ({ sessionId }) => {
                publication.placeholder = { sessionId };
              },
            },
          );
          publication.transcriptPublication = readPublication(current);
          deferSqliteWorkerCommitReceipt(current.db, publication);
          context.admit("commit", publication);
          return publication;
        },
      );
    },
  } satisfies Handlers;
}

export function initializeReplacementTranscript(
  current: OpenClawAgentDatabase,
  options: Pick<AgentWorkerOperationContext["options"], "agentId" | "path">,
  initialization: TranscriptInitialization | undefined,
): void {
  if (!initialization) {
    return;
  }
  try {
    if (!transcript) {
      throw new Error("Session transcript initialization was not prepared");
    }
    const { initialize } = transcript;
    const assertIdentity: typeof transcript.assertIdentity = transcript.assertIdentity;
    assertIdentity(initialization);
    initialize(
      current,
      { agentId: options.agentId, path: options.path, ...initialization },
      initialization.cwd,
    );
  } catch (error) {
    throw Object.assign(new Error(formatErrorMessage(error), { cause: error }), {
      name: "SessionTranscriptInitializationError",
    });
  }
}

export async function loadAgentTranscriptReadOperations() {
  const [
    raw,
    visible,
    memory,
    anchors,
    cold,
    fence,
    identity,
    reader,
    scopes,
    agents,
    errors,
    watermark,
  ] = await Promise.all([
    import("../config/sessions/session-accessor.sqlite-delta.js"),
    import("../config/sessions/session-accessor.sqlite-active-events.js"),
    import("../hooks/bundled/session-memory/capture.worker.js"),
    import("../config/sessions/session-transcript-anchor-read.kernel.js"),
    import("../config/sessions/session-cold-storage-state.js"),
    import("../config/sessions/session-transcript-read-fence.js"),
    import("../infra/sqlite-worker-identity.js"),
    import("./openclaw-agent-db-readonly-open.js"),
    import("../config/sessions/session-accessor.sqlite-scope-helpers.js"),
    import("@openclaw/normalization-core/agent-id"),
    import("../config/sessions/session-history-worker-errors.js"),
    import("../config/sessions/session-accessor.sqlite-transcript-watermark.js"),
  ]);
  const readResult = <T>(read: () => T): SessionTranscriptExecutionReadResult<T> => {
    try {
      return { ok: true, value: read() };
    } catch (error) {
      const encoded = errors.encodeSessionTranscriptWorkerError(error);
      if (!encoded) {
        throw error;
      }
      return { ok: false, error: encoded };
    }
  };
  const open = (
    input: {
      expectedIdentity: SessionTranscriptExecutionReadInputs["cold"]["expectedIdentity"];
      resolved?: ResolvedTranscriptReadScope;
      scope?: SessionTranscriptReadScope;
    },
    context: AgentWorkerOperationContext,
  ) => {
    const database = context.open();
    identity.assertExistingDatabaseIdentity(
      database.path,
      input.expectedIdentity.key,
      input.expectedIdentity.birthtime,
    );
    if (input.scope) {
      identity.assertExistingDatabaseIdentity(
        input.scope.storePath ?? database.path,
        input.expectedIdentity.key,
        input.expectedIdentity.birthtime,
      );
    }
    if (input.resolved) {
      if ((input.resolved.databaseAgentId ?? input.resolved.agentId) !== database.agentId) {
        throw new Error("Prepared transcript read belongs to another agent database");
      }
      identity.assertExistingDatabaseIdentity(
        input.resolved.path ?? database.path,
        input.expectedIdentity.key,
        input.expectedIdentity.birthtime,
      );
      if (input.scope) {
        const scope = input.scope;
        if (
          scope.sessionId !== input.resolved.sessionId ||
          (scope.agentId !== undefined &&
            agents.normalizeAgentId(scope.agentId) !== input.resolved.agentId) ||
          (scope.sessionKey !== undefined &&
            scopes.resolveSqliteSessionKey(scope.sessionKey, input.resolved.agentId) !==
              input.resolved.sessionKey)
        ) {
          throw new Error("Prepared transcript read changed its captured session scope");
        }
      }
    }
    return database;
  };
  const snapshot = <T>(
    input: {
      expectedIdentity: SessionTranscriptExecutionReadInputs["cold"]["expectedIdentity"];
      resolved?: ResolvedTranscriptReadScope;
      scope?: SessionTranscriptReadScope;
    },
    context: AgentWorkerOperationContext,
    read: (database: ReturnType<AgentWorkerOperationContext["open"]>) => T,
  ) => {
    const database = open(input, context);
    return reader.readOpenClawAgentDatabaseSnapshot(database, () => read(database));
  };
  return {
    "session.transcript.watermark.read": (
      input: SessionTranscriptExecutionReadInputs["watermark"],
      context,
    ) =>
      readResult(() => {
        open(input, context);
        return watermark.readSessionTranscriptWatermark(input.scope);
      }),
    "session.transcript.rawDelta.read": (
      input: SessionTranscriptExecutionReadInputs["raw"],
      context,
    ) =>
      readResult(() => {
        const result = snapshot(input, context, (database) =>
          fence.runWithSessionTranscriptReadFence(input.admission, () =>
            raw.readTranscriptRawDeltaInDatabase(database, input.resolved, input.limits),
          ),
        );
        return result.found ? result.value : { kind: "missing" as const };
      }),
    "session.transcript.visibleDelta.read": (
      input: SessionTranscriptExecutionReadInputs["visible"],
      context,
    ) =>
      readResult(() => {
        open(input, context);
        // Projection kernels admit and read the retained writer in their own deferred snapshot.
        return fence.runWithSessionTranscriptReadFence(input.admission, () =>
          visible.readSessionTranscriptVisibleMessageDeltaCore(input.scope, input.limits, {
            readOnly: true,
            resolvedScope: input.resolved,
          }),
        );
      }),
    "session.transcript.memoryCapture.read": (
      input: SessionTranscriptExecutionReadInputs["memory"],
      context,
    ) =>
      readResult(() => {
        open(input, context);
        return fence.runWithSessionTranscriptReadFence(input.admission, () =>
          memory.readSessionMemoryCapture({
            scope: input.scope,
            resolvedScope: input.resolved,
            messageCount: input.messageCount,
          }),
        );
      }),
    "session.transcript.anchors.read": (
      input: SessionTranscriptExecutionReadInputs["anchors"],
      context,
    ) =>
      readResult(() => {
        const result = snapshot(input, context, (database) =>
          anchors.readSessionTranscriptAnchorFactsInDatabase(
            database,
            input.resolved,
            input.selection,
          ),
        );
        return result.found ? result.value : { anchors: [] };
      }),
    "session.transcript.coldMetadata.read": (
      input: SessionTranscriptExecutionReadInputs["cold"],
      context,
    ) =>
      readResult(() => {
        const result = snapshot(input, context, (database) =>
          cold.readSessionColdTranscript(database.db, input.sessionId),
        );
        return result.found ? result.value : undefined;
      }),
  } satisfies Handlers;
}
