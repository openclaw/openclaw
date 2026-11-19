import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isAutomationsToolName } from "../../../../src/agents/tools/automations-tool-name.js";
import {
  automationCreationCall,
  automationCreationFromToolDetails,
} from "../../../../src/chat/automation-job-result.js";
import {
  isToolCallContentType,
  isToolResultContentType,
  readToolErrorFlag,
  resolveToolBlockArgs,
  resolveToolUseId,
} from "../../../../src/chat/tool-content.js";
import {
  automationSlotAtPosition,
  readAutomationCreationEvent,
  type AutomationCreationEvent,
  type AutomationCreationPlan,
} from "../../../../src/shared/automation-creation.js";

type ToolCall = { args: Record<string, unknown>; source: unknown; runId?: string };

function terminalEvent(
  args: Record<string, unknown>,
  details: unknown,
  isError: boolean | undefined,
) {
  if (isError === undefined) {
    return undefined;
  }
  if (isError) {
    return args.action === "add"
      ? readAutomationCreationEvent({
          type: "automation_creation_result",
          planId: args.planId,
          slotId: args.slotId,
          status: "failed",
        })
      : undefined;
  }
  const event = automationCreationFromToolDetails(details);
  if (event?.type === "automation_creation_plan" && args.action === "plan") {
    return event;
  }
  if (
    event?.type === "automation_creation_result" &&
    args.action === "add" &&
    args.planId === event.planId &&
    args.slotId === event.slotId
  ) {
    return event;
  }
  return undefined;
}

/** Only a scheduler invocation and its terminal host result are evidence, never prose or a tool preview. */
export function automationCreationToolEvents(
  messages: readonly unknown[],
  onEvent?: (event: AutomationCreationEvent, source: unknown, runId?: string) => void,
): AutomationCreationEvent[] {
  const events: AutomationCreationEvent[] = [];
  const calls = new Map<string, ToolCall>();
  const declarations = new Map<string, AutomationCreationPlan>();
  const emit = (call: ToolCall, details: unknown, isError: boolean | undefined) => {
    let args = call.args;
    if (args.action === "add" && args.planId === undefined && args.slotId === undefined) {
      const plan = call.runId ? declarations.get(call.runId) : undefined;
      const slot = plan && automationSlotAtPosition(plan, args.position);
      if (!slot || !plan) {
        return;
      }
      args = { ...args, planId: plan.planId, slotId: slot.slotId };
    }
    const event = terminalEvent(args, details, isError);
    if (event?.type === "automation_creation_plan" && call.runId) {
      declarations.set(call.runId, event);
    }
    if (event) {
      events.push(event);
      onEvent?.(event, call.source, call.runId);
    }
  };
  for (const source of messages) {
    const m = asOptionalRecord(source);
    if (!m) {
      continue;
    }
    const meta = asOptionalRecord(m["__openclaw"]);
    if (meta?.catalogSource === true) {
      continue;
    }
    if (m.role === "user") {
      calls.clear();
      continue;
    }
    const nested =
      m.role === "custom" && m.customType === "openclaw.nested-tool.v1" && m.display !== false;
    if (nested && m.content === "") {
      // Before Gateway projection Code Mode persists input/result together in its custom row.
      const activity = asOptionalRecord(m.details);
      const args = automationCreationCall(activity?.input);
      if (
        activity &&
        args &&
        typeof activity.toolName === "string" &&
        isAutomationsToolName(activity.toolName) &&
        typeof activity.runId === "string" &&
        typeof activity.toolCallId === "string"
      ) {
        emit(
          { args, source, runId: activity.runId },
          asOptionalRecord(activity.result)?.details,
          readToolErrorFlag(activity),
        );
      }
      continue;
    }
    const standalone =
      isToolResultContentType(m.role) || m.role === "tool" || m.role === "function";
    const live = m["__openclawToolStreamLive"] === true;
    if (!standalone && !nested && m.role !== "assistant") {
      continue;
    }
    const blocks = standalone ? [m] : Array.isArray(m.content) ? m.content : [];
    const rowRunId = meta?.runId ?? m.runId;
    for (const raw of blocks) {
      const block = asOptionalRecord(raw);
      if (!block) {
        continue;
      }
      const call = !standalone && isToolCallContentType(block.type);
      if (
        !call &&
        !standalone &&
        !(
          isToolResultContentType(block.type) &&
          (nested || (live && m["__openclawToolStreamResultReceived"] === true))
        )
      ) {
        continue;
      }
      const id =
        (standalone ? (m.toolCallId ?? m.tool_call_id) : resolveToolUseId(block)) ?? m.toolCallId;
      if (typeof id !== "string" || !id) {
        continue;
      }
      const name = block.toolName ?? block.tool_name ?? block.name;
      const scheduler = typeof name === "string" && isAutomationsToolName(name);
      // Ordinary transcripts do not have a scheduler call to match. Avoid parsing unrelated
      // tool arguments or allocating per-invocation keys on this hot projection path.
      if (!scheduler && !calls.size) {
        continue;
      }
      const runId =
        typeof rowRunId === "string"
          ? rowRunId
          : typeof block.runId === "string"
            ? block.runId
            : undefined;
      const key = JSON.stringify([runId, id]);
      if (call) {
        const args = scheduler && automationCreationCall(resolveToolBlockArgs(block));
        if (args) {
          calls.set(key, { args, source, runId });
        } else {
          calls.delete(key);
        }
        continue;
      }
      const paired = calls.get(key);
      calls.delete(key);
      if (
        paired &&
        scheduler &&
        asOptionalRecord(asOptionalRecord(block["__openclaw"])?.toolOutput)?.outcome !== "unknown"
      ) {
        emit(paired, block.details, readToolErrorFlag(block));
      }
    }
  }
  return events;
}
