import { action, createMemo, createOptimistic, createSignal } from "solid-js";
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
  readAgentModelCatalog,
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
  type ModelReceipt = { state: CronState; agentId: string; result: Promise<void> };
  const [modelReceipt, setModelReceipt] = createSignal<ModelReceipt | null>(null);
  const modelRead = createMemo(() => modelReceipt()?.result.then(() => null) ?? null);
  const cronModelSuggestions = createMemo(
    () => {
      const state = deps.readState();
      const agentId = deps.context().agentSelection.state.selectedId;
      const receipt = modelReceipt();
      if (receipt?.state !== state || receipt.agentId !== agentId) {
        return [];
      }
      return readAgentModelCatalog(state.client, agentId)
        .models.filter((entry) => entry.manualSelectionAllowed !== false)
        .map((entry) => buildQualifiedChatModelValue(entry.id, entry.provider));
    },
    { lazy: true },
  );
  let modelSuggestionsRequest: { state: CronState; agentId: string } | null = null;
  let stopModelSuggestions: (() => void) | undefined;
  let presentationLifetime = Promise.withResolvers<void>();
  const ownerScope = createMemo(() => deps.readState());
  const connectionEpoch = createMemo(() => {
    deps.readState();
    return deps.connection.epoch;
  });
  // A reconnect retires presentation too: guesses and pending reads from the
  // previous connection must not attach to a same-ID job on its successor.
  const presentation = createMemo(() => {
    const state = ownerScope();
    const epoch = connectionEpoch();
    const [saving, setSaving] = createOptimistic(false);
    return { state, epoch, saving, setSaving };
  });
  const [toggle, setToggle] = createSignal<{
    view: ReturnType<typeof presentation>;
    jobId: string;
  } | null>(null);
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

  const presentMutation = action(function* (
    view: ReturnType<typeof presentation>,
    pending: Promise<unknown>,
    retired: Promise<void>,
  ) {
    try {
      if (isCurrentPresentation(view)) {
        view.setSaving(true);
      }
      // Retiring this presentation never cancels the owner's admitted write.
      // Admission/publication belong to the owner, outside this transaction.
      yield Promise.race([pending, retired]);
    } catch (error) {
      reportActionError(view, error);
    }
  });

  function retirePresentation() {
    // Solid parks reactive cleanup while an action is pending. Retire from
    // the synchronous scope owner so old work cannot hold its successor.
    presentationLifetime.resolve();
    presentationLifetime = Promise.withResolvers<void>();
    setToggle(null);
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
      setModelReceipt(null);
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
        if (deps.active() && deps.currentState().client === client) {
          if (update.type === "invalidated") {
            void loadModelSuggestions(deps.currentState());
          } else {
            deps.publish(deps.currentState());
          }
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
    const result = loadModelCatalog(client, { agentId })
      .then((catalog) => {
        if (isCurrent()) {
          const error = modelCatalogRefreshError(catalog);
          if (error) {
            throw new Error(error);
          }
        }
      })
      .catch((error: unknown) => {
        if (isCurrent()) {
          throw error;
        }
      });
    setModelReceipt({ ...request, result });
    // The boundary observes failures; fire-and-forget callers still consume
    // completion if their view retires before reading it.
    await result.catch(() => {});
  }

  function resetModels() {
    stopModelSuggestions?.();
    stopModelSuggestions = undefined;
    setModelReceipt(null);
    modelSuggestionsRequest = null;
  }

  return {
    capture: presentation,
    isCurrent: isCurrentPresentation,
    retire: retirePresentation,
    get retired() {
      return presentationLifetime.promise;
    },
    dispose() {
      presentationLifetime.resolve();
      stopModelSuggestions?.();
      modelSuggestionsRequest = null;
    },
    modelSuggestions: cronModelSuggestions,
    get modelRequest() {
      return modelSuggestionsRequest;
    },
    loadModels: loadModelSuggestions,
    resetModels,
    runTask: runCronTask,
    async mutate(
      view: ReturnType<typeof presentation>,
      pending: Promise<unknown>,
      expected?: Pick<CronJob, "id" | "enabled">,
    ) {
      const retired = presentationLifetime.promise;
      // Record the accepted toggle before owner publication renders native disabled.
      // The optimistic action still waits for that publication before joining it.
      const intent = expected ? { view, jobId: expected.id } : null;
      if (intent && isCurrentPresentation(view)) {
        setToggle(intent);
      }
      try {
        await Promise.resolve();
        return await presentMutation(view, pending, retired);
      } finally {
        setToggle((current) => (current === intent ? null : current));
      }
    },
    reportError: reportActionError,
    saving: () => presentation().saving(),
    toggleSavingJobId: () => {
      const intent = toggle();
      return intent?.view === presentation() ? intent.jobId : null;
    },
    reads: { models: modelRead, modelRequest: modelReceipt },
  };
}
