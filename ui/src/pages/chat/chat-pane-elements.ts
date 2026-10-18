import type { ChatPaneElement } from "./route-draft-focus-handoff.ts";

const panes = new Set<ChatPaneElement>();
const unboundPanes = new Set<HTMLElement>();

/** Pane hosts span the retained page and assistant dock; each renderer owns its registration. */
export function registerChatPane(pane: ChatPaneElement): () => void {
  panes.add(pane);
  return () => panes.delete(pane);
}

export function chatPanesWithin(root: Node): ChatPaneElement[] {
  return [...panes].filter((pane) => root.contains(pane));
}

export function registerUnboundPane(pane: HTMLElement): () => void {
  unboundPanes.add(pane);
  return () => unboundPanes.delete(pane);
}

export function unboundPanesWithin(root: Node): HTMLElement[] {
  return [...unboundPanes].filter((pane) => root.contains(pane));
}
