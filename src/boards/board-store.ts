import { createHash } from "node:crypto";
import type {
  BoardMcpAppDescriptor,
  BoardOp,
  BoardSnapshot,
  BoardWidgetContent,
  BoardWidgetPutParams,
} from "../../packages/gateway-protocol/src/index.js";
import {
  applyBoardOps,
  BOARD_SIZE_PRESETS,
  BoardValidationError,
  insertBoardWidget,
  normalizeBoardLayout,
  type BoardSize,
} from "./board-layout.js";

export type BoardWidgetHtmlDocument = { html: string; revision: number; sha256: string };
export type BoardWidgetMcpAppDocument = {
  descriptor: BoardMcpAppDescriptor;
  revision: number;
};
export type BoardWidgetDocument = BoardWidgetHtmlDocument | BoardWidgetMcpAppDocument;

export interface BoardStore {
  getSnapshot(sessionKey: string): BoardSnapshot;
  applyOps(sessionKey: string, ops: readonly BoardOp[]): BoardSnapshot;
  putWidget(params: BoardWidgetPutParams): BoardSnapshot;
  grant(sessionKey: string, name: string, decision: "granted" | "rejected"): BoardSnapshot;
  readWidgetHtml(sessionKey: string, name: string): BoardWidgetDocument | undefined;
  listSessionsWithBoards(): string[];
  deleteSession(sessionKey: string): void;
}

type StoredBoard = {
  snapshot: BoardSnapshot;
  documents: Map<string, BoardWidgetDocument>;
};

function emptySnapshot(sessionKey: string): BoardSnapshot {
  return { sessionKey, revision: 0, tabs: [], widgets: [] };
}

function cloneSnapshot(snapshot: BoardSnapshot): BoardSnapshot {
  return {
    sessionKey: snapshot.sessionKey,
    revision: snapshot.revision,
    tabs: snapshot.tabs.map((tab) => ({ ...tab })),
    widgets: snapshot.widgets.map((widget) => ({ ...widget })),
  };
}

function createDocument(content: BoardWidgetContent, revision: number): BoardWidgetDocument {
  if (content.kind === "html") {
    return {
      html: content.html,
      revision,
      sha256: createHash("sha256").update(content.html).digest("hex"),
    };
  }
  return { descriptor: { ...content.descriptor }, revision };
}

function hasDeclarations(params: BoardWidgetPutParams): boolean {
  return Boolean(params.declared?.netOrigins?.length || params.declared?.tools?.length);
}

export class InMemoryBoardStore implements BoardStore {
  private readonly boards = new Map<string, StoredBoard>();

  getSnapshot(sessionKey: string): BoardSnapshot {
    return cloneSnapshot(this.boards.get(sessionKey)?.snapshot ?? emptySnapshot(sessionKey));
  }

  applyOps(sessionKey: string, ops: readonly BoardOp[]): BoardSnapshot {
    const current = this.boards.get(sessionKey);
    const snapshot = current?.snapshot ?? emptySnapshot(sessionKey);
    if (ops.length === 0) {
      return cloneSnapshot(snapshot);
    }
    const layout = applyBoardOps(snapshot, ops);
    const next: BoardSnapshot = {
      sessionKey,
      revision: snapshot.revision + 1,
      ...layout,
    };
    const removedNames = new Set(next.widgets.map((widget) => widget.name));
    const documents = new Map(
      [...(current?.documents ?? [])].filter(([name]) => removedNames.has(name)),
    );
    this.boards.set(sessionKey, { snapshot: next, documents });
    return cloneSnapshot(next);
  }

  putWidget(params: BoardWidgetPutParams): BoardSnapshot {
    const current = this.boards.get(params.sessionKey);
    const prior = current?.snapshot ?? emptySnapshot(params.sessionKey);
    let layout = normalizeBoardLayout(prior);
    if (layout.tabs.length === 0) {
      layout.tabs.push({ tabId: "main", title: "Main", position: 0, chatDock: "right" });
    }
    const existing = layout.widgets.find((widget) => widget.name === params.name);
    const tabId = params.placement?.tabId ?? existing?.tabId ?? layout.tabs[0]!.tabId;
    if (!layout.tabs.some((tab) => tab.tabId === tabId)) {
      throw new BoardValidationError("not_found", `board tab not found: ${tabId}`);
    }
    const size = BOARD_SIZE_PRESETS[(params.placement?.size ?? "md") as BoardSize];
    const widgetRevision = (existing?.revision ?? 0) + 1;
    layout = insertBoardWidget(
      layout,
      {
        name: params.name,
        tabId,
        ...(params.title !== undefined
          ? { title: params.title }
          : existing?.title !== undefined
            ? { title: existing.title }
            : {}),
        contentKind: params.content.kind,
        sizeW: params.placement?.size ? size.sizeW : (existing?.sizeW ?? size.sizeW),
        sizeH: params.placement?.size ? size.sizeH : (existing?.sizeH ?? size.sizeH),
        position: existing?.position ?? layout.widgets.length,
        grantState: hasDeclarations(params) ? "pending" : "none",
        revision: widgetRevision,
      },
      {
        tabId,
        ...(params.placement?.after ? { after: params.placement.after } : {}),
        move: params.placement?.tabId !== undefined || params.placement?.after !== undefined,
      },
    );
    const snapshot: BoardSnapshot = {
      sessionKey: params.sessionKey,
      revision: prior.revision + 1,
      ...layout,
    };
    const documents = new Map(current?.documents ?? []);
    documents.set(params.name, createDocument(params.content, widgetRevision));
    this.boards.set(params.sessionKey, { snapshot, documents });
    return cloneSnapshot(snapshot);
  }

  grant(sessionKey: string, name: string, decision: "granted" | "rejected"): BoardSnapshot {
    const current = this.boards.get(sessionKey);
    const widget = current?.snapshot.widgets.find((candidate) => candidate.name === name);
    if (!current || !widget) {
      throw new BoardValidationError("not_found", `board widget not found: ${name}`);
    }
    if (widget.grantState !== "pending") {
      throw new BoardValidationError(
        "invalid_operation",
        `board widget grant is not pending: ${name}`,
      );
    }
    const snapshot = cloneSnapshot(current.snapshot);
    const nextWidget = snapshot.widgets.find((candidate) => candidate.name === name)!;
    nextWidget.grantState = decision;
    snapshot.revision += 1;
    this.boards.set(sessionKey, { snapshot, documents: current.documents });
    return cloneSnapshot(snapshot);
  }

  readWidgetHtml(sessionKey: string, name: string): BoardWidgetDocument | undefined {
    const document = this.boards.get(sessionKey)?.documents.get(name);
    if (!document) {
      return undefined;
    }
    return "html" in document
      ? { ...document }
      : { descriptor: { ...document.descriptor }, revision: document.revision };
  }

  listSessionsWithBoards(): string[] {
    return [...this.boards]
      .filter(([, board]) => board.snapshot.tabs.length > 0 || board.snapshot.widgets.length > 0)
      .map(([sessionKey]) => sessionKey)
      .toSorted();
  }

  deleteSession(sessionKey: string): void {
    this.boards.delete(sessionKey);
  }
}

// eslint-disable-next-line no-warning-comments -- Required marker for the approved persistence handoff.
// TODO: Swap this in-memory implementation for agent-DB SQLite after schema approval.
export const boardStore: BoardStore = new InMemoryBoardStore();
