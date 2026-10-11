import { createHash } from "node:crypto";
import type { BoardSnapshot, BoardWidget } from "../../packages/gateway-protocol/src/index.js";
import type { SessionActorMemoryStorageContext } from "../config/sessions/session-actor-memory-storage-context.js";
import { applyBoardOps, BoardValidationError } from "./board-layout.js";
import {
  createBoardGrantSnapshot,
  createBoardWidgetPutResult,
  createBoardWidgetPutSnapshot,
  normalizeBoardWidgetPutParams,
  resolveBoardWidgetPutParams,
  type BoardWidgetDocument,
  type BoardWidgetHtmlViewMetadata,
} from "./board-store.js";
import type {
  SessionActorBoardCommand,
  SessionActorBoardQuery,
  SessionActorMemoryBoard,
} from "./session-actor-board-contract.js";

function emptyBoard(sessionKey: string): BoardSnapshot {
  return { sessionKey, revision: 0, tabs: [], widgets: [] };
}

function htmlMetadata(widget: BoardWidget, sha256: string): BoardWidgetHtmlViewMetadata {
  return {
    revision: widget.revision,
    sha256,
    viewGeneration: widget.instanceId!,
    grantState: widget.grantState,
    ...(widget.declared ? { declared: widget.declared } : {}),
  };
}

function document(
  board: SessionActorMemoryBoard | undefined,
  name: string,
): BoardWidgetDocument | undefined {
  const widget = board?.snapshot.widgets.find((candidate) => candidate.name === name);
  const stored = board?.content.get(name);
  if (!widget || !stored) {
    return undefined;
  }
  switch (stored.content.kind) {
    case "html":
      return { ...htmlMetadata(widget, stored.sha256!), html: stored.content.html };
    case "registered":
      return {
        ...htmlMetadata(widget, stored.sha256!),
        source: stored.content.source,
        pluginKind: stored.content.pluginKind,
        ...(widget.title !== undefined ? { title: widget.title } : {}),
      };
    case "mcp-app":
      return {
        descriptor: stored.content.descriptor,
        revision: widget.revision,
        instanceId: widget.instanceId!,
        grantState: widget.grantState,
        declaredTools: widget.declared?.tools ?? [],
        interactive: stored.content.interactive,
      };
    case "plugin":
      break;
  }
  return undefined;
}

export function readSessionActorBoardQuery(
  context: SessionActorMemoryStorageContext,
  query: SessionActorBoardQuery,
) {
  const state = context.get(query.input.sessionKey);
  const board = state?.hot.entry ? state.board : undefined;
  if (query.type === "boards.document") {
    const value = document(board, query.input.name);
    return query.input.contentKind && value && !("descriptor" in value) ? undefined : value;
  }
  const htmlViewMetadata = new Map<string, BoardWidgetHtmlViewMetadata>();
  for (const widget of board?.snapshot.widgets ?? []) {
    const content = board!.content.get(widget.name);
    if (content?.sha256) {
      htmlViewMetadata.set(widget.name, htmlMetadata(widget, content.sha256));
    }
  }
  return { snapshot: board?.snapshot ?? emptyBoard(query.input.sessionKey), htmlViewMetadata };
}

export function executeSessionActorBoardCommand(
  context: SessionActorMemoryStorageContext,
  command: SessionActorBoardCommand,
) {
  const { sessionKey } = command.input;
  if (!context.get(sessionKey)?.hot.entry) {
    throw new BoardValidationError("not_found", `board session not found: ${sessionKey}`);
  }
  const state = context.edit(sessionKey);
  const previous = state.board;
  const snapshot = previous?.snapshot ?? emptyBoard(sessionKey);
  switch (command.type) {
    case "boards.applyOps": {
      if (!command.input.ops.length) {
        return snapshot;
      }
      const next = {
        sessionKey,
        revision: snapshot.revision + 1,
        ...applyBoardOps(snapshot, command.input.ops),
      };
      const names = new Set(next.widgets.map((widget) => widget.name));
      // Durable board existence follows its tab rows, including the empty-board revision reset.
      state.board = next.tabs.length
        ? {
            snapshot: next,
            content: new Map([...(previous?.content ?? [])].filter(([name]) => names.has(name))),
          }
        : undefined;
      return next;
    }
    case "boards.putWidget": {
      const params = resolveBoardWidgetPutParams(
        snapshot,
        normalizeBoardWidgetPutParams(command.input.params, sessionKey),
        new Map(
          [...(previous?.content ?? [])].map(([name, stored]) => [name, stored.nameIdentity]),
        ),
      );
      const prior = previous?.content.get(params.name);
      const grantScopeMatches =
        !prior ||
        (prior.content.kind === params.content.kind &&
          (prior.content.kind !== "mcp-app" ||
            (params.content.kind === "mcp-app" &&
              prior.content.descriptor.serverName === params.content.descriptor.serverName)));
      const next = createBoardWidgetPutSnapshot(snapshot, params, {
        grantScopeMatches,
        grantedSha256: prior?.sha256,
        instanceId: command.input.viewGeneration,
      });
      const content = new Map(previous?.content);
      const body =
        params.content.kind === "html"
          ? params.content.html
          : params.content.kind === "registered"
            ? params.content.source
            : undefined;
      content.set(params.name, {
        content: structuredClone(params.content),
        nameIdentity: params.generatedIdentity
          ? {
              kind: "generated",
              source: params.generatedIdentity.source,
              key: params.generatedIdentity.key,
            }
          : { kind: "explicit" },
        ...(body !== undefined ? { sha256: createHash("sha256").update(body).digest("hex") } : {}),
      });
      state.board = { snapshot: next, content };
      return createBoardWidgetPutResult(next, params.name);
    }
    case "boards.grant":
      break;
  }
  const { name, decision, revision, instanceId } = command.input;
  const next = createBoardGrantSnapshot(snapshot, name, decision, revision, instanceId);
  state.board = { snapshot: next, content: new Map(previous?.content) };
  return next;
}
