import { createChangeListeners, notifyListeners } from "../../../../src/shared/listeners.js";
import type { ChatAttachment, ChatGoalDraftMode, HumanMention } from "./chat-types.ts";

type ComposerDraftSnapshot = {
  draft: string;
  mentions: readonly HumanMention[];
  attachments: ChatAttachment[];
  pendingAttachmentReads: number;
  goalDraftMode?: ChatGoalDraftMode | null;
};

export type ComposerDraftSource = {
  read(): ComposerDraftSnapshot;
  subscribe(listener: () => void): () => void;
};

/** Publishes completed owner mutations without keeping a second draft. */
export function createComposerDraftSource(read: ComposerDraftSource["read"]) {
  const listeners = createChangeListeners();
  return {
    read,
    subscribe: listeners.subscribe,
    publish: listeners.publish,
  };
}

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
