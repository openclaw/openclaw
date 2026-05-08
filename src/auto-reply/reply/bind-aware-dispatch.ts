/**
 * Bind-aware persistent dispatcher fallback (Gap 1 fix).
 *
 * When the parent dispatcher's run ends mid-stream and its sends start
 * returning false, this module consults the session binding service to
 * find active bound conversations and routes payloads via `routeReply`
 * directly — independent of the parent's run lifecycle.
 *
 * This ensures spawn-child outbound events keep reaching the user even
 * after the parent turn completes, which is the root cause described in
 * catalog finding #1 / #15.
 */

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
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
 * Attempt to deliver a payload to all active bound conversations for the
 * given session key via `routeReply`, bypassing the parent dispatcher.
 *
 * Returns true if at least one bound conversation received the payload.
 */
export async function deliverViaSessionBindings(params: {
  sessionKey: string;
  kind: ReplyDispatchKind;
  payload: ReplyPayload;
  cfg: OpenClawConfig;
}): Promise<boolean> {
  const { getSessionBindingService } = await loadDispatchAcpManagerRuntime();
  const bindingService = getSessionBindingService();
  const bindings = bindingService.listBySession(params.sessionKey);
  if (bindings.length === 0) {
    return false;
  }

  const { routeReply } = await loadRouteReplyRuntime();
  let delivered = false;

  for (const binding of bindings) {
    if (binding.status !== "active") {
      continue;
    }
    const channel = normalizeOptionalLowercaseString(binding.conversation.channel);
    const to = normalizeOptionalString(binding.conversation.conversationId);
    if (!channel || !to) {
      continue;
    }
    try {
      const result = await routeReply({
        payload: params.payload,
        channel,
        to,
        accountId: normalizeOptionalString(binding.conversation.accountId) ?? undefined,
        sessionKey: params.sessionKey,
        cfg: params.cfg,
        mirror: false,
      });
      if (result.ok) {
        delivered = true;
      } else {
        logVerbose(
          `bind-aware-dispatch: routeReply failed for binding ${binding.bindingId} (${channel}/${to}): ${result.error ?? "unknown error"}`,
        );
      }
    } catch (err) {
      logVerbose(
        `bind-aware-dispatch: routeReply threw for binding ${binding.bindingId} (${channel}/${to}): ${formatErrorMessage(err)}`,
      );
    }
  }

  return delivered;
}
