import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { isMessagingToolSendAction } from "../../agents/embedded-agent-messaging.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { normalizeAgentPlanSteps } from "../../channels/streaming.js";
import { logVerbose } from "../../globals.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PreparedReplyTranscriptStart } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../types.js";
import type { AgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
import { buildCommandOutputFromToolResultEvent } from "./agent-runner-command-output.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  createCompactionHookNoticePayload,
  createCompactionNoticePayload,
  formatCompactionModelRef,
} from "./compaction-notice.js";

const agentCompactionLog = createSubsystemLogger("auto-reply/compaction");
const CODEX_APP_SERVER_COMPACTION_BACKEND = "codex-app-server";

export type MessageToolDeliveryState = {
  toolCallIds: Set<string>;
  completed: boolean;
};

export function createAgentRunEventHandler(params: {
  turn: AgentTurnParams;
  lifecycleBackstop: AgentLifecycleTerminalBackstop;
  prepareAgentRunStart: () => void | Promise<void>;
  notifyAgentRunStart: (transcriptStart?: PreparedReplyTranscriptStart | null) => void;
  sourceRepliesAreToolOnly: boolean;
  provider: string;
  model: string;
  effectiveSessionId?: string;
  notifyUserAboutCompaction: boolean;
  onCompactionCompleted: () => number;
  messageToolDeliveryState: MessageToolDeliveryState;
}): NonNullable<RunEmbeddedAgentParams["onAgentEvent"]> {
  const shouldSuppressProgressAfterMessageToolDelivery = () =>
    params.sourceRepliesAreToolOnly &&
    params.messageToolDeliveryState.completed &&
    params.turn.opts?.allowProgressCallbacksWhenSourceDeliverySuppressed !== true;

  const currentMessageId =
    params.turn.sessionCtx.MessageSidFull ?? params.turn.sessionCtx.MessageSid;
  const deliverCompactionNoticePayload = async (noticePayload: ReplyPayload, label: string) => {
    const deliver = params.turn.opts?.onBlockReply ?? params.turn.onCompactionNoticePayload;
    if (!deliver) {
      return;
    }
    try {
      await deliver(noticePayload);
    } catch (err) {
      logVerbose(`compaction ${label} notice delivery failed (non-fatal): ${String(err)}`);
    }
  };

  return async (evt) => {
    params.turn.replyOperation?.recordActivity();
    params.lifecycleBackstop.note(evt);
    const hasLifecyclePhase = evt.stream === "lifecycle" && typeof evt.data.phase === "string";
    if (evt.stream !== "lifecycle" || hasLifecyclePhase) {
      const preparation =
        evt.transcriptStart === undefined ? params.prepareAgentRunStart() : undefined;
      if (preparation) {
        await preparation;
      }
      params.notifyAgentRunStart(evt.transcriptStart);
    }
    if (evt.stream === "tool" && evt.data.hideFromChannelProgress !== true) {
      const phase = readStringValue(evt.data.phase) ?? "";
      const name = readStringValue(evt.data.name);
      const toolCallId = readStringValue(evt.data.toolCallId) ?? "";
      const args =
        evt.data.args && typeof evt.data.args === "object"
          ? (evt.data.args as Record<string, unknown>)
          : undefined;
      if (
        params.sourceRepliesAreToolOnly &&
        toolCallId &&
        name &&
        (phase === "start" || phase === "update") &&
        args &&
        isMessagingToolSendAction(name, args)
      ) {
        params.messageToolDeliveryState.toolCallIds.add(toolCallId);
      }
      if (shouldSuppressProgressAfterMessageToolDelivery()) {
        return;
      }
      if (phase === "start" || phase === "update") {
        const toolStartProgressPromise = params.turn.opts?.onToolStart?.({
          itemId: readStringValue(evt.data.itemId),
          toolCallId: readStringValue(evt.data.toolCallId),
          name,
          phase,
          args,
          detailMode: params.turn.toolProgressDetail,
        });
        await Promise.all([params.turn.typingSignals.signalToolStart(), toolStartProgressPromise]);
      }
      const commandOutput = buildCommandOutputFromToolResultEvent(evt);
      if (commandOutput) {
        await params.turn.opts?.onCommandOutput?.(commandOutput);
      }
    }

    const itemPhase = evt.stream === "item" ? readStringValue(evt.data.phase) : "";
    const itemName = evt.stream === "item" ? readStringValue(evt.data.name) : "";
    const itemStatus = evt.stream === "item" ? readStringValue(evt.data.status) : "";
    const itemToolCallId =
      evt.stream === "item" ? (readStringValue(evt.data.toolCallId) ?? "") : "";
    const completedMessageToolDelivery =
      params.sourceRepliesAreToolOnly &&
      itemPhase === "end" &&
      itemStatus === "completed" &&
      itemToolCallId.length > 0 &&
      params.messageToolDeliveryState.toolCallIds.has(itemToolCallId);
    const suppressProgressAfterMessageToolDelivery =
      shouldSuppressProgressAfterMessageToolDelivery();
    if (completedMessageToolDelivery) {
      params.messageToolDeliveryState.toolCallIds.delete(itemToolCallId);
      params.messageToolDeliveryState.completed = true;
    }

    if (
      evt.stream === "item" &&
      (!suppressProgressAfterMessageToolDelivery || completedMessageToolDelivery)
    ) {
      const itemSummary = readStringValue(evt.data.summary);
      const itemProgressText = readStringValue(evt.data.progressText);
      const itemMeta = readStringValue(evt.data.meta);
      const itemCommandBearing =
        typeof evt.data.commandBearing === "boolean" ? evt.data.commandBearing : undefined;
      const itemApprovalId = readStringValue(evt.data.approvalId);
      const itemApprovalSlug = readStringValue(evt.data.approvalSlug);
      await params.turn.opts?.onItemEvent?.({
        itemId: readStringValue(evt.data.itemId),
        kind: readStringValue(evt.data.kind),
        title: readStringValue(evt.data.title),
        phase: itemPhase,
        status: itemStatus,
        ...(evt.data.hideFromChannelProgress === true ? { hideFromChannelProgress: true } : {}),
        ...(evt.data.suppressChannelProgress === true ? { suppressChannelProgress: true } : {}),
        ...(itemToolCallId ? { toolCallId: itemToolCallId } : {}),
        ...(itemName ? { name: itemName } : {}),
        ...(itemSummary !== undefined ? { summary: itemSummary } : {}),
        ...(itemProgressText !== undefined ? { progressText: itemProgressText } : {}),
        ...(itemMeta !== undefined ? { meta: itemMeta } : {}),
        ...(itemCommandBearing !== undefined ? { commandBearing: itemCommandBearing } : {}),
        ...(itemApprovalId !== undefined ? { approvalId: itemApprovalId } : {}),
        ...(itemApprovalSlug !== undefined ? { approvalSlug: itemApprovalSlug } : {}),
      });
    }
    if (evt.stream === "plan" && !shouldSuppressProgressAfterMessageToolDelivery()) {
      await params.turn.opts?.onPlanUpdate?.({
        phase: readStringValue(evt.data.phase),
        title: readStringValue(evt.data.title),
        explanation: readStringValue(evt.data.explanation),
        ...(evt.data.explanationFormat === "plain" ? { explanationFormat: "plain" as const } : {}),
        steps: normalizeAgentPlanSteps(evt.data.steps),
        source: readStringValue(evt.data.source),
      });
    }
    if (evt.stream === "approval" && !shouldSuppressProgressAfterMessageToolDelivery()) {
      const scope = evt.data.scope;
      await params.turn.opts?.onApprovalEvent?.({
        phase: readStringValue(evt.data.phase),
        kind: readStringValue(evt.data.kind),
        status: readStringValue(evt.data.status),
        title: readStringValue(evt.data.title),
        itemId: readStringValue(evt.data.itemId),
        toolCallId: readStringValue(evt.data.toolCallId),
        approvalId: readStringValue(evt.data.approvalId),
        approvalSlug: readStringValue(evt.data.approvalSlug),
        command: readStringValue(evt.data.command),
        host: readStringValue(evt.data.host),
        reason: readStringValue(evt.data.reason),
        scope: scope === "turn" || scope === "session" ? scope : undefined,
        message: readStringValue(evt.data.message),
      });
    }
    const readToolEventIdentity = () => ({
      itemId: readStringValue(evt.data.itemId),
      phase: readStringValue(evt.data.phase),
      title: readStringValue(evt.data.title),
      toolCallId: readStringValue(evt.data.toolCallId),
      name: readStringValue(evt.data.name),
    });
    if (evt.stream === "command_output" && !shouldSuppressProgressAfterMessageToolDelivery()) {
      await params.turn.opts?.onCommandOutput?.({
        ...readToolEventIdentity(),
        output: readStringValue(evt.data.output),
        status: readStringValue(evt.data.status),
        exitCode:
          typeof evt.data.exitCode === "number" || evt.data.exitCode === null
            ? evt.data.exitCode
            : undefined,
        durationMs: typeof evt.data.durationMs === "number" ? evt.data.durationMs : undefined,
        cwd: readStringValue(evt.data.cwd),
      });
    }
    if (evt.stream === "patch" && !shouldSuppressProgressAfterMessageToolDelivery()) {
      const readPaths = (value: unknown) =>
        Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === "string")
          : undefined;
      await params.turn.opts?.onPatchSummary?.({
        ...readToolEventIdentity(),
        added: readPaths(evt.data.added),
        modified: readPaths(evt.data.modified),
        deleted: readPaths(evt.data.deleted),
        summary: readStringValue(evt.data.summary),
      });
    }
    if (evt.stream !== "compaction") {
      return;
    }

    const phase = readStringValue(evt.data.phase) ?? "";
    const backend = readStringValue(evt.data.backend);
    const hookMessages = normalizeTrimmedStringList(evt.data.messages);
    const sendCompactionUserNotices = async (
      noticePhase: "start" | "end" | "incomplete" | "degraded",
    ) => {
      if (hookMessages.length > 0) {
        const noticePayload = createCompactionHookNoticePayload({
          messages: hookMessages,
          currentMessageId,
          applyReplyToMode: params.turn.applyReplyToMode,
        });
        if (noticePayload) {
          await deliverCompactionNoticePayload(noticePayload, "hook");
        }
      }
      if (noticePhase === "degraded" || params.notifyUserAboutCompaction) {
        await deliverCompactionNoticePayload(
          createCompactionNoticePayload({
            phase: noticePhase,
            currentMessageId,
            applyReplyToMode: params.turn.applyReplyToMode,
          }),
          noticePhase,
        );
      }
    };
    if (phase === "start") {
      await params.turn.opts?.onCompactionStart?.();
      await sendCompactionUserNotices("start");
      return;
    }
    if (phase !== "end") {
      return;
    }
    if (evt.data.completed !== true) {
      await params.turn.opts?.onCompactionEnd?.({ completed: false });
      await sendCompactionUserNotices("incomplete");
      return;
    }

    const compactionCount = params.onCompactionCompleted();
    if (backend === CODEX_APP_SERVER_COMPACTION_BACKEND) {
      const modelRef = formatCompactionModelRef(params.provider, params.model);
      const consoleMessage =
        `codex app-server auto-compaction succeeded for ${modelRef}; ` +
        "refreshed session context";
      agentCompactionLog.info("codex app-server auto-compaction succeeded", {
        event: "codex_app_server_compaction_succeeded",
        backend,
        provider: params.provider,
        model: params.model,
        sessionKey: params.turn.sessionKey,
        sessionId: params.effectiveSessionId,
        threadId: readStringValue(evt.data.threadId),
        turnId: readStringValue(evt.data.turnId),
        itemId: readStringValue(evt.data.itemId),
        compactionCount,
        consoleMessage,
      });
    }
    await params.turn.opts?.onCompactionEnd?.({ completed: true });
    await sendCompactionUserNotices(evt.data.qualityDegraded === true ? "degraded" : "end");
  };
}
