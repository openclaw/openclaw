/**
 * Bind-aware persistent dispatcher fallback (Gap 1 fix).
 *
 * When the parent dispatcher's async transport starts failing (e.g., because the
 * parent run ended mid-stream), this module consults the session binding service
 * to find the active bound conversation for the requester and routes payloads via
 * `routeReply` directly — independent of the parent's run lifecycle.
 *
 * Routing is requester-scoped: if a requester conversation is provided, it is used
 * to resolve a single matching binding via `createBoundDeliveryRouter`. If the
 * resolution is ambiguous (multiple active bindings, no requester match), the
 * fallback fails closed — the payload is dropped and logged rather than broadcast
 * to unrelated conversations.
 *
 * This ensures spawn-child outbound events keep reaching the user even after the
 * parent turn completes, which is the root cause described in catalog finding #1 / #15.
 */

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createBoundDeliveryRouter } from "../../infra/outbound/bound-delivery-router.js";
import type { ConversationRef } from "../../infra/outbound/session-binding-service.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import type { ReplyPayload } from "../types.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";

const dispatchAcpManagerRuntimeLoader = createLazyImportLoader(
  () => import("./dispatch-acp-manager.runtime.js"),
);
const routeReplyRuntimeLoader = createLazyImportLoader(() => import("./route-reply.runtime.js"));

function loadDispatchAcpManagerRuntime() {
  return dispatchAcpManagerRuntimeLoader.load();
}

function loadRouteReplyRuntime() {
  return routeReplyRuntimeLoader.load();
}

/**
 * Attempt to deliver a payload to the bound conversation for the given session key
 * via `routeReply`, bypassing the parent dispatcher.
 *
 * Uses requester context to resolve a single binding. Fails closed when the
 * requester is absent and there are multiple active bindings (ambiguous), to
 * prevent broadcasting a private child update to unrelated bound chats.
 *
 * Returns true if the payload was delivered to the resolved bound conversation.
 */
export async function deliverViaSessionBindings(params: {
  sessionKey: string;
  kind: ReplyDispatchKind;
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  requesterConversation?: ConversationRef;
}): Promise<boolean> {
  const { getSessionBindingService } = await loadDispatchAcpManagerRuntime();
  const bindingService = getSessionBindingService();

  const router = createBoundDeliveryRouter(bindingService);
  const resolution = router.resolveDestination({
    eventKind: "task_completion",
    targetSessionKey: params.sessionKey,
    requester: params.requesterConversation,
    // Fail closed: do not broadcast to unrelated bindings when requester context
    // is missing and multiple active bindings exist.
    failClosed: true,
  });

  if (!resolution.binding) {
    if (resolution.reason !== "no-active-binding") {
      // Ambiguous or invalid requester — log and drop rather than broadcast.
      logVerbose(
        `bind-aware-dispatch: dropping payload for session ${params.sessionKey} (${resolution.reason}); payload not delivered`,
      );
    }
    return false;
  }

  const binding = resolution.binding;
  const channel = normalizeOptionalLowercaseString(binding.conversation.channel);
  const to = normalizeOptionalString(binding.conversation.conversationId);
  if (!channel || !to) {
    logVerbose(
      `bind-aware-dispatch: binding ${binding.bindingId} has invalid channel/to — skipping`,
    );
    return false;
  }

  try {
    const { routeReply } = await loadRouteReplyRuntime();
    const result = await routeReply({
      payload: params.payload,
      channel,
      to,
      accountId: normalizeOptionalString(binding.conversation.accountId) ?? undefined,
      sessionKey: params.sessionKey,
      cfg: params.cfg,
      mirror: false,
    });
    if (!result.ok) {
      logVerbose(
        `bind-aware-dispatch: routeReply failed for binding ${binding.bindingId} (${channel}/${to}): ${result.error ?? "unknown error"}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    logVerbose(
      `bind-aware-dispatch: routeReply threw for binding ${binding.bindingId} (${channel}/${to}): ${formatErrorMessage(err)}`,
    );
    return false;
  }
}
