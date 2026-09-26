import { asOptionalRecord as asResultRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GatewayProtocolRequestTimeoutError } from "../../../packages/gateway-client/src/protocol-request.js";
import { GatewayErrorDetailCodes } from "../../../packages/gateway-protocol/src/gateway-error-details.js";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import { stripPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/index.js";
import {
  readPositiveIntegerParam,
  readStringArrayParam,
  readToolStringParam,
} from "../../agents/tools/common.js";
import type { OutboundReplyFacts } from "../../channels/message/types.js";
import { normalizeConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type {
  ChannelId,
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import { isChannelPartialDeliveryError } from "../../channels/turn/partial-delivery-error.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeMessagePresentation } from "../../interactive/payload.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { extractToolPayload } from "../../plugin-sdk/tool-payload.js";
import { resolvePollMaxSelections } from "../../polls.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { stripUnsupportedCitationControlMarkers } from "../../shared/text/citation-control-markers.js";
import { formatErrorMessage } from "../errors.js";
import { throwIfAborted } from "./abort.js";
import { assertOutboundHandoffCurrent, OutboundHandoffRejectedError } from "./deliver-handoff.js";
import {
  createChannelActionContext,
  type MessageActionGateway,
  type MessageActionResult,
  type ResolvedActionContext,
} from "./message-action-contracts.js";
import { annotateSourceDelivery } from "./message-action-result-acceptance.js";
import { resolveAndApplyOutboundThreadId } from "./message-action-threading.js";
import {
  resolveOutboundMessageGatewayOptions,
  type OutboundGatewayRequestContext,
} from "./message-gateway-options.js";
import {
  applyCrossContextDecoration,
  buildCrossContextDecoration,
  type CrossContextDecoration,
  shouldApplyCrossContextMarker,
} from "./outbound-policy.js";
import { executePollAction } from "./outbound-send-service.js";
import {
  beginTerminalSourceReplyDelivery,
  cancelTerminalSourceReplyDelivery,
  reconcileTerminalSourceReplyDelivery,
} from "./source-reply-mirror.js";

export { annotateSourceDelivery } from "./message-action-result-acceptance.js";

const log = createSubsystemLogger("outbound/message-action");

// Gateway runtime is only needed for remote message action dispatch or
// idempotency keys; keep normal in-process actions import-light.
const loadMessageActionGatewayRuntime = createLazyRuntimeModule(
  () => import("./message.gateway.runtime.js"),
);

const MESSAGE_ACTION_RECONCILIATION_TIMEOUT_MS = 60_000;
const MESSAGE_ACTION_RECONCILIATION_MAX_MS = 9 * 60_000;
const MESSAGE_ACTION_INITIAL_SEND_TIMEOUT_MAX_MS = 30_000;

async function callGatewayMessageAction<T>(params: {
  gateway?: MessageActionGateway;
  actionParams: Record<string, unknown>;
  agentRuntimeIdentityToken?: string;
  requestContext?: OutboundGatewayRequestContext;
  abortSignal?: AbortSignal;
  onUnknownDeliveryOutcome?: () => void;
}): Promise<T> {
  const { callGatewayLeastPrivilege, isGatewayTransportError } =
    await loadMessageActionGatewayRuntime();
  const gateway = resolveOutboundMessageGatewayOptions(params.gateway);
  // A timed-out send is reattached with the same idempotency key. Cap only the
  // initial wait so the 9-minute join remains inside Codex's 10-minute tool envelope.
  const timeoutMs =
    params.actionParams.action === "send"
      ? Math.min(gateway.timeoutMs, MESSAGE_ACTION_INITIAL_SEND_TIMEOUT_MAX_MS)
      : gateway.timeoutMs;
  const call = {
    ...gateway,
    method: "message.action",
    params: params.actionParams,
    timeoutMs,
    signal: params.abortSignal,
    agentRuntimeIdentityToken: params.agentRuntimeIdentityToken,
  };
  const request = <R>(
    options: typeof call | (Omit<typeof call, "timeoutMs"> & { timeoutMs: number | null }),
  ) =>
    params.gateway?.request
      ? params.gateway.request<R>(options, params.requestContext)
      : callGatewayLeastPrivilege<R>(options);
  try {
    return await request<T>(call);
  } catch (error) {
    if (
      !(
        (isGatewayTransportError(error) && error.kind === "timeout") ||
        (error instanceof GatewayProtocolRequestTimeoutError && error.requestSent)
      ) ||
      params.actionParams.action !== "send"
    ) {
      throw error;
    }
    // The Gateway may still finish the first request after the local timer.
    // Nothing learned by a later reattach can prove that attempt did not send.
    params.onUnknownDeliveryOutcome?.();
    throwIfAborted(params.abortSignal);
  }

  const reconciliationSignal = params.abortSignal
    ? AbortSignal.any([
        params.abortSignal,
        AbortSignal.timeout(MESSAGE_ACTION_RECONCILIATION_MAX_MS),
      ])
    : undefined;
  const reconciliationCall = {
    ...call,
    // `null` keeps startup bounded but removes the per-request timer after
    // hello. The dedicated signal bounds a joined in-flight action without
    // reconnecting every minute or inheriting the run's much longer lifetime.
    timeoutMs: params.abortSignal
      ? null
      : Math.max(call.timeoutMs, MESSAGE_ACTION_RECONCILIATION_TIMEOUT_MS),
    signal: reconciliationSignal,
  };
  // A caller-side timeout does not cancel Gateway work. Reattach once with the
  // unchanged idempotency key so the live Gateway can join the original work.
  return await request<T>(reconciliationCall);
}

function isConfirmedGatewayMessageActionRejection(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "GatewayClientRequestError") {
    return false;
  }
  const requestError = error as Error & { details?: unknown; gatewayCode?: unknown };
  if (typeof requestError.gatewayCode !== "string" || requestError.gatewayCode.length === 0) {
    return false;
  }
  if (requestError.gatewayCode !== ErrorCodes.UNAVAILABLE) {
    // Authorization, scope, validation, and unknown-method errors are emitted
    // before message.action enters its provider dispatch path.
    return true;
  }
  const details = requestError.details;
  // Gateway startup/suspension rejection carries the method name. Provider
  // exceptions use an unstructured UNAVAILABLE response and remain ambiguous.
  return (
    details !== null &&
    typeof details === "object" &&
    (details as { method?: unknown }).method === "message.action"
  );
}

export function projectMessageActionPartialDelivery(error: unknown) {
  const directDelivery = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
  const gatewayDelivery =
    error instanceof Error && error.name === "GatewayClientRequestError"
      ? asResultRecord(asResultRecord(error)?.details)?.partialDelivery
      : undefined;
  const deliveryResult = directDelivery ?? gatewayDelivery;
  return deliveryResult === undefined
    ? undefined
    : {
        ok: false as const,
        deliveryStatus: "partial_failed" as const,
        sentBeforeError: true as const,
        error: formatErrorMessage(error),
        result: deliveryResult,
      };
}

export function projectGatewayQueuedDeliveryResult(error: unknown) {
  if (!(error instanceof Error) || error.name !== "GatewayClientRequestError") {
    return undefined;
  }
  const details = asResultRecord(asResultRecord(error)?.details);
  if (details?.code !== GatewayErrorDetailCodes.OUTBOUND_DELIVERY_QUEUED) {
    return undefined;
  }
  return {
    status: "delivery_queued",
    delivered: false as const,
    message: `Delivery is pending: ${error.message}. The gateway owns retry or reconciliation; delivery is not yet confirmed. Do not resend it.`,
  };
}

async function resolveGatewayActionIdempotencyKey(idempotencyKey?: string): Promise<string> {
  if (idempotencyKey) {
    return idempotencyKey;
  }
  const { randomIdempotencyKey } = await loadMessageActionGatewayRuntime();
  return randomIdempotencyKey();
}

function applyCrossContextMessageDecoration({
  params,
  message,
  decoration,
  preferPresentation,
}: {
  params: Record<string, unknown>;
  message: string;
  decoration: CrossContextDecoration;
  preferPresentation: boolean;
}): string {
  const applied = applyCrossContextDecoration({
    message,
    decoration,
    preferPresentation,
  });
  params.message = applied.message;
  if (applied.presentation) {
    const existing = normalizeMessagePresentation(params.presentation);
    params.presentation = existing
      ? {
          ...existing,
          blocks: [...applied.presentation.blocks, ...existing.blocks],
        }
      : applied.presentation;
  }
  return applied.message;
}

export async function applyMessageCrossContextMarker(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  action: ChannelMessageActionName;
  target: string;
  toolContext?: ChannelThreadingToolContext;
  accountId?: string | null;
  agentId?: string | null;
  args: Record<string, unknown>;
  message: string;
  preferPresentation: boolean;
}): Promise<string> {
  if (!shouldApplyCrossContextMarker(params.action) || !params.toolContext) {
    return params.message;
  }
  const decoration = await buildCrossContextDecoration({
    cfg: params.cfg,
    channel: params.channel,
    target: params.target,
    toolContext: params.toolContext,
    accountId: params.accountId ?? undefined,
    agentId: params.agentId ?? undefined,
  });
  if (!decoration) {
    return params.message;
  }
  return applyCrossContextMessageDecoration({
    params: params.args,
    message: params.message,
    decoration,
    preferPresentation: params.preferPresentation,
  });
}

export async function executeGatewayAction(
  ctx: ResolvedActionContext,
  params: {
    action: ChannelMessageActionName;
    reply?: OutboundReplyFacts;
    result: (payload: unknown) => MessageActionResult;
  },
): Promise<MessageActionResult | null> {
  if (ctx.dryRun || !ctx.gateway) {
    return null;
  }
  const channelPlugin = ctx.channelPlugin;
  const supportsCanonicalGatewayDelivery =
    Boolean(ctx.input.messageActionAuthorization?.scheduled && ctx.gateway.request) &&
    channelPlugin?.outbound?.deliveryMode === "gateway" &&
    ((params.action === "send" &&
      Boolean(channelPlugin.message?.send?.text || channelPlugin.outbound.sendText)) ||
      (params.action === "poll" && Boolean(channelPlugin.outbound.sendPoll))) &&
    (!channelPlugin.actions?.handleAction ||
      channelPlugin.actions.supportsAction?.({ action: params.action }) === false);
  if (!channelPlugin?.actions?.handleAction && !supportsCanonicalGatewayDelivery) {
    return null;
  }
  const executionMode =
    channelPlugin.actions?.resolveExecutionMode?.({ action: params.action }) ?? "local";
  if (executionMode !== "gateway" && !supportsCanonicalGatewayDelivery) {
    return null;
  }
  const conversationReadOrigin = normalizeConversationReadInvocationOrigin(
    ctx.input.conversationReadOrigin,
  );
  const idempotencyKey = await resolveGatewayActionIdempotencyKey(
    normalizeOptionalString(ctx.params.idempotencyKey),
  );
  const callerOwnsTerminalReceipt =
    ctx.gateway.terminalSourceReplyReceiptOwner === "caller" && ctx.input.sourceReplyFinal === true;
  // Resolve local capability/auth preflight before arming a durable send intent.
  // A failure here proves the RPC never reached the gateway.
  const requestContext = {
    sourceReplyFinal: ctx.input.sourceReplyFinal,
    sourceReplyToolCallId: ctx.input.sourceReplyToolCallId,
  };
  const agentRuntimeIdentityToken = ctx.gateway.request
    ? undefined
    : await ctx.gateway.resolveAgentRuntimeIdentityToken?.(requestContext);
  const sourceReplyMirror = {
    action: params.action,
    channel: ctx.channel,
    actionParams: ctx.params,
    cfg: ctx.cfg,
    accountId: ctx.accountId,
    currentAccountId:
      ctx.input.messageActionAuthorization?.requesterAccountId ?? ctx.input.defaultAccountId,
    sessionKey: ctx.input.sourceReplySessionKey ?? ctx.input.sessionKey,
    sessionId: ctx.input.sessionId,
    agentId: ctx.agentId,
    toolContext: ctx.input.messageActionAuthorization?.toolContext,
    replyToIsExplicit: params.reply?.source === "explicit",
    idempotencyKey,
    sourceReplyFinal: ctx.input.sourceReplyFinal,
    toolCallId: ctx.input.sourceReplyToolCallId,
  };
  const terminalDeliveryStart = callerOwnsTerminalReceipt
    ? await beginTerminalSourceReplyDelivery(sourceReplyMirror)
    : undefined;
  if (terminalDeliveryStart && "outcome" in terminalDeliveryStart) {
    return params.result(terminalDeliveryStart.result);
  }
  const terminalDeliveryReceipt = terminalDeliveryStart;
  let hadUnknownDeliveryOutcome = false;
  let payload: unknown;
  try {
    assertOutboundHandoffCurrent(ctx.input.assertDirectAdapterHandoff);
    payload = await callGatewayMessageAction<unknown>({
      gateway: ctx.gateway,
      abortSignal: ctx.input.abortSignal,
      agentRuntimeIdentityToken,
      requestContext,
      onUnknownDeliveryOutcome: () => {
        hadUnknownDeliveryOutcome = true;
      },
      actionParams: {
        channel: ctx.channel,
        action: params.action,
        params: ctx.params,
        ...(params.reply ? { reply: params.reply } : {}),
        accountId: ctx.accountId ?? undefined,
        senderIsOwner: ctx.input.senderIsOwner,
        sessionKey: ctx.input.sessionKey,
        sessionId: ctx.input.sessionId,
        inboundTurnKind: ctx.input.inboundEventKind,
        agentId: ctx.agentId,
        ...(conversationReadOrigin === "direct-operator" ? { conversationReadOrigin } : {}),
        ...(ctx.input.messageActionAuthorization?.scheduled &&
        ctx.input.allowNativeChannelNamespace !== undefined
          ? { allowNativeChannelNamespace: ctx.input.allowNativeChannelNamespace }
          : {}),
        idempotencyKey,
      },
    });
  } catch (error) {
    const partialDelivery = ctx.input.messageActionAuthorization?.scheduled
      ? projectMessageActionPartialDelivery(error)
      : undefined;
    if (partialDelivery !== undefined) {
      payload = partialDelivery;
    } else {
      if (
        callerOwnsTerminalReceipt &&
        !hadUnknownDeliveryOutcome &&
        (error instanceof OutboundHandoffRejectedError ||
          isConfirmedGatewayMessageActionRejection(error))
      ) {
        await cancelTerminalSourceReplyDelivery(terminalDeliveryReceipt);
      }
      throw error;
    }
  }
  if (callerOwnsTerminalReceipt) {
    try {
      await reconcileTerminalSourceReplyDelivery({
        deliveredPayload: payload,
        mirror: sourceReplyMirror,
        receipt: terminalDeliveryReceipt,
        ...(hadUnknownDeliveryOutcome ? { preservePendingOnExplicitFailure: true } : {}),
      });
    } catch (error) {
      // The pre-send intent remains durable. Return the provider result so the
      // model cannot retry an external effect with an unknown outcome.
      log.warn("Terminal source reply receipt reconciliation failed.", {
        channel: ctx.channel,
        sessionKey: ctx.input.sessionKey,
        error: formatErrorMessage(error),
      });
    }
  }
  const result = params.result(payload);
  if (!supportsCanonicalGatewayDelivery) {
    return result;
  }
  const partialDelivery = asResultRecord(payload)?.deliveryStatus === "partial_failed";
  if (result.kind === "send") {
    return {
      ...result,
      handledBy: "core",
      ...(partialDelivery
        ? {}
        : {
            // SAFETY: successful canonical Gateway sends return MessageSendResult payloads.
            sendResult: payload as Extract<MessageActionResult, { kind: "send" }>["sendResult"],
          }),
    };
  }
  if (result.kind === "poll") {
    return {
      ...result,
      handledBy: "core",
      ...(partialDelivery
        ? {}
        : {
            // SAFETY: successful canonical Gateway polls return MessagePollResult payloads.
            pollResult: payload as Extract<MessageActionResult, { kind: "poll" }>["pollResult"],
          }),
    };
  }
  return result;
}

export async function executeMessagePoll(ctx: ResolvedActionContext): Promise<MessageActionResult> {
  const { cfg, params, channel, channelPlugin, accountId, dryRun, input, agentId, abortSignal } =
    ctx;
  throwIfAborted(abortSignal);
  const action: ChannelMessageActionName = "poll";
  const to = readToolStringParam(params, "to", { required: true });
  const silent = readBooleanParam(params, "silent");

  const resolvedThreadId = resolveAndApplyOutboundThreadId(params, {
    cfg,
    to,
    accountId,
    toolContext: input.toolContext,
    resolveAutoThreadId: channelPlugin?.threading?.resolveAutoThreadId,
  });

  const base = typeof params.message === "string" ? params.message : "";
  await applyMessageCrossContextMarker({
    cfg,
    channel,
    action,
    target: to,
    toolContext: input.toolContext,
    accountId,
    agentId,
    args: params,
    message: base,
    preferPresentation: false,
  });

  const gatewayPluginAction = await executeGatewayAction(ctx, {
    action,
    result: (payload) => ({
      kind: "poll",
      channel,
      action,
      to,
      handledBy: "plugin",
      payload,
      dryRun,
    }),
  });
  const pollReplyToIsExplicit = Boolean(readToolStringParam(params, "replyTo"));
  if (gatewayPluginAction) {
    return await annotateSourceDelivery(gatewayPluginAction, ctx, pollReplyToIsExplicit);
  }

  const poll = await executePollAction({
    ctx: {
      ...ctx,
      // Poll actions expose requester IDs, turn context, and the same live
      // provider-call fence as every other scheduled message action.
      mediaAccess: undefined,
      input: {
        cfg,
        action,
        params,
        requesterAccountId: input.requesterAccountId,
        requesterSenderId: input.requesterSenderId,
        conversationReadOrigin: input.conversationReadOrigin,
        sessionKey: input.sessionKey,
        sessionId: input.sessionId,
        inboundEventKind: input.inboundEventKind,
        toolContext: input.toolContext,
        messageActionAuthorization: input.messageActionAuthorization,
        gatewayOwnedDelivery: input.gatewayOwnedDelivery,
        onPlatformSendDispatch: input.onPlatformSendDispatch,
        assertDirectAdapterHandoff: input.assertDirectAdapterHandoff,
      },
      silent: silent ?? undefined,
    },
    resolveCorePoll: () => {
      const question = readToolStringParam(params, "pollQuestion", {
        required: true,
      });
      const options = readStringArrayParam(params, "pollOption", { required: true });
      if (options.length < 2) {
        throw new Error("pollOption requires at least two values");
      }
      let content = readToolStringParam(params, "message", { allowEmpty: true, trim: false });
      if (content !== undefined && !content.trim()) {
        content = "";
      }
      const allowMultiselect = readBooleanParam(params, "pollMulti") ?? false;
      const durationHours = readPositiveIntegerParam(params, "pollDurationHours", {
        message: "pollDurationHours must be a positive integer",
      });

      return {
        to,
        question,
        content,
        options,
        maxSelections: resolvePollMaxSelections(options.length, allowMultiselect),
        durationHours: durationHours ?? undefined,
        threadId: resolvedThreadId ?? undefined,
      };
    },
  });

  return await annotateSourceDelivery(
    {
      kind: "poll",
      channel,
      action,
      to,
      handledBy: poll.handledBy,
      payload: poll.payload,
      toolResult: poll.toolResult,
      pollResult: poll.pollResult,
      dryRun,
    },
    ctx,
    pollReplyToIsExplicit,
  );
}

export async function executeMessagePlugin(
  ctx: ResolvedActionContext,
): Promise<MessageActionResult> {
  const {
    cfg,
    params,
    channel,
    channelPlugin,
    mediaAccess,
    accountId,
    dryRun,
    input,
    abortSignal,
  } = ctx;
  throwIfAborted(abortSignal);
  const action = input.action as Exclude<ChannelMessageActionName, "send" | "poll" | "broadcast">;
  const actionResult = {
    kind: "action" as const,
    channel,
    action,
    ...(ctx.resolvedTarget ? { to: ctx.resolvedTarget.to } : {}),
    dryRun,
  };
  if (dryRun) {
    return {
      ...actionResult,
      handledBy: "dry-run",
      payload: { ok: true, dryRun: true, channel, action },
    };
  }

  if (!channelPlugin?.actions?.handleAction) {
    throw new Error(`Channel ${channel} is unavailable for message actions (plugin not loaded).`);
  }

  // Plugin actions bypass buildSendPayloadParts, so model-authored text here
  // never crossed the outbound text hygiene sends get: reply/edit deliveries
  // leaked raw citation control markers to end users.
  const rawActionMessage = params.message;
  if (typeof rawActionMessage === "string" && rawActionMessage) {
    params.message = stripPlainTextToolCallBlocks(
      stripUnsupportedCitationControlMarkers(rawActionMessage),
    );
  }

  // Plugin actions bypass send/poll, so inherit thread metadata before either
  // gateway or local dispatch to keep both execution modes on the same topic.
  const targetForThreading =
    normalizeOptionalString(params.to) ?? normalizeOptionalString(params.channelId) ?? "";
  // File downloads authorize caller-supplied resource scope. Ambient threading
  // must not silently narrow a channel-only request to the current thread.
  if (targetForThreading && action !== "download-file") {
    resolveAndApplyOutboundThreadId(params, {
      cfg,
      to: targetForThreading,
      accountId,
      toolContext: input.toolContext,
      resolveAutoThreadId: channelPlugin.threading?.resolveAutoThreadId,
      resolveReplyTransport: channelPlugin.threading?.resolveReplyTransport,
      replyToIsExplicit: Boolean(readToolStringParam(params, "replyTo")),
    });
  }

  const gatewayPluginAction = await executeGatewayAction(ctx, {
    action,
    result: (payload) => ({
      ...actionResult,
      handledBy: "plugin",
      payload,
    }),
  });
  const replyToIsExplicit = Boolean(readToolStringParam(params, "replyTo"));
  if (gatewayPluginAction) {
    // Gateway-owned actions must execute where the live channel runtime exists.
    return await annotateSourceDelivery(gatewayPluginAction, ctx, replyToIsExplicit);
  }

  const authorization = input.messageActionAuthorization;
  let handled;
  try {
    handled = await dispatchChannelMessageAction({
      ...createChannelActionContext({ ctx, action, mediaAccess }),
      progressSnapshot: input.progressSnapshot,
      requesterAccountId:
        authorization !== undefined
          ? authorization.requesterAccountId
          : (input.requesterAccountId ?? undefined),
      requesterSenderId:
        authorization !== undefined
          ? authorization.requesterSenderId
          : (input.requesterSenderId ?? undefined),
      toolContext: authorization !== undefined ? authorization.toolContext : input.toolContext,
      messageActionAuthorization: authorization,
      deliveryRetryOwner: input.actionOrigin === "message-tool" ? "caller" : undefined,
      skipQueue: input.skipQueue,
    });
  } catch (error) {
    const partialDelivery = input.messageActionAuthorization?.scheduled
      ? projectMessageActionPartialDelivery(error)
      : undefined;
    if (partialDelivery) {
      return await annotateSourceDelivery(
        {
          ...actionResult,
          handledBy: "plugin",
          payload: partialDelivery,
        },
        ctx,
        replyToIsExplicit,
      );
    }
    throw error;
  }
  if (!handled) {
    throw new Error(`Message action ${action} not supported for channel ${channel}.`);
  }
  return await annotateSourceDelivery(
    {
      ...actionResult,
      handledBy: "plugin",
      payload: extractToolPayload(handled),
      toolResult: handled,
    },
    ctx,
    replyToIsExplicit,
  );
}
