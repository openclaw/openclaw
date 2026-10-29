import { keyboardHints } from "../keyboard-hints.ts";
import { createSharedSourceProjection } from "./shared-owner-projection.ts";

/** One shared projection; every keycap reads it instead of subscribing itself. */
export const keyboardHintsVisible = createSharedSourceProjection({
  read: (owner: typeof keyboardHints) => owner.visible(),
  subscribe: (owner, notify) => owner.subscribe(notify),
})(keyboardHints).read;
