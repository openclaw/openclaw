import { deliveryContextFromConversation } from "../../../channels/route-projection.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { summarizeSpawnError } from "../../spawn-pipeline.js";
import { prepareSpawnThreadBinding } from "../../spawn-plan.js";
import { buildSpawnThreadBinding } from "./spawn-thread-binding.js";
import {
  getSessionBindingService,
  listSessionBindingsBySessionAsync,
} from "./subagent-spawn.runtime.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

export async function bindThreadForSubagentSpawn(params: {
  assertActive?: () => void;
  cfg: OpenClawConfig;
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: SpawnSubagentMode;
  requesterSessionKey?: string;
  requester: DeliveryContext;
}): Promise<
  | { status: "ok"; deliveryOrigin?: DeliveryContext }
  | {
      status: "error";
      error: string;
    }
> {
  const prepared = await prepareSpawnThreadBinding({
    cfg: params.cfg,
    kind: "subagent",
    mode: params.mode,
    bindingService: {
      ...getSessionBindingService(),
      listBySession: listSessionBindingsBySessionAsync,
    },
    requesterSessionKey: params.requesterSessionKey,
    channel: params.requester.channel,
    accountId: params.requester.accountId,
    to: params.requester.to,
    threadId: params.requester.threadId,
  });
  if (!prepared.ok) {
    return {
      status: "error",
      error: prepared.error,
    };
  }

  try {
    params.assertActive?.();
    const binding = await getSessionBindingService().bind(
      buildSpawnThreadBinding({
        cfg: params.cfg,
        sessionKey: params.childSessionKey,
        targetKind: "subagent",
        agentId: params.agentId,
        label: params.label,
        binding: prepared.binding,
      }),
    );
    if (!binding.conversation.conversationId) {
      return {
        status: "error",
        error:
          "Unable to create or bind a thread for this subagent session. Session mode is unavailable for this target.",
      };
    }
    const deliveryOrigin = deliveryContextFromConversation(binding.conversation);
    return {
      status: "ok",
      ...(deliveryOrigin ? { deliveryOrigin } : {}),
    };
  } catch (err) {
    return {
      status: "error",
      error: `Thread bind failed: ${summarizeSpawnError(err)}`,
    };
  }
}
