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
export class CronRouteSelection {
  target: ReturnType<typeof resolveCronRouteData> | null = null;
  requested = false;
  private scope: ReturnType<typeof gatewayPresentationScope> | undefined;

  bind(gateway: ApplicationGateway): boolean {
    const scope = gatewayPresentationScope(gateway);
    const changed = this.scope !== undefined && this.scope !== scope;
    this.scope = scope;
    if (changed) {
      this.target = null;
    }
    return changed;
  }

  async resolve(
    state: CronState,
    isCurrent: () => boolean,
    select: (job: CronJob, runId: string | null) => void,
  ) {
    const target = this.target;
    if (!target?.jobId || !state.client || !state.connected || this.requested) {
      return;
    }
    this.requested = true;
    const ownsSelection = () => isCurrent() && this.target === target;
    try {
      // A filtered inventory cannot resolve an exact link or a resumed selection.
      const job = await state.client.request<CronJob>("cron.get", { id: target.jobId });
      if (ownsSelection()) {
        select(job, target.runId);
      }
    } catch (error) {
      if (ownsSelection()) {
        this.target = null;
        state.cronError = formatUiError(error);
      }
    }
  }

  select(jobId: string, runId: string | null) {
    this.target = { jobId, runId };
    this.requested = true;
  }
}
