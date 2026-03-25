// Test helper: shared capture object for inbound context contract tests.
import type { MsgContext } from "../../../auto-reply/templating.js";

/** Mutable capture object for the most-recent dispatched inbound MsgContext. */
export const inboundCtxCapture: { ctx: MsgContext | undefined } = {
  ctx: undefined,
};
