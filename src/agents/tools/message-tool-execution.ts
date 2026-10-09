import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveActiveReplyOperationForSessionId } from "../../auto-reply/reply/reply-run-registry.js";
import { isScheduledMessageWriteAction } from "../../channels/plugins/message-action-dispatch.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { resolveCommandSecretRefsViaGateway } from "../../cli/command-secret-gateway.js";
import { getScopedChannelsCommandSecretTargets } from "../../cli/command-secret-targets.js";
import { resolveMessageSecretScope } from "../../cli/message-secret-scope.js";
import { getRuntimeConfig } from "../../config/config.js";
import * as messageActionTurnCapability from "../../gateway/message-action-turn-capability.js";
import type { MessageActionAuthorization } from "../../gateway/message-action-turn-capability.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import {
  resolveMessageBroadcastAccountPlan,
  validateExplicitMessageAccountSelection,
} from "../../infra/outbound/message-account-selection.js";
import type { MessageActionResult } from "../../infra/outbound/message-action-contracts.js";
import { projectGatewayQueuedDeliveryResult } from "../../infra/outbound/message-action-execution.js";
import { hasAcceptedMessageActionResult } from "../../infra/outbound/message-action-result-acceptance.js";
import { getToolResult, runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { enforceMessageActionAllowlist } from "../../infra/outbound/outbound-policy.js";
import { isDeliveredCurrentSourceReplyAsync } from "../../infra/outbound/source-reply-mirror.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { getPreparedMessageToolCatalog } from "../../plugins/prepared-message-tool-catalog.js";
import { withChannelReadAuthority } from "../../shared/channel-read-authority.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import * as embeddedMessageDelivery from "../embedded-agent-message-delivery.js";
import { createSandboxBridgeReadFile } from "../sandbox-media-paths.js";
import { type AnyAgentTool, jsonResult, readToolStringParam } from "./common.js";
import { captureGatewayToolCallerAssertion } from "./gateway-caller-context.js";
import {
  createMessageToolDecisionRecorder,
  resolveTrustedDecisionChannel,
} from "./message-tool-decision.js";
import {
  buildMessageToolDescription,
  buildMessageToolSchema,
  type MessageToolDiscoveryParams,
  resolveAgentAccountId,
  resolveEffectiveCurrentChannelContext,
  resolveEffectiveCurrentChannelContextForRequest,
  resolveMessageToolActionSchemaActions,
  resolveMessageToolDiscoveryAsync,
} from "./message-tool-discovery.js";
import type { MessageToolOptions } from "./message-tool-execution.types.js";
import { createMessageToolExplicitTargetGuard } from "./message-tool-explicit-target.js";
import { createMessageToolGateway } from "./message-tool-gateway.js";
import { prepareMessageToolGroupThread } from "./message-tool-group-thread.js";
import { deriveMessageToolIdempotency } from "./message-tool-idempotency.js";
import { resolveOutboundActionRoute } from "./message-tool-outbound-route.js";
import {
  projectScheduledMessageActionPartialResult,
  shouldRevalidateCompletedMessageAction,
} from "./message-tool-scheduled-execution.js";
import { MessageToolSchema } from "./message-tool-schema.js";
import {
  addSourceReplyFinalControl,
  enforceSourceReplyOnlyMessageAction,
  enforceSourceReplyOnlyTextDirectives,
  enforceTrustedTurnExplicitAccount,
  resolveSourceReplySinkDeliveryMode,
  SOURCE_REPLY_ONLY_MESSAGE_SCHEMA,
} from "./message-tool-source-policy.js";
import { createMessageToolTurnAuthority } from "./message-tool-turn-authority.js";
import {
  appendMessageToolNotices,
  prepareMessageToolTurnSendBudget,
  resolveTurnSendBudgetContext,
} from "./message-tool-turn-send-budget.js";
import {
  hasSanitizedSendPayloadContent,
  sanitizeMessageToolVisiblePayload,
  type VisibleTextSuppressionReason,
} from "./message-tool-visible-content.js";
import {
  recordPollVote,
  resolvePollVoteEchoRoute,
  suppressPollVoteEcho,
} from "./poll-vote-echo.js";
import { buildTurnSendLedgerSessionKey } from "./turn-send-ledger.js";

export function createMessageTool(options?: MessageToolOptions): AnyAgentTool {
  const steps = createMessageToolSteps(options);
  let next = steps.next();
  while (!next.done) {
    const actions = resolveMessageToolActionSchemaActions(next.value);
    next = steps.next({ actions, schema: buildMessageToolSchema(next.value, actions) });
  }
  return next.value;
}

export async function createMessageToolAsync(options?: MessageToolOptions): Promise<AnyAgentTool> {
  const steps = createMessageToolSteps(options);
  let next = steps.next();
  while (!next.done) {
    next = steps.next(await resolveMessageToolDiscoveryAsync(next.value));
  }
  return next.value;
}

function* createMessageToolSteps(
  options?: MessageToolOptions,
): Generator<
  MessageToolDiscoveryParams,
  AnyAgentTool,
  Awaited<ReturnType<typeof resolveMessageToolDiscoveryAsync>>
> {
  const loadConfigForTool = options?.getRuntimeConfig ?? getRuntimeConfig;
  const getScopedSecretTargetsForTool =
    options?.getScopedChannelsCommandSecretTargets ?? getScopedChannelsCommandSecretTargets;
  const resolveSecretRefsForTool =
    options?.resolveCommandSecretRefsViaGateway ?? resolveCommandSecretRefsViaGateway;
  const runMessageActionForTool = options?.runMessageAction ?? runMessageAction;
  let generatedIdempotencyCounter = 0;
  const rawPollEchoSessionKey = options?.agentSessionKey?.trim() || undefined;
  const failedAutogeneratedIdempotencyKeys = new Map<string, string>();
  const inferredCurrentChannel = resolveEffectiveCurrentChannelContext(options);
  const preparedMessageToolCatalog =
    options?.preparedMessageToolCatalog ?? getPreparedMessageToolCatalog();
  const currentThreadTs =
    options?.currentThreadTs ??
    (options?.agentThreadId != null
      ? stringifyRouteThreadId(options.agentThreadId)
      : inferredCurrentChannel.currentThreadTs);
  const replyToMode = options?.replyToMode ?? (currentThreadTs ? "all" : undefined);
  const agentAccountId =
    resolveAgentAccountId(options?.agentAccountId) ?? inferredCurrentChannel.accountId;
  const sourceReplySinkDeliveryMode = resolveSourceReplySinkDeliveryMode(
    inferredCurrentChannel.currentChannelProvider,
    options?.sourceReplyDeliveryMode,
  );
  const resolvedAgentId =
    options?.agentId ??
    (options?.agentSessionKey
      ? resolveSessionAgentId({
          sessionKey: options.agentSessionKey,
          config: options?.config,
        })
      : undefined);
  const turnSendSessionKey = buildTurnSendLedgerSessionKey(resolvedAgentId, rawPollEchoSessionKey);
  const pollEchoSessionKey =
    sourceReplySinkDeliveryMode === "message_tool_only" ? turnSendSessionKey : undefined;
  const turnAuthority = createMessageToolTurnAuthority({
    token: options?.messageActionTurnCapability,
    agentId: resolvedAgentId,
    runId: options?.runId,
    sessionKey: options?.agentSessionKey,
    sessionId: options?.sessionId,
    getConfig: () => options?.config ?? loadConfigForTool(),
    admitScheduledInvocation: options?.admitScheduledInvocation,
  });
  const messageToolDiscoveryParams: MessageToolDiscoveryParams | undefined =
    options?.config && !options.sourceReplyOnly
      ? {
          cfg: options.config,
          currentChatType: inferredCurrentChannel.currentChatType,
          currentChannelProvider: inferredCurrentChannel.currentChannelProvider,
          currentChannelId: inferredCurrentChannel.currentChannelId,
          currentThreadTs,
          currentMessageId: options.currentMessageId,
          currentPromptReaction: turnAuthority.hasCurrentPromptReaction,
          currentAccountId: agentAccountId,
          isScheduledRun: turnAuthority.isScheduledRun,
          scheduledAccountScope: turnAuthority.scheduledAccountScope,
          sessionKey: options.agentSessionKey,
          sessionId: options.sessionId,
          agentId: resolvedAgentId,
          requesterSenderId: options.requesterSenderId,
          senderIsOwner: options.senderIsOwner,
          preparedMessageToolCatalog,
        }
      : undefined;
  // Model-supplied channel text is untrusted until routing resolves it. Early
  // denials retain only the host-prepared source provider.
  const decisionChannel = resolveTrustedDecisionChannel(
    inferredCurrentChannel.currentChannelProvider,
    preparedMessageToolCatalog,
  );
  const explicitTargetGuard = options?.requireExplicitTarget
    ? createMessageToolExplicitTargetGuard({
        currentChannelProvider: inferredCurrentChannel.currentChannelProvider,
        preparedMessageToolCatalog,
        decisionChannel,
      })
    : undefined;
  // Schema and prompt must use the same snapshot; repeated discovery can drift
  // across plugin hooks while needlessly loading channel action metadata twice.
  const discovered = messageToolDiscoveryParams ? yield messageToolDiscoveryParams : undefined;
  const actions = discovered?.actions;
  const baseSchema = options?.sourceReplyOnly
    ? SOURCE_REPLY_ONLY_MESSAGE_SCHEMA
    : discovered
      ? discovered.schema
      : MessageToolSchema;
  const schema = addSourceReplyFinalControl(baseSchema);
  const description = options?.sourceReplyOnly
    ? "Send a message to the current source conversation. Supports actions: send."
    : buildMessageToolDescription(actions) +
      (turnAuthority.hasCurrentPromptReaction && (!actions || actions.includes("react"))
        ? " In this WebChat turn, react with emoji (and optional remove:true) to the current prompt as the agent. Omit channel, target, and messageId. This stays local; use an explicit external channel and messageId for external reactions."
        : "");
  const sandboxRoot = options?.sandboxRoot?.trim();
  const sandboxWorkspaceMediaAccess =
    sandboxRoot && options?.sandboxFsBridge && options.sandboxWorkspaceMediaReadAllowed === true
      ? {
          localRoots: [
            sandboxRoot,
            ...(options?.sandboxContainerWorkdir ? [options.sandboxContainerWorkdir] : []),
            ...(options?.sandboxReadOnlyResourceMounts?.map((mount) => mount.containerPath) ?? []),
          ],
          readFile: createSandboxBridgeReadFile({
            sandbox: { root: sandboxRoot, bridge: options.sandboxFsBridge },
          }),
          workspaceDir: sandboxRoot,
        }
      : undefined;

  return {
    label: "Message",
    name: "message",
    displaySummary: "Send and manage messages across configured channels.",
    description,
    parameters: schema,
    prepareBeforeToolCallParams: explicitTargetGuard?.prepareBeforeToolCallParams,
    finalizeBeforeToolCallParams: explicitTargetGuard?.finalizeBeforeToolCallParams,
    execute: async (toolCallId, args, signal) => {
      const assertCaller = turnAuthority.captureCaller(signal, captureGatewayToolCallerAssertion);
      // Shallow-copy so we don't mutate the original event args (used for logging/dedup).
      const params = { ...(args as Record<string, unknown>) };
      const action = readToolStringParam(params, "action", {
        required: true,
      }) as ChannelMessageActionName;
      const {
        authorization: trustedTurnContext,
        currentPromptReaction,
        config: rawConfig,
        scheduledRead,
        assertDashboardReadCurrent,
        hasChannelTurnContext,
        gatewayTurnCapability,
      } = turnAuthority.beginInvocation(action);
      const messageActionAuthorization: MessageActionAuthorization = trustedTurnContext ?? {};
      const requestedAccountId = readToolStringParam(params, "accountId");
      const effectiveCurrentChannel = await resolveEffectiveCurrentChannelContextForRequest(
        options,
        {
          config: rawConfig,
          action,
          params,
          accountId: requestedAccountId ?? agentAccountId,
          preparedMessageToolCatalog,
        },
      );
      const decisions = createMessageToolDecisionRecorder({
        actionId: toolCallId,
        action,
        channel: decisionChannel,
      });
      const executionIdentityToken =
        !options?.runId || decisions.executionIdentityToken?.runId === options.runId
          ? decisions.executionIdentityToken
          : undefined;
      const deliveryRunId = options?.runId ?? executionIdentityToken?.runId;
      const scheduledWrite = isScheduledMessageWriteAction(action)
        ? messageActionAuthorization.scheduled
        : undefined;
      const scheduledPolicy = (scheduledRead ?? scheduledWrite)?.policy;
      const scheduledAccountId =
        scheduledPolicy?.mode === "account" ? scheduledPolicy.ownerAccountId : undefined;
      if (normalizeOptionalString(options?.messageActionTurnCapability) && !trustedTurnContext) {
        decisions.recordTurnCapabilityInactive();
        throw new Error("message action turn capability is no longer active");
      }
      const assertActionCurrent = () => {
        assertCaller();
        turnAuthority.assertCurrent();
        const scheduled = messageActionAuthorization.scheduled;
        ((scheduledRead ?? scheduledWrite)
          ? (scheduled?.assertSourceCurrent ?? scheduled?.assertCurrent)
          : scheduled?.assertCurrent)?.();
        assertDashboardReadCurrent?.();
      };
      assertActionCurrent();
      if (options?.sourceReplyOnly) {
        decisions.runBoundary(() =>
          enforceSourceReplyOnlyMessageAction({
            action,
            args: params,
            currentChannelProvider: effectiveCurrentChannel.currentChannelProvider,
            currentChannelId: effectiveCurrentChannel.currentChannelId,
            currentMessagingTarget: effectiveCurrentChannel.currentMessagingTarget,
            currentThreadTs,
            currentMessageId: options.currentMessageId,
            currentAccountId: agentAccountId,
            trustedTurnContext,
          }),
        );
      }
      // `final` is a host-owned source-reply completion control. It must
      // not be dispatched to a provider or participate in idempotency.
      const requestedSourceReplyFinal =
        typeof params.final === "boolean" ? params.final : undefined;
      delete params.final;

      const suppressedVisiblePayloadReason = sanitizeMessageToolVisiblePayload(
        params,
        options?.agentSessionKey,
      );
      if (options?.sourceReplyOnly) {
        decisions.runBoundary(() => enforceSourceReplyOnlyTextDirectives(params));
      }

      if (
        suppressedVisiblePayloadReason &&
        action === "send" &&
        !hasSanitizedSendPayloadContent(params)
      ) {
        decisions.recordVisibleTextSuppressed(suppressedVisiblePayloadReason);
        return jsonResult({
          status: "suppressed",
          reason: suppressedVisiblePayloadReason,
          message:
            suppressedVisiblePayloadReason === "inbound_metadata_echo"
              ? "Suppressed outbound message text because it matched inbound runtime metadata."
              : "Suppressed outbound message text because it matched internal runtime context.",
        });
      }
      if (explicitTargetGuard) {
        decisions.runBoundary(() => explicitTargetGuard.require(params, action));
      }
      // The admitted prompt wins over an inherited external delivery route. Only
      // an explicit external channel enters the ordinary channel reaction path.
      const requestedReactionChannel = normalizeOptionalLowercaseString(params.channel);
      if (
        action === "react" &&
        currentPromptReaction &&
        (!requestedReactionChannel || requestedReactionChannel === "webchat")
      ) {
        const allowedParams = new Set(["action", "channel", "emoji", "remove", "dryRun"]);
        if (
          Object.keys(params).some((key) => params[key] !== undefined && !allowedParams.has(key))
        ) {
          throw new Error(
            "WebChat reactions only target the current prompt; omit target, messageId, and identity parameters.",
          );
        }
        decisions.runBoundary(() =>
          enforceMessageActionAllowlist({
            cfg: rawConfig,
            agentId: resolvedAgentId,
            action,
          }),
        );
        const emoji = readToolStringParam(params, "emoji", { required: true });
        const remove = readBooleanParam(params, "remove") === true;
        const dryRun = readBooleanParam(params, "dryRun") === true;
        const result = await currentPromptReaction({
          emoji,
          remove,
          dryRun,
          assertCurrent: assertActionCurrent,
        });
        assertActionCurrent();
        const sourceReplyDelivered =
          requestedSourceReplyFinal === true && result.changed && !remove && !dryRun;
        if (sourceReplyDelivered && options?.sessionId) {
          resolveActiveReplyOperationForSessionId(options.sessionId)?.markSourceReplyDelivered();
        }
        return embeddedMessageDelivery.attachEmbeddedMessageDeliveryFact(
          jsonResult({ ok: true, channel: "webchat", ...result, remove, dryRun }),
          {
            status: dryRun ? "dryRun" : "settled",
            partialDelivery: false,
            createdThreadIds: [],
            ...(sourceReplyDelivered ? { sourceReplyDelivered: true } : {}),
          },
        );
      }

      const gatewayContext = { ...options, messageActionTurnCapability: gatewayTurnCapability };
      const gateway = createMessageToolGateway(params, gatewayContext, signal, {
        resolveConfig: () => cfg,
        preserveWriteOutcome: Boolean(
          messageActionAuthorization.scheduled &&
          !scheduledRead &&
          readBooleanParam(params, "dryRun") !== true,
        ),
        hasScheduledAuthority: Boolean(messageActionAuthorization.scheduled),
      });
      await decisions.runBoundaryAsync(() =>
        validateExplicitMessageAccountSelection({
          cfg: rawConfig,
          accountId: requestedAccountId,
          checkResolvedAccount: false,
        }),
      );
      const requestedBroadcastChannel = normalizeOptionalLowercaseString(params.channel);
      if (
        action === "broadcast" &&
        requestedBroadcastChannel &&
        requestedBroadcastChannel !== "all"
      ) {
        // Authorize and execute the same canonical provider. Otherwise an unavailable
        // hint can fall back to the current provider only after account authorization.
        const selection = await resolveMessageChannelSelection({
          cfg: rawConfig,
          channel: requestedBroadcastChannel,
          fallbackChannel: effectiveCurrentChannel.currentChannelProvider,
        });
        params.channel = selection.channel;
      }
      const scope = resolveMessageSecretScope({
        channel: params.channel,
        target: params.target,
        targets: params.targets,
        fallbackChannel: effectiveCurrentChannel.currentChannelProvider,
        accountId: requestedAccountId,
        fallbackAccountId: scheduledAccountId ?? agentAccountId,
      });
      // Broadcast execution only narrows on an explicit non-all channel. Target
      // prefixes cannot authorize fewer providers than the runner will execute.
      const unscopedExplicitBroadcast =
        action === "broadcast" &&
        (!requestedBroadcastChannel || requestedBroadcastChannel === "all") &&
        requestedAccountId !== undefined;
      const explicitAccountId = await decisions.runBoundaryAsync(() =>
        validateExplicitMessageAccountSelection({
          cfg: rawConfig,
          channel: unscopedExplicitBroadcast ? undefined : scope.channel,
          accountId: requestedAccountId ?? scheduledAccountId,
          checkResolvedAccount: false,
        }),
      );
      const broadcastAccountPlan =
        unscopedExplicitBroadcast && explicitAccountId
          ? await resolveMessageBroadcastAccountPlan({
              cfg: rawConfig,
              accountId: explicitAccountId,
            })
          : undefined;
      decisions.runBoundary(() =>
        enforceTrustedTurnExplicitAccount({
          explicitAccountId,
          selectedChannels: broadcastAccountPlan
            ? broadcastAccountPlan.candidateChannels
            : [scope.channel],
          trustedCurrentChannel: trustedTurnContext?.toolContext?.currentChannelProvider,
          trustedRequesterAccountId: trustedTurnContext?.requesterAccountId,
          hasTrustedTurnContext: hasChannelTurnContext,
        }),
      );
      if (explicitAccountId) {
        scope.accountId = explicitAccountId;
        params.accountId = explicitAccountId;
      }
      const scopedTargets = getScopedSecretTargetsForTool({
        config: rawConfig,
        channel: broadcastAccountPlan ? undefined : scope.channel,
        ...(broadcastAccountPlan ? { channels: broadcastAccountPlan.secretChannels } : {}),
        accountId: scope.accountId,
      });
      const cfg = (
        await resolveSecretRefsForTool({
          config: rawConfig,
          commandName: "tools.message",
          targetIds: scopedTargets.targetIds,
          ...(scopedTargets.allowedPaths ? { allowedPaths: scopedTargets.allowedPaths } : {}),
          mode: "enforce_resolved",
        })
      ).resolvedConfig;
      assertActionCurrent();

      const accountId = explicitAccountId ?? scheduledAccountId ?? agentAccountId;
      const pollVoteEchoRoute = resolvePollVoteEchoRoute({
        action,
        args: params,
        channel: scope.channel ?? effectiveCurrentChannel.currentChannelProvider,
        accountId,
        currentChannelId: effectiveCurrentChannel.currentChannelId,
        currentMessagingTarget: effectiveCurrentChannel.currentMessagingTarget,
        preparedMessageToolCatalog,
      });
      const outboundActionRoute = resolveOutboundActionRoute({
        action,
        args: params,
        channel: scope.channel ?? effectiveCurrentChannel.currentChannelProvider,
        accountId,
        currentChannelId: effectiveCurrentChannel.currentChannelId,
        currentMessagingTarget: effectiveCurrentChannel.currentMessagingTarget,
      });
      const budgetContext = resolveTurnSendBudgetContext({
        action,
        outboundActionRoute,
        sessionKey: turnSendSessionKey,
        runId: options?.runId,
        isDryRun: Boolean(params.dryRun),
      });
      if (suppressPollVoteEcho(pollEchoSessionKey, pollVoteEchoRoute, action, params)) {
        decisions.recordPollVoteEchoSuppressed();
        return jsonResult({
          status: "suppressed",
          reason: "poll_vote_echo" satisfies VisibleTextSuppressionReason,
          message: "Suppressed outbound text because it only restated the poll vote just cast.",
        });
      }

      const hasCurrentMessageId =
        typeof options?.currentMessageId === "number" ||
        (typeof options?.currentMessageId === "string" &&
          options.currentMessageId.trim().length > 0);

      const toolContext =
        effectiveCurrentChannel.currentChannelId ||
        effectiveCurrentChannel.currentChatType ||
        effectiveCurrentChannel.currentChannelProvider ||
        effectiveCurrentChannel.currentMessagingTarget ||
        currentThreadTs ||
        hasCurrentMessageId ||
        replyToMode ||
        options?.hasRepliedRef ||
        options?.sameChannelThreadRequired
          ? {
              currentChannelId: effectiveCurrentChannel.currentChannelId,
              currentChatType: effectiveCurrentChannel.currentChatType,
              currentMessagingTarget: effectiveCurrentChannel.currentMessagingTarget,
              currentChannelProvider: effectiveCurrentChannel.currentChannelProvider,
              currentThreadTs,
              currentMessageId: options?.currentMessageId,
              replyToMode,
              hasRepliedRef: options?.hasRepliedRef,
              sameChannelThreadRequired: options?.sameChannelThreadRequired,
              // Direct tool invocations should not add cross-context decoration.
              // The agent is composing a message, not forwarding from another chat.
              skipCrossContextDecoration: true,
            }
          : undefined;
      const groupThread = prepareMessageToolGroupThread(params, {
        action,
        channel: scope.channel,
        accountId,
        currentAccountId: agentAccountId,
        toolContext,
        catalog: preparedMessageToolCatalog,
      });
      if (groupThread.silent) {
        return jsonResult({ status: "suppressed", reason: "silent_reply" });
      }
      const { actionIdempotencyKey, autogeneratedDeliveryFingerprint } =
        deriveMessageToolIdempotency({
          action,
          params,
          explicitIdempotencyKey: params.idempotencyKey,
          runId: options?.runId,
          toolCallId,
          failedAutogeneratedKeys: failedAutogeneratedIdempotencyKeys,
          nextOperationId: () => String(++generatedIdempotencyCounter),
        });
      const actionParams = actionIdempotencyKey
        ? { ...params, idempotencyKey: actionIdempotencyKey }
        : params;
      const turnSendBudget = prepareMessageToolTurnSendBudget({
        budgetContext,
        action,
        cfg: rawConfig,
        agentId: resolvedAgentId,
        gatewayPresent: gateway !== undefined,
        deliveryChannel: scope.channel ?? effectiveCurrentChannel.currentChannelProvider,
        actionIdempotencyKey,
      });
      if (turnSendBudget.exhaustedMessage) {
        return jsonResult({
          status: "suppressed",
          reason: "turn_send_budget_exhausted",
          message: turnSendBudget.exhaustedMessage,
        });
      }
      const hasExactSourceTurn =
        action === "send" &&
        sourceReplySinkDeliveryMode === "message_tool_only" &&
        normalizeOptionalString(trustedTurnContext?.toolContext?.currentSourceTurnId) !== undefined;
      return await withChannelReadAuthority(
        action === "download-file" || scheduledRead || assertDashboardReadCurrent
          ? assertActionCurrent
          : undefined,
        async () => {
          let result: MessageActionResult;
          try {
            result = await groupThread.run(() =>
              runMessageActionForTool({
                cfg,
                action,
                params: actionParams,
                actionOrigin: "message-tool",
                defaultAccountId: accountId ?? undefined,
                ...messageActionTurnCapability.selectMessageActionRequesterIdentity(
                  trustedTurnContext,
                ),
                messageActionAuthorization,
                assertDirectAdapterHandoff: assertActionCurrent,
                onPlatformSendDispatch: messageActionAuthorization.scheduled
                  ? async () => assertActionCurrent()
                  : undefined,
                skipQueue: Boolean(messageActionAuthorization.scheduled),
                senderIsOwner: options?.senderIsOwner,
                conversationReadOrigin: options?.conversationReadOrigin,
                workspaceDir: options?.workspaceDir,
                broadcastAccountPlan,
                gateway,
                toolContext,
                sessionKey: options?.agentSessionKey,
                sourceReplySessionKey: options?.runSessionKey,
                sessionId: options?.sessionId,
                runId: deliveryRunId,
                executionIdentityToken,
                agentId: resolvedAgentId,
                workspaceMediaAccess: sandboxWorkspaceMediaAccess,
                sandboxRoot: options?.sandboxRoot,
                sandboxContainerWorkdir: options?.sandboxContainerWorkdir,
                sourceReplyDeliveryMode: sourceReplySinkDeliveryMode,
                sourceReplyTranscriptOnly: options?.inputProvenance?.kind === "inter_session",
                // Only an admitted channel source can arm terminal restart reconciliation.
                // Source-less scheduled and ambient sends remain ordinary message actions.
                sourceReplyFinal: hasExactSourceTurn
                  ? (requestedSourceReplyFinal ?? true)
                  : undefined,
                sourceReplyToolCallId: hasExactSourceTurn ? toolCallId : undefined,
                onActionDenied: (error, channel, receiptDiscriminator) =>
                  decisions.recordTypedDenial(
                    error,
                    resolveTrustedDecisionChannel(channel, preparedMessageToolCatalog),
                    receiptDiscriminator,
                  ),
                inboundEventKind: options?.inboundEventKind,
                inboundAudio: options?.hasCurrentInboundAudio?.() ?? options?.currentInboundAudio,
                abortSignal: signal,
              }),
            );
          } catch (error) {
            const partialResult = projectScheduledMessageActionPartialResult({
              error,
              action,
              actionParams: params,
              scopeChannel: scope.channel,
              hasScheduledAuthority: Boolean(messageActionAuthorization.scheduled),
            });
            if (partialResult) {
              result = partialResult;
            } else {
              turnSendBudget.release();
              if (autogeneratedDeliveryFingerprint && actionIdempotencyKey) {
                failedAutogeneratedIdempotencyKeys.set(
                  autogeneratedDeliveryFingerprint,
                  actionIdempotencyKey,
                );
              }
              // Queue-owned retry: the gateway already holds the durable row and
              // caches this outcome under the same idempotency key, so a model resend
              // of the same content collapses instead of minting a second send.
              const queuedDelivery = projectGatewayQueuedDeliveryResult(error);
              if (queuedDelivery) {
                return jsonResult(queuedDelivery);
              }
              decisions.recordTypedDenial(error);
              throw error;
            }
          }
          if (
            autogeneratedDeliveryFingerprint &&
            failedAutogeneratedIdempotencyKeys.get(autogeneratedDeliveryFingerprint) ===
              actionIdempotencyKey
          ) {
            failedAutogeneratedIdempotencyKeys.delete(autogeneratedDeliveryFingerprint);
          }
          decisions.recordActionResult(
            result,
            resolveTrustedDecisionChannel(result.channel, preparedMessageToolCatalog),
          );
          const toolResult = getToolResult(result);
          // A2A enters through webchat but resolves an external source route here.
          // Compare the completed send with that route, independently of display mirrors.
          const sourceReply = {
            action,
            cfg,
            channel: result.channel,
            actionParams: "to" in result ? { ...actionParams, target: result.to } : actionParams,
            accountId,
            currentAccountId: agentAccountId,
            sessionKey: options?.agentSessionKey,
            toolContext,
            deliveredPayload: result.payload,
            sourceReplyFinal: requestedSourceReplyFinal,
            replyToIsExplicit: Boolean(readToolStringParam(actionParams, "replyTo")),
          };
          const currentSourceReply =
            result.handledBy !== "internal-source" &&
            (await isDeliveredCurrentSourceReplyAsync(sourceReply));
          // A completed provider write must settle even if its caller was revoked
          // while awaiting the accepted response. Its next request stays fenced.
          if (
            !embeddedMessageDelivery.hasAcceptedBroadcastDelivery(result) &&
            shouldRevalidateCompletedMessageAction({
              hasScheduledAuthority: Boolean(messageActionAuthorization.scheduled),
              scheduledRead: Boolean(scheduledRead),
              dryRun: result.dryRun,
              acceptedResult: hasAcceptedMessageActionResult(
                result,
                messageActionAuthorization.scheduled !== undefined,
              ),
            })
          ) {
            assertActionCurrent();
          }
          const messageDelivery = embeddedMessageDelivery.projectEmbeddedMessageDeliveryFact(
            result,
            currentSourceReply,
          );
          groupThread.record(result, sourceReply, currentSourceReply, requestedSourceReplyFinal);
          if (
            messageDelivery?.status === "settled" &&
            !messageDelivery.partialDelivery &&
            requestedSourceReplyFinal !== false &&
            !result.dryRun &&
            currentSourceReply
          ) {
            messageDelivery.sourceReplyDelivered = true;
            // A later stall cannot erase this answer; recovery and its notice read it.
            if (options?.sessionId) {
              resolveActiveReplyOperationForSessionId(
                options.sessionId,
              )?.markSourceReplyDelivered();
            }
          }
          if (action === "poll-vote" && pollVoteEchoRoute && pollEchoSessionKey) {
            const details = toolResult?.details as { pollVotedOption?: unknown } | undefined;
            recordPollVote(pollEchoSessionKey, pollVoteEchoRoute, details?.pollVotedOption);
          }
          const response = toolResult ?? jsonResult(result.payload);
          const deliveryStatus =
            result.kind === "send" ? result.sendResult?.deliveryStatus : undefined;
          const landed =
            result.kind !== "broadcast" &&
            !result.dryRun &&
            deliveryStatus !== "suppressed" &&
            deliveryStatus !== "failed";
          return embeddedMessageDelivery.attachEmbeddedMessageDeliveryFact(
            appendMessageToolNotices(
              response,
              result.kind === "send" && !result.dryRun ? result.normalization?.notice : undefined,
              turnSendBudget.commitAndResolveNotice(landed),
            ),
            messageDelivery,
          );
        },
        signal,
      );
    },
  };
}
