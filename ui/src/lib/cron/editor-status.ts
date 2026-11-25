import { createDeferredCore, type Deferred } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronJob } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../gateway-errors.ts";
import { readCronStatus } from "./state.ts";
import type { CronState } from "./types.ts";

type CronStatusState = Pick<
  CronState,
  | "client"
  | "connected"
  | "canRefresh"
  | "cronAgentId"
  | "cronEditingJob"
  | "cronStatus"
  | "cronError"
  | "cronBusy"
>;

type CronStatusRequest = {
  client: GatewayBrowserClient;
  selectedJob: CronJob | null;
  reportErrors: boolean;
  queued?: Deferred;
};
const activeCronStatusRequests = new WeakMap<CronStatusState, CronStatusRequest>();

export function retireCronStatusRequest(state: CronStatusState) {
  activeCronStatusRequests.get(state)?.queued?.resolve();
  activeCronStatusRequests.delete(state);
}

export function retireCronStatusFeedback(state: CronStatusState) {
  const request = activeCronStatusRequests.get(state);
  if (request) {
    request.reportErrors = false;
  }
}

export async function loadCronStatus(
  state: CronStatusState,
  opts?: { coalesce?: boolean },
): Promise<string | null | void> {
  const client = state.client;
  if (!client || !state.connected || state.canRefresh?.() === false) {
    return;
  }
  const active = activeCronStatusRequests.get(state);
  if (opts?.coalesce && active?.client === client) {
    return (active.queued ??= createDeferredCore()).promise;
  }
  const agentId = state.cronAgentId;
  const selectedJob = state.cronEditingJob;
  const request: CronStatusRequest = {
    client,
    selectedJob,
    reportErrors: !opts?.coalesce || !state.cronBusy,
  };
  activeCronStatusRequests.set(state, request);
  const isCurrent = () =>
    activeCronStatusRequests.get(state) === request &&
    state.connected &&
    state.client === client &&
    state.cronAgentId === agentId;
  const ownsSelectedJob = () =>
    isCurrent() && request.selectedJob === selectedJob && state.cronEditingJob === selectedJob;
  const selectedJobRead = selectedJob
    ? client.request<CronJob>("cron.get", { id: selectedJob.id }).then(
        (fresh) => {
          if (ownsSelectedJob() && fresh.id === selectedJob.id) {
            // Runtime refresh must not replace the editor's saved definition or dirty form.
            selectedJob.state = fresh.state;
          }
        },
        (error: unknown) => {
          if (ownsSelectedJob() && request.reportErrors && (!opts?.coalesce || !request.queued)) {
            state.cronError = formatUiError(error);
          }
        },
      )
    : Promise.resolve();
  try {
    const res = await readCronStatus(client);
    if (isCurrent()) {
      state.cronStatus = res;
    }
  } catch (err) {
    if (!isCurrent() || !request.reportErrors || (opts?.coalesce && request.queued)) {
      return;
    }
    if (isMissingOperatorReadScopeError(err)) {
      const message = await formatMissingOperatorReadScopeMessage(
        "cron status",
        formatUiError(err),
      );
      if (!isCurrent() || !request.reportErrors || (opts?.coalesce && request.queued)) {
        return;
      }
      state.cronStatus = null;
      state.cronError = message;
    } else {
      state.cronError = formatUiError(err);
    }
    return state.cronError;
  } finally {
    await selectedJobRead;
    const reload = isCurrent();
    if (activeCronStatusRequests.get(state) === request) {
      activeCronStatusRequests.delete(state);
    }
    if (request.queued) {
      const trailing = reload ? loadCronStatus(state, { coalesce: true }) : undefined;
      // Queued events keep their data freshness without reclaiming retired feedback.
      if (reload && !request.reportErrors) {
        retireCronStatusFeedback(state);
      }
      request.queued.resolve(trailing?.then(() => {}));
    }
  }
}

export function retireCronSelectedJobRead(state: CronState) {
  const request = activeCronStatusRequests.get(state);
  if (request) {
    request.selectedJob = null;
  }
}
