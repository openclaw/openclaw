import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import {
  isToolErrorOutput,
  isToolCallContentType,
  isToolResultContentType,
  readToolErrorFlag,
  resolveToolUseId,
} from "./tool-content.js";

/** A successful instruction load, without paths or instruction content. */
export type ConversationSkillLoad =
  import("../../packages/gateway-protocol/src/schema/logs-chat.js").ChatSkillLoads[number];

function isFailedSkillResult(
  output: Record<string, unknown>,
  owner: Record<string, unknown>,
  explicitError: boolean | undefined,
): boolean {
  const classified =
    asOptionalRecord(asOptionalRecord(output["__openclaw"])?.toolOutput) ??
    asOptionalRecord(asOptionalRecord(owner["__openclaw"])?.toolOutput);
  if (
    classified?.outcome === "failed" ||
    classified?.outcome === "unknown" ||
    asOptionalRecord(output.details ?? owner.details)?.status === "skipped"
  ) {
    return true;
  }
  return (
    explicitError ??
    isToolErrorOutput(
      typeof output.text === "string"
        ? output.text
        : (extractTextFromChatContent(output.content, {
            joinWith: "\n",
            normalizeText: (text) => text,
          }) ?? undefined),
    )
  );
}

/** One contract for native tools, Code Mode history, and the live display stream. */
export function createConversationSkillLoadCollector(
  initial: readonly ConversationSkillLoad[] = [],
) {
  const loaded = new Map(initial.map((load) => [load.id, load]));
  const calls = new Map<string, string>();
  const identity = (runId: string | undefined, callId: unknown) =>
    typeof callId === "string" && callId ? JSON.stringify([runId ?? "", callId]) : undefined;
  const addLoaded = (id: string | undefined, name: unknown) => {
    if (id && typeof name === "string" && name.trim() && !loaded.has(id)) {
      loaded.set(id, { id, name: name.trim() });
    }
  };
  const add = (message: unknown) => {
    const record = asOptionalRecord(message);
    if (!record || record.display === false) {
      return;
    }
    const runId =
      normalizeOptionalString(asOptionalRecord(record["__openclaw"])?.runId) ??
      normalizeOptionalString(record.runId);
    if (record.role === "custom" && record.customType === "openclaw.nested-tool.v1") {
      const activity = asOptionalRecord(record.details);
      const output = asOptionalRecord(activity?.result);
      if (
        activity?.toolName === "skills_read" &&
        activity.isError === false &&
        output &&
        !isFailedSkillResult(output, record, false)
      ) {
        addLoaded(
          identity(
            typeof activity.runId === "string" ? activity.runId : runId,
            activity.toolCallId,
          ),
          asOptionalRecord(activity.input)?.name,
        );
      }
      return;
    }
    if (!["assistant", "toolResult", "tool", "function"].includes(String(record.role))) {
      return;
    }
    const live = record["__openclawToolStreamLive"] === true;
    const completed =
      !live ||
      record["__openclawToolStreamResultReceived"] === true ||
      record["__openclawToolStreamItemEnded"] === true;
    const result = (item: Record<string, unknown>) => {
      if (
        !completed ||
        isFailedSkillResult(item, record, readToolErrorFlag(item) ?? readToolErrorFlag(record))
      ) {
        return;
      }
      const id = identity(
        typeof item.runId === "string" ? item.runId : runId,
        resolveToolUseId(item) ?? resolveToolUseId(record),
      );
      const name = id ? calls.get(id) : undefined;
      addLoaded(id, name ?? asOptionalRecord(item.details ?? record.details)?.name);
    };
    if (record.role === "toolResult" || record.role === "tool" || record.role === "function") {
      if (
        record.toolName === "skills_read" ||
        calls.has(identity(runId, resolveToolUseId(record)) ?? "")
      ) {
        result(record);
      }
      return;
    }
    if (!Array.isArray(record.content)) {
      return;
    }
    for (const block of record.content) {
      const item = asOptionalRecord(block);
      if (!item) {
        continue;
      }
      if (isToolCallContentType(item.type) && item.name === "skills_read") {
        const id = identity(
          typeof item.runId === "string" ? item.runId : runId,
          resolveToolUseId(item) ?? resolveToolUseId(record),
        );
        const raw = item.arguments ?? item.args ?? item.input;
        const args = typeof raw === "string" ? safeParseJsonRecord(raw) : asOptionalRecord(raw);
        if (id && typeof args?.name === "string") {
          calls.set(id, args.name);
        }
      } else if (isToolResultContentType(item.type)) {
        const id = identity(
          typeof item.runId === "string" ? item.runId : runId,
          resolveToolUseId(item) ?? resolveToolUseId(record),
        );
        if ((item.toolName ?? item.name) === "skills_read" || calls.has(id ?? "")) {
          result(item);
        }
      }
    }
  };
  return { add, finish: () => [...loaded.values()] };
}
