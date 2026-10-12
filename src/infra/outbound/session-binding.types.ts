/**
 * Runtime destination a conversation binding points at.
 */
export type BindingTargetKind = "subagent" | "session";

/**
 * Placement requested when binding a child/current session to a conversation.
 */
export type SessionBindingPlacement = "current" | "child";

/**
 * Stable error codes emitted by session-binding service failures.
 */
export type SessionBindingErrorCode =
  | "BINDING_ADAPTER_UNAVAILABLE"
  | "BINDING_CAPABILITY_UNSUPPORTED"
  | "BINDING_CREATE_FAILED";

/**
 * Channel/account/conversation tuple used to resolve a bound delivery route.
 */
export type ConversationRef = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
};

/** Channel/account owner of an adapter-local binding id. */
export type SessionBindingScope = Pick<ConversationRef, "channel" | "accountId">;

/**
 * Persistable record that connects one conversation to one target session.
 */
export type SessionBindingRecord = {
  bindingId: string;
  targetSessionKey: string;
  targetKind: BindingTargetKind;
  conversation: ConversationRef;
  /** Lifecycle state for a registered session binding. */
  status: "active" | "ending" | "ended";
  boundAt: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
};

export type SessionBindingInspection =
  | { status: "available"; binding: SessionBindingRecord | null }
  | { status: "unavailable" };

/**
 * Request to create or refresh a session binding for a conversation.
 */
export type SessionBindingBindInput = {
  targetSessionKey: string;
  targetKind: BindingTargetKind;
  conversation: ConversationRef;
  placement?: SessionBindingPlacement;
  metadata?: Record<string, unknown>;
  ttlMs?: number;
  /** Host admission authority; current-placement adapters recheck before committing a binding. */
  assertCurrent?: () => void;
};

/**
 * Request to remove bindings by id or target session.
 */
export type SessionBindingUnbindInput = {
  bindingId?: string;
  targetSessionKey?: string;
  /** Restrict removal to this owner; omit only for intentional cross-channel cleanup. */
  scope?: SessionBindingScope;
  reason: string;
};

/**
 * Capability summary exposed by the active binding adapter for a conversation scope.
 */
export type SessionBindingCapabilities = {
  adapterAvailable: boolean;
  bindSupported: boolean;
  unbindSupported: boolean;
  placements: SessionBindingPlacement[];
};

type SessionBindingAdapterCapabilities = {
  placements?: SessionBindingPlacement[];
  bindSupported?: boolean;
  unbindSupported?: boolean;
};

/** @deprecated Implement SessionBindingAdapterV2; removed in the next Plugin SDK major. */
export type SessionBindingAdapter = {
  channel: string;
  accountId: string;
  capabilities?: SessionBindingAdapterCapabilities;
  bind?: (input: SessionBindingBindInput) => Promise<SessionBindingRecord | null>;
  /** @deprecated Use listBySessionAsync; removed in the next Plugin SDK major. */
  listBySession: (targetSessionKey: string) => SessionBindingRecord[];
  /** @deprecated Use resolveByConversationAsync. The synchronous form will be removed in the next Plugin SDK major. */
  resolveByConversation: (ref: ConversationRef) => SessionBindingRecord | null;
  /** @deprecated Use inspectByConversationAsync; removed in the next Plugin SDK major. */
  inspectByConversation?: (ref: ConversationRef) => SessionBindingRecord | null;
  /** Inspects committed ownership without creating storage or pruning rows. */
  inspectByConversationAsync?: (ref: ConversationRef) => Promise<SessionBindingRecord | null>;
  resolveByConversationAsync?: (ref: ConversationRef) => Promise<SessionBindingRecord | null>;
  /** @deprecated Use touchAsync. The synchronous form will be removed in the next Plugin SDK major. */
  touch?: (bindingId: string, at?: number) => void;
  /** Settles accepted persistence before resolving. */
  touchAsync?: (bindingId: string, at?: number) => Promise<void>;
  unbind?: (input: SessionBindingUnbindInput) => Promise<SessionBindingRecord[]>;
};

/** A coherent source-owned selection; its assertion also covers absence and replacement. */
export type SessionBindingSelectionSnapshot = {
  bindings: readonly (SessionBindingRecord | null)[];
  assertCurrent: () => void;
};

/** Awaited adapter contract. Synchronous members serve released SDK consumers only. */
export type SessionBindingAdapterV2 = SessionBindingAdapter & {
  version: 2;
  inspectByConversationsAsync: (
    refs: readonly ConversationRef[],
  ) => Promise<SessionBindingSelectionSnapshot>;
  touchAsync: (bindingId: string, at?: number) => Promise<void>;
  /** Rechecks the original owner after awaited work and before accepting mutations. */
  assertCurrent: () => void;
  listBySessionAsync: (targetSessionKey: string) => Promise<SessionBindingRecord[]>;
  inspectByConversationAsync: (ref: ConversationRef) => Promise<SessionBindingRecord | null>;
  resolveByConversationAsync: (ref: ConversationRef) => Promise<SessionBindingRecord | null>;
};
