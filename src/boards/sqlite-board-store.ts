import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { Result } from "@openclaw/normalization-core/result";
import type {
  BoardOp,
  BoardSnapshot,
  BoardWidgetMaterializedPutParams,
} from "../../packages/gateway-protocol/src/index.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  readErrorName,
} from "../infra/errors.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { isSqliteWorkerError, type SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
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
import { openOpenClawAgentSqliteWorkerStore } from "../state/openclaw-agent-worker-store.js";
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
import { rowToBoardWidgetDocument } from "./sqlite-board-codec.js";
import type { BoardWriteOperations, BoardWriteOutcome } from "./sqlite-board-operations.js";
import {
  ensureBoardSchema,
  hasBoardSession,
  readBoardSnapshotWithHtmlViewMetadata,
  readBoardWidgetRow,
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
  };
  env?: NodeJS.ProcessEnv;
};

type ResolvedBoardSession = ReturnType<SqliteBoardStoreOptions["resolveSession"]>;

function emptyBoardSnapshot(sessionKey: string): BoardSnapshot {
  return { sessionKey, revision: 0, tabs: [], widgets: [] };
}

export class SqliteBoardStore implements BoardStore {
  constructor(private readonly options: SqliteBoardStoreOptions) {}

  private resolve(target: BoardSessionTarget): ResolvedBoardSession {
    return this.options.resolveSession(target);
  }

  private assertTargetCurrent(target: BoardSessionTarget, resolved: ResolvedBoardSession): void {
    const current = this.resolve(target);
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
    prepare?: () => Promise<void>,
  ): Promise<T> {
    const resolved = this.resolve(target);
    const env = cloneEnvWithPlatformSemantics(this.options.env ?? process.env);
    env.OPENCLAW_STATE_DIR = resolveStateDir(env);
    const databaseOptions = {
      ...resolved,
      env,
      path: resolveOpenClawAgentSqlitePath({ ...resolved, env }),
    };
    const assertCurrent = () => {
      options?.assertCurrent?.();
      this.assertTargetCurrent(target, resolved);
    };
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
    return this.readSnapshotWithHtmlViewMetadata(this.resolve(target)).snapshot;
  }

  async getSnapshotWithHtmlViewMetadata(
    target: BoardSessionTarget,
  ): Promise<BoardSnapshotWithHtmlViewMetadata> {
    return this.readSnapshotWithHtmlViewMetadata(this.resolve(target));
  }

  private async consumeRead<T>(
    target: BoardSessionTarget,
    consume: (resolved: ResolvedBoardSession, env: NodeJS.ProcessEnv) => T,
  ): Promise<Awaited<T>> {
    const resolved = this.resolve(target);
    const env = cloneEnvWithPlatformSemantics(this.options.env ?? process.env);
    env.OPENCLAW_STATE_DIR = resolveStateDir(env);
    const captured = {
      ...resolved,
      env,
      path: resolveOpenClawAgentSqlitePath({ ...resolved, env }),
    };
    // Consumer continuations retain caller authority, not this read turn's reentrant grant.
    const runInCallerContext = AsyncLocalStorage.snapshot();
    // The reservation also queues writes started by consume instead of lending it reentrancy.
    const result = await runOpenClawAgentWorkerWrite(captured, async () => {
      this.assertTargetCurrent(target, resolved);
      return { value: runInCallerContext(consume, captured, env) };
    });
    // External consumer work must not hold the database's FIFO lane.
    return await result.value;
  }

  async useSnapshot<T>(
    target: BoardSessionTarget,
    consume: (snapshot: BoardSnapshot) => T,
  ): Promise<Awaited<T>> {
    return this.consumeRead(target, (resolved, env) =>
      consume(this.readSnapshotWithHtmlViewMetadata(resolved, env).snapshot),
    );
  }

  async useWidgetDocument<T>(
    target: BoardSessionTarget,
    name: string,
    consume: (document: BoardWidgetDocument | undefined) => T,
  ): Promise<Awaited<T>> {
    return this.consumeRead(target, (resolved, env) =>
      consume(this.readWidgetDocument(resolved, name, undefined, env)),
    );
  }

  private readSnapshotWithHtmlViewMetadata(
    resolved: ResolvedBoardSession,
    env = this.options.env,
  ): BoardSnapshotWithHtmlViewMetadata {
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => readBoardSnapshotWithHtmlViewMetadata(database, resolved.sessionKey),
      {
        agentId: resolved.agentId,
        ...(resolved.path ? { path: resolved.path } : {}),
        env,
      },
    );
    const stored = result.found ? result.value : undefined;
    return {
      snapshot: cloneBoardSnapshot(stored?.snapshot ?? emptyBoardSnapshot(resolved.sessionKey)),
      htmlViewMetadata: stored?.htmlViewMetadata ?? new Map(),
    };
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
    );
  }

  private readWidgetDocument(
    resolved: ResolvedBoardSession,
    name: string,
    contentKind?: "mcp-app",
    env = this.options.env,
  ): BoardWidgetDocument | undefined {
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => readBoardWidgetRow(database, resolved.sessionKey, name),
      {
        agentId: resolved.agentId,
        ...(resolved.path ? { path: resolved.path } : {}),
        env,
      },
    );
    const row = result.found ? result.value : undefined;
    return row && (!contentKind || row.content_kind === contentKind)
      ? rowToBoardWidgetDocument(row)
      : undefined;
  }

  async readWidgetMcpApp(
    target: BoardSessionTarget,
    name: string,
  ): Promise<BoardWidgetMcpAppDocument | undefined> {
    const document = this.readWidgetDocument(this.resolve(target), name, "mcp-app");
    return document && "descriptor" in document ? document : undefined;
  }
}
