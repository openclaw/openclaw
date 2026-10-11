type AgentScopeSelection = {
  readonly state: { scopeId: string | null };
  readonly intentRevision: number;
  subscribe: (listener: (state: { scopeId: string | null }) => void) => () => void;
};

/** Watches semantic scope changes across selection-source replacements. */
export function watchAgentScope(
  onChange: (scopeId: string | null, intentChanged: boolean) => void,
): (selection: AgentScopeSelection) => () => void {
  let observed:
    | { selection: AgentScopeSelection; scopeId: string | null; revision: number }
    | undefined;
  return (selection) => {
    const sync = () => {
      const nextScopeId = selection.state.scopeId;
      const previous = observed;
      observed = { selection, scopeId: nextScopeId, revision: selection.intentRevision };
      if (!previous || nextScopeId === previous.scopeId) {
        return;
      }
      onChange(
        nextScopeId,
        selection !== previous.selection || selection.intentRevision !== previous.revision,
      );
    };
    sync();
    return selection.subscribe(sync);
  };
}
