import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ChatType } from "../../channels/chat-type.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import type { ConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import type { PreparedMessageToolCatalog } from "../../channels/plugins/message-action-discovery.js";
import { isScheduledMessageWriteAction } from "../../channels/plugins/message-action-dispatch.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { resolveCommandSecretRefsViaGateway } from "../../cli/command-secret-gateway.js";
import { getScopedChannelsCommandSecretTargets } from "../../cli/command-secret-targets.js";
import { resolveMessageSecretScope } from "../../cli/message-secret-scope.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
import { isDeliveredCurrentSourceReplyAsync } from "../../infra/outbound/source-reply-mirror.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { getPreparedMessageToolCatalog } from "../../plugins/prepared-message-tool-catalog.js";
import { withChannelReadAuthority } from "../../shared/channel-read-authority.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import * as embeddedMessageDelivery from "../embedded-agent-message-delivery.js";
import { createSandboxBridgeReadFile } from "../sandbox-media-paths.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";
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
  resolveMessageToolActionSchemaActions,
} from "./message-tool-discovery.js";
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
  SOURCE_REPLY_ONLY_MESSAGE_SCHEMA,
} from "./message-tool-source-policy.js";
import { createMessageToolTurnAuthority } from "./message-tool-turn-authority.js";
import {
  hasSanitizedSendPayloadContent,
  sanitizeMessageToolVisiblePayload,
  type VisibleTextSuppressionReason,
} from "./message-tool-visible-content.js";
import { isPollVoteEchoText, resolvePollVoteEchoRoute } from "./poll-vote-echo.js";

const POLL_VOTE_ECHO_TTL_MS = 30_000;

// Keyed by agent session (conversation), NOT per message-tool instance: a native
// poll and its accompanying comment arrive as separate inbound messages and are
// processed in separate agent runs, each with a fresh tool instance. An
// instance-local record would be lost before the follow-up text run, so the echo
// (the agent restating its vote in prose) would leak. Session-scoped +
// route-checked storage lets the vote in one run suppress the restatement in the
// next while never crossing conversations. Single slot per session, TTL-bounded.
const recentPollVoteBySession = new Map<
  string,
  { option: string; route: string; recordedAt: number }
>();

type MessageToolOptions = {
  agentAccountId?: string;
  agentSessionKey?: string;
  runSessionKey?: string;
  runId?: string;
  sessionId?: string;
  agentId?: string;
  config?: OpenClawConfig;
  preparedMessageToolCatalog?: PreparedMessageToolCatalog;
  getRuntimeConfig?: () => OpenClawConfig;
  admitScheduledInvocation?: () => OpenClawConfig;
  getScopedChannelsCommandSecretTargets?: typeof getScopedChannelsCommandSecretTargets;
  resolveCommandSecretRefsViaGateway?: typeof resolveCommandSecretRefsViaGateway;
  runMessageAction?: typeof runMessageAction;
  currentChannelId?: string;
  currentChatType?: ChatType;
  currentMessagingTarget?: string;
  messageActionTurnCapability?: string;
  currentChannelProvider?: string;
  currentThreadTs?: string;
  agentThreadId?: string | number;
  currentMessageId?: string | number;
  currentInboundAudio?: boolean;
  hasCurrentInboundAudio?: () => boolean;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
  sameChannelThreadRequired?: boolean;
  sandboxRoot?: string;
  sandboxContainerWorkdir?: string;
  sandboxFsBridge?: SandboxFsBridge;
  sandboxReadOnlyResourceMounts?: readonly { hostPath: string; containerPath: string }[];
  sandboxWorkspaceMediaReadAllowed?: boolean;
  requireExplicitTarget?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  /** Process-local completion authority: send only to the current source route. */
  sourceReplyOnly?: boolean;
  inboundEventKind?: InboundEventKind;
  requesterSenderId?: string;
  senderIsOwner?: boolean;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  workspaceDir?: string;
};

export function createMessageTool(options?: MessageToolOptions): AnyAgentTool {
  const loadConfigForTool = options?.getRuntimeConfig ?? getRuntimeConfig;
  const getScopedSecretTargetsForTool =
    options?.getScopedChannelsCommandSecretTargets ?? getScopedChannelsCommandSecretTargets;
  const resolveSecretRefsForTool =
    options?.resolveCommandSecretRefsViaGateway ?? resolveCommandSecretRefsViaGateway;
  const runMessageActionForTool = options?.runMessageAction ?? runMessageAction;
  let generatedIdempotencyCounter = 0;
  // Poll-vote echo record lives in the session-scoped map (recentPollVoteBySession)
  // so it survives the run boundary between the vote and the follow-up text; a
  // null session key disables the guard.
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
  const currentChannelIsInternal =
    normalizeMessageChannel(inferredCurrentChannel.currentChannelProvider) ===
    INTERNAL_MESSAGE_CHANNEL;
  // WebChat tool sends use the private sink without changing the run-level
  // contract: ordinary final answers must remain automatic and visible.
  const sourceReplySinkDeliveryMode = currentChannelIsInternal
    ? "message_tool_only"
    : options?.sourceReplyDeliveryMode;
  const resolvedAgentId =
    options?.agentId ??
    (options?.agentSessionKey
      ? resolveSessionAgentId({
          sessionKey: options.agentSessionKey,
          config: options?.config,
        })
      : undefined);
  const pollEchoSessionKey =
    rawPollEchoSessionKey && resolvedAgentId
      ? `${resolvedAgentId}\0${rawPollEchoSessionKey}`
      : undefined;
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
          currentAccountId: agentAccountId,
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
  const actions = messageToolDiscoveryParams
    ? resolveMessageToolActionSchemaActions(messageToolDiscoveryParams)
    : undefined;
  const baseSchema = options?.sourceReplyOnly
    ? SOURCE_REPLY_ONLY_MESSAGE_SCHEMA
    : messageToolDiscoveryParams
      ? buildMessageToolSchema(messageToolDiscoveryParams, actions ?? [])
      : MessageToolSchema;
  const schema = addSourceReplyFinalControl(baseSchema);
  const description = options?.sourceReplyOnly
    ? "Send a message to the current source conversation. Supports actions: send."
    : buildMessageToolDescription(actions);
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
        config: rawConfig,
        scheduledRead,
        assertDashboardReadCurrent,
        hasChannelTurnContext,
        gatewayTurnCapability,
      } = turnAuthority.beginInvocation(action);
      const messageActionAuthorization: MessageActionAuthorization = trustedTurnContext ?? {};
      const requestedAccountId = readToolStringParam(params, "accountId");
      const effectiveCurrentChannel = resolveEffectiveCurrentChannelContext(options, {
        config: rawConfig,
        action,
        params,
        accountId: requestedAccountId ?? agentAccountId,
        preparedMessageToolCatalog,
      });
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
      const recentPollVote = pollEchoSessionKey
        ? recentPollVoteBySession.get(pollEchoSessionKey)
        : undefined;
      if (
        recentPollVote &&
        pollEchoSessionKey &&
        sourceReplySinkDeliveryMode === "message_tool_only" &&
        (action === "send" || action === "reply")
      ) {
        if (Date.now() - recentPollVote.recordedAt >= POLL_VOTE_ECHO_TTL_MS) {
          recentPollVoteBySession.delete(pollEchoSessionKey);
        } else if (pollVoteEchoRoute === recentPollVote.route) {
          const vote = recentPollVote;
          recentPollVoteBySession.delete(pollEchoSessionKey);
          const outboundText =
            readToolStringParam(params, "text") ??
            readToolStringParam(params, "message") ??
            readToolStringParam(params, "content");
          if (outboundText && isPollVoteEchoText(vote.option, outboundText)) {
            decisions.recordPollVoteEchoSuppressed();
            return jsonResult({
              status: "suppressed",
              reason: "poll_vote_echo" satisfies VisibleTextSuppressionReason,
              message: "Suppressed outbound text because it only restated the poll vote just cast.",
            });
          }
        }
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
          }
          if (
            action === "poll-vote" &&
            pollVoteEchoRoute &&
            pollEchoSessionKey &&
            sourceReplySinkDeliveryMode === "message_tool_only"
          ) {
            const details = toolResult?.details as { pollVotedOption?: unknown } | undefined;
            const option =
              typeof details?.pollVotedOption === "string" ? details.pollVotedOption.trim() : "";
            if (option) {
              const recordedAt = Date.now();
              // Prune expired entries on write so a session that votes but never
              // sends a follow-up text can't leak a record forever in a long-lived
              // gateway; the map stays bounded to sessions that voted within the TTL.
              for (const [key, entry] of recentPollVoteBySession) {
                if (recordedAt - entry.recordedAt >= POLL_VOTE_ECHO_TTL_MS) {
                  recentPollVoteBySession.delete(key);
                }
              }
              recentPollVoteBySession.set(pollEchoSessionKey, {
                option,
                route: pollVoteEchoRoute,
                recordedAt,
              });
            }
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
