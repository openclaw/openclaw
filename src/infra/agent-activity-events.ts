import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isSyntheticMissingToolResult } from "../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import type { AgentActivityItem } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { projectAgentActivityItem } from "../agents/agent-activity-presentation.js";
import { isProcessPollResultDetails } from "../agents/bash-tools.process-schema.js";
import {
  inferToolMetaFromArgsCore,
  isCommandBearingToolCall,
  resolveToolDisplay,
} from "../agents/tool-display.js";
import { isToolResultError } from "../agents/tool-result-error.js";
import {
  isToolCallContentType,
  isToolResultContentType,
  readToolErrorFlag,
  resolveToolUseId,
} from "../chat/tool-content.js";
import {
  readNestedToolActivity,
  nestedToolActivityContent,
} from "../sessions/nested-tool-activity.js";
import { readSessionTranscriptRunId } from "../sessions/transcript-events.js";
import { emitAgentEvent, type AgentApprovalEventData } from "./agent-events.js";

type AgentItemEventStatus = NonNullable<AgentActivityItem["status"]>;

/** Live producers retain a known status and may attach additional telemetry. */
export type AgentItemEventData = AgentActivityItem &
  Record<string, unknown> & { status: AgentItemEventStatus };

/** Incremental command output payload associated with an item/tool call. */
export type AgentCommandOutputEventFields = {
  itemId: string;
  phase: "delta" | "end";
  title: string;
  toolCallId: string;
  name?: string;
  output?: string;
  status?: AgentItemEventStatus | "running";
  exitCode?: number | null;
  durationMs?: number;
  cwd?: string;
};
export type AgentCommandOutputEventData = Record<string, unknown> & AgentCommandOutputEventFields;

/** Patch summary payload emitted after an agent applies file changes. */
export type AgentPatchSummaryEventData = Record<string, unknown> & {
  itemId: string;
  phase: "end";
  title: string;
  toolCallId: string;
  name?: string;
  added: string[];
  modified: string[];
  deleted: string[];
  summary: string;
};

type AgentActivityEventDataByStream = {
  item: AgentItemEventData;
  approval: AgentApprovalEventData & Record<string, unknown>;
  command_output: AgentCommandOutputEventData;
  patch: AgentPatchSummaryEventData;
};

type ToolActivityInput = {
  toolCallId: string;
  name: string;
  phase: "start" | "update" | "result";
  args?: unknown;
  result?: unknown;
  meta?: string;
  status?: AgentItemEventStatus | "unknown";
  isError?: boolean;
  hideFromChannelProgress?: boolean;
  nativeOperation?: "wait" | "process.poll";
};

export function projectAgentToolActivity(
  tool: ToolActivityInput & ({ phase: "start" | "update" } | { status: AgentItemEventStatus }),
): AgentItemEventData;
export function projectAgentToolActivity(tool: ToolActivityInput): AgentActivityItem;
export function projectAgentToolActivity(tool: ToolActivityInput): AgentActivityItem {
  const meta = tool.meta ?? inferToolMetaFromArgsCore(tool.name, tool.args);
  const label = resolveToolDisplay({ name: tool.name }).label;
  const details = asOptionalRecord(asOptionalRecord(tool.result)?.details);
  const approval =
    tool.phase === "result" &&
    (details?.status === "approval-pending" || details?.status === "approval-unavailable");
  const skipped = tool.phase === "result" && details?.status === "skipped";
  const status =
    tool.phase !== "result"
      ? "running"
      : approval || skipped
        ? "blocked"
        : tool.status === "unknown"
          ? undefined
          : (tool.status ??
            (tool.isError === true ? "failed" : tool.isError === false ? "completed" : undefined));
  return projectAgentActivityItem(
    {
      itemId: `tool:${tool.toolCallId}`,
      toolCallId: tool.toolCallId,
      name: tool.name,
      kind: "tool",
      phase: tool.phase === "result" ? "end" : tool.phase,
      title: meta ? `${label} ${meta}` : label,
      ...(status
        ? { status }
        : { summary: "Outcome unknown", title: `${label} — outcome unknown` }),
      ...(approval
        ? {
            approvalId: normalizeOptionalString(details?.approvalId),
            approvalSlug: normalizeOptionalString(details?.approvalSlug),
            summary:
              details?.status === "approval-pending"
                ? "Awaiting approval before command can run."
                : "Command is blocked because no interactive approval route is available.",
          }
        : {}),
      ...(skipped ? { summary: "Skipped" } : {}),
      ...(meta ? { meta } : {}),
      commandBearing: isCommandBearingToolCall(tool.name, tool.args),
      ...(tool.hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
    },
    { args: tool.args, result: tool.result, nativeOperation: tool.nativeOperation },
  );
}

export type AgentHistoryActivity = { messageId: string; items: AgentActivityItem[] };

export function projectAgentHistoryActivity(
  messages: ReadonlyArray<{ messageId: string; message: unknown }>,
): AgentHistoryActivity[] {
  const facts = new Map<string, Parameters<typeof projectAgentToolActivity>[0]>();
  let turn = 0;
  const entries = messages.map(({ messageId, message }) => {
    const record = asOptionalRecord(message);
    const metadata = asOptionalRecord(record?.["__openclaw"]);
    if (
      record?.role === "user" &&
      !metadata?.steerTargetRunId &&
      !(record.excludeFromContext === true && metadata?.contextFreeCommand === true)
    ) {
      turn += 1;
    }
    const nestedActivity = readNestedToolActivity(message);
    const nested = nestedActivity?.details;
    const content = nestedActivity
      ? nestedToolActivityContent(nestedActivity)
      : Array.isArray(record?.content)
        ? record.content
        : [];
    const blocks = content.flatMap((block) => {
      const value = asOptionalRecord(block);
      return value && (isToolCallContentType(value.type) || isToolResultContentType(value.type))
        ? [value]
        : [];
    });
    if (
      record &&
      (isToolResultContentType(record.role) || record.role === "tool" || record.role === "function")
    ) {
      // Result envelopes mirror their payload as a content block. The envelope
      // owns details and error state; it is one outcome, not two operations.
      blocks.splice(0, blocks.length, record);
    }
    return {
      messageId,
      hasTools: blocks.length > 0,
      blocks: blocks.map((block, index) => {
        const toolCallId =
          normalizeOptionalString(block.toolCallId) ??
          normalizeOptionalString(block.tool_call_id) ??
          normalizeOptionalString(block.toolUseId) ??
          normalizeOptionalString(block.tool_use_id) ??
          (block === record ? undefined : resolveToolUseId(block));
        return {
          block,
          key: toolCallId
            ? JSON.stringify([
                turn,
                nested?.runId ?? readSessionTranscriptRunId(message),
                nested?.scopeId,
                toolCallId,
              ])
            : "history:" + messageId + ":" + index,
          toolCallId: toolCallId ?? "history:" + messageId + ":" + index,
          executedArgs: nested && nested.toolCallId === toolCallId ? nested.input : undefined,
          isError:
            readToolErrorFlag(block) ??
            (record ? readToolErrorFlag(record) : undefined) ??
            (typeof nested?.isError === "boolean" ? nested.isError : undefined),
        };
      }),
    };
  });
  const groups = new Map<string, { calls: number; results: number; synthetic: number }>();
  for (const { blocks } of entries) {
    for (const { block, key } of blocks) {
      const group = groups.get(key) ?? { calls: 0, results: 0, synthetic: 0 };
      group[
        isToolCallContentType(block.type)
          ? "calls"
          : isSyntheticMissingToolResult(block)
            ? "synthetic"
            : "results"
      ] += 1;
      groups.set(key, group);
    }
  }
  for (const entry of entries) {
    entry.blocks = entry.blocks.filter(({ block, key }) => {
      const group = groups.get(key)!;
      // Transcript repair placeholders lose compact authority to an actual result.
      // The raw row remains available, with an explicit empty activity descriptor.
      return !(group.calls <= 1 && group.results === 1 && isSyntheticMissingToolResult(block));
    });
    for (const [index, block] of entry.blocks.entries()) {
      const group = groups.get(block.key)!;
      // Legacy/imported rows may reuse IDs. Never propagate an ambiguous outcome.
      if (group.calls > 1 || group.results + (group.results === 1 ? 0 : group.synthetic) > 1) {
        block.key = "history:" + entry.messageId + ":" + index;
      }
    }
  }
  for (const { blocks } of entries) {
    for (const { block, key, toolCallId, executedArgs } of blocks) {
      if (isToolCallContentType(block.type)) {
        const name =
          normalizeOptionalString(block.name) ?? normalizeOptionalString(block.toolName) ?? "Tool";
        // A transcript call is not live authority. Its result may be absent or
        // outside this page; only live events can establish running activity.
        facts.set(key, { toolCallId, name, phase: "result", args: executedArgs });
      }
    }
  }
  for (const { blocks } of entries) {
    for (const { block, key, toolCallId, executedArgs, isError } of blocks) {
      if (isToolCallContentType(block.type)) {
        continue;
      }
      const call = facts.get(key);
      const name =
        call?.name ??
        normalizeOptionalString(block.toolName) ??
        normalizeOptionalString(block.name) ??
        "Tool";
      const failed = isError === true || isToolResultError(block);
      const details = asOptionalRecord(block.details);
      const exitReasonLost =
        (name === "exec" || name === "bash" || name === "process") &&
        details?.status === "completed" &&
        typeof details.exitCode === "number" &&
        Number.isFinite(details.exitCode) &&
        details.exitCode !== 0 &&
        details.persistedDetailsTruncated === true &&
        details.exitReason === undefined &&
        Array.isArray(details.originalDetailKeys) &&
        details.originalDetailKeys.includes("exitReason");
      const poll = name === "process" && isProcessPollResultDetails(details);
      facts.set(key, {
        ...call,
        toolCallId,
        name,
        phase: "result",
        args: executedArgs ?? call?.args,
        result: block,
        isError: failed ? true : poll ? false : isError,
        // The existing persistence cap can remove the distinction between a
        // requested stop and a failed command. Do not invent that outcome.
        ...(!failed && exitReasonLost ? { status: "unknown" as const } : {}),
        ...(poll ? { nativeOperation: "process.poll" } : {}),
      });
    }
  }
  return entries.flatMap(({ messageId, blocks, hasTools }) => {
    if (!hasTools) {
      return [];
    }
    const items = new Map<string, AgentActivityItem>();
    for (const { key } of blocks) {
      const fact = facts.get(key);
      if (!fact) {
        continue;
      }
      const item = projectAgentToolActivity({
        ...fact,
        ...(fact.name === "collab.wait" ? { nativeOperation: "wait" } : {}),
      });
      if (!item.hideFromChannelProgress && !item.suppressChannelProgress) {
        items.set(item.itemId, item);
      }
    }
    return [{ messageId, items: [...items.values()] }];
  });
}

type AgentActivityEventParams = {
  [Stream in keyof AgentActivityEventDataByStream]: {
    runId: string;
    sessionKey?: string;
    stream: Stream;
    data: AgentActivityEventDataByStream[Stream];
  };
}[keyof AgentActivityEventDataByStream];

/** Emits a typed activity event on the shared agent event bus. */
export function emitAgentActivityEvent(params: AgentActivityEventParams): void {
  emitAgentEvent({
    runId: params.runId,
    stream: params.stream,
    data: params.data,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}
