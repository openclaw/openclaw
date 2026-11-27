import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { createCronExecutionId } from "../../../../src/cron/run-id.js";
import type { CronJob } from "../../api/types.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import type { CronState } from "../../lib/cron/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";

export function resolveCronRouteData(search: string): {
  jobId: string | null;
  runId: string | null;
  settings?: true;
  /** `?new` opens the create panel, as the sidebar's New automation does. */
  create?: true;
  /** `?activity` opens every automation's run history, as the sidebar's Activity does. */
  activity?: true;
} {
  const params = new URLSearchParams(search);
  const jobId = params.get("job")?.trim() || null;
  return {
    jobId,
    runId: jobId ? params.get("run")?.trim() || null : null,
    ...(jobId && !params.has("run") && params.get("tab") === "settings"
      ? { settings: true as const }
      : {}),
    ...(!jobId && params.has("new") ? { create: true as const } : {}),
    ...(!jobId && params.has("activity") ? { activity: true as const } : {}),
  };
}

/** Keeps current selection intent separate from transport-owned reads and job data. */
export function createCronRouteSelection() {
  const selection: { target: ReturnType<typeof resolveCronRouteData> | null; requested: boolean } =
    { target: null, requested: false };
  let scope: ReturnType<typeof gatewayPresentationScope> | undefined;

  function bind(gateway: ApplicationGateway): boolean {
    const nextScope = gatewayPresentationScope(gateway);
    const changed = scope !== undefined && scope !== nextScope;
    scope = nextScope;
    if (changed) {
      selection.target = null;
    }
    return changed;
  }

  async function resolve(
    state: CronState,
    isCurrent: () => boolean,
    apply: (job: CronJob, runId: string | null) => void,
  ) {
    const target = selection.target;
    if (!target?.jobId || !state.client || !state.connected || selection.requested) {
      return;
    }
    selection.requested = true;
    const ownsSelection = () => isCurrent() && selection.target === target;
    try {
      // A filtered inventory cannot resolve an exact link or a resumed selection.
      const job = await state.client.request<CronJob>("cron.get", { id: target.jobId });
      if (ownsSelection()) {
        apply(job, target.runId);
      }
    } catch (error) {
      if (ownsSelection()) {
        selection.target = null;
        state.cronError =
          error instanceof GatewayProtocolRequestError && error.gatewayCode === "UNAVAILABLE"
            ? t("cron.linkUnavailable")
            : formatUiError(error);
      }
    }
  }

  function select(jobId: string, runId: string | null, settings?: true) {
    selection.target = { jobId, runId, settings };
    selection.requested = true;
  }
  return Object.assign(selection, { bind, resolve, select });
}

/** The run a failure banner reviews: the saved job's last run, when the job recorded one. */
export function failedRunId(job: CronJob): string | null {
  return typeof job.state.lastRunAtMs === "number"
    ? createCronExecutionId(job.id, job.state.lastRunAtMs)
    : null;
}

/** Ordinary job links keep the prompt and history; an explicit settings link opens the editor. */
export function resolveCronDetailTab(
  job: CronJob | null,
  target: ReturnType<typeof resolveCronRouteData> | null,
): "history" | "settings" {
  return !job || (target?.jobId === job.id && target.settings) ? "settings" : "history";
}
