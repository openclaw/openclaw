import { registerListener } from "../../../../src/shared/listeners.js";
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
  const listeners = new Set<() => void>();
  return {
    read,
    subscribe: (listener: () => void) => registerListener(listeners, listener),
    publish: () => {
      for (const listener of listeners) {
        listener();
      }
    },
  };
}
