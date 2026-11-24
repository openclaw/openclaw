import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isAutomationsToolName } from "../agents/tools/automations-tool-name.js";
import { readAutomationCreationEvent } from "../shared/automation-creation.js";
import { readAutomationSavedDefinition } from "../shared/automation-saved-definition.js";

/** Only call at cron.add's result boundary. Read/update return the same job shape. */
export function automationJobResultId(value: unknown): string | undefined {
  const result = asOptionalRecord(value);
  if (
    !result ||
    result.error !== undefined ||
    result.status !== undefined ||
    result.saved === false ||
    result.ok === false ||
    result.created === false ||
    result.updated === true
  ) {
    return undefined;
  }
  const job = result.created === true ? asOptionalRecord(result.job) : result;
  const id = job?.id;
  return typeof id === "string" &&
    id.length > 0 &&
    id.length <= 1024 &&
    id.trim() === id &&
    typeof job?.enabled === "boolean" &&
    typeof job.name === "string" &&
    typeof asOptionalRecord(job.schedule)?.kind === "string"
    ? id
    : undefined;
}

export function automationCreationCall(value: unknown) {
  const args = asOptionalRecord(value);
  if (args?.action === "plan") {
    return { action: "plan" as const };
  }
  if (args?.action === "add" && args.planId === undefined && args.slotId === undefined) {
    return {
      action: "add" as const,
      ...(typeof args.position === "number" ? { position: args.position } : {}),
    };
  }
  if (
    args?.action === "add" &&
    typeof args.planId === "string" &&
    args.planId.length <= 1024 &&
    typeof args.slotId === "string" &&
    args.slotId.length <= 64
  ) {
    return { action: "add" as const, planId: args.planId, slotId: args.slotId };
  }
  return undefined;
}

/** Project this tool's host-authored facts for harness progress and public history. */
export function readAutomationToolCreation(toolName: unknown, details: unknown) {
  return typeof toolName === "string" && isAutomationsToolName(toolName)
    ? automationCreationFromToolDetails(details)
    : undefined;
}

/** Compact, allowlisted facts for the scheduler tool's terminal result, never output text. */
export function automationCreationFromToolDetails(details: unknown) {
  const record = asOptionalRecord(details);
  const event = readAutomationCreationEvent(record?.automationCreation ?? record);
  if (
    event?.type !== "automation_creation_result" ||
    event.status !== "created" ||
    event.definition ||
    automationJobResultId(record) !== event.jobId
  ) {
    return event;
  }
  const definition = readAutomationSavedDefinition(
    record?.created === true ? record.job : record,
    event.jobId,
  );
  return definition ? { ...event, definition } : event;
}
