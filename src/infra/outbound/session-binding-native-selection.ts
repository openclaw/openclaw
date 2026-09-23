import type { ConversationRef, SessionBindingRecord } from "./session-binding.types.js";

/** Private core capability; kept outside the public adapter contract and SDK. */
export const nativeSessionBindingSelection = Symbol.for("openclaw.sessionBinding.nativeSelection");

export type NativeSessionBindingSelection = {
  [nativeSessionBindingSelection]?: (
    refs: readonly ConversationRef[],
  ) => Promise<ReadonlyArray<SessionBindingRecord | null>>;
};
