import type { BoardFace } from "../../lib/board/settings.ts";

export type ChatPaneElement = HTMLElement & {
  active?: boolean;
  readonly composerElement?: HTMLTextAreaElement | null;
  readonly headerElement?: HTMLElement | null;
  discardStagedAttachments?: () => void;
  paneId?: string;
  prepareForEviction?: () => void;
  hasQueuedMessageEdit?: boolean;
  presented?: boolean;
  captureNavigationFace?: () => BoardFace | undefined;
  routeFace?: BoardFace;
  sessionKey?: string;
  transcriptLoading?: boolean;
  transcriptReady?: boolean;
  updateComplete?: Promise<unknown>;
  visuallyPresented?: boolean;
};

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
