import {
  hasNonEmptyString,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isScheduledMessageWriteAction } from "../../channels/plugins/message-action-dispatch.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { resolveCommandSecretRefsViaGateway } from "../../cli/command-secret-gateway.js";
import { getScopedChannelsCommandSecretTargets } from "../../cli/command-secret-targets.js";
import { resolveMessageSecretScope } from "../../cli/message-secret-scope.js";
import { getRuntimeConfig } from "../../config/config.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";
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
import { isCronSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { withChannelReadAuthority } from "../../shared/channel-read-authority.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { runWithAgentToolSourceExecutionScope } from "../agent-tool-source-execution-guard.js";
import * as embeddedMessageDelivery from "../embedded-agent-message-delivery.js";
import { createSandboxBridgeReadFile } from "../sandbox-media-paths.js";
import { captureAgentWorkspaceReadiness } from "../workspace-readiness.js";
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
  resolveMessageToolDefinitionContext,
  prepareMessageToolSessionBinding,
  readMessageToolSessionEntry,
  resolveMessageToolScheduledAccountScope,
  supportsMessageToolPromptReactions,
} from "./message-tool-discovery.js";
import type { MessageToolOptions } from "./message-tool-execution.types.js";
import { createMessageToolExplicitTargetGuard } from "./message-tool-explicit-target.js";
import { createMessageToolGateway } from "./message-tool-gateway.js";
import { prepareMessageToolGroupThread } from "./message-tool-group-thread.js";
import {
  buildMessageToolDeliveryFingerprint,
  normalizeMessageToolIdempotencyKeyPart,
} from "./message-tool-idempotency.js";
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
} from "./message-tool-source-policy.js";
import { createMessageToolTurnAuthority } from "./message-tool-turn-authority.js";
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

export function createMessageTool(options?: MessageToolOptions): AnyAgentTool {
  const steps = createMessageToolSteps(options, readMessageToolSessionEntry(options));
  let next = steps.next();
  while (!next.done) {
    const actions = resolveMessageToolActionSchemaActions(next.value);
    next = steps.next({ actions, schema: buildMessageToolSchema(next.value, actions) });
  }
  return next.value;
}

export async function createMessageToolAsync(options?: MessageToolOptions): Promise<AnyAgentTool> {
  const steps = createMessageToolSteps(options, await prepareMessageToolSessionBinding(options));
  let next = steps.next();
  while (!next.done) {
    next = steps.next(await resolveMessageToolDiscoveryAsync(next.value));
  }
  return next.value;
}

function* createMessageToolSteps(
  options?: MessageToolOptions,
  sessionEntry?: SessionEntry,
): Generator<
  MessageToolDiscoveryParams,
  AnyAgentTool,
  Awaited<ReturnType<typeof resolveMessageToolDiscoveryAsync>>
> {
  const workspaceReadiness = captureAgentWorkspaceReadiness(
    options?.runSessionKey ?? options?.agentSessionKey,
  );
  let generatedIdempotencyCounter = 0;
  const rawPollEchoSessionKey = options?.agentSessionKey?.trim() || undefined;
  const failedAutogeneratedIdempotencyKeys = new Map<string, string>();
  const inferredCurrentChannel = resolveEffectiveCurrentChannelContext(options);
  const definitionContext = resolveMessageToolDefinitionContext(options, sessionEntry);
  const supportsPromptReactions = supportsMessageToolPromptReactions(options);
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
      ? resolveSessionAgentId({ sessionKey: options.agentSessionKey, config: options.config })
      : undefined);
  const pollEchoSessionKey =
    rawPollEchoSessionKey && resolvedAgentId && sourceReplySinkDeliveryMode === "message_tool_only"
      ? `${resolvedAgentId}\0${rawPollEchoSessionKey}`
      : undefined;
  const turnAuthority = createMessageToolTurnAuthority({
    token: options?.messageActionTurnCapability,
    agentId: resolvedAgentId,
    runId: options?.runId,
    sessionKey: options?.agentSessionKey,
    sessionId: options?.sessionId,
    getConfig: () => options?.config ?? getRuntimeConfig(),
    admitScheduledInvocation: options?.admitScheduledInvocation,
  });
  const messageToolDiscoveryParams: MessageToolDiscoveryParams | undefined = options?.config
    ? {
        cfg: options.config,
        currentChatType: definitionContext.currentChatType,
        currentChannelProvider: definitionContext.currentChannelProvider,
        currentChannelId: definitionContext.currentChannelId,
        currentThreadTs: definitionContext.currentThreadTs,
        supportsPromptReactions,
        currentAccountId:
          definitionContext.accountId ??
          (options.agentSessionKey ? undefined : options.agentAccountId),
        isScheduledRun: isCronSessionKey(options.agentSessionKey),
        scheduledAccountScope: resolveMessageToolScheduledAccountScope(
          options.scheduledToolPolicy,
          sessionEntry,
        ),
        sessionKey: options.agentSessionKey,
        sessionId: options.sessionId,
        agentId: resolvedAgentId,
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
  // A source-bound completion keeps the session's message definition so its
  // prompt prefix stays cached; the source-reply policy is enforced per call.
  const baseSchema = discovered?.schema ?? MessageToolSchema;
  const description =
    buildMessageToolDescription(actions) +
    (supportsPromptReactions && (!actions || actions.includes("react"))
      ? " When the current WebChat prompt permits reactions, react with emoji (and optional remove:true) as the agent. Omit channel, target, and messageId. This stays local; use an explicit external channel and messageId for external reactions."
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
    parameters: addSourceReplyFinalControl(baseSchema),
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
        sourceReplyOperation,
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
      const scheduled = messageActionAuthorization.scheduled;
      const assertActionCurrent = composeSessionSourceAssertion(
        [
          assertCaller,
          (scheduledRead ?? scheduledWrite)
            ? (scheduled?.assertSourceCurrent ?? scheduled?.assertCurrent)
            : scheduled?.assertCurrent,
        ],
        (assertSources) => {
          turnAuthority.assertCurrent();
          assertSources();
          assertDashboardReadCurrent?.();
        },
      );
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
      // A live local prompt grant wins over an inherited external delivery route.
      const requestedChannel = normalizeOptionalLowercaseString(params.channel);
      const reactionChannel =
        requestedChannel ??
        (currentPromptReaction ||
        parseAgentSessionKey(options?.agentSessionKey)?.rest.startsWith("dashboard:")
          ? "webchat"
          : normalizeMessageChannel(options?.currentChannelProvider)) ??
        "webchat";
      const reactsToCurrentPrompt = action === "react" && reactionChannel === "webchat";
      if (reactsToCurrentPrompt && !currentPromptReaction) {
        throw new Error("No prompt here permits reactions; pass channel, target, and messageId.");
      }
      if (reactsToCurrentPrompt && currentPromptReaction) {
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
        const result = await runWithAgentToolSourceExecutionScope(assertActionCurrent, () =>
          currentPromptReaction({
            emoji,
            remove,
            dryRun,
            assertCurrent: assertActionCurrent,
          }),
        );
        assertActionCurrent();
        const sourceReplyDelivered =
          requestedSourceReplyFinal === true && result.changed && !remove && !dryRun;
        if (sourceReplyDelivered) {
          sourceReplyOperation?.markSourceReplyDelivered();
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
      if (action === "broadcast" && requestedChannel && requestedChannel !== "all") {
        // Authorize and execute the same canonical provider. Otherwise an unavailable
        // hint can fall back to the current provider only after account authorization.
        const selection = await resolveMessageChannelSelection({
          cfg: rawConfig,
          channel: requestedChannel,
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
        (!requestedChannel || requestedChannel === "all") &&
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
      const scopedTargets = getScopedChannelsCommandSecretTargets({
        config: rawConfig,
        channel: broadcastAccountPlan ? undefined : scope.channel,
        ...(broadcastAccountPlan ? { channels: broadcastAccountPlan.secretChannels } : {}),
        accountId: scope.accountId,
      });
      const cfg = (
        await resolveCommandSecretRefsViaGateway({
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
      if (suppressPollVoteEcho(pollEchoSessionKey, pollVoteEchoRoute, action, params)) {
        decisions.recordPollVoteEchoSuppressed();
        return jsonResult({
          status: "suppressed",
          reason: "poll_vote_echo" satisfies VisibleTextSuppressionReason,
          message: "Suppressed outbound text because it only restated the poll vote just cast.",
        });
      }

      const toolContext =
        effectiveCurrentChannel.currentChannelId ||
        effectiveCurrentChannel.currentChatType ||
        effectiveCurrentChannel.currentChannelProvider ||
        effectiveCurrentChannel.currentMessagingTarget ||
        currentThreadTs ||
        typeof options?.currentMessageId === "number" ||
        hasNonEmptyString(options?.currentMessageId) ||
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
      let autogeneratedDeliveryFingerprint: string | undefined;
      let actionIdempotencyKey = normalizeOptionalString(params.idempotencyKey);
      if (!actionIdempotencyKey && options?.runId) {
        autogeneratedDeliveryFingerprint = buildMessageToolDeliveryFingerprint({ action, params });
        actionIdempotencyKey = failedAutogeneratedIdempotencyKeys.get(
          autogeneratedDeliveryFingerprint,
        );
        if (!actionIdempotencyKey) {
          const operationId =
            normalizeMessageToolIdempotencyKeyPart(toolCallId) ??
            String(++generatedIdempotencyCounter);
          const runId = normalizeMessageToolIdempotencyKeyPart(options.runId) ?? options.runId;
          actionIdempotencyKey = `${runId}:message-tool:${autogeneratedDeliveryFingerprint}:${operationId}`;
        }
      }
      const actionParams = actionIdempotencyKey
        ? { ...params, idempotencyKey: actionIdempotencyKey }
        : params;
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
            result = await runWithAgentToolSourceExecutionScope(assertActionCurrent, () =>
              groupThread.run(() =>
                runMessageAction({
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
                  workspaceReadiness,
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
                  // Preserve explicit progress even without a source turn: recovery must not
                  // mistake its persisted mirror for a completed assistant reply.
                  sourceReplyFinal: hasExactSourceTurn
                    ? (requestedSourceReplyFinal ?? true)
                    : action === "send" && requestedSourceReplyFinal === false
                      ? false
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
              ),
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
          // Resolve source completion independently of display mirrors.
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
            result.handledBy === "internal-source"
              ? options?.inputProvenance?.kind !== "inter_session"
              : await isDeliveredCurrentSourceReplyAsync(sourceReply);
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
            sourceReplyOperation?.markSourceReplyDelivered();
          }
          if (action === "poll-vote" && pollVoteEchoRoute && pollEchoSessionKey) {
            const details = toolResult?.details as { pollVotedOption?: unknown } | undefined;
            recordPollVote(pollEchoSessionKey, pollVoteEchoRoute, details?.pollVotedOption);
          }
          const response = toolResult ?? jsonResult(result.payload);
          const notice =
            result.kind === "send" && !result.dryRun ? result.normalization?.notice : undefined;
          return embeddedMessageDelivery.attachEmbeddedMessageDeliveryFact(
            notice
              ? { ...response, content: [...response.content, { type: "text", text: notice }] }
              : response,
            messageDelivery,
          );
        },
        signal,
      );
    },
  };
}
