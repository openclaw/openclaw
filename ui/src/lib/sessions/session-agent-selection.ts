export type SessionAgentSelection = {
  readonly state: { readonly selectedId: string | null };
  readonly intentRevision?: number;
  subscribe: (listener: () => void) => () => void;
};

/** Distinguish deliberate navigation from automatic default-agent reconciliation. */
export function subscribeAgentSelection(
  selection: SessionAgentSelection,
  changed: (agentId: string | null, foreground: boolean) => void,
): () => void {
  let selectedId = selection.state.selectedId;
  let intentRevision = selection.intentRevision;
  return selection.subscribe(() => {
    const nextId = selection.state.selectedId;
    const foreground =
      selection.intentRevision !== undefined && selection.intentRevision !== intentRevision;
    intentRevision = selection.intentRevision;
    if (selectedId === nextId) {
      return;
    }
    selectedId = nextId;
    changed(nextId, foreground);
  });
}
