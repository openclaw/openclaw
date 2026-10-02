import { html, nothing } from "lit";
import { Value } from "typebox/value";
import type {
  ClawConfiguredAccess,
  ClawScheduledJobs,
} from "../../../../packages/gateway-protocol/src/schema/claws.js";
import {
  ClawConfiguredAccessSchema,
  ClawScheduledJobsSchema,
} from "../../../../packages/gateway-protocol/src/schema/claws.js";
import { t } from "../../i18n/index.ts";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import "../../styles/claws-access-review.css";

type ReviewPlan = {
  operation: "add" | "update";
  actions: Array<{ kind: string; id: string; action: string; blocked: boolean }>;
  configuredAccess?: ClawConfiguredAccess;
  scheduledJobs?: ClawScheduledJobs;
};

type CompleteReviewPlan = ReviewPlan & {
  configuredAccess: ClawConfiguredAccess & {
    desired: NonNullable<ClawConfiguredAccess["desired"]>;
  };
  scheduledJobs: ClawScheduledJobs;
};

export function hasCompleteClawDisclosures(
  plan: ReviewPlan | null | undefined,
): plan is CompleteReviewPlan {
  if (
    !Value.Check(ClawConfiguredAccessSchema, plan?.configuredAccess) ||
    !plan.configuredAccess.desired ||
    (plan.operation === "update" && !plan.configuredAccess.current) ||
    !Value.Check(ClawScheduledJobsSchema, plan.scheduledJobs)
  ) {
    return false;
  }
  const actions = plan.actions.filter((action) => action.kind === "cronJob");
  const jobs = plan.scheduledJobs.jobs;
  if (actions.length !== jobs.length || new Set(jobs.map((job) => job.id)).size !== jobs.length) {
    return false;
  }
  return actions.every((action) => {
    const job = jobs.find((candidate) => candidate.id === action.id);
    const needsCurrent =
      plan.operation === "update" && ["change", "remove", "unchanged"].includes(action.action);
    const needsProposed = ["schedule", "add", "change", "unchanged"].includes(action.action);
    return (
      job?.action === action.action &&
      job.blocked === action.blocked &&
      (action.blocked ||
        ((!needsCurrent || Boolean(job.current)) && (!needsProposed || Boolean(job.proposed))))
    );
  });
}

function renderValue(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return t("clawsAccessReview.none");
  }
  if (typeof value === "boolean") {
    return t(value ? "clawsAccessReview.yes" : "clawsAccessReview.no");
  }
  return String(value);
}

function renderFact(label: string, value: unknown) {
  return html`<div class="claws-access-review__fact">
    <dt>${label}</dt>
    <dd>${value}</dd>
  </div>`;
}

function renderSnapshot(snapshot: NonNullable<ClawConfiguredAccess["desired"]>, title: string) {
  const memory = snapshot.memorySearch;
  const subagentTargets = snapshot.subagentTargets;
  const heartbeat = snapshot.heartbeat;
  const activeHours = heartbeat.activeHours;
  const interval =
    heartbeat.intervalMs === null
      ? t("clawsAccessReview.none")
      : (formatDurationCompact(heartbeat.intervalMs) ?? `${heartbeat.intervalMs} ms`);
  return html`<section class="claws-access-review__snapshot" aria-label=${title}>
    <h5>${title}</h5>
    <dl>
      ${renderFact(t("clawsAccessReview.allowedTools"), renderValue(snapshot.tools.allowed.join(", ")))}
      ${renderFact(t("clawsAccessReview.excludedTools"), renderValue(snapshot.tools.excluded.join(", ")))}
      ${renderFact(t("clawsAccessReview.spawnTargets"), renderValue(subagentTargets.allowedAgentIds.join(", ")))}
      ${renderFact(t("clawsAccessReview.anyConfiguredAgent"), renderValue(subagentTargets.allowAnyConfiguredAgent))}
      ${renderFact(t("clawsAccessReview.implicitSelfAllowed"), renderValue(subagentTargets.implicitSelfAllowed))}
      ${renderFact(t("clawsAccessReview.requireAgentId"), renderValue(subagentTargets.requireAgentId))}
      ${renderFact(t("clawsAccessReview.sandbox"), `${snapshot.sandbox.mode} / ${snapshot.sandbox.scope} / ${snapshot.sandbox.workspaceAccess} / ${snapshot.sandbox.backend}`)}
      ${renderFact(t("clawsAccessReview.workspaceOnly"), renderValue(snapshot.filesystem.workspaceOnly))}
      ${renderFact(t("clawsAccessReview.heartbeat"), heartbeat.enabled ? interval : t("clawsAccessReview.off"))}
      ${activeHours ? renderFact(t("clawsAccessReview.activeHours"), `${activeHours.start ?? "?"} to ${activeHours.end ?? "?"} ${activeHours.timezone ?? ""}`) : nothing}
      ${heartbeat.isolatedSession !== undefined ? renderFact(t("clawsAccessReview.isolatedSession"), renderValue(heartbeat.isolatedSession)) : nothing}
      ${renderFact(t("clawsAccessReview.memory"), memory.state === "disabled" ? t("clawsAccessReview.off") : memory.state === "configured" ? t("clawsAccessReview.on") : t("clawsAccessReview.unresolved"))}
      ${memory.state === "configured" ? renderFact(t("clawsAccessReview.memorySources"), renderValue(memory.indexedSources.join(", "))) : nothing}
      ${memory.state === "configured" ? renderFact(t("clawsAccessReview.searchSources"), renderValue(memory.searchSources.join(", "))) : nothing}
      ${memory.state === "configured" ? renderFact(t("clawsAccessReview.sessionMemory"), renderValue(memory.sessionMemory)) : nothing}
      ${memory.state === "configured" ? renderFact(t("clawsAccessReview.remember"), renderValue(memory.rememberAcrossConversations)) : nothing}
      ${memory.state === "configured" && memory.extraPathCount ? renderFact(t("clawsAccessReview.extraPaths"), memory.extraPathCount) : nothing}
    </dl>
  </section>`;
}

function renderSchedule(
  declaration: NonNullable<ClawScheduledJobs["jobs"][number]["proposed"]>,
  title: string,
) {
  return html`<span
    >${title}: <code>${declaration.schedule.cron}</code> ${declaration.schedule.timezone} ·
    ${declaration.session} · ${declaration.delivery}</span
  >`;
}

export function renderClawAccessReview(plan: ReviewPlan | null | undefined) {
  if (!hasCompleteClawDisclosures(plan)) {
    return html`<div class="callout danger" role="alert">
      ${t("clawsAccessReview.unavailable")}
    </div>`;
  }
  const access = plan.configuredAccess;
  const jobs = plan.scheduledJobs.jobs;
  return html`<section class="claws-access-review" aria-label=${t("clawsAccessReview.title")}>
    <h4>${t("clawsAccessReview.title")}</h4>
    <p class="claws-access-review__coverage">${t("clawsAccessReview.coverage")}</p>
    <div class="claws-access-review__snapshots">
      ${access.current ? renderSnapshot(access.current, t("clawsAccessReview.current")) : nothing}
      ${renderSnapshot(access.desired, t(plan.operation === "add" ? "clawsAccessReview.afterAdd" : "clawsAccessReview.afterUpdate"))}
    </div>
    <h4>${t("clawsAccessReview.schedules")}</h4>
    ${jobs.length ? html`<p class="claws-access-review__coverage">${t("clawsAccessReview.scheduleTaskWithheld")}</p>` : nothing}
    ${
      jobs.length
        ? html`<ul class="claws-access-review__jobs">
            ${jobs.map(
              (job) => html`<li>
                <strong>${job.id}</strong>
                <span>${job.action}</span>
                ${job.current ? renderSchedule(job.current, t("clawsAccessReview.current")) : nothing}
                ${job.proposed ? renderSchedule(job.proposed, t(plan.operation === "add" ? "clawsAccessReview.afterAdd" : "clawsAccessReview.afterUpdate")) : nothing}
              </li>`,
            )}
          </ul>`
        : html`<p class="claws-access-review__coverage">${t("clawsAccessReview.noSchedules")}</p>`
    }
  </section>`;
}
