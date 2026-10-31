import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isSubagentSessionKey } from "../routing/session-key.js";

export async function emitSessionUnboundLifecycleEvent(params: {
  targetSessionKey: string;
  reason: "session-reset" | "session-delete";
  emitHooks?: boolean;
}) {
  const targetKind = isSubagentSessionKey(params.targetSessionKey) ? "subagent" : "acp";
  await getSessionBindingService().unbind({
    targetSessionKey: params.targetSessionKey,
    reason: params.reason,
  });

  if (params.emitHooks === false) {
    return;
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_ended")) {
    return;
  }
  await hookRunner.runSubagentEnded(
    {
      targetSessionKey: params.targetSessionKey,
      targetKind,
      reason: params.reason,
      sendFarewell: true,
      outcome: params.reason === "session-reset" ? "reset" : "deleted",
    },
    {
      childSessionKey: params.targetSessionKey,
    },
  );
}
