let readPanelTarget: (() => boolean) | undefined;
let opensInPanel = false;
const listeners = new Set<() => void>();

export function externalLinkOpensInPanel(): boolean {
  return opensInPanel;
}

export function subscribeExternalLinkPresentation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function refreshExternalLinkPresentation(): void {
  const next = readPanelTarget?.() ?? false;
  if (next !== opensInPanel) {
    opensInPanel = next;
    for (const listener of listeners) {
      listener();
    }
  }
}

/** The mounted navigation owner publishes its decision; this module only projects it. */
export function bindExternalLinkPresentation(read: () => boolean): () => void {
  readPanelTarget = read;
  refreshExternalLinkPresentation();
  return () => {
    if (readPanelTarget === read) {
      readPanelTarget = undefined;
      refreshExternalLinkPresentation();
    }
  };
}
