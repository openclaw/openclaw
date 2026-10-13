import { notifyListeners } from "../../../../src/shared/listeners.js";

const durableComposerDraftChangeListeners = new Set<() => void>();

export function subscribeDurableComposerDraftChanges(listener: () => void): () => void {
  durableComposerDraftChangeListeners.add(listener);
  return () => void durableComposerDraftChangeListeners.delete(listener);
}

export function notifyDurableComposerDraftChanges(): void {
  notifyListeners(durableComposerDraftChangeListeners, undefined, (error) =>
    console.error("[openclaw] durable composer draft listener failed", error),
  );
}
