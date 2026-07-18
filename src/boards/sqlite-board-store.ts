import { createHash } from "node:crypto";
import type { Selectable } from "kysely";
import type {
  BoardMcpAppDescriptor,
  BoardOp,
  BoardSnapshot,
  BoardTab,
  BoardWidget,
  BoardWidgetPutParams,
} from "../../packages/gateway-protocol/src/index.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type {
  BoardTabs as BoardTabRow,
  BoardWidgets as BoardWidgetRow,
  DB as OpenClawAgentKyselyDatabase,
} from "../state/openclaw-agent-db.generated.js";
import {
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { applyBoardOps, normalizeBoardLayout } from "./board-layout.js";
import {
  cloneBoardSnapshot,
  createBoardDeclaredSummary,
  createBoardGrantSnapshot,
  createBoardWidgetPutSnapshot,
  type BoardStore,
  type BoardWidgetDocument,
} from "./board-store.js";

type BoardDatabase = Pick<OpenClawAgentKyselyDatabase, "board_tabs" | "board_widgets">;
type SelectedBoardTabRow = Selectable<BoardTabRow>;
type SelectedBoardWidgetRow = Selectable<BoardWidgetRow>;

type StoredBoard = {
  snapshot: BoardSnapshot;
  tabRows: SelectedBoardTabRow[];
  widgetRows: SelectedBoardWidgetRow[];
};

export type SqliteBoardStoreOptions = {
  resolveAgentId: (sessionKey: string) => string;
  env?: NodeJS.ProcessEnv;
};

function parseManifest(value: string): BoardWidgetPutParams["declared"] {
  const parsed = JSON.parse(value) as { netOrigins?: unknown; tools?: unknown };
  const netOrigins = Array.isArray(parsed.netOrigins)
    ? parsed.netOrigins.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const tools = Array.isArray(parsed.tools)
    ? parsed.tools.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  return {
    ...(netOrigins?.length ? { netOrigins } : {}),
    ...(tools?.length ? { tools } : {}),
  };
}

function parseDescriptor(value: string): BoardMcpAppDescriptor {
  return JSON.parse(value) as BoardMcpAppDescriptor;
}

function rowToTab(row: SelectedBoardTabRow): BoardTab {
  return {
    tabId: row.tab_id,
    title: row.title,
    position: row.position,
    chatDock: row.chat_dock as BoardTab["chatDock"],
  };
}

function rowToWidget(row: SelectedBoardWidgetRow): BoardWidget {
  const declaredSummary = createBoardDeclaredSummary(parseManifest(row.manifest));
  return {
    name: row.name,
    tabId: row.tab_id,
    ...(row.title !== null ? { title: row.title } : {}),
    contentKind: row.content_kind as BoardWidget["contentKind"],
    sizeW: row.size_w,
    sizeH: row.size_h,
    position: row.position,
    grantState: row.grant_state as BoardWidget["grantState"],
    revision: row.revision,
    ...(declaredSummary ? { declaredSummary } : {}),
  };
}

function readStoredBoard(database: OpenClawAgentDatabase, sessionKey: string): StoredBoard {
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
      const widgetRows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("board_widgets")
          .selectAll()
          .where("session_key", "=", sessionKey)
          .orderBy("tab_id", "asc")
          .orderBy("position", "asc")
          .orderBy("name", "asc"),
      ).rows as SelectedBoardWidgetRow[];
      const layout = normalizeBoardLayout({
        tabs: tabRows.map(rowToTab),
        widgets: widgetRows.map(rowToWidget),
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
        widgetRows,
      };
    },
    { databaseLabel: database.path, operationLabel: "board.read" },
  );
}

function upsertTabs(
  database: OpenClawAgentDatabase,
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
  database: OpenClawAgentDatabase,
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

function deleteRemovedWidgets(
  database: OpenClawAgentDatabase,
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
  database: OpenClawAgentDatabase,
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

function contentFields(params: BoardWidgetPutParams, revision: number, now: number) {
  const manifest = JSON.stringify(params.declared ?? {});
  if (params.content.kind === "html") {
    return {
      content_kind: "html",
      html: Buffer.from(params.content.html, "utf8"),
      descriptor_json: null,
      sha256: createHash("sha256").update(params.content.html).digest("hex"),
      revision,
      manifest,
      grant_state: createBoardDeclaredSummary(params.declared) ? "pending" : "none",
      granted_sha: null,
      updated_at: now,
    };
  }
  const descriptorJson = JSON.stringify(params.content.descriptor);
  return {
    content_kind: "mcp-app",
    html: null,
    descriptor_json: descriptorJson,
    sha256: createHash("sha256").update(descriptorJson).digest("hex"),
    revision,
    manifest,
    grant_state: createBoardDeclaredSummary(params.declared) ? "pending" : "none",
    granted_sha: null,
    updated_at: now,
  };
}

export class SqliteBoardStore implements BoardStore {
  constructor(private readonly options: SqliteBoardStoreOptions) {}

  private resolveAgentId(sessionKey: string, agentId?: string): string {
    return agentId ?? this.options.resolveAgentId(sessionKey);
  }

  private open(sessionKey: string, agentId?: string): OpenClawAgentDatabase {
    return openOpenClawAgentDatabase({
      agentId: this.resolveAgentId(sessionKey, agentId),
      env: this.options.env,
    });
  }

  getSnapshot(sessionKey: string): BoardSnapshot {
    return cloneBoardSnapshot(readStoredBoard(this.open(sessionKey), sessionKey).snapshot);
  }

  applyOps(sessionKey: string, ops: readonly BoardOp[]): BoardSnapshot {
    if (ops.length === 0) {
      return this.getSnapshot(sessionKey);
    }
    const agentId = this.resolveAgentId(sessionKey);
    return runOpenClawAgentWriteTransaction(
      (database) => {
        const previous = readStoredBoard(database, sessionKey);
        const layout = applyBoardOps(previous.snapshot, ops);
        const next: BoardSnapshot = {
          sessionKey,
          revision: previous.snapshot.revision + 1,
          ...layout,
        };
        const now = Date.now();
        upsertTabs(database, previous, next);
        deleteRemovedWidgets(database, previous, next);
        updateWidgetLayouts(database, next, now);
        deleteRemovedTabs(database, previous, next);
        return cloneBoardSnapshot(next);
      },
      { agentId, env: this.options.env },
      { operationLabel: "board.apply-ops" },
    );
  }

  putWidget(params: BoardWidgetPutParams): BoardSnapshot {
    const agentId = this.resolveAgentId(params.sessionKey);
    return runOpenClawAgentWriteTransaction(
      (database) => {
        const previous = readStoredBoard(database, params.sessionKey);
        const next = createBoardWidgetPutSnapshot(previous.snapshot, params);
        const widget = next.widgets.find((candidate) => candidate.name === params.name)!;
        const existing = previous.widgetRows.find((row) => row.name === params.name);
        const now = Date.now();
        upsertTabs(database, previous, next);
        const db = getNodeSqliteKysely<BoardDatabase>(database.db);
        const fields = contentFields(params, widget.revision, now);
        executeSqliteQuerySync(
          database.db,
          db
            .insertInto("board_widgets")
            .values({
              session_key: params.sessionKey,
              name: params.name,
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
        updateWidgetLayouts(database, next, now);
        return cloneBoardSnapshot(next);
      },
      { agentId, env: this.options.env },
      { operationLabel: "board.put-widget" },
    );
  }

  grant(sessionKey: string, name: string, decision: "granted" | "rejected"): BoardSnapshot {
    const agentId = this.resolveAgentId(sessionKey);
    return runOpenClawAgentWriteTransaction(
      (database) => {
        const previous = readStoredBoard(database, sessionKey);
        const next = createBoardGrantSnapshot(previous.snapshot, name, decision);
        upsertTabs(database, previous, next);
        const row = previous.widgetRows.find((candidate) => candidate.name === name)!;
        const db = getNodeSqliteKysely<BoardDatabase>(database.db);
        executeSqliteQuerySync(
          database.db,
          db
            .updateTable("board_widgets")
            .set({
              grant_state: decision,
              granted_sha: decision === "granted" ? row.sha256 : null,
              updated_at: Date.now(),
            })
            .where("session_key", "=", sessionKey)
            .where("name", "=", name),
        );
        return cloneBoardSnapshot(next);
      },
      { agentId, env: this.options.env },
      { operationLabel: "board.grant-widget" },
    );
  }

  readWidgetHtml(sessionKey: string, name: string): BoardWidgetDocument | undefined {
    const database = this.open(sessionKey);
    const db = getNodeSqliteKysely<BoardDatabase>(database.db);
    const row = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("board_widgets")
        .select(["content_kind", "html", "descriptor_json", "revision", "sha256"])
        .where("session_key", "=", sessionKey)
        .where("name", "=", name)
        .limit(1),
    ).rows[0];
    if (!row) {
      return undefined;
    }
    if (row.content_kind === "html" && row.html !== null) {
      return {
        html: Buffer.from(row.html).toString("utf8"),
        revision: row.revision,
        sha256: row.sha256,
      };
    }
    if (row.content_kind === "mcp-app" && row.descriptor_json !== null) {
      return { descriptor: parseDescriptor(row.descriptor_json), revision: row.revision };
    }
    return undefined;
  }

  listSessionsWithBoards(): string[] {
    const sessionKeys = new Set<string>();
    for (const registered of listOpenClawRegisteredAgentDatabases({ env: this.options.env })) {
      const database = openOpenClawAgentDatabase({
        agentId: registered.agentId,
        path: registered.path,
        env: this.options.env,
      });
      const db = getNodeSqliteKysely<BoardDatabase>(database.db);
      for (const row of executeSqliteQuerySync(
        database.db,
        db.selectFrom("board_tabs").select("session_key").distinct(),
      ).rows) {
        sessionKeys.add(row.session_key);
      }
    }
    return [...sessionKeys].toSorted();
  }

  deleteSession(sessionKey: string, agentId?: string): void {
    const resolvedAgentId = this.resolveAgentId(sessionKey, agentId);
    runOpenClawAgentWriteTransaction(
      (database) => {
        const db = getNodeSqliteKysely<BoardDatabase>(database.db);
        executeSqliteQuerySync(
          database.db,
          db.deleteFrom("board_widgets").where("session_key", "=", sessionKey),
        );
        executeSqliteQuerySync(
          database.db,
          db.deleteFrom("board_tabs").where("session_key", "=", sessionKey),
        );
      },
      { agentId: resolvedAgentId, env: this.options.env },
      { operationLabel: "board.delete-session" },
    );
  }
}
