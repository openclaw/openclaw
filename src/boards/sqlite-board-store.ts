import { randomBytes } from "node:crypto";
import type {
  BoardOp,
  BoardSnapshot,
  BoardWidgetMaterializedPutParams,
} from "../../packages/gateway-protocol/src/index.js";
import { resolveStateDir } from "../config/state-dir.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
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
import {
  ensureBoardSchema,
  hasBoardSession,
  readBoardSnapshotWithHtmlViewMetadata,
  readBoardWidgetRow,
  applyBoardOpsToDatabase,
  putBoardWidgetInDatabase,
  grantBoardWidgetInDatabase,
} from "./sqlite-board-store.kernel.js";

type SqliteBoardStoreOptions = {
  resolveSession: (target: BoardSessionTarget) => {
    agentId: string;
    path?: string;
    sessionKey: string;
  };
  env?: NodeJS.ProcessEnv;
};

function emptyBoardSnapshot(sessionKey: string): BoardSnapshot {
  return { sessionKey, revision: 0, tabs: [], widgets: [] };
}

export class SqliteBoardStore implements BoardStore {
  constructor(private readonly options: SqliteBoardStoreOptions) {}

  private resolve(target: BoardSessionTarget): {
    agentId: string;
    path?: string;
    sessionKey: string;
  } {
    return this.options.resolveSession(target);
  }

  private requireExistingSession(
    resolved: {
      agentId: string;
      path?: string;
      sessionKey: string;
    },
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
    operation: (database: OpenClawAgentDatabase, sessionKey: string) => T,
    prepare?: () => Promise<void>,
  ): Promise<T> {
    const resolved = this.resolve(target);
    const env = { ...(this.options.env ?? process.env) };
    env.OPENCLAW_STATE_DIR = resolveStateDir(env);
    const databaseOptions = {
      ...resolved,
      env,
      path: resolveOpenClawAgentSqlitePath({ ...resolved, env }),
    };
    const assertCurrent = () => {
      options?.assertCurrent?.();
      const current = this.resolve(target);
      if (
        current.agentId !== resolved.agentId ||
        current.path !== resolved.path ||
        current.sessionKey !== resolved.sessionKey
      ) {
        throw new BoardValidationError("invalid_operation", "board session changed; retry");
      }
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
            // First-use schema work shares the data write's admission and current authority.
            assertCurrent();
            if (prepare && getOpenClawAgentDatabaseIfOpen(databaseOptions) !== database) {
              throw new BoardValidationError(
                "invalid_operation",
                "board database closed or changed; retry",
              );
            }
            ensureBoardSchema(database);
            return runOpenClawAgentWriteTransaction(
              (transactionDatabase) => {
                assertCurrent();
                return operation(transactionDatabase, resolved.sessionKey);
              },
              databaseOptions,
              { operationLabel },
            );
          },
          assertOpenCurrent,
        ),
      true,
    );
  }

  async getSnapshot(target: BoardSessionTarget): Promise<BoardSnapshot> {
    return this.readSnapshotWithHtmlViewMetadata(target).snapshot;
  }

  async getSnapshotWithHtmlViewMetadata(
    target: BoardSessionTarget,
  ): Promise<BoardSnapshotWithHtmlViewMetadata> {
    return this.readSnapshotWithHtmlViewMetadata(target);
  }

  async useSnapshot<T>(
    target: BoardSessionTarget,
    consume: (snapshot: BoardSnapshot) => T,
  ): Promise<Awaited<T>> {
    return await consume(this.readSnapshotWithHtmlViewMetadata(target).snapshot);
  }

  async useWidgetDocument<T>(
    target: BoardSessionTarget,
    name: string,
    consume: (document: BoardWidgetDocument | undefined) => T,
  ): Promise<Awaited<T>> {
    return await consume(this.readWidgetDocument(target, name));
  }

  private readSnapshotWithHtmlViewMetadata(
    target: BoardSessionTarget,
  ): BoardSnapshotWithHtmlViewMetadata {
    const resolved = this.resolve(target);
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => readBoardSnapshotWithHtmlViewMetadata(database, resolved.sessionKey),
      {
        agentId: resolved.agentId,
        ...(resolved.path ? { path: resolved.path } : {}),
        env: this.options.env,
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
    return this.write(target, options, "board.apply-ops", (database, sessionKey) =>
      applyBoardOpsToDatabase(database, sessionKey, ops),
    );
  }

  async putWidget(params: BoardWidgetMaterializedPutParams, options?: BoardWidgetWriteOptions) {
    const viewGeneration = randomBytes(16).toString("hex");
    let preparedParams = params;
    const content = params.content;
    const resolveInteraction = options?.resolveMcpAppInteraction;
    const prepare =
      content.kind === "mcp-app" && content.interactive && resolveInteraction
        ? async () => {
            if (!(await resolveInteraction())) {
              preparedParams = {
                ...params,
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
    return this.write(target, options, "board.grant-widget", (database, sessionKey) =>
      grantBoardWidgetInDatabase(database, sessionKey, name, decision, revision, instanceId),
    );
  }

  private readWidgetDocument(
    target: BoardSessionTarget,
    name: string,
    contentKind?: "mcp-app",
  ): BoardWidgetDocument | undefined {
    const resolved = this.resolve(target);
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => readBoardWidgetRow(database, resolved.sessionKey, name),
      {
        agentId: resolved.agentId,
        ...(resolved.path ? { path: resolved.path } : {}),
        env: this.options.env,
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
    const document = this.readWidgetDocument(target, name, "mcp-app");
    return document && "descriptor" in document ? document : undefined;
  }
}
