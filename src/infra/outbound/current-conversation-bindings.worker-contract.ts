import type {
  BindingTargetKind,
  ConversationRef,
  SessionBindingRecord,
} from "./session-binding.types.js";

export type CurrentConversationBindingTouch = {
  conversation: ConversationRef;
  bindingId: string;
  at: number;
  accountPolicy?: {
    idleTimeoutMs: number;
    maxAgeMs: number;
    targetKinds: Record<BindingTargetKind, BindingTargetKind>;
  };
};

export type CurrentConversationBindingWorkerOperations = {
  "conversationBindings.readSelection": {
    input: readonly ConversationRef[];
    output: ReadonlyArray<SessionBindingRecord | null>;
  };
  "conversationBindings.resolve": { input: ConversationRef; output: SessionBindingRecord | null };
  "conversationBindings.touch": {
    input: CurrentConversationBindingTouch;
    output: SessionBindingRecord | null;
  };
};
