import type { ConversationRef, SessionBindingRecord } from "./session-binding.types.js";

/** Private core capability; kept outside the public adapter contract and SDK. */
export const nativeSessionBindingSelection = Symbol.for("openclaw.sessionBinding.nativeSelection");

export type NativeSessionBindingSelection = {
  [nativeSessionBindingSelection]?: (
    refs: readonly ConversationRef[],
  ) => Promise<ReadonlyArray<SessionBindingRecord | null>>;
};

/** Core-owned SQLite adapters enumerate through their original worker; SDK adapters keep their contract. */
export const nativeSessionBindingListBySession = Symbol.for(
  "openclaw.sessionBinding.nativeListBySession",
);

export type NativeSessionBindingListing = {
  [nativeSessionBindingListBySession]?: (
    targetSessionKey: string,
  ) => Promise<SessionBindingRecord[]>;
};
