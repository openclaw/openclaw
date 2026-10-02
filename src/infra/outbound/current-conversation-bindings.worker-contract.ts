import type { BindingTargetKind, ConversationRef } from "./session-binding.types.js";

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
