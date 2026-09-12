import { randomBytes } from "node:crypto";
import type {
  BoardOp,
  BoardSnapshot,
  BoardWidgetMaterializedPutParams,
} from "../../packages/gateway-protocol/src/index.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { BoardValidationError } from "./board-layout.js";
import {
  cloneBoardSnapshot,
  normalizeBoardWidgetPutParams,
  type BoardSessionTarget,
  type BoardStore,
  type BoardWriteOptions,
  type BoardWidgetDocument,
  type BoardSnapshotWithHtmlViewMetadata,
  type BoardWidgetMcpAppDocument,
} from "./board-store.js";
import { rowToBoardWidgetDocument } from "./sqlite-board-codec.js";
import {
  ensureBoardSchema,
  hasBoardSession,
  readBoardSessionKeys,
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

export async function listBoardSessionKeysReadOnly(params: {
  agentId: string;
  path: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ReadonlySet<string>> {
  const result = withOpenClawAgentDatabaseReadOnly(readBoardSessionKeys, params);
  return new Set(result.found ? result.value : []);
}

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

  private requireExistingSession(resolved: {
    agentId: string;
    path?: string;
    sessionKey: string;
  }): void {
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => hasBoardSession(database, resolved.sessionKey),
      {
        agentId: resolved.agentId,
        ...(resolved.path ? { path: resolved.path } : {}),
        env: this.options.env,
      },
    );
    if (!result.found || !result.value) {
      throw new BoardValidationError(
        "not_found",
        `board session not found: ${resolved.sessionKey}`,
      );
    }
  }

  private prepareWrite(target: BoardSessionTarget): {
    database: OpenClawAgentDatabase;
    resolved: { agentId: string; path?: string; sessionKey: string };
  } {
    const resolved = this.resolve(target);
    this.requireExistingSession(resolved);
    const database = openOpenClawAgentDatabase({
      agentId: resolved.agentId,
      ...(resolved.path ? { path: resolved.path } : {}),
      env: this.options.env,
    });
    ensureBoardSchema(database);
    return { database, resolved };
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
    options?.assertCurrent?.();
    const { database, resolved } = this.prepareWrite(target);
    return runOpenClawAgentWriteTransaction(
      (transactionDatabase) => {
        options?.assertCurrent?.();
        return applyBoardOpsToDatabase(transactionDatabase, resolved.sessionKey, ops);
      },
      { agentId: resolved.agentId, path: database.path, env: this.options.env },
      { operationLabel: "board.apply-ops" },
    );
  }

  async putWidget(params: BoardWidgetMaterializedPutParams, options?: BoardWriteOptions) {
    options?.assertCurrent?.();
    const { database, resolved } = this.prepareWrite(params);
    const canonicalInput = normalizeBoardWidgetPutParams(params, resolved.sessionKey);
    const viewGeneration = randomBytes(16).toString("hex");
    return runOpenClawAgentWriteTransaction(
      (transactionDatabase) => {
        options?.assertCurrent?.();
        return putBoardWidgetInDatabase(
          transactionDatabase,
          resolved.sessionKey,
          canonicalInput,
          viewGeneration,
        );
      },
      { agentId: resolved.agentId, path: database.path, env: this.options.env },
      { operationLabel: "board.put-widget" },
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
    options?.assertCurrent?.();
    const { database, resolved } = this.prepareWrite(target);
    return runOpenClawAgentWriteTransaction(
      (transactionDatabase) => {
        options?.assertCurrent?.();
        return grantBoardWidgetInDatabase(
          transactionDatabase,
          resolved.sessionKey,
          name,
          decision,
          revision,
          instanceId,
        );
      },
      { agentId: resolved.agentId, path: database.path, env: this.options.env },
      { operationLabel: "board.grant-widget" },
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
