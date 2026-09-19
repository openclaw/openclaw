import { parseDateFirstTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentActivityItem } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { createChannelProgressDraftCompositor } from "../channels/progress-draft-compositor.js";
import type { ChannelProgressDraftCompositorSnapshot } from "../channels/progress-draft-compositor.types.js";
import { getProgressDraftLineText } from "../channels/progress-draft-lines.js";
import {
  buildChannelProgressDraftLineForEntry,
  copyProgressDraftLineMetadata,
  resolveChannelProgressDraftMaxLines,
  resolveChannelStreamingPreviewCommandText,
  resolveChannelStreamingPreviewToolProgress,
  resolveChannelStreamingProgressCommentary,
} from "../channels/streaming.js";
import { mergeAccountConfig } from "../config/channel-account-config.js";
import { resolveChannelConfigRecord } from "../config/channel-configured-shared.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveChannelAccountKey } from "../routing/account-lookup.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { getTaskExecutionObservation } from "./task-execution-observation.js";
import { getTaskPreparedActivity } from "./task-registry-activity.js";
import type { TaskProgressItem, TaskProgressPlan } from "./task-registry.process-state.js";
import type { TaskRecord } from "./task-registry.types.js";
import { formatTaskStatusTitleText } from "./task-status.js";

export async function prepareProgressContent(
  key: string,
  origin: DeliveryContext | undefined,
  rows: readonly { task: TaskRecord; entry: Pick<SubagentRunRecord, "runId" | "generation"> }[],
  initialSnapshot?: ChannelProgressDraftCompositorSnapshot,
  updates?: { items: readonly TaskProgressItem[]; plan?: TaskProgressPlan },
): Promise<{ content: string; snapshot: ChannelProgressDraftCompositorSnapshot } | undefined> {
  if (!origin?.channel) {
    return undefined;
  }
  const channel = resolveChannelConfigRecord(getRuntimeConfig(), origin.channel) ?? undefined;
  const accounts = asOptionalRecord(channel?.accounts);
  const accountKey = resolveChannelAccountKey(
    accounts,
    origin.accountId ?? "default",
    origin.channel,
  );
  const account = asOptionalRecord(accountKey ? accounts?.[accountKey] : undefined);
  const config = mergeAccountConfig({ channelConfig: channel, accountConfig: account });
  const streaming = asOptionalRecord(config.streaming);
  // Task state_changes is the opt-in. Explicit channel detail/quiet choices still win.
  const entry = {
    streaming: {
      ...streaming,
      progress: {
        ...asOptionalRecord(streaming?.progress),
        toolProgress: resolveChannelStreamingPreviewToolProgress({ streaming }, true, "progress"),
        commentary: resolveChannelStreamingProgressCommentary({ streaming }, true, "progress"),
        commandText: resolveChannelStreamingPreviewCommandText({ streaming }, "raw"),
      },
    },
  };
  const budget = resolveChannelProgressDraftMaxLines(entry);
  const childLabels = new Map<string, string>();
  const observations = new Map(
    rows.map(({ task }) => [task.taskId, getTaskExecutionObservation(task)]),
  );
  const prepareItem = (update: TaskProgressItem): AgentActivityItem => {
    const { item, source } = update;
    if (!source) {
      return item;
    }
    const namespace = `${source.runId}:${source.generation}`;
    const itemId = `${namespace}:${item.itemId}`;
    const observation = observations.get(source.taskId);
    childLabels.set(itemId, source.label);
    return {
      ...item,
      itemId,
      ...(item.toolCallId ? { toolCallId: `${namespace}:${item.toolCallId}` } : {}),
      ...(item.kind === "preamble" && item.progressText
        ? { progressText: `${source.label}: ${item.progressText}` }
        : {}),
      ...(item.status === "running" && observation?.state !== "running"
        ? { status: undefined, phase: "end", summary: "Current activity unavailable" }
        : {}),
    };
  };
  const compositor = createChannelProgressDraftCompositor({
    entry,
    mode: "progress",
    active: true,
    preparedItems: true,
    reasoningGate: false,
    commentaryItalics: false,
    seed: key,
    initialSnapshot: initialSnapshot
      ? {
          ...initialSnapshot,
          lines: initialSnapshot.lines.map((line) => {
            if (typeof line === "string" || line.status !== "running") {
              return line;
            }
            const historical = { ...line, status: "last observed" };
            return { ...historical, text: getProgressDraftLineText(historical) };
          }),
        }
      : undefined,
    buildProgressEventLine: (input, options) => {
      const line = buildChannelProgressDraftLineForEntry(entry, input, options);
      const label =
        input.event === "item" && input.itemId ? childLabels.get(input.itemId) : undefined;
      if (!line || !label) {
        return line;
      }
      const labeled = { ...line, label: `${label}: ${line.label}`, text: `${label}: ${line.text}` };
      copyProgressDraftLineMetadata(line, labeled);
      return labeled;
    },
  });
  let retained = 0;
  const streams = rows.map(({ task, entry: run }) => {
    const label = formatTaskStatusTitleText(task.label, "Subagent");
    const observation = observations.get(task.taskId)!;
    const namespace = `${run.runId}:${run.generation}`;
    const taskItem: AgentActivityItem = {
      itemId: `${namespace}:task`,
      kind: "subagent",
      phase: "update",
      title: observation.state === "finished" ? `${label} (${task.status})` : label,
      ...(observation.state === "running"
        ? { status: "running" }
        : observation.state === "finished"
          ? {
              phase: "end",
              status:
                task.status === "cancelled"
                  ? undefined
                  : task.status === "succeeded"
                    ? "completed"
                    : "failed",
            }
          : {}),
      ...(!initialSnapshot && observation.state === "running" && observation.currentTool
        ? { summary: observation.currentTool.name }
        : {}),
      ...(observation.state === "unknown" ? { summary: "Current activity unavailable" } : {}),
      ...(observation.state === "waiting" || observation.state === "queued"
        ? { summary: observation.state }
        : {}),
    };
    const terminalItem = observation.state === "finished" ? taskItem : undefined;
    const items: AgentActivityItem[] = terminalItem ? [] : [taskItem];
    const prepared = initialSnapshot ? getTaskPreparedActivity(task.taskId) : undefined;
    for (const item of prepared?.values() ?? []) {
      items.push(
        prepareItem({
          item,
          source: {
            taskId: task.taskId,
            runId: run.runId,
            generation: run.generation ?? 0,
            label,
          },
        }),
      );
    }
    const selected = items.slice(-budget);
    retained = Math.max(retained, selected.length);
    return {
      items: selected,
      terminalItem,
      at: parseDateFirstTimestampMs(observation.lastActivityAt) ?? task.createdAt,
    };
  });
  streams.sort((left, right) => left.at - right.at);
  // Interleave children so one chatty child cannot consume every retained row.
  for (let offset = retained - 1; offset >= 0; offset -= 1) {
    for (const { items } of streams) {
      const item = items[items.length - 1 - offset];
      if (item) {
        await compositor.pushItemEvent(item);
      }
    }
  }
  for (const update of updates?.items ?? []) {
    await compositor.pushItemEvent(prepareItem(update));
  }
  // Pending activity can outlive overlay cleanup; finish with authoritative outcomes.
  for (const { terminalItem } of streams) {
    if (terminalItem) {
      await compositor.pushItemEvent(terminalItem);
    }
  }
  if (updates?.plan) {
    await compositor.pushPlanProgress(updates.plan.steps, {
      explanation: updates.plan.explanation,
      explanationFormat: updates.plan.explanationFormat,
    });
  }
  return {
    content: compositor.getText(),
    snapshot: compositor.getSnapshot(),
  };
}
