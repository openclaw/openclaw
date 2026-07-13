import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type {
  PluginHookOutboundDeliveryPolicyDestination,
  PluginHookOutboundDeliveryPolicyEvent,
  PluginHookOutboundDeliveryPolicyResult,
  PluginHookSourcePolicyResult,
} from "./hook-delivery-policy.types.js";
import type { PluginHookMessageContext } from "./hook-message.types.js";
import type { HookRunnerRegistry } from "./hook-registry.types.js";
import { getHooksForName } from "./hook-runner-list.js";
import { acceptPluginReplyPayload, toPluginReplyPayload } from "./hook-runner-reply-payload.js";
import type { PluginHookRegistration } from "./hook-types.js";

function lastDefined<T>(previous: T | undefined, next: T | undefined): T | undefined {
  return next ?? previous;
}

/** Merge restrictive source-policy results in plugin priority order. */
export function mergeSourcePolicyResults(
  accumulated: PluginHookSourcePolicyResult | undefined,
  next: PluginHookSourcePolicyResult,
): PluginHookSourcePolicyResult {
  return {
    sourceReplyDeliveryMode:
      accumulated?.sourceReplyDeliveryMode === "message_tool_only" ||
      next.sourceReplyDeliveryMode === "message_tool_only"
        ? "message_tool_only"
        : undefined,
    promptBody: lastDefined(accumulated?.promptBody, next.promptBody),
    currentInboundContext: Object.hasOwn(next, "currentInboundContext")
      ? next.currentInboundContext
      : accumulated?.currentInboundContext,
    suppressConversationContext:
      accumulated?.suppressConversationContext === true || next.suppressConversationContext === true
        ? true
        : undefined,
    reason: lastDefined(accumulated?.reason, next.reason),
  };
}

function acceptDestination(
  previous: PluginHookOutboundDeliveryPolicyDestination,
  next: PluginHookOutboundDeliveryPolicyDestination,
): PluginHookOutboundDeliveryPolicyDestination {
  return {
    channel: next.channel,
    to: next.to,
    conversationId: next.conversationId || next.to,
    ...(next.accountId ? { accountId: next.accountId } : {}),
    ...(next.threadId !== undefined ? { threadId: next.threadId } : {}),
    path: next.path ?? previous.path,
  };
}

type OutboundPolicyRegistration = PluginHookRegistration<"outbound_delivery_policy">;

/** Run destination-aware outbound policy hooks sequentially. */
export async function runOutboundDeliveryPolicyHooks(params: {
  registry: HookRunnerRegistry;
  event: PluginHookOutboundDeliveryPolicyEvent;
  ctx: PluginHookMessageContext;
  debug?: (message: string) => void;
  invoke: (
    hook: OutboundPolicyRegistration,
    event: PluginHookOutboundDeliveryPolicyEvent,
    ctx: PluginHookMessageContext,
  ) => Promise<PluginHookOutboundDeliveryPolicyResult | void>;
  onError: (hook: OutboundPolicyRegistration, error: unknown) => void;
}): Promise<PluginHookOutboundDeliveryPolicyResult | undefined> {
  const hooks = getHooksForName(params.registry, "outbound_delivery_policy");
  if (hooks.length === 0) {
    return undefined;
  }
  params.debug?.(`[hooks] running outbound_delivery_policy (${hooks.length} handlers, sequential)`);

  let currentPayload: ReplyPayload = params.event.payload;
  let currentDestination = params.event.destination;
  let result: PluginHookOutboundDeliveryPolicyResult | undefined;
  let decision: "allow" | "cancel" | "reroute" | undefined;

  for (const hook of hooks) {
    try {
      const handlerResult = await params.invoke(
        hook,
        {
          ...params.event,
          payload: toPluginReplyPayload(currentPayload),
          destination: currentDestination,
        },
        params.ctx,
      );
      if (!handlerResult) {
        continue;
      }
      if (handlerResult.payload !== undefined) {
        currentPayload = acceptPluginReplyPayload(currentPayload, handlerResult.payload);
      }
      if (handlerResult.decision === "reroute") {
        currentDestination = acceptDestination(currentDestination, handlerResult.destination);
        decision = "reroute";
      } else if (handlerResult.decision === "cancel") {
        decision = "cancel";
      } else if (!decision) {
        decision = "allow";
      }
      const reason = lastDefined(result?.reason, handlerResult.reason);
      result =
        decision === "reroute"
          ? { decision, payload: currentPayload, destination: currentDestination, reason }
          : { decision: decision ?? "allow", payload: currentPayload, reason };
      if (handlerResult.decision === "cancel") {
        params.debug?.(
          `[hooks] outbound_delivery_policy cancel decided by ${hook.pluginId} (priority=${hook.priority ?? 0}); skipping remaining handlers`,
        );
        break;
      }
    } catch (error) {
      params.onError(hook, error);
    }
  }
  return result;
}
