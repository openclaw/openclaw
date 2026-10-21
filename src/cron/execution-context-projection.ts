/**
 * Projects what the existing scheduled-run code decides for a stored job and
 * labels where the execution context differs. Pure; shared by the development
 * replay script and Doctor.
 */
import { isRuntimeToolAllowed } from "../agents/tool-policy-match.js";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import type {
  ScheduledAdmissionFacts,
  ScheduledExecutionContextResult,
} from "./execution-context.js";
import { resolveCronRunAdmissionSource } from "./run-authority.js";
import { resolveCronSessionTargetSessionKey } from "./session-target.js";
import type { CronStoredJob } from "./types.js";

type ScheduledDivergenceLabel =
  | "equal"
  | "gain-intended"
  | "gain-unexpected"
  | "loss"
  | "retarget"
  | "pause";

type ScheduledDecisionField =
  | "admissionSource"
  | "ownerEmbedded"
  | "automations"
  | "board"
  | "eventTarget"
  | "memory"
  | "workspace"
  | "sandbox"
  | "parentState";

type ScheduledDecisionVector = Readonly<{
  admissionSource?: "operator-schedule" | "requester-schedule";
  ownerEmbedded: boolean;
  automations: "none" | "self" | "self-and-parent-wake" | "unscoped";
  board: string;
  eventTarget: string;
  memory: "run-session" | "parent";
  workspace: "run-session" | "parent-row";
  sandbox: boolean;
  parentState: "ready" | "pause";
}>;

type ProjectionJob = Pick<
  CronStoredJob,
  "sessionTarget" | "owner" | "scheduledToolPolicy" | "payload" | "toolsAllowProvenance"
>;

/** The decisions the existing code makes for one occurrence. */
function projectLegacyDecisions(
  job: ProjectionJob,
  facts: ScheduledAdmissionFacts,
): ScheduledDecisionVector {
  const inSession = resolveCronSessionTargetSessionKey(job.sessionTarget) !== undefined;
  const allow = facts.resolvedToolsAllow;
  const automationsAllowed = isRuntimeToolAllowed(AUTOMATIONS_TOOL_NAME, allow);
  return {
    ...(facts.trigger === "cron" ? { admissionSource: resolveCronRunAdmissionSource(job) } : {}),
    // Embedded scheduled runs pass no sender bit, which keeps owner-only tools.
    ownerEmbedded: true,
    automations: !automationsAllowed ? "none" : facts.trigger === "cron" ? "self" : "unscoped",
    board: facts.runSessionKey,
    eventTarget: inSession ? facts.runSessionKey : facts.agentMainSessionKey,
    memory: "run-session",
    workspace: "run-session",
    sandbox:
      facts.agentSandboxMode === "all" ||
      (facts.agentSandboxMode === "non-main" &&
        facts.runSessionKey !== facts.agentMainSessionKey) ||
      facts.creatorRoleSandbox === "required",
    parentState: "ready",
  };
}

/** The same decisions read from a built context. */
function projectContextDecisions(
  result: ScheduledExecutionContextResult,
  legacy: ScheduledDecisionVector,
): ScheduledDecisionVector | "pause" | "fail" {
  if (result.status === "pause") {
    return "pause";
  }
  if (result.status === "fail") {
    return "fail";
  }
  const { facts } = result;
  return {
    ...(facts.authority.admissionSource
      ? { admissionSource: facts.authority.admissionSource }
      : {}),
    ownerEmbedded: facts.authority.owner,
    automations: facts.toolPolicy.automations.scope,
    board: facts.resources.boardSessionKey,
    eventTarget: facts.resources.eventTargetSessionKey,
    memory: facts.resources.memory.source,
    workspace: facts.resources.workspace.source,
    sandbox: facts.resources.sandbox.required,
    parentState: legacy.parentState,
  };
}

const AUTOMATIONS_RANK: Record<ScheduledDecisionVector["automations"], number> = {
  none: 0,
  self: 1,
  "self-and-parent-wake": 2,
  unscoped: 3,
};

// Fields whose widening is the intended fix for parent-linked runs.
const INTENDED_GAINS = new Set<ScheduledDecisionField>(["memory", "workspace", "automations"]);
const RETARGETS = new Set<ScheduledDecisionField>(["board", "eventTarget"]);

function labelField(
  field: ScheduledDecisionField,
  legacy: ScheduledDecisionVector,
  context: ScheduledDecisionVector,
): ScheduledDivergenceLabel {
  const before = legacy[field];
  const after = context[field];
  if (before === after) {
    return "equal";
  }
  if (RETARGETS.has(field)) {
    return "retarget";
  }
  if (field === "ownerEmbedded") {
    return after ? "gain-unexpected" : "loss";
  }
  if (field === "sandbox") {
    // A stricter sandbox is less access.
    return after ? "loss" : "gain-unexpected";
  }
  if (field === "automations") {
    return AUTOMATIONS_RANK[context.automations] > AUTOMATIONS_RANK[legacy.automations]
      ? "gain-intended"
      : "loss";
  }
  if (field === "admissionSource") {
    return after === "operator-schedule" ? "gain-unexpected" : "loss";
  }
  return INTENDED_GAINS.has(field) ? "gain-intended" : "gain-unexpected";
}

export type ScheduledDivergence = Readonly<{
  status: "ready" | "pause" | "fail";
  labels: Readonly<Partial<Record<ScheduledDecisionField, ScheduledDivergenceLabel>>>;
  /** Only fields that differ, with both values. */
  changes: ReadonlyArray<
    Readonly<{
      field: ScheduledDecisionField;
      legacy: unknown;
      context: unknown;
      label: ScheduledDivergenceLabel;
    }>
  >;
  reason?: string;
}>;

const FIELDS: readonly ScheduledDecisionField[] = [
  "admissionSource",
  "ownerEmbedded",
  "automations",
  "board",
  "eventTarget",
  "memory",
  "workspace",
  "sandbox",
];

/** Labels every decision a built context changes relative to the legacy code. */
export function compareScheduledDecisions(
  job: ProjectionJob,
  facts: ScheduledAdmissionFacts,
  result: ScheduledExecutionContextResult,
): ScheduledDivergence {
  const legacy = projectLegacyDecisions(job, facts);
  const context = projectContextDecisions(result, legacy);
  if (context === "pause" || context === "fail") {
    return {
      status: context,
      labels: context === "pause" ? { parentState: "pause" } : {},
      changes: [],
      ...(result.status === "pause"
        ? { reason: `${result.reason}: ${result.parentSessionKey}` }
        : result.status === "fail"
          ? { reason: result.error }
          : {}),
    };
  }
  const labels: Partial<Record<ScheduledDecisionField, ScheduledDivergenceLabel>> = {};
  const changes: Array<ScheduledDivergence["changes"][number]> = [];
  for (const field of FIELDS) {
    const label = labelField(field, legacy, context);
    labels[field] = label;
    if (label !== "equal") {
      changes.push({ field, legacy: legacy[field], context: context[field], label });
    }
  }
  return { status: "ready", labels, changes };
}
