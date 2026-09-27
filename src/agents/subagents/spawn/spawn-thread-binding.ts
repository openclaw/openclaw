import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../../../channels/thread-bindings-messages.js";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "../../../channels/thread-bindings-policy.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SessionBindingBindInput } from "../../../infra/outbound/session-binding-service.js";
import type { PreparedSpawnThreadBinding } from "../../spawn-plan.js";

export function buildSpawnThreadBinding(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  targetKind: "session" | "subagent";
  agentId: string;
  label?: string;
  binding: PreparedSpawnThreadBinding;
  sessionCwd?: string;
  sessionDetails?: string[];
}): SessionBindingBindInput {
  const { cfg, agentId, label, binding } = params;
  return {
    targetSessionKey: params.sessionKey,
    targetKind: params.targetKind,
    conversation: {
      channel: binding.channel,
      accountId: binding.accountId,
      conversationId: binding.conversationId,
      ...(binding.parentConversationId
        ? { parentConversationId: binding.parentConversationId }
        : {}),
    },
    placement: binding.placement,
    metadata: {
      threadName: resolveThreadBindingThreadName({ agentId, label: label || agentId }),
      agentId,
      label: label || undefined,
      boundBy: "system",
      introText: resolveThreadBindingIntroText({
        agentId,
        label: label || undefined,
        idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
          cfg,
          channel: binding.channel,
          accountId: binding.accountId,
        }),
        maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
          cfg,
          channel: binding.channel,
          accountId: binding.accountId,
        }),
        sessionCwd: params.sessionCwd,
        sessionDetails: params.sessionDetails,
      }),
    },
  };
}
