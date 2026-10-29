import type { CronJob } from "../../api/types.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import type { CronState } from "../../lib/cron/types.ts";
import { formatUiError } from "../../lib/format-error.ts";

export function resolveCronRouteData(search: string): {
  jobId: string | null;
  runId: string | null;
  session?: { sessionKey: string; sessionAgentId: string };
} {
  const params = new URLSearchParams(search);
  const jobId = params.get("job")?.trim() || null;
  const sessionKey = params.get("session")?.trim();
  const agentId = params.get("agent")?.trim();
  return {
    jobId,
    runId: jobId ? params.get("run")?.trim() || null : null,
    ...(!jobId && sessionKey && agentId
      ? { session: { sessionKey, sessionAgentId: agentId } }
      : {}),
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
        state.cronError = formatUiError(error);
      }
    }
  }

  function select(jobId: string, runId: string | null) {
    selection.target = { jobId, runId };
    selection.requested = true;
  }
  function resolveLoadedSession(state: CronState, apply: (job: CronJob) => void) {
    if (selection.target?.session && state.cronJobsSnapshotRevision && !state.cronLoading) {
      selection.target = null;
      const [job] = state.cronJobs;
      if (state.cronJobsTotal === 1 && job) {
        apply(job);
      }
    }
  }
  return Object.assign(selection, { bind, resolve, resolveLoadedSession, select });
}
