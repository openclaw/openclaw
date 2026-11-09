import type { BoardOp, BoardSnapshot } from "../../packages/gateway-protocol/src/index.js";
import { BoardValidationError } from "./board-layout.js";

export type BoardComponentTarget = { name: string; id: string };
const conversationPattern =
  /^(agent:[^:]+:lobby-[a-f0-9-]{36}):component:([a-z0-9][a-z0-9._-]{0,63}):([a-f0-9]{32})$/u;

export function isLobbyConversation(key: string | undefined) {
  return /^agent:[^:]+:lobby-[a-f0-9-]{36}$/u.test(key ?? "");
}

/** The address carries routing data; normal Gateway authorization still admits the parent board. */
export function parseComponentConversation(key: string | undefined) {
  const match = key?.match(conversationPattern);
  return match
    ? { sessionKey: match[1]!, component: { name: match[2]!, id: match[3]! } }
    : undefined;
}

export function componentConversationKey(sessionKey: string, component: BoardComponentTarget) {
  const key = `${sessionKey}:component:${component.name}:${component.id}`;
  if (!parseComponentConversation(key)) {
    throw new BoardValidationError(
      "invalid_operation",
      "Component conversations require a Lobby session",
    );
  }
  return key;
}

export function requireBoardComponent(snapshot: BoardSnapshot, target: BoardComponentTarget) {
  const widget = snapshot.widgets.find((candidate) => candidate.name === target.name);
  if (!widget || widget.componentId !== target.id) {
    throw new BoardValidationError(
      "not_found",
      "This component was removed or replaced. Open its conversation from the Lobby again.",
    );
  }
  return widget;
}

export function scopeBoardSnapshot<T extends BoardSnapshot>(
  snapshot: T,
  target?: BoardComponentTarget,
  allowRemoved = false,
): T {
  if (!target) {
    return snapshot;
  }
  if (allowRemoved && !snapshot.widgets.some((widget) => widget.name === target.name)) {
    return { ...snapshot, widgets: [], tabs: [] };
  }
  const widget = requireBoardComponent(snapshot, target);
  return {
    ...snapshot,
    widgets: [widget],
    tabs: snapshot.tabs.filter((tab) => tab.tabId === widget.tabId),
  };
}

export function assertComponentDocument(
  target: BoardComponentTarget | undefined,
  name: string,
  document: { componentId?: string } | undefined,
) {
  if (target && (name !== target.name || document?.componentId !== target.id)) {
    throw new BoardValidationError(
      "not_found",
      "This component was removed or replaced. Open its conversation from the Lobby again.",
    );
  }
}

export function assertComponentOperations(
  snapshot: BoardSnapshot,
  target: BoardComponentTarget | undefined,
  ops: readonly BoardOp[],
) {
  if (!target) {
    return;
  }
  requireBoardComponent(snapshot, target);
  if (
    ops.some(
      (op) =>
        !["widget_move", "widget_resize", "widget_remove"].includes(op.kind) ||
        !("name" in op) ||
        op.name !== target.name,
    )
  ) {
    throw new BoardValidationError(
      "invalid_operation",
      "Use the general Lobby conversation to arrange other components or tabs.",
    );
  }
}
