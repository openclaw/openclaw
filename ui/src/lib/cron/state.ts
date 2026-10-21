// Shared scheduler reads stay independent of the lazy Cron editor and mutation helpers.
import { createDeferredCore, type Deferred } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronJob, CronStatus } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../gateway-errors.ts";
import type { CronFormState, CronState } from "./types.ts";

export const DEFAULT_CRON_FORM: CronFormState = {
  name: "",
  description: "",
  agentId: "",
  sessionKey: "",
  clearAgent: false,
  enabled: true,
  deleteAfterRun: false,
  scheduleKind: "every",
  eventSource: "mcp-events",
  eventServer: "",
  eventName: "",
  eventArguments: "{}",
  scheduleAt: "",
  everyAmount: "30",
  everyUnit: "minutes",
  cronExpr: "0 7 * * *",
  cronTz: "",
  scheduleExact: false,
  staggerAmount: "",
  staggerUnit: "seconds",
  activeHoursEnabled: false,
  activeHoursStart: "09:00",
  activeHoursEnd: "17:00",
  activeHoursTimezone: "",
  idleOnly: false,
  payloadSkipIfScratchEmpty: false,
  deliveryTarget: "",
  deliveryDirectPolicy: "",
  triggerEnabled: false,
  triggerScript: "",
  triggerOnce: false,
  sessionTarget: "isolated",
  wakeMode: "now",
  payloadKind: "agentTurn",
  payloadLocked: false,
  payloadText: "",
  payloadModel: "",
  payloadThinking: "",
  payloadLightContext: false,
  payloadIncludeReasoning: false,
  deliveryMode: "none",
  deliveryChannel: "last",
  deliveryTo: "",
  deliveryAccountId: "",
  deliveryBestEffort: false,
  deliveryThreadId: undefined,
  deliveryCompletionDestination: undefined,
  deliveryFailureDestination: undefined,
  failureAlertMode: "inherit",
  failureAlertAfter: "",
  failureAlertCooldownSeconds: "",
  failureAlertChannel: "last",
  failureAlertTo: "",
  failureAlertDeliveryMode: "",
  failureAlertAccountId: "",
  timeoutSeconds: "",
};

export function createInitialCronState<Row = CronJob>(
  snapshot: Partial<Pick<CronState, "client" | "connected">> = {},
): CronState<Row> {
  return {
    client: snapshot.client ?? null,
    connected: snapshot.connected ?? false,
    cronLoading: false,
    cronJobsError: null,
    cronJobsLoadingMore: false,
    cronJobsReloadPending: false,
    cronJobsReloadPendingTableFilters: false,
    cronJobs: [],
    cronJobsSnapshotRevision: null,
    cronJobsTotal: 0,
    cronJobsHasMore: false,
    cronJobsNextOffset: null,
    cronJobsLimit: 50,
    cronJobsQuery: "",
    cronJobsEnabledFilter: "all",
    cronJobsScheduleKindFilter: "all",
    cronJobsLastStatusFilter: "all",
    cronJobsTriggerFilter: "all",
    cronJobsSortBy: "nextRunAtMs",
    cronJobsSortDir: "asc",
    cronAgentId: null,
    cronStatus: null,
    cronScopedTotal: null,
    cronScopedNextWakeAtMs: null,
    cronError: null,
    cronForm: { ...DEFAULT_CRON_FORM },
    cronCreateOpen: false,
    cronFieldErrors: {},
    cronEditingJob: null,
    cronCloningJob: null,
    cronRunsError: null,
    cronRunsJobId: null,
    cronRunsLoadingMore: false,
    cronRuns: [],
    cronRunsHasMore: false,
    cronRunsNextOffset: null,
    cronRunsLimit: 50,
    cronRunsScope: "all",
    cronRunsStatuses: [],
    cronRunsDeliveryStatuses: [],
    cronRunsQuery: "",
    cronRunsSortDir: "desc",
    cronBusy: false,
  };
}

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
    const res = await client.request<CronStatus>("cron.status", {});
    if (isCurrent()) {
      state.cronStatus = res;
    }
  } catch (err) {
    if (!isCurrent() || !request.reportErrors || (opts?.coalesce && request.queued)) {
      return;
    }
    if (isMissingOperatorReadScopeError(err)) {
      state.cronStatus = null;
      state.cronError = formatMissingOperatorReadScopeMessage("cron status");
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
