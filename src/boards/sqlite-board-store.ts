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
import { captureSessionEntryNativeMutationWitness } from "../config/sessions/session-entry-read-ordered.js";
import type { IncognitoSessionActor } from "../config/sessions/session-incognito-actor.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import { releaseSessionSourceAuthorities } from "../config/sessions/session-source-authority.js";
import { targetDiscoveryLane } from "../config/sessions/session-transcript-worker-resources.js";
import {
  withSessionHistoryWorkerDatabase,
  type SessionHistoryWorkerDatabase,
} from "../config/sessions/session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import { resolveStateDir } from "../config/state-dir.js";
import { collectErrorGraphCandidates, extractErrorCode, readErrorName } from "../infra/errors.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { isSqliteWorkerError, type SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabaseFileIdentity,
} from "../infra/sqlite-worker-identity.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { IncognitoSessionMissingError } from "../state/incognito-session-error.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseAsync,
  withOpenClawAgentDatabaseRuntime,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { openOpenClawAgentSqliteWorkerStore } from "../state/openclaw-agent-worker-store.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../state/openclaw-agent-write-admission.js";
import { BoardValidationError } from "./board-layout.js";
import {
  normalizeBoardWidgetPutParams,
  type BoardSessionTarget,
  type BoardStore,
  type BoardWriteOptions,
  type BoardWidgetWriteOptions,
  type BoardWidgetDocument,
  type BoardSnapshotWithHtmlViewMetadata,
  type BoardWidgetMcpAppDocument,
} from "./board-store.js";
import {
  prepareBoardSourceAuthority,
  reportBoardCleanupFailure,
} from "./sqlite-board-authority.js";
import type { BoardWriteOperations, BoardWriteOutcome } from "./sqlite-board-operations.js";
import {
  ensureBoardSchema,
  hasBoardSession,
  readBoardSnapshotWithHtmlViewMetadata,
  readBoardWidgetDocument,
  applyBoardOpsToDatabase,
  putBoardWidgetInDatabase,
  grantBoardWidgetInDatabase,
  type BoardSessionIdentity,
} from "./sqlite-board-store.kernel.js";
import type { BoardWorkerInput } from "./sqlite-board-store.worker.js";

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
    incognito?: { actor: IncognitoSessionActor; authority: IncognitoSessionAuthority };
    absent?: { assertCurrent(): void };
  };
  env?: NodeJS.ProcessEnv;
};

type ResolvedBoardSession = ReturnType<SqliteBoardStoreOptions["resolveSession"]>;

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
      actor: IncognitoSessionActor,
      authority: IncognitoSessionAuthority,
      sessionKey: string,
    ) => Promise<BoardWriteOutcome<T>>,
    prepare?: () => Promise<void>,
  ): Promise<T> {
    const resolved = this.options.resolveSession(target);
    if (resolved.absent) {
      options?.assertCurrent?.();
      this.assertTargetCurrent(target, resolved);
      resolved.absent.assertCurrent();
      throw new IncognitoSessionMissingError();
    }
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
    const incognito = isIncognitoOpenClawAgentSqlitePath(databaseOptions.path, databaseOptions);
    const assertOpenCurrent = () => {
      assertCurrent();
      if (incognito) {
        this.requireExistingSession({ ...resolved, path: databaseOptions.path }, env);
      }
    };
    assertOpenCurrent();
    return runOpenClawAgentWriteAdmission(
      databaseOptions,
      async (identity, assertDatabaseCurrent) => {
        let expectedSession: BoardSessionIdentity | undefined;
        if (!incognito) {
          const source = await withSessionHistoryWorkerDatabase(
            databaseOptions,
            (reader) =>
              reader.readExactEntries({
                env,
                sessionKeys: [resolved.sessionKey],
                projection: "exact",
                snapshotFields: [],
                expectedIdentity: identity,
              }),
            targetDiscoveryLane,
          );
          assertDatabaseCurrent();
          assertOpenCurrent();
          const entry = source.entries[0]?.entry;
          if (!entry) {
            throw new BoardValidationError(
              "not_found",
              `board session not found: ${resolved.sessionKey}`,
            );
          }
          expectedSession = {
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
          };
        }
        const authority = await prepareBoardSourceAuthority(options?.assertCurrent, identity);
        const nativeSource = incognito || authority.nativeSource;
        const assertPreparedCurrent = () => {
          assertDatabaseCurrent();
          this.assertTargetCurrent(target, resolved);
          if (nativeSource) {
            assertOpenCurrent();
          } else {
            authority.assertCurrent();
          }
        };
        const withDatabase = nativeSource
          ? withOpenClawAgentDatabaseAsync
          : withOpenClawAgentDatabaseRuntime;
        return withDatabase(
          databaseOptions,
          async (database) => {
            if (prepare) {
              await prepare();
            }
            assertPreparedCurrent();
            if (prepare && getOpenClawAgentDatabaseIfOpen(databaseOptions) !== database) {
              throw new BoardValidationError(
                "invalid_operation",
                "board database closed or changed; retry",
              );
            }
            if (
              nativeSource ||
              typeof readOpenClawAgentDatabaseIdentity(database).identity === "symbol"
            ) {
              // Released opaque/cross-store guards keep synchronous authority and mutation together.
              ensureBoardSchema(database);
              return runOpenClawAgentWriteTransaction(
                (current) => {
                  assertPreparedCurrent();
                  if (
                    expectedSession &&
                    !hasBoardSession(current, resolved.sessionKey, expectedSession)
                  ) {
                    throw new BoardValidationError(
                      "invalid_operation",
                      "board session changed; retry",
                    );
                  }
                  const value = native(current, resolved.sessionKey);
                  assertPreparedCurrent();
                  return value;
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
                input: (expectedSession
                  ? {
                      agentId: databaseOptions.agentId,
                      sessionKey: resolved.sessionKey,
                      expectedSession,
                      sources: authority.checks.map(({ predicate }) => predicate),
                    }
                  : undefined) satisfies BoardWorkerInput,
                assertAdmission: authority.assertAdmission,
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
              }, assertPreparedCurrent);
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
              reportBoardCleanupFailure(cleanup.error);
            }
            return outcome.value;
          },
          assertPreparedCurrent,
        ).then(
          async (value) => {
            try {
              await releaseSessionSourceAuthorities([authority]);
            } catch (error) {
              reportBoardCleanupFailure(error);
            }
            return value;
          },
          async (error: unknown) => {
            await releaseSessionSourceAuthorities([authority], [error]);
            throw error;
          },
        );
      },
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
      reader: SessionHistoryWorkerDatabase,
      sessionKey: string,
      env: NodeJS.ProcessEnv,
      expectedIdentity: DatabaseFileIdentity,
    ) => Promise<Value | undefined>,
    actorRead: (
      actor: IncognitoSessionActor,
      authority: IncognitoSessionAuthority,
      sessionKey: string,
    ) => Promise<Value | undefined>,
    consume: (value: Value | undefined, sessionKey: string) => T,
  ): Promise<Awaited<T>> {
    const capturedTarget = { ...target };
    const resolved = this.options.resolveSession(capturedTarget);
    if (resolved.absent) {
      this.assertTargetCurrent(capturedTarget, resolved);
      resolved.absent.assertCurrent();
      const result = await consume(undefined, resolved.sessionKey);
      this.assertTargetCurrent(capturedTarget, resolved);
      resolved.absent.assertCurrent();
      return result;
    }
    const env = captureSessionTranscriptStorageEnvironment(this.options.env ?? process.env);
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
    // FIFO-held reads and their failure cleanup use the writer-safe discovery lane.
    const result = await withSessionHistoryWorkerDatabase(
      { ...captured, path: identity.canonicalPath, requestedPaths: [captured.path] },
      (reader) =>
        runOpenClawAgentWriteAdmission(
          captured,
          async () => {
            this.assertTargetCurrent(capturedTarget, resolved);
            const assertNativeCurrent = captureSessionEntryNativeMutationWitness([captured]);
            const value = await worker(reader, captured.sessionKey, env, identity);
            assertExistingDatabaseIdentity(captured.path, identity.key, identity.birthtime);
            reader.assertCurrent();
            assertNativeCurrent();
            return accept(value);
          },
          true,
        ),
      targetDiscoveryLane,
    ).catch((error: unknown) => {
      throw restoreBoardError(error);
    });
    // External consumer work must not hold the database's FIFO lane.
    return await result.value;
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
      (reader, sessionKey, env, expectedIdentity) =>
        reader.readBoardSnapshot({ sessionKey, env, expectedIdentity }),
      (actor, authority, sessionKey) =>
        actor.sessions.sideData(authority, {
          type: "session.boards.readSnapshot",
          input: { sessionKey },
        }),
      (stored, sessionKey) =>
        consume(
          stored ?? {
            snapshot: { sessionKey, revision: 0, tabs: [], widgets: [] },
            htmlViewMetadata: new Map(),
          },
        ),
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
        scope.execute({
          type: "boards.applyOps",
          input: { sessionKey, ops: capturedOps },
        }),
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
      (reader, sessionKey, env, expectedIdentity) =>
        reader.readBoardWidgetDocument({ sessionKey, name, contentKind, env, expectedIdentity }),
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
