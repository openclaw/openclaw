/**
 * Projects what the existing scheduled-run code decides for a stored job and
 * labels where the execution context differs. Pure; shared by the development
 * replay script and the fixture tests.
 */
import { isRuntimeToolAllowed } from "../agents/tool-policy-match.js";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import { resolveScheduledSenderBit } from "./execution-context-registry.js";
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
  | "ownerCli"
  | "automations"
  | "automationsCli"
  | "requesterYield"
  | "board"
  | "eventTarget"
  | "memory"
  | "workspace"
  | "sandbox"
  | "parentState";

/** Decision fields plus the bound inference runtime, which the replay supplies separately. */
type ScheduledLabeledField = ScheduledDecisionField | "inference";

/**
 * The owner-only surface a run's tools get: `owner` (no sender bit), `non-owner`
 * (`senderIsOwner: false`), or the in-session turn's own command-owner check.
 */
type ScheduledOwnerSurface = "owner" | "non-owner" | "session-turn";

type ScheduledDecisionVector = Readonly<{
  admissionSource?: "operator-schedule" | "requester-schedule";
  ownerEmbedded: ScheduledOwnerSurface;
  ownerCli: ScheduledOwnerSurface;
  automations: "none" | "self" | "self-and-parent-wake";
  /** The CLI loopback's automations tool; `session-turn` is the turn's owner-only rule. */
  automationsCli: "none" | "self" | "self-and-parent-wake" | "session-turn";
  requesterYield: "offered" | "refused";
  board: string;
  eventTarget: string;
  /** The parent's memory as the owner's private memory, or only its conversation. */
  memory: "run-session" | "parent-owner" | "parent-conversation";
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
  const sessionTurn = inSession || job.sessionTarget === "main";
  const allow = facts.resolvedToolsAllow;
  const automationsAllowed = isRuntimeToolAllowed(AUTOMATIONS_TOOL_NAME, allow);
  return {
    ...(facts.trigger === "cron" ? { admissionSource: resolveCronRunAdmissionSource(job) } : {}),
    // Embedded scheduled runs pass no sender bit, which keeps owner-only tools; the
    // CLI grant coerces that absent bit to `false`. In-session turns run their own check.
    ownerEmbedded: sessionTurn ? "session-turn" : "owner",
    ownerCli: sessionTurn ? "session-turn" : "non-owner",
    // Scheduled and ingress turns are both limited to their own automation.
    automations: !automationsAllowed ? "none" : "self",
    // The loopback denied automations to child and detached runs; in-session turns
    // kept the grant's owner-only rule.
    automationsCli: sessionTurn ? "session-turn" : "none",
    requesterYield: isCronSessionKey(facts.runSessionKey) ? "refused" : "offered",
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
    ...projectContextOwner(result, legacy),
    ...projectContextAutomations(result, legacy),
    board: facts.resources.boardSessionKey,
    eventTarget: facts.resources.eventTargetSessionKey,
    memory:
      facts.resources.memory.source === "parent"
        ? facts.resources.memory.owner
          ? "parent-owner"
          : "parent-conversation"
        : "run-session",
    workspace: facts.resources.workspace.source,
    sandbox: facts.resources.sandbox.required,
    parentState: legacy.parentState,
  };
}

// Runs whose context does not decide the sender bit keep the legacy surfaces.
function projectContextOwner(
  result: ScheduledExecutionContextResult,
  legacy: ScheduledDecisionVector,
): Pick<ScheduledDecisionVector, "ownerEmbedded" | "ownerCli"> {
  const bit = resolveScheduledSenderBit(result);
  if (!bit) {
    return { ownerEmbedded: legacy.ownerEmbedded, ownerCli: legacy.ownerCli };
  }
  const surface = bit.senderIsOwner === false ? "non-owner" : "owner";
  return { ownerEmbedded: surface, ownerCli: surface };
}

// The automations tool and requester yield a run's tools get. The parent wake is
// not offered yet, so a `self-and-parent-wake` scope offers the self actions.
// Ingress turns keep their legacy CLI surface and yield.
function projectContextAutomations(
  result: Extract<ScheduledExecutionContextResult, { status: "ready" }>,
  legacy: ScheduledDecisionVector,
): Pick<ScheduledDecisionVector, "automations" | "automationsCli" | "requesterYield"> {
  const { facts } = result;
  const offered = facts.toolPolicy.automations.scope === "none" ? "none" : "self";
  if (facts.principal.kind === "ingress") {
    return {
      automations: offered,
      automationsCli: legacy.automationsCli,
      requesterYield: legacy.requesterYield,
    };
  }
  return { automations: offered, automationsCli: offered, requesterYield: "refused" };
}

const AUTOMATIONS_RANK: Record<ScheduledDecisionVector["automations"], number> = {
  none: 0,
  self: 1,
  "self-and-parent-wake": 2,
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
  if (field === "ownerEmbedded" || field === "ownerCli") {
    if (after === "non-owner") {
      return "loss";
    }
    // The CLI gaining the embedded run's owner surface is the #178813 parity fix.
    return field === "ownerCli" && legacy.ownerEmbedded === after
      ? "gain-intended"
      : "gain-unexpected";
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
  if (field === "automationsCli") {
    // The CLI taking the embedded run's scope is the parity fix; an in-session
    // turn's unscoped owner tool narrowing to its own job is a loss.
    if (before === "session-turn" || after === "none") {
      return "loss";
    }
    return after === legacy.automations ? "gain-intended" : "gain-unexpected";
  }
  if (field === "requesterYield") {
    return after === "refused" ? "loss" : "gain-unexpected";
  }
  if (field === "admissionSource") {
    return after === "operator-schedule" ? "gain-unexpected" : "loss";
  }
  return INTENDED_GAINS.has(field) ? "gain-intended" : "gain-unexpected";
}

/**
 * The runtime the existing run picks for a bound job from its copied cron session entry,
 * read from the rows and config the run reads. `models` is set for a job that copies a
 * creating conversation: the model that copy selects, and the job's own scheduled model.
 */
export type ScheduledInferenceRuntimeFacts = Readonly<{
  legacy: string;
  models?: Readonly<{ legacy: string; context: string }>;
}>;

// A recorded runtime replaces the legacy pick, and the job's scheduled model replaces the
// model a copied creating conversation selects; a binding without one keeps both picks.
function labelInference(
  result: Extract<ScheduledExecutionContextResult, { status: "ready" }>,
  runtimes: ScheduledInferenceRuntimeFacts,
): Readonly<{ label: ScheduledDivergenceLabel; legacy: string; context: string }> | undefined {
  const { inference } = result.facts;
  if (inference.kind !== "bound") {
    return undefined;
  }
  const recorded = inference.binding.runtime;
  if (recorded) {
    const { models } = runtimes;
    const same = recorded === runtimes.legacy && (!models || models.legacy === models.context);
    return {
      label: same ? "equal" : "retarget",
      legacy: models ? `${runtimes.legacy} ${models.legacy}` : runtimes.legacy,
      context: models ? `${recorded} ${models.context}` : recorded,
    };
  }
  return { label: "equal", legacy: runtimes.legacy, context: runtimes.legacy };
}

export type ScheduledDivergence = Readonly<{
  status: "ready" | "pause" | "fail";
  labels: Readonly<Partial<Record<ScheduledLabeledField, ScheduledDivergenceLabel>>>;
  /** Only fields that differ, with both values. */
  changes: ReadonlyArray<
    Readonly<{
      field: ScheduledLabeledField;
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
  "ownerCli",
  "automations",
  "automationsCli",
  "requesterYield",
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
  inferenceRuntimes?: ScheduledInferenceRuntimeFacts,
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
  const labels: Partial<Record<ScheduledLabeledField, ScheduledDivergenceLabel>> = {};
  const changes: Array<ScheduledDivergence["changes"][number]> = [];
  for (const field of FIELDS) {
    const label = labelField(field, legacy, context);
    labels[field] = label;
    if (label !== "equal") {
      changes.push({ field, legacy: legacy[field], context: context[field], label });
    }
  }
  const inference =
    result.status === "ready" && inferenceRuntimes
      ? labelInference(result, inferenceRuntimes)
      : undefined;
  if (inference) {
    labels.inference = inference.label;
    if (inference.label !== "equal") {
      changes.push({ field: "inference", ...inference });
    }
  }
  return { status: "ready", labels, changes };
}
