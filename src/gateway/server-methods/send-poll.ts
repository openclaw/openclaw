import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, validatePollParams } from "../../../packages/gateway-protocol/src/index.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";
import { normalizePollInput } from "../../polls.js";
import {
  createMessageActionRuntimeAuthority,
  resolveAgentRuntimeMessageActionAuthorization,
  resolveAgentRuntimeMessageActionConfig,
} from "./message-action-context.js";
import {
  buildGatewayDeliveryPayload,
  createGatewayInflightAuthorityFailure,
  createGatewayInflightFailure,
  createGatewayInflightSuccess,
} from "./message-operation-result.js";
import { withMessageOperationRoute } from "./message-operation-route.js";
import { respondError } from "./response.js";
import {
  resolveGatewayOutboundTarget,
  resolveRequestedChannel,
} from "./send-channel-resolution.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const pollHandler: GatewayRequestHandlers["poll"] = async ({
  params: request,
  respond,
  context,
  client,
  sessionMutationCommitGuard,
}) => {
  if (!assertValidParams(request, validatePollParams, "poll", respond)) {
    return;
  }
  const messageAuthority = createMessageActionRuntimeAuthority({
    client,
    sessionMutationCommitGuard,
    request: { action: "poll", accountId: request.accountId, params: {} },
    authorization: resolveAgentRuntimeMessageActionAuthorization(client),
  });
  const messageActionConfig = resolveAgentRuntimeMessageActionConfig(client);
  const assertDirectAdapterHandoff = messageAuthority.assertDirectAdapterHandoff;
  const onPlatformSendDispatch = messageAuthority.onPlatformSendDispatch;
  await withMessageOperationRoute({
    context,
    prefix: "poll",
    idempotencyKey: request.idempotencyKey,
    respond,
    requestChannel: request.channel,
    bindingAccountIds: [request.accountId],
    routeAccountIds: (binding) => [request.accountId, binding?.reservedRoute?.accountId],
    conflictMessage: "poll account selections do not match",
    authority: messageAuthority,
    resolveChannel: async (requestChannel) => {
      const resolved = await resolveRequestedChannel({
        requestChannel,
        unsupportedMessage: (input) => `unsupported poll channel: ${input}`,
        context,
        config: messageActionConfig,
      });
      if ("error" in resolved) {
        respond(false, undefined, resolved.error);
        return undefined;
      }
      const { cfg, channel } = resolved;
      const plugin = resolveOutboundChannelPlugin({ channel, cfg });
      const outbound = plugin?.outbound;
      // Reject channel-specific options before normalization can silently truncate them.
      for (const [parameter, capability] of [
        ["durationSeconds", "supportsPollDurationSeconds"],
        ["isAnonymous", "supportsAnonymousPolls"],
      ] as const) {
        if (request[parameter] !== undefined && outbound?.[capability] !== true) {
          respondError(
            respond,
            ErrorCodes.INVALID_REQUEST,
            `${parameter} is not supported for ${channel} polls`,
          );
          return undefined;
        }
      }
      if (!plugin || !outbound?.sendPoll) {
        respondError(respond, ErrorCodes.INVALID_REQUEST, `unsupported poll channel: ${channel}`);
        return undefined;
      }
      return { cfg, channel, plugin, outbound, sendPoll: outbound.sendPoll };
    },
    work: async ({ cfg, channel, accountId, idem, dedupeKey, outbound, sendPoll, authorize }) => {
      const poll = {
        question: request.question,
        options: request.options,
        maxSelections: request.maxSelections,
        durationSeconds: request.durationSeconds,
        durationHours: request.durationHours,
      };
      const threadId = normalizeOptionalString(request.threadId);
      try {
        const resolvedTarget = await resolveGatewayOutboundTarget({
          channel,
          to: request.to.trim(),
          cfg,
          accountId,
        });
        if (!resolvedTarget.ok) {
          return { ok: false, error: resolvedTarget.error };
        }
        const normalized = outbound.pollMaxOptions
          ? normalizePollInput(poll, { maxOptions: outbound.pollMaxOptions })
          : normalizePollInput(poll);
        if (!authorize()) {
          return createGatewayInflightAuthorityFailure({ context, dedupeKey, channel });
        }
        await messageAuthority.beforeDeliveryAttempt();
        assertDirectAdapterHandoff?.();
        const result = await sendPoll({
          cfg,
          to: resolvedTarget.to,
          poll: normalized,
          accountId,
          threadId,
          silent: request.silent,
          isAnonymous: request.isAnonymous,
          gatewayClientScopes: client?.connect?.scopes ?? [],
          onPlatformSendDispatch,
          assertDirectAdapterHandoff,
        });
        const payload = buildGatewayDeliveryPayload({ runId: idem, channel, result });
        return createGatewayInflightSuccess({ context, dedupeKey, payload, channel });
      } catch (err) {
        return createGatewayInflightFailure({ context, dedupeKey, channel, err }, authorize);
      }
    },
  });
};
