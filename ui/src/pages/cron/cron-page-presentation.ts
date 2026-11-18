import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { action, createMemo, createOptimistic, createSignal } from "solid-js";
import { tryResolveCronJobEffectiveAgentId } from "../../../../src/cron/agent-id.js";
import type { AgentsListResult, CronJob } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { CronFormState, CronState } from "../../lib/cron/types.ts";
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
  modelAgentId: (state: CronState) => string | undefined;
  publish: (state: CronState) => void;
};

export function resolveCronModelAgentId(
  form: CronFormState,
  config: Record<string, unknown> | null,
  roster: AgentsListResult | null | undefined,
) {
  const defaults = asNullableRecord(asNullableRecord(config?.agents)?.defaults);
  const configuredOwner = normalizeOptionalString(asNullableRecord(defaults?.systemAgent)?.agentId);
  // The Gateway can expose a UI fallback ID even when cron has no implicit owner.
  const rosterOwner =
    roster &&
    (roster.selectionRequired === false ||
      (roster.selectionRequired === undefined && roster.agents.length === 1))
      ? roster.defaultId
      : undefined;
  return tryResolveCronJobEffectiveAgentId(
    { agentId: form.clearAgent ? undefined : form.agentId, sessionKey: form.sessionKey },
    configuredOwner ?? rosterOwner,
  );
}

/** Presents admitted cron work; the plain owners retain every request decision. */
export function createCronPresentation(deps: CronPresentationDeps) {
  type ModelReceipt = { state: CronState; agentId: string; result: Promise<void> };
  const [modelReceipt, setModelReceipt] = createSignal<ModelReceipt | null>(null);
  const modelRead = createMemo(() => modelReceipt()?.result.then(() => null) ?? null);
  const cronModelCatalog = createMemo(
    () => {
      const state = deps.readState();
      const agentId = deps.modelAgentId(state);
      const receipt = modelReceipt();
      if (receipt?.state !== state || receipt.agentId !== agentId) {
        return undefined;
      }
      return readAgentModelCatalog(state.client, agentId);
    },
    { lazy: true },
  );
  let modelRequest: { state: CronState; agentId: string } | null = null;
  let stopModelCatalog: (() => void) | undefined;
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

  function ensureModels(state: CronState, forceRefresh: boolean) {
    const agentId = deps.modelAgentId(state);
    if (!agentId) {
      if (modelRequest) {
        resetModels();
      }
    } else if (forceRefresh || modelRequest?.state !== state || modelRequest.agentId !== agentId) {
      void loadModels(state, agentId);
    }
  }

  async function loadModels(cronState: CronState, agentId: string) {
    const client = cronState.client;
    // Last-good suggestions belong to one agent, including when its successor has no catalog.
    if (modelRequest?.agentId !== agentId) {
      modelRequest = null;
      setModelReceipt(null);
      deps.publish(cronState);
    }
    if (!client || !isGatewayAvailable(deps.context().gateway.snapshot)) {
      return;
    }
    const connectionScope = deps.connection.capture();
    if (!connectionScope) {
      return;
    }
    stopModelCatalog ??= subscribeModelCatalogCache(
      client,
      (update) => {
        if (deps.active() && deps.currentState().client === client) {
          if (update.type === "invalidated") {
            ensureModels(deps.currentState(), true);
          } else {
            deps.publish(deps.currentState());
          }
        }
      },
      () => ({ agentId: deps.modelAgentId(deps.currentState()) }),
    );
    const request = { state: cronState, agentId };
    modelRequest = request;
    // Only the latest catalog request may publish rows or errors.
    const isCurrent = () =>
      deps.active() &&
      deps.currentState() === cronState &&
      deps.connection.isCurrent(connectionScope) &&
      modelRequest === request &&
      deps.modelAgentId(cronState) === agentId;
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
    stopModelCatalog?.();
    stopModelCatalog = undefined;
    setModelReceipt(null);
    modelRequest = null;
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
      stopModelCatalog?.();
      modelRequest = null;
    },
    modelCatalog: cronModelCatalog,
    ensureModels,
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
