const durableComposerDraftChangeListeners = new Set<() => void>();

export function subscribeDurableComposerDraftChanges(listener: () => void): () => void {
  durableComposerDraftChangeListeners.add(listener);
  return () => void durableComposerDraftChangeListeners.delete(listener);
}

export function notifyDurableComposerDraftChanges(): void {
  for (const listener of durableComposerDraftChangeListeners) {
    try {
      listener();
    } catch (error) {
      console.error("[openclaw] durable composer draft listener failed", error);
    }
  }
}
