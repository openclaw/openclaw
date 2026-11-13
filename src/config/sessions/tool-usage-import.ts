import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createToolUsageCatalogResolver,
  isToolUsageWrapper,
  mergeToolUsage,
  classifyToolUsage,
  type ToolUsageCatalogEntry,
  type ToolUsageRow,
  TOOL_USAGE_RETENTION_MS,
} from "../../agents/tool-usage.js";
import {
  dropInheritedTranscriptEvents,
  projectUsageScanFields,
} from "../../infra/session-cost-usage-inherited.js";
import {
  isNestedToolActivityResultOmitted,
  readOwnNestedToolActivity,
} from "../../sessions/nested-tool-activity.js";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import type { AgentToolUsageImportScan } from "./tool-usage.types.js";

function timestamp(value: unknown, fallback: number): number {
  const time = typeof value === "string" ? Date.parse(value) : value;
  return typeof time === "number" && Number.isFinite(time) ? time : fallback;
}

/** One session at a time; only call identity and target survive the current payload. */
export function createToolUsageTranscriptAccumulator(input: {
  catalog: readonly ToolUsageCatalogEntry[];
  since: number;
  before: number;
  coveredWindows?: readonly { since: number; before: number }[];
  liveRuns?: ReadonlySet<string>;
  liveSince?: number | null;
}) {
  const resolve = createToolUsageCatalogResolver(input.catalog);
  const catalogNames = new Map(input.catalog.map((entry) => [entry.id, entry.name]));
  const rows = new Map<string, ToolUsageRow>();
  const calls = new Map<string, { name: string; target?: string; codeModeControl: boolean }>();
  const seen = new Set<string>();
  const nestedParents = new Set<string>();
  const dispatches = new Map<
    string,
    { toolId: string; at: number; navigation: Record<string, unknown> }
  >();
  const navigation: Record<string, unknown>[] = [];
  const contributions: { row: ToolUsageRow; navigation: Record<string, unknown> }[] = [];
  let scannedEvents = 0;
  let successfulCalls = 0;
  let coldEvents = 0;
  const excluded = {
    errors: 0,
    cancelled: 0,
    pending: 0,
    incognito: 0,
    notExecuted: 0,
    wrappers: 0,
    unknownTools: 0,
    duplicates: 0,
    outsideWindow: 0,
    inherited: 0,
    recordedLive: 0,
    unknownRuns: 0,
    unknownOutcomes: 0,
  };
  function count(
    callId: string,
    toolId: string | undefined,
    at: number,
    eventNavigation: Record<string, unknown>,
  ) {
    if (!toolId) {
      excluded.unknownTools++;
      return;
    }
    if (seen.has(callId)) {
      excluded.duplicates++;
      return;
    }
    const recordedAt =
      typeof eventNavigation.usageRecordedAt === "number" ? eventNavigation.usageRecordedAt : at;
    if (
      recordedAt < input.since ||
      at < input.before - TOOL_USAGE_RETENTION_MS ||
      recordedAt >= input.before ||
      input.coveredWindows?.some(
        (window) => recordedAt >= window.since && recordedAt < window.before,
      )
    ) {
      excluded.outsideWindow++;
      return;
    }
    seen.add(callId);
    contributions.push({ row: { toolId, score: 1, updatedAt: at }, navigation: eventNavigation });
  }
  function finishSession() {
    for (const [callId, result] of dispatches) {
      if (!nestedParents.has(callId)) {
        count(callId, result.toolId, result.at, result.navigation);
      }
    }
    const owned = new Set(
      dropInheritedTranscriptEvents(
        navigation,
        contributions.map((entry) => entry.navigation),
      ),
    );
    for (const contribution of contributions) {
      if (!owned.has(contribution.navigation)) {
        excluded.inherited++;
        continue;
      }
      const row = contribution.row;
      const previous = rows.get(row.toolId);
      rows.set(row.toolId, previous ? mergeToolUsage(previous, row) : row);
      successfulCalls++;
    }
    navigation.length = 0;
    contributions.length = 0;
    calls.clear();
    seen.clear();
    nestedParents.clear();
    dispatches.clear();
  }
  return {
    finishSession,
    countColdEvent() {
      coldEvents++;
    },
    skipIncognito() {
      excluded.incognito++;
    },
    append(event: unknown, createdAt: number) {
      scannedEvents++;
      const envelope = asOptionalRecord(event);
      const eventNavigation: Record<string, unknown> = { usageRecordedAt: createdAt };
      if (envelope) {
        projectUsageScanFields(envelope, eventNavigation);
        navigation.push(eventNavigation);
      }
      const message = asOptionalRecord(envelope?.message) ?? envelope;
      if (!message) {
        return;
      }
      if (message.incognito === true || envelope?.incognito === true) {
        excluded.incognito++;
        return;
      }
      const nested = readOwnNestedToolActivity(message);
      if (nested || message.role === "toolResult") {
        const runId = nested?.details.runId ?? readSessionTranscriptRunId(message);
        if (runId && input.liveRuns?.has(runId)) {
          excluded.recordedLive++;
          return;
        }
        if (!runId && input.liveSince != null && createdAt >= input.liveSince) {
          excluded.unknownRuns++;
          return;
        }
      }
      if (nested) {
        const { toolCallId, toolName, isError, result, parentToolCallId } = nested.details;
        if (parentToolCallId) {
          nestedParents.add(parentToolCallId);
        }
        const reason = classifyToolUsage({ isError, result });
        if (reason) {
          excluded[reason]++;
        } else if (isNestedToolActivityResultOmitted(nested)) {
          excluded.unknownOutcomes++;
        } else if (isToolUsageWrapper(toolName)) {
          excluded.wrappers++;
        } else {
          const parent = parentToolCallId ? calls.get(parentToolCallId) : undefined;
          const target =
            parent?.name === "dispatch_action"
              ? parent.target && catalogNames.get(parent.target) === toolName
                ? parent.target
                : undefined
              : resolve(toolName);
          count(toolCallId, target, nested.details.timestamp, eventNavigation);
        }
        return;
      }
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          const call = asOptionalRecord(block);
          if (
            call?.type !== "toolCall" ||
            typeof call.id !== "string" ||
            typeof call.name !== "string"
          ) {
            continue;
          }
          const args = asOptionalRecord(call.arguments);
          calls.set(call.id, {
            name: call.name,
            codeModeControl:
              (call.name === "exec" && typeof args?.code === "string") ||
              (call.name === "wait" && typeof args?.runId === "string"),
            target:
              call.name === "dispatch_action" && typeof args?.id === "string"
                ? resolve(args.id)
                : resolve(call.name),
          });
        }
        return;
      }
      if (message.role !== "toolResult" || typeof message.toolCallId !== "string") {
        return;
      }
      const call = calls.get(message.toolCallId);
      const name =
        call?.name ?? (typeof message.toolName === "string" ? message.toolName : undefined);
      const dispatchResult = asOptionalRecord(asOptionalRecord(message.details)?.result);
      const reason =
        classifyToolUsage({ isError: message.isError === true, result: message }) ??
        (dispatchResult
          ? classifyToolUsage({ isError: dispatchResult.isError === true, result: dispatchResult })
          : undefined);
      if (reason) {
        excluded[reason]++;
        return;
      }
      if (!name) {
        excluded.unknownTools++;
        return;
      }
      const resultDetails = asOptionalRecord(message.details);
      if (
        call?.codeModeControl ||
        (name === "exec" &&
          asOptionalRecord(resultDetails?.telemetry) &&
          Array.isArray(resultDetails?.output))
      ) {
        excluded.wrappers++;
        return;
      }
      // Without the declaration, exec could be either the shell tool or a Code Mode control.
      if (!call && name === "exec") {
        excluded.unknownTools++;
        return;
      }
      const at = timestamp(message.timestamp, timestamp(envelope?.timestamp, createdAt));
      if (name === "dispatch_action") {
        excluded.wrappers++;
        if (call?.target) {
          dispatches.set(message.toolCallId, {
            toolId: call.target,
            at,
            navigation: eventNavigation,
          });
        } else {
          excluded.unknownTools++;
        }
      } else if (!isToolUsageWrapper(name)) {
        count(message.toolCallId, call?.target ?? resolve(name), at, eventNavigation);
      } else {
        excluded.wrappers++;
      }
    },
    result(): AgentToolUsageImportScan {
      finishSession();
      return {
        rows: [...rows.values()].toSorted((a, b) => a.toolId.localeCompare(b.toolId)),
        successfulCalls,
        scannedEvents,
        coldEvents,
        excluded,
      };
    },
  };
}
