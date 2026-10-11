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
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
} from "../config/sessions/session-actor-storage-binding.js";
import { releaseSessionSourceAuthorities } from "../config/sessions/session-source-authority.js";
import { targetDiscoveryLane } from "../config/sessions/session-transcript-worker-resources.js";
import {
  withSessionHistoryWorkerDatabase,
  type SessionHistoryWorkerDatabase,
} from "../config/sessions/session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import { resolveStateDir } from "../config/state-dir.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabaseFileIdentity,
} from "../infra/sqlite-worker-identity.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { IncognitoSessionMissingError } from "../state/incognito-session-error.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseAsync,
  withOpenClawAgentDatabaseRuntime,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { openOpenClawAgentSqliteWorkerStore } from "../state/openclaw-agent-worker-store.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../state/openclaw-agent-write-admission.js";
import { BoardValidationError } from "./board-layout.js";
import { hasUnknownBoardWriteOutcome, restoreBoardError } from "./board-store-errors.js";
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
import { createSessionActorBoardStore } from "./session-actor-board-store.js";
import {
  prepareBoardSourceAuthority,
  reportBoardCleanupFailure,
} from "./sqlite-board-authority.js";
import type { BoardWriteOperations, BoardWriteOutcome } from "./sqlite-board-operations.js";
import {
  ensureBoardSchema,
  hasBoardSession,
  applyBoardOpsToDatabase,
  putBoardWidgetInDatabase,
  grantBoardWidgetInDatabase,
  type BoardSessionIdentity,
} from "./sqlite-board-store.kernel.js";
import type { BoardWorkerInput } from "./sqlite-board-store.worker.js";

type SqliteBoardStoreOptions = {
  resolveSession: (target: BoardSessionTarget) => {
    agentId: string;
    path?: string;
    sessionKey: string;
    /** Captured logical routing authority; worker grants must not repeat database discovery. */
    assertCurrent?: () => void;
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

  private useMemory<T>(
    target: BoardSessionTarget,
    consume: (store: BoardStore) => Promise<T>,
    missing?: () => T | Promise<T>,
  ): Promise<{ value: T }> | undefined {
    const resolved = this.options.resolveSession(target);
    const assertCurrent = () => this.assertTargetCurrent(target, resolved);
    const authority = { assertCurrent, authorize() {} };
    const scope = { ...resolved, storePath: resolved.path, env: this.options.env };
    const memory = captureSessionActorStorageOwner(scope, authority);
    if (!memory) return undefined;
    return withSessionActorStorage(
      scope,
      {
        authority: memory.authority,
        lifetime: { assertCurrent, assertReadable: assertCurrent },
      },
      async (binding) => ({ value: await consume(createSessionActorBoardStore(() => binding)) }),
    ).then(async (result) => {
      if (result) return result;
      assertCurrent();
      if (missing) return { value: await missing() };
      throw new BoardValidationError(
        "not_found",
        `board session not found: ${resolved.sessionKey}`,
      );
    });
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
    assertCurrent();
    return runOpenClawAgentWriteAdmission(
      databaseOptions,
      async (identity, assertDatabaseCurrent) => {
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
        assertCurrent();
        const entry = source.entries[0]?.entry;
        if (!entry) {
          throw new BoardValidationError(
            "not_found",
            `board session not found: ${resolved.sessionKey}`,
          );
        }
        const expectedSession: BoardSessionIdentity = {
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
        };
        const authority = await prepareBoardSourceAuthority(options?.assertCurrent, identity);
        const nativeSource = authority.nativeSource;
        const assertPreparedCurrent = () => {
          assertDatabaseCurrent();
          this.assertTargetCurrent(target, resolved);
          if (nativeSource) {
            assertCurrent();
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
            if (nativeSource) {
              // Released opaque/cross-store guards keep synchronous authority and mutation together.
              ensureBoardSchema(database);
              return runOpenClawAgentWriteTransaction(
                (current) => {
                  assertPreparedCurrent();
                  if (!hasBoardSession(current, resolved.sessionKey, expectedSession)) {
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
                input: {
                  agentId: databaseOptions.agentId,
                  sessionKey: resolved.sessionKey,
                  expectedSession,
                  sources: authority.checks.map(({ predicate }) => predicate),
                } satisfies BoardWorkerInput,
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
    const memory = this.useMemory(
      target,
      (store) => store.getSnapshotWithHtmlViewMetadata(target),
      () => ({
        snapshot: { sessionKey: target.sessionKey, revision: 0, tabs: [], widgets: [] },
        htmlViewMetadata: new Map(),
      }),
    );
    if (memory) return (await memory).value;
    return this.consumeSnapshotWithHtmlViewMetadata(target, (snapshot) => snapshot);
  }

  private async consumeRead<Value, T>(
    target: BoardSessionTarget,
    worker: (
      reader: SessionHistoryWorkerDatabase,
      sessionKey: string,
      env: NodeJS.ProcessEnv,
      expectedIdentity: DatabaseFileIdentity,
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
            const value = await worker(reader, captured.sessionKey, env, identity);
            assertExistingDatabaseIdentity(captured.path, identity.key, identity.birthtime);
            reader.assertCurrent();
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
    const memory = this.useMemory(
      target,
      (store) => store.useSnapshot(target, consume),
      async () => consume({ sessionKey: target.sessionKey, revision: 0, tabs: [], widgets: [] }),
    );
    if (memory) return (await memory).value;
    return this.consumeSnapshotWithHtmlViewMetadata(target, ({ snapshot }) => consume(snapshot));
  }

  async useWidgetDocument<T>(
    target: BoardSessionTarget,
    name: string,
    consume: (document: BoardWidgetDocument | undefined) => T,
  ): Promise<Awaited<T>> {
    const memory = this.useMemory(
      target,
      (store) => store.useWidgetDocument(target, name, consume),
      async () => consume(undefined),
    );
    if (memory) return (await memory).value;
    return this.consumeWidgetDocument(target, name, consume);
  }

  private consumeSnapshotWithHtmlViewMetadata<T>(
    target: BoardSessionTarget,
    consume: (snapshot: BoardSnapshotWithHtmlViewMetadata) => T,
  ): Promise<Awaited<T>> {
    return this.consumeRead(
      target,
      (reader, sessionKey, env, expectedIdentity) =>
        reader.readBoardSnapshot({ sessionKey, env, expectedIdentity }),
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
    const memory = this.useMemory(target, (store) => store.applyOps(target, capturedOps, options));
    if (memory) return (await memory).value;
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
    );
  }

  async putWidget(params: BoardWidgetMaterializedPutParams, options?: BoardWidgetWriteOptions) {
    let preparedParams = structuredClone(params);
    const memory = this.useMemory(params, (store) => store.putWidget(preparedParams, options));
    if (memory) return (await memory).value;
    const viewGeneration = randomBytes(16).toString("hex");
    const content = preparedParams.content;
    const resolveInteraction = options?.resolveMcpAppInteraction;
    const prepare =
      content.kind === "mcp-app" && content.interactive && resolveInteraction
        ? async () => {
            if (!(await resolveInteraction())) {
              preparedParams = {
                ...preparedParams,
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
    const memory = this.useMemory(target, (store) =>
      store.grant(target, name, decision, revision, instanceId, options),
    );
    if (memory) return (await memory).value;
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
      (reader, sessionKey, env, expectedIdentity) =>
        reader.readBoardWidgetDocument({ sessionKey, name, contentKind, env, expectedIdentity }),
      consume,
    );
  }

  async readWidgetMcpApp(
    target: BoardSessionTarget,
    name: string,
  ): Promise<BoardWidgetMcpAppDocument | undefined> {
    const memory = this.useMemory(
      target,
      (store) => store.readWidgetMcpApp(target, name),
      () => undefined,
    );
    if (memory) return (await memory).value;
    return this.consumeWidgetDocument(
      target,
      name,
      (document) => (document && "descriptor" in document ? document : undefined),
      "mcp-app",
    );
  }
}
