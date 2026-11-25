/** Native admission and open actions shared with non-preview catalog rows. */
export type MessageMediaAction = {
  onOpen?: () => void;
  onFindWorkspaceFile?: () => void;
  onRetry?: () => void;
  onAllow?: () => void;
  onFocus?: () => void;
  observeElement?: (element: Element | undefined) => void;
  pending: boolean;
  reason?: string;
  /** Admitted image pixels a catalog tile may display; absent for documents and unavailable media. */
  previewUrl?: string;
};

export type WorkspaceFileSearchTarget = {
  name: string;
  sessionKey?: string;
  agentId?: string;
};
