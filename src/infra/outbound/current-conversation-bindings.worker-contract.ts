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

export type CurrentConversationBindingBind = {
  record: SessionBindingRecord;
  metadataKeys?: string[];
  accountPolicy?: { inferredAgentId: string | undefined };
  expected?: SessionBindingRecord | null;
};

export type CurrentConversationBindingRemove =
  | { conversation: ConversationRef; bindingId?: string; expected?: SessionBindingRecord | null }
  | {
      targetSessionKey: string;
      scope?: { channel: string; accountId: string };
      genericOnly: boolean;
    };
