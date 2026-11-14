import {
  loadCronJobsPage,
  loadCronScopeStats,
  loadCronStatus,
  runCronJob,
} from "../../lib/cron/index.ts";
import type { CronState } from "../../lib/cron/types.ts";
import type { GatewayMethodOperatorScope } from "../../lib/gateway-methods.ts";

export type AgentCronRead = {
  scope: CronState;
  completion: Promise<string | void>;
  append?: boolean;
};

/** Presents admitted work; the page and cron owners retain scope and write authority. */
export function createAgentCronPresenter(deps: {
  currentState: () => CronState;
  readState: () => CronState;
  canCall: (method: string, scope: GatewayMethodOperatorScope) => boolean;
  publish: () => void;
}) {
  let retirement = Promise.withResolvers<void>();
  let summary: AgentCronRead | null = null;
  let jobs: AgentCronRead | null = null;
  let refresh: AgentCronRead | null = null;
  let command: AgentCronRead | null = null;

  async function runTask<T>(scope: CronState, task: (state: CronState) => Promise<T>) {
    try {
      const result = task(scope);
      if (deps.currentState() === scope) {
        deps.publish();
      }
      return await result;
    } finally {
      if (deps.currentState() === scope) {
        deps.publish();
      }
    }
  }

  function read(task: (scope: CronState) => Promise<string | null | void>, append = false) {
    const scope = deps.currentState();
    scope.canRefresh = () =>
      deps.currentState() === scope && deps.canCall("cron.list", "operator.read");
    const completion = Promise.race([
      runTask(scope, task).then((error) => {
        if (error) {
          throw new Error(error);
        }
      }),
      retirement.promise,
    ]);
    // The view may be unmounted before it observes this receipt.
    void completion.catch(() => {});
    return { scope, completion, append };
  }

  async function loadJobs(scope: CronState, append = false, force = false) {
    await loadCronJobsPage(scope, { append, tableFilters: true, refresh: force });
    return scope.cronJobsError;
  }

  function onRefresh(force = true) {
    const scope = deps.currentState();
    if (
      !scope.connected ||
      !scope.client ||
      scope.cronLoading ||
      !deps.canCall("cron.list", "operator.read")
    ) {
      return;
    }
    summary = read(async (current) => {
      const [error] = await Promise.all([
        loadCronStatus(current),
        loadCronScopeStats(current, { refresh: force }),
      ]);
      return error;
    });
    if (scope.cronJobsLoadingMore) {
      // The admitted append also awaits the queued page-zero recovery.
      void runTask(scope, (current) => loadCronJobsPage(current, { tableFilters: true }));
    } else {
      jobs = read((current) => loadJobs(current, false, force));
    }
    refresh = {
      scope,
      completion: Promise.allSettled([summary.completion, jobs?.completion]).then((results) => {
        for (const result of results) {
          if (result.status === "rejected") {
            throw result.reason;
          }
        }
      }),
    };
    void refresh.completion.catch(() => {});
    deps.publish();
  }

  function onLoadMore() {
    const scope = deps.currentState();
    if (
      scope.cronLoading ||
      scope.cronJobsLoadingMore ||
      !scope.cronJobsHasMore ||
      !deps.canCall("cron.list", "operator.read")
    ) {
      return;
    }
    jobs = read((current) => loadJobs(current, true), true);
    deps.publish();
  }

  function onRuntime(event: unknown) {
    const scope = deps.currentState();
    if (!scope.connected || !scope.client || !deps.canCall("cron.list", "operator.read")) {
      return;
    }
    jobs = read(async (current) => {
      await loadCronJobsPage(current, { tableFilters: true, event });
      return current.cronJobsError;
    });
    deps.publish();
  }

  function onRunNow(jobId: string) {
    const scope = deps.currentState();
    if (
      !deps.canCall("cron.run", "operator.admin") ||
      scope.cronBusy ||
      !scope.cronJobs.some((job) => job.id === jobId)
    ) {
      return undefined;
    }
    command = summary = null;
    const admitted = read((current) => runCronJob(current, jobId, "force"));
    const receipt = {
      ...admitted,
      completion: admitted.completion.then(() => scope.cronError ?? undefined),
    };
    const settle = () => {
      if (deps.currentState() === scope) {
        command = receipt;
        deps.publish();
      }
    };
    // Only the terminal result is read by the boundary; the action owns pending presentation.
    void receipt.completion.then(settle, settle);
    deps.publish();
    return receipt;
  }

  return {
    onRefresh,
    onLoadMore,
    onRuntime,
    onRunNow,
    read(this: void) {
      const scope = deps.readState();
      return {
        summary: summary?.scope === scope ? summary : null,
        jobs: jobs?.scope === scope ? jobs : null,
        refresh: refresh?.scope === scope ? refresh : null,
        command: command?.scope === scope ? command : null,
      };
    },
    retire() {
      retirement.resolve();
      retirement = Promise.withResolvers<void>();
      summary = jobs = refresh = command = null;
    },
  };
}
