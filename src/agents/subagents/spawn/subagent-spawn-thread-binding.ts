/**
 * Child-thread binding for user-started subagent sessions (`/subagents spawn --thread`).
 * Agent-started spawns never bind; this path only creates a new thread or topic and never
 * binds the conversation the user is in.
 */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveInboundConversationResolution } from "../../../channels/conversation-resolution.js";
import { deliveryContextFromConversation } from "../../../channels/route-projection.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../../../channels/thread-bindings-messages.js";
import {
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingAccountId,
  resolveThreadBindingSpawnPolicy,
} from "../../../channels/thread-bindings-policy.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { summarizeSpawnError } from "../../spawn-pipeline.js";
import { getSessionBindingService } from "./subagent-spawn.runtime.js";

export const CHILD_THREAD_UNAVAILABLE_ERROR =
  "This conversation can't hold a new thread. Run it in a forum group or a server channel.";

export async function bindChildThreadForSubagentSpawn(params: {
  assertActive?: () => void;
  cfg: OpenClawConfig;
  childSessionKey: string;
  agentId: string;
  label?: string;
  boundBy: string;
  requester: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
}): Promise<
  { status: "ok"; deliveryOrigin?: DeliveryContext } | { status: "error"; error: string }
> {
  const channel = normalizeOptionalLowercaseString(params.requester.channel);
  if (!channel) {
    return { status: "error", error: CHILD_THREAD_UNAVAILABLE_ERROR };
  }
  const accountId = resolveThreadBindingAccountId({
    cfg: params.cfg,
    channel,
    accountId: params.requester.accountId,
  });
  const policy = resolveThreadBindingSpawnPolicy({
    cfg: params.cfg,
    channel,
    accountId,
    kind: "subagent",
  });
  if (!policy.enabled) {
    return {
      status: "error",
      error: formatThreadBindingDisabledError({ ...policy, kind: "subagent" }),
    };
  }
  if (!policy.spawnEnabled) {
    return {
      status: "error",
      error: formatThreadBindingSpawnDisabledError({ ...policy, kind: "subagent" }),
    };
  }
  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({
    channel: policy.channel,
    accountId: policy.accountId,
  });
  const conversation = resolveInboundConversationResolution({
    cfg: params.cfg,
    channel: policy.channel,
    accountId: policy.accountId,
    to: params.requester.to,
    threadId: params.requester.threadId,
  });
  if (
    !capabilities.adapterAvailable ||
    !capabilities.bindSupported ||
    !capabilities.placements.includes("child") ||
    !conversation?.conversationId
  ) {
    return { status: "error", error: CHILD_THREAD_UNAVAILABLE_ERROR };
  }

  try {
    params.assertActive?.();
    const binding = await bindingService.bind({
      // The owner's authority is rechecked right before the channel creates the thread.
      ...(params.assertActive ? { assertCurrent: params.assertActive } : {}),
      targetSessionKey: params.childSessionKey,
      targetKind: "subagent",
      conversation: {
        channel: policy.channel,
        accountId: policy.accountId,
        conversationId: conversation.conversationId,
        ...(conversation.parentConversationId
          ? { parentConversationId: conversation.parentConversationId }
          : {}),
      },
      placement: "child",
      metadata: {
        threadName: resolveThreadBindingThreadName({
          agentId: params.agentId,
          label: params.label || params.agentId,
        }),
        agentId: params.agentId,
        label: params.label || undefined,
        boundBy: params.boundBy,
        introText: resolveThreadBindingIntroText({
          agentId: params.agentId,
          label: params.label || undefined,
          idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
            cfg: params.cfg,
            channel: policy.channel,
            accountId: policy.accountId,
          }),
          maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
            cfg: params.cfg,
            channel: policy.channel,
            accountId: policy.accountId,
          }),
        }),
      },
    });
    if (!normalizeOptionalString(binding.conversation.conversationId)) {
      return { status: "error", error: CHILD_THREAD_UNAVAILABLE_ERROR };
    }
    const deliveryOrigin = deliveryContextFromConversation(binding.conversation);
    return { status: "ok", ...(deliveryOrigin ? { deliveryOrigin } : {}) };
  } catch (err) {
    return {
      status: "error",
      error: `${CHILD_THREAD_UNAVAILABLE_ERROR} (${summarizeSpawnError(err)})`,
    };
  }
}
