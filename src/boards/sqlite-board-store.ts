import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { isPromise } from "node:util/types";
import type { Result } from "@openclaw/normalization-core/result";
import type {
  BoardOp,
  BoardSnapshot,
  BoardWidgetMaterializedPutParams,
} from "../../packages/gateway-protocol/src/index.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import { resolveStateDir } from "../config/state-dir.js";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  readErrorName,
} from "../infra/errors.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { isSqliteWorkerError, type SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseAsync,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import {
  openOpenClawAgentSqliteWorkerStore,
  type OpenClawAgentSqliteWorkerStore,
} from "../state/openclaw-agent-worker-store.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../state/openclaw-agent-write-admission.js";
import { BoardValidationError } from "./board-layout.js";
import {
  cloneBoardSnapshot,
  normalizeBoardWidgetPutParams,
  type BoardSessionTarget,
  type BoardStore,
  type BoardWriteOptions,
  type BoardWidgetWriteOptions,
  type BoardWidgetDocument,
  type BoardSnapshotWithHtmlViewMetadata,
  type BoardWidgetMcpAppDocument,
} from "./board-store.js";
import type {
  BoardReadOperations,
  BoardWriteOperations,
  BoardWriteOutcome,
} from "./sqlite-board-operations.js";
import {
  ensureBoardSchema,
  hasBoardSession,
  readBoardSnapshotWithHtmlViewMetadata,
  readBoardWidgetDocument,
  applyBoardOpsToDatabase,
  putBoardWidgetInDatabase,
  grantBoardWidgetInDatabase,
} from "./sqlite-board-store.kernel.js";

const log = createSubsystemLogger("boards/store");

function restoreBoardError(error: unknown): unknown {
  if (
    error instanceof Error &&
    error.name === "BoardValidationError" &&
    "code" in error &&
    (error.code === "conflict" || error.code === "invalid_operation" || error.code === "not_found")
  ) {
    return new BoardValidationError(error.code, error.message);
  }
  return error;
}

/** Invalidation never grants retries; transported post-execution failures are plain Errors. */
function hasUnknownBoardWriteOutcome(error: unknown): boolean {
  return collectErrorGraphCandidates(error, (current) =>
    current instanceof AggregateError ? [current.cause] : [],
  ).some(
    (current) =>
      isSqliteWorkerError(current, "outcome-unknown") ||
      (current instanceof Error &&
        readErrorName(current) === "SqliteWorkerError" &&
        extractErrorCode(current) === "outcome-unknown"),
  );
}

type SqliteBoardStoreOptions = {
  resolveSession: (target: BoardSessionTarget) => {
    agentId: string;
    path?: string;
    sessionKey: string;
    /** Captured logical routing authority; worker grants must not repeat database discovery. */
    assertCurrent?: () => void;
    /** Captured by the future activation owner; ordinary production routing remains native. */
    incognito?: { actor: IncognitoAgentDatabaseExecution; authority: IncognitoSessionAuthority };
  };
  env?: NodeJS.ProcessEnv;
};

type ResolvedBoardSession = ReturnType<SqliteBoardStoreOptions["resolveSession"]>;

function emptyBoardSnapshot(sessionKey: string): BoardSnapshot {
  return { sessionKey, revision: 0, tabs: [], widgets: [] };
}

export class SqliteBoardStore implements BoardStore {
  constructor(private readonly options: SqliteBoardStoreOptions) {}

  private assertTargetCurrent(target: BoardSessionTarget, resolved: ResolvedBoardSession): void {
    if (resolved.assertCurrent) {
      resolved.assertCurrent();
      return;
    }
    const current = this.options.resolveSession(target);
    if (
      current.agentId !== resolved.agentId ||
      current.path !== resolved.path ||
      current.sessionKey !== resolved.sessionKey
    ) {
      throw new BoardValidationError("invalid_operation", "board session changed; retry");
    }
  }

  private requireExistingSession(
    resolved: { agentId: string; path?: string; sessionKey: string },
    env: NodeJS.ProcessEnv,
  ): void {
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => hasBoardSession(database, resolved.sessionKey),
      {
        agentId: resolved.agentId,
        ...(resolved.path ? { path: resolved.path } : {}),
        env,
      },
    );
    if (!result.found || !result.value) {
      throw new BoardValidationError(
        "not_found",
        `board session not found: ${resolved.sessionKey}`,
      );
    }
  }

  private write<T>(
    target: BoardSessionTarget,
    options: BoardWriteOptions | undefined,
    operationLabel: string,
    native: (database: OpenClawAgentDatabase, sessionKey: string) => T,
    worker: (
      scope: Pick<SqliteWorkerStore<BoardWriteOperations>, "execute">,
      sessionKey: string,
    ) => Promise<BoardWriteOutcome<T>>,
    actorWrite: (
      actor: IncognitoAgentDatabaseExecution,
      authority: IncognitoSessionAuthority,
      sessionKey: string,
    ) => Promise<BoardWriteOutcome<T>>,
    prepare?: () => Promise<void>,
  ): Promise<T> {
    const resolved = this.options.resolveSession(target);
    const env = cloneEnvWithPlatformSemantics(this.options.env ?? process.env);
    env.OPENCLAW_STATE_DIR = resolveStateDir(env);
    const databaseOptions = {
      agentId: resolved.agentId,
      env,
      path: resolveOpenClawAgentSqlitePath({ ...resolved, env }),
    };
    const assertCurrent = () => {
      options?.assertCurrent?.();
      this.assertTargetCurrent(target, resolved);
    };
    if (resolved.incognito) {
      const { actor, authority } = resolved.incognito;
      if (actor.agentId !== resolved.agentId || actor.path !== databaseOptions.path) {
        throw new Error("Board target differs from its captured incognito actor");
      }
      const currentAuthority: IncognitoSessionAuthority = {
        assertCurrent() {
          assertCurrent();
          authority.assertCurrent();
          actor.assertCurrent();
        },
        authorize: (stage, facts) => authority.authorize?.(stage, facts),
      };
      currentAuthority.assertCurrent();
      const execute = async (writeAuthority: IncognitoSessionAuthority) => {
        try {
          const committed = await actorWrite(actor, writeAuthority, resolved.sessionKey);
          sessionChanges.emitBatch(committed.changes);
          return committed.value;
        } catch (error) {
          // Disclosure can fail after the actor acknowledges COMMIT; invalidate without replay.
          sessionChanges.emit({ sessionKey: resolved.sessionKey, storePath: actor.path });
          throw restoreBoardError(error);
        }
      };
      return actor.sessions
        .withSharedState(async () => {
          if (!prepare) {
            return execute(currentAuthority);
          }
          const source = await actor.sessions.read(currentAuthority, {
            sessionKey: resolved.sessionKey,
          });
          if (!source.entry) {
            throw new BoardValidationError(
              "not_found",
              `board session not found: ${resolved.sessionKey}`,
            );
          }
          await prepare();
          source.claim.assertCurrent();
          const expected = source.entry;
          const writeAuthority: IncognitoSessionAuthority = {
            ...currentAuthority,
            authorize(stage, facts) {
              if (
                facts.sharing?.entry?.sessionId !== expected.sessionId ||
                facts.sharing.entry.lifecycleRevision !== expected.lifecycleRevision
              ) {
                throw new BoardValidationError("invalid_operation", "board session changed; retry");
              }
              return currentAuthority.authorize?.(stage, facts);
            },
          };
          return execute(writeAuthority);
        })
        .then((result) => {
          currentAuthority.assertCurrent();
          actor.assertReadable();
          return result;
        });
    }
    const assertOpenCurrent = () => {
      assertCurrent();
      this.requireExistingSession({ ...resolved, path: databaseOptions.path }, env);
    };
    assertOpenCurrent();
    return runOpenClawAgentWriteAdmission(
      databaseOptions,
      () =>
        withOpenClawAgentDatabaseAsync(
          databaseOptions,
          async (database) => {
            if (prepare) {
              await prepare();
            }
            assertCurrent();
            if (prepare && getOpenClawAgentDatabaseIfOpen(databaseOptions) !== database) {
              throw new BoardValidationError(
                "invalid_operation",
                "board database closed or changed; retry",
              );
            }
            // First-use schema work must precede the worker's strict native-open validation.
            ensureBoardSchema(database);
            if (typeof readOpenClawAgentDatabaseIdentity(database).identity === "symbol") {
              return runOpenClawAgentWriteTransaction(
                (current) => {
                  assertCurrent();
                  return native(current, resolved.sessionKey);
                },
                databaseOptions,
                { operationLabel },
              );
            }
            const publication = await openOpenClawAgentSqliteWorkerStore<BoardWriteOperations>(
              databaseOptions,
              database.db,
              {
                moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.boardStore),
                input: undefined,
              },
            );
            let outcome: Result<T, unknown>;
            try {
              const value = await publication.run(async (scope) => {
                let committed: BoardWriteOutcome<T>;
                try {
                  committed = await worker(scope, resolved.sessionKey);
                } catch (error) {
                  if (hasUnknownBoardWriteOutcome(error)) {
                    sessionChanges.emit({
                      sessionKey: resolved.sessionKey,
                      storePath: database.path,
                    });
                  }
                  throw error;
                }
                // Committed invalidation belongs to the original store, even after caller revocation.
                sessionChanges.emitBatch(committed.changes);
                return committed.value;
              }, assertCurrent);
              outcome = { ok: true, value };
            } catch (error) {
              outcome = { ok: false, error: restoreBoardError(error) };
            }
            let cleanup: Result<void, unknown>;
            try {
              await publication.close();
              cleanup = { ok: true, value: undefined };
            } catch (error) {
              cleanup = { ok: false, error };
            }
            if (!outcome.ok) {
              if (!cleanup.ok) {
                throw new AggregateError(
                  [outcome.error, cleanup.error],
                  "Board publication and cleanup failed",
                  { cause: outcome.error },
                );
              }
              throw outcome.error;
            }
            if (!cleanup.ok) {
              try {
                log.warn(
                  `Board publication completed before cleanup failed: ${formatErrorMessage(cleanup.error)}`,
                );
              } catch {
                // The resource owner retains cleanup; diagnostics cannot reverse a committed result.
              }
            }
            return outcome.value;
          },
          assertOpenCurrent,
        ),
      true,
    );
  }

  async getSnapshot(target: BoardSessionTarget): Promise<BoardSnapshot> {
    return this.useSnapshot(target, (snapshot) => snapshot);
  }

  async getSnapshotWithHtmlViewMetadata(
    target: BoardSessionTarget,
  ): Promise<BoardSnapshotWithHtmlViewMetadata> {
    return this.consumeSnapshotWithHtmlViewMetadata(target, (snapshot) => snapshot);
  }

  private async consumeRead<Value, T>(
    target: BoardSessionTarget,
    native: (
      database: Pick<OpenClawAgentDatabase, "db" | "path">,
      sessionKey: string,
    ) => Value | undefined,
    worker: (
      scope: Pick<SqliteWorkerStore<BoardReadOperations>, "execute">,
      sessionKey: string,
    ) => Promise<Value | undefined>,
    actorRead: (
      actor: IncognitoAgentDatabaseExecution,
      authority: IncognitoSessionAuthority,
      sessionKey: string,
    ) => Promise<Value | undefined>,
    consume: (value: Value | undefined, sessionKey: string) => T,
  ): Promise<Awaited<T>> {
    const capturedTarget = { ...target };
    const resolved = this.options.resolveSession(capturedTarget);
    const env = cloneEnvWithPlatformSemantics(this.options.env ?? process.env);
    env.OPENCLAW_STATE_DIR = resolveStateDir(env);
    const captured = {
      agentId: resolved.agentId,
      sessionKey: resolved.sessionKey,
      env,
      path: resolveOpenClawAgentSqlitePath({ ...resolved, env }),
    };
    // Consumer continuations retain caller authority, not this read turn's reentrant grant.
    const runInCallerContext = AsyncLocalStorage.snapshot();
    const accept = (value: Value | undefined) => {
      this.assertTargetCurrent(capturedTarget, resolved);
      const result = runInCallerContext(consume, value, captured.sessionKey);
      // Cleanup may await the worker after consumption has already rejected.
      if (isPromise(result)) {
        void result.catch(() => {});
      }
      return { value: result };
    };
    if (resolved.incognito) {
      const { actor, authority } = resolved.incognito;
      if (actor.agentId !== captured.agentId || actor.path !== captured.path) {
        throw new Error("Board target differs from its captured incognito actor");
      }
      const currentAuthority: IncognitoSessionAuthority = {
        assertCurrent: () => {
          this.assertTargetCurrent(capturedTarget, resolved);
          authority.assertCurrent();
          actor.assertCurrent();
        },
        authorize: (stage, facts) => authority.authorize?.(stage, facts),
      };
      const result = await actor.sessions.withSharedState(async () => {
        // Retain the composition for dependent writes, outside the reader's FIFO grant.
        const runInRetainedContext = AsyncLocalStorage.snapshot();
        try {
          const value = await actorRead(actor, currentAuthority, captured.sessionKey);
          currentAuthority.assertCurrent();
          actor.assertReadable();
          return await runInRetainedContext(consume, value, captured.sessionKey);
        } catch (error) {
          throw restoreBoardError(error);
        }
      });
      currentAuthority.assertCurrent();
      actor.assertReadable();
      return result;
    }
    if (isIncognitoOpenClawAgentSqlitePath(captured.path, captured)) {
      // The excluded process-held owner cannot be reopened by a durable worker.
      const result = await runOpenClawAgentWorkerWrite(captured, async () => {
        this.assertTargetCurrent(capturedTarget, resolved);
        const read = withOpenClawAgentDatabaseReadOnly(
          (database) => native(database, captured.sessionKey),
          captured,
        );
        return accept(read.found ? read.value : undefined);
      });
      return await result.value;
    }
    const identity = readDatabasePathIdentitySync(captured.path);
    if (!identity.key.startsWith("file:")) {
      const result = await runOpenClawAgentWorkerWrite(captured, async () => accept(undefined));
      return await result.value;
    }
    const execution = captureOpenClawAgentDatabaseExecution(captured, {
      expectedIdentity: {
        kind: "file",
        physicalIdentity: identity.key.slice("file:".length),
        nativeLocation: identity.canonicalPath,
        birthtime: identity.birthtime,
      },
    });
    const assertCurrent = () => {
      execution.assertCurrent();
      this.assertTargetCurrent(capturedTarget, resolved);
    };
    let publication: OpenClawAgentSqliteWorkerStore<BoardReadOperations> | undefined;
    let result: { value: T } | undefined;
    const failures: unknown[] = [];
    try {
      // Reserve before yielding; the publication installs the non-reentrant worker grant.
      result = await runOpenClawAgentWriteAdmission(
        captured,
        async () => {
          publication = await openOpenClawAgentSqliteWorkerStore<BoardReadOperations>(
            captured,
            { execution },
            {
              moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.boardStore),
              input: "read",
            },
          );
          return publication.run(async (scope) => {
            const value = await worker(scope, captured.sessionKey);
            assertCurrent();
            return accept(value);
          }, assertCurrent);
        },
        true,
      );
    } catch (error) {
      failures.push(restoreBoardError(error));
    } finally {
      for (const close of [() => publication?.close(), () => execution.release()]) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    throwSqliteLifecycleErrors(failures, "Board read and cleanup failed");
    // External consumer work must not hold the database's FIFO lane.
    return await result!.value;
  }

  async useSnapshot<T>(
    target: BoardSessionTarget,
    consume: (snapshot: BoardSnapshot) => T,
  ): Promise<Awaited<T>> {
    return this.consumeSnapshotWithHtmlViewMetadata(target, ({ snapshot }) => consume(snapshot));
  }

  async useWidgetDocument<T>(
    target: BoardSessionTarget,
    name: string,
    consume: (document: BoardWidgetDocument | undefined) => T,
  ): Promise<Awaited<T>> {
    return this.consumeWidgetDocument(target, name, consume);
  }

  private consumeSnapshotWithHtmlViewMetadata<T>(
    target: BoardSessionTarget,
    consume: (snapshot: BoardSnapshotWithHtmlViewMetadata) => T,
  ): Promise<Awaited<T>> {
    return this.consumeRead(
      target,
      readBoardSnapshotWithHtmlViewMetadata,
      (scope, sessionKey) => scope.execute({ type: "boards.readSnapshot", input: { sessionKey } }),
      (actor, authority, sessionKey) =>
        actor.sessions.sideData(authority, {
          type: "session.boards.readSnapshot",
          input: { sessionKey },
        }),
      (stored, sessionKey) =>
        consume({
          snapshot: cloneBoardSnapshot(stored?.snapshot ?? emptyBoardSnapshot(sessionKey)),
          htmlViewMetadata: stored?.htmlViewMetadata ?? new Map(),
        }),
    );
  }

  async applyOps(
    target: BoardSessionTarget,
    ops: readonly BoardOp[],
    options?: BoardWriteOptions,
  ): Promise<BoardSnapshot> {
    if (ops.length === 0) {
      return this.getSnapshot(target);
    }
    const capturedOps = structuredClone(ops);
    return this.write(
      target,
      options,
      "board.apply-ops",
      (database, sessionKey) => applyBoardOpsToDatabase(database, sessionKey, capturedOps),
      (scope, sessionKey) =>
        scope.execute({ type: "boards.applyOps", input: { sessionKey, ops: capturedOps } }),
      (actor, authority, sessionKey) =>
        actor.sessions.sideData(authority, {
          type: "session.boards.applyOps",
          input: { sessionKey, ops: capturedOps },
        }),
    );
  }

  async putWidget(params: BoardWidgetMaterializedPutParams, options?: BoardWidgetWriteOptions) {
    const capturedParams = structuredClone(params);
    const viewGeneration = randomBytes(16).toString("hex");
    let preparedParams = capturedParams;
    const content = capturedParams.content;
    const resolveInteraction = options?.resolveMcpAppInteraction;
    const prepare =
      content.kind === "mcp-app" && content.interactive && resolveInteraction
        ? async () => {
            if (!(await resolveInteraction())) {
              preparedParams = {
                ...capturedParams,
                content: { ...content, interactive: false },
                declared: undefined,
              };
            }
          }
        : undefined;
    return this.write(
      params,
      options,
      "board.put-widget",
      (database, sessionKey) =>
        putBoardWidgetInDatabase(
          database,
          sessionKey,
          normalizeBoardWidgetPutParams(preparedParams, sessionKey),
          viewGeneration,
        ),
      (scope, sessionKey) =>
        scope.execute({
          type: "boards.putWidget",
          input: { sessionKey, params: preparedParams, viewGeneration },
        }),
      (actor, authority, sessionKey) =>
        actor.sessions.sideData(authority, {
          type: "session.boards.putWidget",
          input: { sessionKey, params: preparedParams, viewGeneration },
        }),
      prepare,
    );
  }

  async grant(
    target: BoardSessionTarget,
    name: string,
    decision: "granted" | "rejected",
    revision: number,
    instanceId?: string,
    options?: BoardWriteOptions,
  ): Promise<BoardSnapshot> {
    return this.write(
      target,
      options,
      "board.grant-widget",
      (database, sessionKey) =>
        grantBoardWidgetInDatabase(database, sessionKey, name, decision, revision, instanceId),
      (scope, sessionKey) =>
        scope.execute({
          type: "boards.grant",
          input: { sessionKey, name, decision, revision, instanceId },
        }),
      (actor, authority, sessionKey) =>
        actor.sessions.sideData(authority, {
          type: "session.boards.grant",
          input: { sessionKey, name, decision, revision, instanceId },
        }),
    );
  }

  private consumeWidgetDocument<T>(
    target: BoardSessionTarget,
    name: string,
    consume: (document: BoardWidgetDocument | undefined) => T,
    contentKind?: "mcp-app",
  ): Promise<Awaited<T>> {
    return this.consumeRead(
      target,
      (database, sessionKey) => readBoardWidgetDocument(database, sessionKey, name, contentKind),
      (scope, sessionKey) =>
        scope.execute({
          type: "boards.readWidgetDocument",
          input: { sessionKey, name, contentKind },
        }),
      (actor, authority, sessionKey) =>
        actor.sessions.sideData(authority, {
          type: "session.boards.readWidgetDocument",
          input: { sessionKey, name, contentKind },
        }),
      consume,
    );
  }

  async readWidgetMcpApp(
    target: BoardSessionTarget,
    name: string,
  ): Promise<BoardWidgetMcpAppDocument | undefined> {
    return this.consumeWidgetDocument(
      target,
      name,
      (document) => (document && "descriptor" in document ? document : undefined),
      "mcp-app",
    );
  }
}
