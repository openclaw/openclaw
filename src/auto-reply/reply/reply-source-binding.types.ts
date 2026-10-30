import type { SessionControllerInput } from "../../sessions/session-controller.contracts.js";

// Host-only, enumerable binding: ordinary lifecycle/options spreads retain the
// exact mailbox input without adding controller capabilities to the public API.
export const replySource = Symbol.for("openclaw.replySourceInput");
export type ReplySourceBinding = { [replySource]?: SessionControllerInput };
