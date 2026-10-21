import {
  action,
  affects,
  createMemo,
  createOptimistic,
  createOptimisticStore,
  createSignal,
  refresh,
} from "solid-js";
import type { CronJob } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { buildQualifiedChatModelValue } from "../../lib/chat/model-ref.ts";
import type { CronState } from "../../lib/cron/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayAvailable } from "../../lib/gateway-availability.ts";
import type { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import {
  loadModelCatalog,
  modelCatalogRefreshError,
  subscribeModelCatalogCache,
} from "../../lib/model-catalog-store.ts";

type CronPresentationDeps = {
  currentState: () => CronState;
  readState: () => CronState;
  connection: ReturnType<typeof createGatewayConnectionLifecycle>;
  context: () => ApplicationContext;
  active: () => boolean;
  publish: (state: CronState) => void;
};

/** Presents admitted cron work; the plain owners retain every request decision. */
export function createCronPresentation(deps: CronPresentationDeps) {
  const [cronModelSuggestions, setCronModelSuggestions] = createSignal<string[]>([]);
  const [modelSuggestionsError, setModelSuggestionsError] = createSignal<string | null>(null);
  let modelSuggestionsRequest: { state: CronState; agentId: string } | null = null;
  let stopModelSuggestions: (() => void) | undefined;
  // Receipts describe work already admitted by the plain owner. Reading them
  // never starts an RPC or transfers its cancellation/publication authority.
  type ReadReceipt = { state: CronState; epoch: number; result: Promise<unknown> };
  const [jobsReceipt, setJobsReceipt] = createSignal<ReadReceipt | null>(null);
  const [statusReceipt, setStatusReceipt] = createSignal<ReadReceipt | null>(null);
  let presentationLifetime = Promise.withResolvers<void>();
  const ownerScope = createMemo(() => deps.readState());
  const ownerJobs = createMemo(() => deps.readState().cronJobs);
  const ownerJobsError = createMemo(() => {
    const state = deps.readState();
    return state.cronJobsSnapshotRevision ? null : state.cronJobsError;
  });
  const ownerStatus = createMemo(() => deps.readState().cronStatus);
  const connectionEpoch = createMemo(() => {
    deps.readState();
    return deps.connection.epoch;
  });
  // Read computations outlive their scope so replacement does not retire a
  // pending child while its parent is waiting to publish the new scope.
  const jobsRead = createMemo(() => {
    const state = ownerScope();
    const epoch = connectionEpoch();
    ownerJobs();
    ownerJobsError();
    const receipt = jobsReceipt();
    return receipt?.state === state && receipt.epoch === epoch
      ? receipt.result.then(() => {
          // Keep last-good data on refresh failure; only a failed first read
          // has no content to retain and belongs to the error boundary.
          if (!state.cronJobsSnapshotRevision && state.cronJobsError) {
            throw new Error(state.cronJobsError);
          }
          return state.cronJobs;
        })
      : Promise.resolve(state.cronJobs);
  });
  const statusRead = createMemo(() => {
    const state = ownerScope();
    const epoch = connectionEpoch();
    ownerStatus();
    const receipt = statusReceipt();
    return receipt?.state === state && receipt.epoch === epoch
      ? receipt.result.then(() => state.cronStatus)
      : Promise.resolve(state.cronStatus);
  });
  // A reconnect retires presentation too: guesses and pending reads from the
  // previous connection must not attach to a same-ID job on its successor.
  const presentation = createMemo(() => {
    const state = ownerScope();
    const epoch = connectionEpoch();
    const [jobs, setOptimisticJobs] = createOptimisticStore(
      () => {
        ownerJobs();
        return state.cronJobs;
      },
      [],
      { key: "id" },
    );
    const [saving, setSaving] = createOptimistic(false);
    return {
      state,
      epoch,
      jobsRead,
      statusRead,
      jobs,
      setOptimisticJobs,
      saving,
      setSaving,
    };
  });
  const isCurrentPresentation = (view: ReturnType<typeof presentation>) =>
    view.state === deps.currentState() && view.epoch === deps.connection.epoch;
  async function runCronTask<T>(task: (cronState: CronState) => Promise<T>): Promise<T> {
    const cronState = deps.currentState();
    try {
      const result = task(cronState);
      deps.publish(cronState);
      return await result;
    } finally {
      deps.publish(cronState);
    }
  }

  function runCronRead<T>(kind: "jobs" | "status", task: (state: CronState) => Promise<T>) {
    const state = deps.currentState();
    const epoch = deps.connection.epoch;
    const joinsJobsRead = kind === "jobs" && (state.cronLoading || state.cronJobsLoadingMore);
    const result = runCronTask(task);
    // Jobs' owner queues overlapping refreshes behind the original promise.
    if (!joinsJobsRead) {
      (kind === "jobs" ? setJobsReceipt : setStatusReceipt)({ state, epoch, result });
    }
    return result;
  }

  const presentMutation = action(function* (
    view: ReturnType<typeof presentation>,
    pending: Promise<unknown>,
    retired: Promise<void>,
    expected?: Pick<CronJob, "id" | "enabled">,
  ) {
    try {
      if (isCurrentPresentation(view)) {
        view.setSaving(true);
        if (expected) {
          view.setOptimisticJobs((rows) => {
            const row = rows.find((entry) => entry.id === expected.id);
            if (row) {
              row.enabled = expected.enabled;
            }
          });
          // The Gateway supplies updated revisions and next-run state.
          affects(view.jobsRead);
        }
      }
      // Retiring this presentation never cancels the owner's admitted write.
      yield Promise.race([pending, retired]);
      // Admission/publication belong to the owner, outside this transaction.
      if (isCurrentPresentation(view)) {
        void refresh(view.jobs);
      }
    } catch (error) {
      reportActionError(view, error);
    }
  });

  function retirePresentation() {
    // Solid parks reactive cleanup while an action is pending. Retire from
    // the synchronous scope owner so old work cannot hold its successor.
    presentationLifetime.resolve();
    presentationLifetime = Promise.withResolvers<void>();
  }

  function reportActionError(view: ReturnType<typeof presentation>, error: unknown) {
    if (isCurrentPresentation(view)) {
      view.state.cronError = formatUiError(error);
      deps.publish(view.state);
    }
  }

  async function loadModelSuggestions(cronState: CronState) {
    const client = cronState.client;
    const agentId = deps.context().agentSelection.state.selectedId;
    // Last-good suggestions belong to one agent, including when its successor has no catalog.
    if (modelSuggestionsRequest?.agentId !== agentId) {
      modelSuggestionsRequest = null;
      setCronModelSuggestions([]);
      setModelSuggestionsError(null);
      deps.publish(cronState);
    }
    if (!client || !agentId || !isGatewayAvailable(deps.context().gateway.snapshot)) {
      return;
    }
    const connectionScope = deps.connection.capture();
    if (!connectionScope) {
      return;
    }
    stopModelSuggestions ??= subscribeModelCatalogCache(
      client,
      (update) => {
        if (
          deps.active() &&
          deps.currentState().client === client &&
          update.type === "invalidated"
        ) {
          void loadModelSuggestions(deps.currentState());
        }
      },
      () => ({ agentId: deps.context().agentSelection.state.selectedId ?? undefined }),
    );
    const request = { state: cronState, agentId };
    modelSuggestionsRequest = request;
    // Only the latest catalog request may publish rows or errors.
    const isCurrent = () =>
      deps.active() &&
      deps.currentState() === cronState &&
      deps.connection.isCurrent(connectionScope) &&
      modelSuggestionsRequest === request &&
      deps.context().agentSelection.state.selectedId === agentId;
    try {
      const result = await loadModelCatalog(client, { agentId });
      if (isCurrent()) {
        setCronModelSuggestions(
          result.models
            .filter((entry) => entry.manualSelectionAllowed !== false)
            .map((entry) => buildQualifiedChatModelValue(entry.id, entry.provider)),
        );
        setModelSuggestionsError(modelCatalogRefreshError(result));
        deps.publish(cronState);
      }
    } catch (error) {
      if (isCurrent()) {
        setModelSuggestionsError(formatUiError(error));
        deps.publish(cronState);
      }
    }
  }

  function resetModels() {
    stopModelSuggestions?.();
    stopModelSuggestions = undefined;
    setCronModelSuggestions([]);
    setModelSuggestionsError(null);
    modelSuggestionsRequest = null;
  }

  return {
    capture: presentation,
    isCurrent: isCurrentPresentation,
    retire: retirePresentation,
    dispose() {
      presentationLifetime.resolve();
      stopModelSuggestions?.();
      modelSuggestionsRequest = null;
    },
    modelSuggestions: cronModelSuggestions,
    modelError: modelSuggestionsError,
    get modelRequest() {
      return modelSuggestionsRequest;
    },
    loadModels: loadModelSuggestions,
    resetModels,
    runTask: runCronTask,
    read: runCronRead,
    async mutate(
      view: ReturnType<typeof presentation>,
      pending: Promise<unknown>,
      expected?: Pick<CronJob, "id" | "enabled">,
    ) {
      const retired = presentationLifetime.promise;
      // Let the owner's synchronous publication land before opening an action.
      await Promise.resolve();
      return presentMutation(view, pending, retired, expected);
    },
    reportError: reportActionError,
    saving: () => presentation().saving(),
    reads: {
      jobs: () => presentation().jobsRead(),
      rows: () => presentation().jobs,
      status: () => presentation().statusRead(),
      scope: presentation,
    },
  };
}
