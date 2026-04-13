import { info } from "../globals.js";
import { getPlanById, listPlanRecords, updatePlanStatus } from "../plans/plan-registry.js";
import { summarizePlanRecords } from "../plans/plan-registry.summary.js";
import {
  isPlanStatusTransitionError,
  type PlanRecord,
  type PlanRecordStatus,
} from "../plans/plan-registry.types.js";
import type { RuntimeEnv } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isRich, theme } from "../terminal/theme.js";

const ID_PAD = 14;
const STATUS_PAD = 18;
const SCOPE_PAD = 8;

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 1) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 1)}…`;
}

function shortPlanId(value: string): string {
  return truncate(value, ID_PAD);
}

function formatPlanStatusCell(status: PlanRecord["status"], rich: boolean) {
  const padded = status.padEnd(STATUS_PAD);
  if (!rich) {
    return padded;
  }
  if (status === "approved") {
    return theme.success(padded);
  }
  if (status === "rejected") {
    return theme.error(padded);
  }
  if (status === "ready_for_review") {
    return theme.warn(padded);
  }
  return theme.muted(padded);
}

function formatPlanRows(plans: PlanRecord[], rich: boolean) {
  const header = [
    "Plan".padEnd(ID_PAD),
    "Status".padEnd(STATUS_PAD),
    "Scope".padEnd(SCOPE_PAD),
    "Owner".padEnd(18),
    "Title",
  ].join(" ");
  const lines = [rich ? theme.heading(header) : header];
  for (const plan of plans) {
    lines.push(
      [
        shortPlanId(plan.planId).padEnd(ID_PAD),
        formatPlanStatusCell(plan.status, rich),
        plan.scopeKind.padEnd(SCOPE_PAD),
        truncate(plan.ownerKey, 18).padEnd(18),
        truncate(plan.title, 80),
      ]
        .join(" ")
        .trimEnd(),
    );
  }
  return lines;
}

function formatPlanListSummary(plans: PlanRecord[]) {
  const summary = summarizePlanRecords(plans);
  return `${summary.byStatus.draft} draft · ${summary.byStatus.ready_for_review} ready · ${summary.byStatus.approved} approved`;
}

export async function plansListCommand(
  opts: { json?: boolean; status?: string },
  runtime: RuntimeEnv,
) {
  const statusFilter = normalizeOptionalString(opts.status);
  const plans = listPlanRecords().filter((plan) => {
    if (statusFilter && plan.status !== statusFilter) {
      return false;
    }
    return true;
  });

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          count: plans.length,
          status: statusFilter ?? null,
          plans,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(info(`Plans: ${plans.length}`));
  runtime.log(info(`Plan status: ${formatPlanListSummary(plans)}`));
  if (statusFilter) {
    runtime.log(info(`Status filter: ${statusFilter}`));
  }
  if (plans.length === 0) {
    runtime.log("No plans found.");
    return;
  }
  const rich = isRich();
  for (const line of formatPlanRows(plans, rich)) {
    runtime.log(line);
  }
}

export async function plansSetStatusCommand(
  opts: { lookup: string; status: PlanRecordStatus },
  runtime: RuntimeEnv,
) {
  const lookup = opts.lookup.trim();
  const plan = listPlanRecords().find(
    (candidate) => candidate.planId === lookup || candidate.title === lookup,
  );
  const resolved = plan ? getPlanById(plan.planId) : getPlanById(lookup);
  if (!resolved) {
    runtime.error(`Plan not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  try {
    const result = updatePlanStatus({
      planId: resolved.planId,
      status: opts.status,
    });
    runtime.log(
      `Updated ${result.plan.planId} status from ${result.previousStatus} to ${result.plan.status}.`,
    );
  } catch (error) {
    if (isPlanStatusTransitionError(error)) {
      runtime.error(error.message);
      runtime.exit(1);
      return;
    }
    throw error;
  }
}

export async function plansShowCommand(
  opts: { json?: boolean; lookup: string },
  runtime: RuntimeEnv,
) {
  const lookup = opts.lookup.trim();
  const plan = listPlanRecords().find(
    (candidate) => candidate.planId === lookup || candidate.title === lookup,
  );
  const resolved = plan ? getPlanById(plan.planId) : getPlanById(lookup);
  if (!resolved) {
    runtime.error(`Plan not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    runtime.log(JSON.stringify(resolved, null, 2));
    return;
  }

  const lines = [
    "Plan:",
    `planId: ${resolved.planId}`,
    `status: ${resolved.status}`,
    `scopeKind: ${resolved.scopeKind}`,
    `ownerKey: ${resolved.ownerKey}`,
    `sessionKey: ${resolved.sessionKey ?? "n/a"}`,
    `parentPlanId: ${resolved.parentPlanId ?? "n/a"}`,
    `format: ${resolved.format}`,
    `title: ${resolved.title}`,
    `summary: ${resolved.summary ?? "n/a"}`,
    `linkedFlowIds: ${resolved.linkedFlowIds?.join(", ") ?? "n/a"}`,
    `createdAt: ${new Date(resolved.createdAt).toISOString()}`,
    `updatedAt: ${new Date(resolved.updatedAt).toISOString()}`,
    `reviewedAt: ${resolved.reviewedAt ? new Date(resolved.reviewedAt).toISOString() : "n/a"}`,
    `approvedAt: ${resolved.approvedAt ? new Date(resolved.approvedAt).toISOString() : "n/a"}`,
    `rejectedAt: ${resolved.rejectedAt ? new Date(resolved.rejectedAt).toISOString() : "n/a"}`,
    `archivedAt: ${resolved.archivedAt ? new Date(resolved.archivedAt).toISOString() : "n/a"}`,
    "content:",
    resolved.content,
  ];
  for (const line of lines) {
    runtime.log(line);
  }
}
