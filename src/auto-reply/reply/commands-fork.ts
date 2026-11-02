import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { getLoadedChannelPluginForRead } from "../../channels/plugins/registry-loaded.js";
import { deliveryContextFromConversation } from "../../channels/route-projection.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
  createDynamicSessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import {
  getSessionBindingService,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import {
  extractAssistantPhaseText,
  extractFirstTextBlock,
  isSilentAssistantTranscriptMessage,
} from "../../shared/chat-message-content.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../shared/transcript-only-openclaw-assistant.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { commandReply, defineAuthorizedTextCommand, matchCommandPrefix } from "./command-gates.js";
import { resolveCommandSourceSessionKey } from "./command-source-session-key.js";
import type { CommandHandler } from "./commands-types.js";
import { resolveConversationBindingContextFromMessage } from "./conversation-binding-input.js";
import { routePreparedReply } from "./route-reply.js";

/** Only display-projected conversation text may cross into the new native thread. */
function forkPreview(messages: unknown[]): string {
  const excerpts = messages.flatMap((value) => {
    const message = asOptionalRecord(value);
    if (
      !message ||
      message.display === false ||
      (message.role !== "user" && message.role !== "assistant")
    ) {
      return [];
    }
    if (
      message.role === "assistant" &&
      (isSilentAssistantTranscriptMessage(message) ||
        isTranscriptOnlyOpenClawAssistantMessage(message))
    ) {
      return [];
    }
    const text =
      message.role === "assistant"
        ? extractAssistantPhaseText(message)
        : extractFirstTextBlock(message);
    return text?.trim()
      ? [
          `${message.role === "user" ? "User" : "Assistant"}: ${truncateUtf16Safe(text.trim(), 800)}`,
        ]
      : [];
  });
  return [
    "Forked from the original thread. Earlier context is copied; new messages stay here.",
    "",
    "Recent messages:",
    ...excerpts.slice(-3),
  ].join("\n");
}

export const handleForkCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/fork", match: (body) => matchCommandPrefix(body, "/fork") },
  async (params, rawTitle) => {
    const conversation = resolveConversationBindingContextFromMessage({
      cfg: params.cfg,
      ctx: params.ctx,
      commandTo: params.command.to,
    });
    const plugin = conversation ? getLoadedChannelPluginForRead(conversation.channel) : undefined;
    const prepareFork = plugin?.conversationBindings?.prepareFork;
    if (!conversation || !plugin || !prepareFork) {
      return commandReply(
        "/fork is unavailable here. Use a supported channel thread, or Fork conversation in the Control UI.",
      );
    }
    const title = rawTitle.trim() || undefined;
    if (title && /[\r\n]/.test(title)) {
      return commandReply("Usage: /fork [title] — use a single-line title.");
    }
    const assertCommandAuthorized = params.command.assertAuthorizedCurrent;
    let open = true;
    let childKey: string | undefined;
    let binding: SessionBindingRecord | undefined;
    let audience = "";
    let assertNativeCurrent: (() => void) | undefined;
    let source:
      | Awaited<
          ReturnType<
            typeof import("../../config/sessions/session-delivery-generation.js").prepareSessionGenerationFacts
          >
        >
      | undefined;
    let sourceSessionKey: string | undefined;
    let recordOutcome: ((text: string, replyId: string) => Promise<void>) | undefined;
    const assertHostCurrent = composeSessionSourceAssertion([
      createDynamicSessionSourceAssertion(
        () => source?.assertCurrent,
        () => {
          throw new Error("The fork source changed; send a new request.");
        },
      ),
      captureExternalSessionCommitGuard(() => {
        if (!open || getLoadedChannelPluginForRead(conversation.channel) !== plugin) {
          throw new Error("The fork command or channel owner changed; send a new request.");
        }
        assertCommandAuthorized?.();
        params.commandInvocationSignal?.throwIfAborted();
        params.opts?.abortSignal?.throwIfAborted();
        if (params.command.senderIsOwner) {
          params.command.assertOwnerCurrent?.();
        }
      }),
    ]);
    const assertCurrent = composeSessionSourceAssertion([
      assertHostCurrent,
      captureExternalSessionCommitGuard(() => assertNativeCurrent?.()),
    ]);
    const finish = async (outcomeText: string) => {
      const text = outcomeText + audience;
      if (!recordOutcome || !sourceSessionKey) {
        return commandReply(text);
      }
      try {
        await recordOutcome(text, "fork-outcome");
        return commandReply(
          setReplyPayloadMetadata(
            { text },
            {
              sourceReplyTranscriptMirror: {
                sessionKey: sourceSessionKey,
                transcriptOwner: true,
                text,
              },
            },
          ),
        );
      } catch (error) {
        return commandReply(
          text +
            " The final command outcome could not be recorded: " +
            formatErrorMessage(error) +
            ".",
        );
      }
    };
    try {
      const prepared = await prepareFork({
        cfg: params.cfg,
        accountId: conversation.accountId,
        source: conversation,
        sourceMessageId: params.ctx.MessageSidFull ?? params.ctx.MessageSid,
        isGroup: params.isGroup,
        senderId: params.command.senderId,
        title,
        assertCurrent: assertHostCurrent,
        signal: params.opts?.abortSignal,
      });
      assertCurrent();
      if (!prepared.ok) {
        return commandReply(prepared.reason);
      }
      assertNativeCurrent = prepared.assertCurrent;
      assertCurrent();
      const bindings = getSessionBindingService();
      const bound = await bindings.resolveByConversationAsync(conversation);
      assertCurrent();
      const parentKey = resolveCommandSourceSessionKey(
        {
          cfg: params.cfg,
          ctx: params.ctx,
          sessionKey: bound?.targetSessionKey ?? params.sessionKey,
        },
        bound ? { preferCommandTarget: false } : undefined,
      );
      if (!parentKey) {
        throw new Error("Could not resolve the source conversation");
      }
      sourceSessionKey = parentKey;
      const agentId = resolveSessionAgentId({
        sessionKey: parentKey,
        config: params.cfg,
        fallbackAgentId: params.agentId,
      });
      const storePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
      const [
        { createGatewaySession },
        { readSessionEntryReadOnlyInWorker },
        { isSessionControllerWorkActive },
        { prepareSessionGenerationFacts },
        { recordCommittedCommandExchange, scopeCommandTranscriptId },
        { runAgentHarnessBeforeMessageWriteHook },
      ] = await Promise.all([
        import("../../gateway/session-create-service.js"),
        import("../../config/sessions/session-entry-read-runtime.js"),
        import("../../sessions/session-controller.lifecycle.js"),
        import("../../config/sessions/session-delivery-generation.js"),
        import("../../config/sessions/command-transcript.js"),
        import("../../agents/harness/hook-helpers.js"),
      ]);
      const parent = await readSessionEntryReadOnlyInWorker(
        {
          agentId,
          sessionKey: parentKey,
          storePath,
        },
        assertCurrent,
      );
      if (!parent) {
        return commandReply(
          "There is no conversation context to fork yet. Send a message in this thread first.",
        );
      }
      source = await prepareSessionGenerationFacts({
        agentId,
        storePath,
        sessionKey: parentKey,
        sessionId: parent.sessionId,
        lifecycleRevision: parent.lifecycleRevision ?? null,
      });
      assertCurrent();
      const commandId = scopeCommandTranscriptId(
        params.ctx.MessageSidFull ?? params.ctx.MessageSid ?? params.opts?.runId ?? randomUUID(),
        {
          channelId: conversation.channel,
          accountId: conversation.accountId,
          conversationId: conversation.conversationId,
        },
      );
      recordOutcome = async (replyText, replyId) => {
        const inputAdmission = params.opts?.userTurnTranscriptRecorder?.getAdmissionReceipt();
        const result = await recordCommittedCommandExchange({
          config: params.cfg,
          agentId,
          sessionKey: parentKey,
          storePath,
          expectedSessionId: parent.sessionId,
          expectedLifecycleRevision: parent.lifecycleRevision ?? null,
          // Local recovery recording needs the source owner, not permission to send a recap.
          assertCurrent: assertHostCurrent,
          beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
          commandText: params.command.commandBodyNormalized,
          commandId,
          commandInputCommitted:
            inputAdmission?.sessionKey === parentKey &&
            inputAdmission.sessionId === parent.sessionId,
          replyText,
          replyId,
        });
        if (!result.ok) {
          throw new Error(result.reason);
        }
      };
      const active = isSessionControllerWorkActive(
        storePath,
        [parentKey, parent.sessionId],
        agentId,
      );
      // Adoption prevents ingress redelivery from creating a second native destination.
      await params.opts?.turnAdoptionLifecycle?.onAdopted();
      assertCurrent();
      const created = await createGatewaySession({
        cfg: params.cfg,
        key: `agent:${agentId}:fork:${randomUUID()}`,
        agentId,
        displayName: title ?? "Forked conversation",
        parentSessionKey: parentKey,
        fork: true,
        ...(active ? { forkFrom: "last-completed" as const } : {}),
        commandSource: `${conversation.channel}:fork`,
        creation: {
          via: "channel",
          actor: { type: "human", source: "channel", id: params.command.senderId },
        },
        commitGuard: captureExternalSessionCommitGuard(assertCurrent),
        onCreatedSessionCommitted: (child) => {
          childKey = child.key;
        },
      });
      if (!created.ok) {
        throw new Error(created.error.message);
      }
      childKey = created.key;
      // Save the local commit before any native effect; a lost acknowledgment
      // must not erase the copy or imply that a thread or recap was delivered.
      await recordOutcome(
        "Copied session " +
          childKey +
          " created. Native thread creation and recap delivery are unconfirmed.",
        "fork-created",
      );
      const { readChatHistoryPage } =
        await import("../../gateway/server-methods/chat-history-pages.js");
      // Use the committed child snapshot, including a busy source's completed-prefix selection.
      const history = await readChatHistoryPage(
        {
          entry: created.entry,
          provider: undefined,
          sessionId: created.entry.sessionId,
          storePath,
          sessionAgentId: created.agentId,
          canonicalKey: childKey,
          max: 50,
          maxHistoryBytes: 128_000,
          effectiveMaxChars: 800,
          offset: undefined,
          messageId: undefined,
        },
        params.opts?.abortSignal,
      );
      assertCurrent();
      const destination = await prepared.create(childKey);
      audience = destination.notice ? ` ${destination.notice}` : "";
      const candidate = destination.binding;
      assertCurrent();
      if (
        candidate.targetSessionKey !== childKey ||
        candidate.status !== "active" ||
        candidate.conversation.channel !== conversation.channel ||
        candidate.conversation.accountId !== conversation.accountId
      ) {
        throw new Error("The channel returned a fork binding for a different session or account");
      }
      binding = candidate;
      const delivery = deliveryContextFromConversation(binding.conversation);
      if (!delivery?.to) {
        throw new Error("The channel did not return a delivery target for the new thread");
      }
      // Copied transcript text must never be interpreted as model-authored delivery instructions.
      const recapText = forkPreview(history.messages);
      const plan = createStructuredOutboundPayloadPlan([
        prepared.formatRecap?.(recapText) ?? { text: recapText },
      ])[0];
      if (!plan) {
        throw new Error("Could not prepare the fork recap");
      }
      const sent = await routePreparedReply({
        plan,
        channel: conversation.channel,
        to: delivery.to,
        accountId: conversation.accountId,
        threadId: delivery.threadId,
        cfg: params.cfg,
        agentId,
        sessionKey: childKey,
        policyConversationType: "group",
        isGroup: true,
        // Confirmed recap delivery is display-only bookkeeping, not a second
        // model-visible copy of the inherited excerpts.
        mirror: true,
        replyKind: "final",
        assertCurrent,
        abortSignal: params.opts?.abortSignal,
      });
      const location = destination.url ?? binding.conversation.conversationId;
      if (sent.queueCustody === "held" || sent.ambiguous || (sent.delivered && !sent.ok)) {
        return await finish(
          `Fork created: ${location}. Recap delivery is unconfirmed; check the new thread before retrying.`,
        );
      }
      return await finish(
        sent.delivered
          ? `Fork created: ${location}. The last three available text messages are in the new thread; continue there.`
          : `Fork created: ${location}, but the recap was not delivered. The copied context is saved; check channel permissions and continue in the new thread.`,
      );
    } catch (error) {
      const retained = binding
        ? ` The new thread ${binding.conversation.conversationId} and copied session are retained.`
        : childKey
          ? ` Copied session ${childKey} is retained, but thread creation was not confirmed. Check the channel permissions and thread list before retrying.`
          : "";
      return await finish(`Could not complete /fork: ${formatErrorMessage(error)}.${retained}`);
    } finally {
      open = false;
      source?.release();
    }
  },
);
