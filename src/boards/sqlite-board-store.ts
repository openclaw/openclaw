import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  BoardOp,
  BoardSnapshot,
  BoardWidgetMaterializedPutParams,
} from "../../packages/gateway-protocol/src/index.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "../infra/sqlite-transaction.js";
import { ensureOpenClawAgentBoardSchemaInTransaction } from "../state/openclaw-agent-board-schema.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { applyBoardOps, BoardValidationError, normalizeBoardLayout } from "./board-layout.js";
import {
  cloneBoardSnapshot,
  createBoardWidgetPutResult,
  createBoardGrantSnapshot,
  createBoardWidgetPutSnapshot,
  normalizeBoardWidgetPutParams,
  type BoardSessionTarget,
  type BoardStore,
  type BoardWriteOptions,
  type BoardWidgetDocument,
  type BoardSnapshotWithHtmlViewMetadata,
  type BoardWidgetHtmlViewMetadata,
  type BoardWidgetMcpAppDocument,
} from "./board-store.js";
import {
  BOARD_WIDGET_SNAPSHOT_COLUMNS,
  createBoardWidgetContentFields,
  parseDescriptor,
  parseManifest,
  parsePluginContent,
  resolveSqliteBoardWidgetPutParams,
  rowToBoardWidgetDocument,
  rowToTab,
  rowToHtmlViewMetadata,
  rowToWidget,
  serializeManifest,
  updateManifestHeightMode,
  type SelectedBoardTabRow,
  type SelectedBoardWidgetSnapshotRow,
} from "./sqlite-board-codec.js";

type BoardDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "board_tabs" | "board_widgets" | "session_nodes"
>;
type BoardDatabaseHandle = Pick<OpenClawAgentDatabase, "db" | "path">;

type StoredBoard = {
  snapshot: BoardSnapshot;
  tabRows: SelectedBoardTabRow[];
  widgetRows: SelectedBoardWidgetSnapshotRow[];
  htmlViewMetadata: ReadonlyMap<string, BoardWidgetHtmlViewMetadata>;
};

const ensuredBoardDatabases = new WeakSet<DatabaseSync>();
const presentBoardDatabases = new WeakSet<DatabaseSync>();

// Read-only connections cannot run the lazy DDL, and a pre-existing v13 DB has
// no board tables until the first write. Reads must treat that as "no boards",
// not "no such table".
function boardTablesPresent(database: Pick<OpenClawAgentDatabase, "db">): boolean {
  if (ensuredBoardDatabases.has(database.db) || presentBoardDatabases.has(database.db)) {
    return true;
  }
  const row = database.db // sqlite-allow-raw: catalog probe before Kysely table access.
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'board_widgets'")
    .get();
  if (!row) {
    return false;
  }
  presentBoardDatabases.add(database.db);
  return true;
}

export async function listBoardSessionKeysReadOnly(params: {
  agentId: string;
  path: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ReadonlySet<string>> {
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    if (!boardTablesPresent(database)) {
      return [];
    }
    const db = getNodeSqliteKysely<BoardDatabase>(database.db);
    // Every persisted widget belongs to a tab, so distinct tab owners are the
    // complete board inventory without reading widget payloads.
    return executeSqliteQuerySync(
      database.db,
      db.selectFrom("board_tabs").select("session_key").distinct(),
    ).rows.map((row) => row.session_key);
  }, params);
  return new Set(result.found ? result.value : []);
}

function ensureBoardSchema(database: OpenClawAgentDatabase): void {
  if (ensuredBoardDatabases.has(database.db)) {
    return;
  }
  if (database.db.isTransaction) {
    throw new Error("board schema must be ensured before the write transaction starts");
  }
  runSqliteImmediateTransactionSync(
    database.db,
    () => ensureOpenClawAgentBoardSchemaInTransaction(database.db),
    {
      databaseLabel: database.path,
      operationLabel: "board.ensure-schema",
    },
  );
  // Additive-surface rule: fold this into the next natural schema bump, then delete this lazy ensure.
  ensuredBoardDatabases.add(database.db);
  presentBoardDatabases.add(database.db);
}

type SqliteBoardStoreOptions = {
  resolveSession: (target: BoardSessionTarget) => {
    agentId: string;
    path?: string;
    sessionKey: string;
  };
  env?: NodeJS.ProcessEnv;
};

function readStoredBoard(database: BoardDatabaseHandle, sessionKey: string): StoredBoard {
  // Write callers already hold an IMMEDIATE transaction; the shared helper nests
  // this consistent read as a savepoint instead of issuing a second BEGIN.
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const db = getNodeSqliteKysely<BoardDatabase>(database.db);
      const tabRows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("board_tabs")
          .selectAll()
          .where("session_key", "=", sessionKey)
          .orderBy("position", "asc")
          .orderBy("tab_id", "asc"),
      ).rows as SelectedBoardTabRow[];
      const selectedWidgetRows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("board_widgets")
          .select(BOARD_WIDGET_SNAPSHOT_COLUMNS)
          .where("session_key", "=", sessionKey)
          .orderBy("tab_id", "asc")
          .orderBy("position", "asc")
          .orderBy("name", "asc"),
      ).rows as SelectedBoardWidgetSnapshotRow[];
      const parsedWidgetRows = selectedWidgetRows.map((row) => ({
        row,
        manifest: parseManifest(row.manifest),
      }));
      // Rows without the canonical authority snapshot predate this unreleased contract.
      // Keep them out of runtime state so they can never mint an interactive lease.
      const admittedWidgetRows = parsedWidgetRows.filter(({ row, manifest }) => {
        if (row.content_kind !== "mcp-app") {
          return true;
        }
        return manifest.mcpAppInteractive !== undefined && manifest.mcpAppInstanceId !== undefined;
      });
      const htmlViewMetadata = new Map<string, BoardWidgetHtmlViewMetadata>();
      for (const { row, manifest } of admittedWidgetRows) {
        const metadata = rowToHtmlViewMetadata(row, manifest);
        if (metadata) {
          htmlViewMetadata.set(row.name, metadata);
        }
      }
      const layout = normalizeBoardLayout({
        tabs: tabRows.map(rowToTab),
        widgets: admittedWidgetRows.map(({ row, manifest }) => rowToWidget(row, manifest)),
      });
      return {
        snapshot: {
          sessionKey,
          // Board existence is row-defined; deleting the last empty tab removes
          // the board, so a later read starts again at the empty revision.
          revision: tabRows.reduce((revision, row) => Math.max(revision, row.revision), 0),
          ...layout,
        },
        tabRows,
        widgetRows: admittedWidgetRows.map(({ row }) => row),
        htmlViewMetadata,
      };
    },
    { databaseLabel: database.path, operationLabel: "board.read" },
  );
}

function upsertTabs(
  database: BoardDatabaseHandle,
  previous: StoredBoard,
  next: BoardSnapshot,
): void {
  const db = getNodeSqliteKysely<BoardDatabase>(database.db);
  const createdBy = new Map(previous.tabRows.map((row) => [row.tab_id, row.created_by]));
  for (const tab of next.tabs) {
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("board_tabs")
        .values({
          session_key: next.sessionKey,
          tab_id: tab.tabId,
          title: tab.title,
          position: tab.position,
          chat_dock: tab.chatDock,
          created_by: createdBy.get(tab.tabId) ?? "agent",
          revision: next.revision,
        })
        .onConflict((conflict) =>
          conflict.columns(["session_key", "tab_id"]).doUpdateSet({
            title: tab.title,
            position: tab.position,
            chat_dock: tab.chatDock,
            revision: next.revision,
          }),
        ),
    );
  }
}

function updateWidgetLayouts(
  database: BoardDatabaseHandle,
  snapshot: BoardSnapshot,
  updatedAt: number,
): void {
  const db = getNodeSqliteKysely<BoardDatabase>(database.db);
  for (const widget of snapshot.widgets) {
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("board_widgets")
        .set({
          tab_id: widget.tabId,
          title: widget.title ?? null,
          size_w: widget.sizeW,
          size_h: widget.sizeH,
          position: widget.position,
          updated_at: updatedAt,
        })
        .where("session_key", "=", snapshot.sessionKey)
        .where("name", "=", widget.name),
    );
  }
}

function updateWidgetHeightModes(
  database: BoardDatabaseHandle,
  previous: StoredBoard,
  ops: readonly BoardOp[],
): void {
  const db = getNodeSqliteKysely<BoardDatabase>(database.db);
  for (const op of ops) {
    if (op.kind !== "widget_resize") {
      continue;
    }
    const row = previous.widgetRows.find((candidate) => candidate.name === op.name);
    if (!row) {
      continue;
    }
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("board_widgets")
        .set({ manifest: updateManifestHeightMode(row.manifest, op.heightMode ?? "fixed") })
        .where("session_key", "=", previous.snapshot.sessionKey)
        .where("name", "=", op.name),
    );
  }
}

function deleteRemovedWidgets(
  database: BoardDatabaseHandle,
  previous: StoredBoard,
  next: BoardSnapshot,
): void {
  const db = getNodeSqliteKysely<BoardDatabase>(database.db);
  const widgetNames = new Set(next.widgets.map((widget) => widget.name));
  for (const row of previous.widgetRows) {
    if (!widgetNames.has(row.name)) {
      executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("board_widgets")
          .where("session_key", "=", next.sessionKey)
          .where("name", "=", row.name),
      );
    }
  }
}

function deleteRemovedTabs(
  database: BoardDatabaseHandle,
  previous: StoredBoard,
  next: BoardSnapshot,
): void {
  const db = getNodeSqliteKysely<BoardDatabase>(database.db);
  const tabIds = new Set(next.tabs.map((tab) => tab.tabId));
  for (const row of previous.tabRows) {
    if (!tabIds.has(row.tab_id)) {
      executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("board_tabs")
          .where("session_key", "=", next.sessionKey)
          .where("tab_id", "=", row.tab_id),
      );
    }
  }
}

function hasSession(database: BoardDatabaseHandle, sessionKey: string): boolean {
  const db = getNodeSqliteKysely<BoardDatabase>(database.db);
  const row = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select("entry_json")
      .where("session_key", "=", sessionKey)
      .limit(1),
  ).rows[0];
  if (!row) {
    return false;
  }
  try {
    const entry = JSON.parse(row.entry_json) as unknown;
    return Boolean(
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof (entry as { sessionId?: unknown }).sessionId === "string",
    );
  } catch {
    return false;
  }
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
      (database) => hasSession(database, resolved.sessionKey),
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
      (database) =>
        hasSession(database, resolved.sessionKey) && boardTablesPresent(database)
          ? readStoredBoard(database, resolved.sessionKey)
          : undefined,
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
        if (!hasSession(transactionDatabase, resolved.sessionKey)) {
          throw new BoardValidationError(
            "not_found",
            `board session not found: ${resolved.sessionKey}`,
          );
        }
        const previous = readStoredBoard(transactionDatabase, resolved.sessionKey);
        const layout = applyBoardOps(previous.snapshot, ops);
        const next: BoardSnapshot = {
          sessionKey: resolved.sessionKey,
          revision: previous.snapshot.revision + 1,
          ...layout,
        };
        const now = Date.now();
        upsertTabs(transactionDatabase, previous, next);
        deleteRemovedWidgets(transactionDatabase, previous, next);
        updateWidgetLayouts(transactionDatabase, next, now);
        updateWidgetHeightModes(transactionDatabase, previous, ops);
        deleteRemovedTabs(transactionDatabase, previous, next);
        return cloneBoardSnapshot(next);
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
        if (!hasSession(transactionDatabase, resolved.sessionKey)) {
          throw new BoardValidationError(
            "not_found",
            `board session not found: ${resolved.sessionKey}`,
          );
        }
        const previous = readStoredBoard(transactionDatabase, resolved.sessionKey);
        const canonicalParams = resolveSqliteBoardWidgetPutParams(
          previous.snapshot,
          canonicalInput,
          previous.widgetRows,
        );
        const existing = previous.widgetRows.find((row) => row.name === canonicalParams.name);
        const grantScopeMatches = existing
          ? existing.content_kind === "html"
            ? canonicalParams.content.kind === "html"
            : existing.content_kind === "mcp-app"
              ? existing.descriptor_json !== null &&
                canonicalParams.content.kind === "mcp-app" &&
                parseDescriptor(existing.descriptor_json).serverName ===
                  canonicalParams.content.descriptor.serverName
              : existing.descriptor_json !== null &&
                (canonicalParams.content.kind === "plugin" ||
                  canonicalParams.content.kind === "registered") &&
                parsePluginContent(existing.descriptor_json).pluginKind ===
                  canonicalParams.content.pluginKind
          : true;
        const next = createBoardWidgetPutSnapshot(previous.snapshot, canonicalParams, {
          grantScopeMatches,
          grantedSha256: existing?.granted_sha ?? undefined,
          instanceId: viewGeneration,
        });
        const widget = next.widgets.find((candidate) => candidate.name === canonicalParams.name)!;
        const now = Date.now();
        upsertTabs(transactionDatabase, previous, next);
        const db = getNodeSqliteKysely<BoardDatabase>(transactionDatabase.db);
        const fields = createBoardWidgetContentFields(
          canonicalParams,
          { presentation: widget.presentation, heightMode: widget.heightMode },
          widget.revision,
          widget.grantState,
          viewGeneration,
          now,
        );
        executeSqliteQuerySync(
          transactionDatabase.db,
          db
            .insertInto("board_widgets")
            .values({
              session_key: resolved.sessionKey,
              name: canonicalParams.name,
              tab_id: widget.tabId,
              title: widget.title ?? null,
              size_w: widget.sizeW,
              size_h: widget.sizeH,
              position: widget.position,
              created_by: existing?.created_by ?? "agent",
              created_at: existing?.created_at ?? now,
              ...fields,
            })
            .onConflict((conflict) =>
              conflict.columns(["session_key", "name"]).doUpdateSet({
                tab_id: widget.tabId,
                title: widget.title ?? null,
                size_w: widget.sizeW,
                size_h: widget.sizeH,
                position: widget.position,
                ...fields,
              }),
            ),
        );
        updateWidgetLayouts(transactionDatabase, next, now);
        return createBoardWidgetPutResult(next, canonicalParams.name);
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
        if (!hasSession(transactionDatabase, resolved.sessionKey)) {
          throw new BoardValidationError(
            "not_found",
            `board session not found: ${resolved.sessionKey}`,
          );
        }
        const previous = readStoredBoard(transactionDatabase, resolved.sessionKey);
        const next = createBoardGrantSnapshot(
          previous.snapshot,
          name,
          decision,
          revision,
          instanceId,
        );
        upsertTabs(transactionDatabase, previous, next);
        const widget = next.widgets.find((candidate) => candidate.name === name)!;
        if (!widget.contentOwner) {
          throw new BoardValidationError(
            "invalid_operation",
            `board widget ${name} content ownership is unavailable`,
          );
        }
        const row = previous.widgetRows.find((candidate) => candidate.name === name)!;
        const manifest = parseManifest(row.manifest);
        const declared = manifest.declared;
        const db = getNodeSqliteKysely<BoardDatabase>(transactionDatabase.db);
        executeSqliteQuerySync(
          transactionDatabase.db,
          db
            .updateTable("board_widgets")
            .set({
              grant_state: decision,
              granted_sha: decision === "granted" ? row.sha256 : null,
              manifest: serializeManifest(
                {
                  contentOwner: widget.contentOwner,
                  ...(widget.registeredContentKind
                    ? { registeredContentKind: widget.registeredContentKind }
                    : {}),
                },
                declared,
                decision,
                manifest.mcpAppInteractive !== undefined && manifest.mcpAppInstanceId
                  ? {
                      kind: "mcp-app" as const,
                      interactive: manifest.mcpAppInteractive,
                      instanceId: manifest.mcpAppInstanceId,
                    }
                  : manifest.registeredInstanceId
                    ? { kind: "registered" as const, instanceId: manifest.registeredInstanceId }
                    : undefined,
                {
                  presentation: manifest.presentation,
                  heightMode: manifest.heightMode,
                },
                manifest.nameIdentity,
              ),
              updated_at: Date.now(),
            })
            .where("session_key", "=", resolved.sessionKey)
            .where("name", "=", name),
        );
        return cloneBoardSnapshot(next);
      },
      { agentId: resolved.agentId, path: database.path, env: this.options.env },
      { operationLabel: "board.grant-widget" },
    );
  }

  private readWidgetRow(target: BoardSessionTarget, name: string) {
    const resolved = this.resolve(target);
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => {
        if (!hasSession(database, resolved.sessionKey) || !boardTablesPresent(database)) {
          return undefined;
        }
        const db = getNodeSqliteKysely<BoardDatabase>(database.db);
        const row = executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("board_widgets")
            .select([
              "content_kind",
              "html",
              "descriptor_json",
              "title",
              "revision",
              "sha256",
              "view_generation",
              "grant_state",
              "manifest",
            ])
            .where("session_key", "=", resolved.sessionKey)
            .where("name", "=", name)
            .limit(1),
        ).rows[0];
        return row;
      },
      {
        agentId: resolved.agentId,
        ...(resolved.path ? { path: resolved.path } : {}),
        env: this.options.env,
      },
    );
    return result.found ? result.value : undefined;
  }

  private readWidgetDocument(
    target: BoardSessionTarget,
    name: string,
    contentKind?: "mcp-app",
  ): BoardWidgetDocument | undefined {
    const row = this.readWidgetRow(target, name);
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
