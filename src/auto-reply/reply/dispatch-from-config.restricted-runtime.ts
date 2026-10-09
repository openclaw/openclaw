import type { ReplyPayload } from "../types.js";
import { admittedSessionSettingsRestrictRuntime } from "./dispatch-from-config.events.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";

const RESTRICTED_RUNTIME_TAKEOVER_ERROR =
  "This session's bound runtime cannot enforce its permission or tool policy; use an embedded runtime for this restricted conversation.";

export type DispatchTakeoverReply = {
  payload: ReplyPayload;
  deliveryId: string;
  recordProcessed: () => void;
};

export function resolveRestrictedRuntimeTakeover(
  state: PrepareDispatchOperationReadyState,
): DispatchTakeoverReply | undefined {
  if (
    state.dispatchKind !== "acp" ||
    !admittedSessionSettingsRestrictRuntime(state.params.replyOptions?.admittedSessionSettings)
  ) {
    return undefined;
  }
  return {
    payload: { text: RESTRICTED_RUNTIME_TAKEOVER_ERROR, isError: true },
    deliveryId: "restricted-runtime-takeover",
    recordProcessed: () =>
      state.recordProcessed("error", {
        reason: "restricted_runtime_takeover",
        error: RESTRICTED_RUNTIME_TAKEOVER_ERROR,
      }),
  };
}
