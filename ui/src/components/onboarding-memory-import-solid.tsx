import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import type {
  MemoryMigrationProviderPlan,
  MigrationsMemoryApplyResult,
  MigrationsMemoryPlanResult,
} from "../../../packages/gateway-protocol/src/schema/migrations.js";
import type { ApplicationContext } from "../app/context.ts";
import { hasOperatorAdminAccess } from "../app/operator-access.ts";
import { formatUiError, formatUiExternalText } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";
import { generateUUID } from "../lib/uuid.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import "../styles/onboarding-memory-import.css";
import "./modal-dialog.ts";

const ONBOARDING_MEMORY_IMPORT_KEY = "openclaw.onboarding.memory-import";
type Props = { context?: ApplicationContext; active: boolean };
export type OnboardingMemoryImportElement = SolidBridgeElement<Props>;
type ProviderResult =
  | { kind: "success" | "partial"; result: MigrationsMemoryApplyResult }
  | { kind: "error"; message: string };
type PlanBinding = {
  client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
  agentId: string;
  plan: MigrationsMemoryPlanResult;
};
type ImportAction = "continue" | "import" | "skip" | "review";

function plannedItems(provider: MemoryMigrationProviderPlan) {
  return provider.items.filter((item) => item.status === "planned");
}
function offeredProviders(plan: MigrationsMemoryPlanResult | null) {
  return (
    plan?.providers.filter(
      (provider) => provider.found && provider.planFingerprint && plannedItems(provider).length > 0,
    ) ?? []
  );
}
function guardIsDone() {
  try {
    return globalThis.sessionStorage?.getItem(ONBOARDING_MEMORY_IMPORT_KEY) === "done";
  } catch {
    return false;
  }
}
function setGuardDone() {
  try {
    globalThis.sessionStorage?.setItem(ONBOARDING_MEMORY_IMPORT_KEY, "done");
  } catch {
    /* Closing still works for this load when storage is unavailable. */
  }
}
function currentAgentId(context: ApplicationContext | undefined): string | null {
  const list = context?.agents.state.agentsList;
  if (!list) {
    return null;
  }
  const selected = context?.agentSelection.state.selectedId;
  return selected && list.agents.some((agent) => agent.id === selected)
    ? selected
    : (list.defaultId ?? list.agents[0]?.id ?? null);
}

function providerResultMessage(result: ProviderResult | undefined) {
  if (!result) {
    return "";
  }
  if (result.kind === "error") {
    return t("onboarding.memoryImport.providerError", {
      error: formatUiExternalText(result.message),
    });
  }
  const summary = result.result.summary;
  return result.kind === "partial"
    ? t("onboarding.memoryImport.providerIncomplete", {
        conflicts: String(summary.conflicts),
        errors: String(summary.errors),
        migrated: String(summary.migrated),
        skipped: String(summary.skipped),
      })
    : t("onboarding.memoryImport.providerResult", {
        migrated: String(summary.migrated),
        skipped: String(summary.skipped),
      });
}

function OnboardingMemoryImportContent(props: Props & { host: OnboardingMemoryImportElement }) {
  const host = untrack(() => props.host);
  // Workflow decisions remain synchronous; this signal only publishes their presentation.
  const [revision, setRevision] = createSignal(0);
  const [planRequest, setPlanRequest] = createSignal(0);
  const publish = () => setRevision((value) => value + 1);
  let selectedByProvider: Record<string, boolean> = {};
  let applyingProviderId: string | null = null;
  let results: Record<string, ProviderResult> = {};
  let done = false;
  let closed = false;
  let binding: PlanBinding | null = null;
  let abortPlan: AbortController | undefined;
  let agentsListRequest: ApplicationContext["agents"] | undefined;
  let disposed = false;

  createEffect(
    () => props.context,
    (context) => {
      if (!context) {
        return undefined;
      }
      const releases = [context.gateway, context.agents, context.agentSelection].map((source) =>
        source.subscribe(publish),
      );
      return () => releases.forEach((release) => release());
    },
  );
  createEffect(
    () => {
      revision();
      return { context: props.context, list: props.context?.agents.state.agentsList };
    },
    ({ context, list }) => {
      if (list) {
        agentsListRequest = undefined;
      } else if (context && agentsListRequest !== context.agents) {
        const agents = context.agents;
        agentsListRequest = agents;
        void agents
          .ensureList()
          .catch(() => null)
          .then(() => {
            if (host.context?.agents === agents && !agents.state.agentsList) {
              agentsListRequest = undefined;
            }
          });
      }
    },
  );

  const planInputs = createMemo(
    () => {
      revision();
      const snapshot = props.context?.gateway.snapshot;
      return [
        props.active,
        closed,
        guardIsDone(),
        snapshot?.phase === "connected" ? snapshot.client : null,
        snapshot ? hasOperatorAdminAccess(snapshot.hello?.auth ?? null) : false,
        currentAgentId(props.context),
        planRequest(),
      ] as const;
    },
    { equals: (left, right) => left.every((value, index) => value === right[index]) },
  );
  createEffect(planInputs, ([active, isClosed, guarded, client, admin, agentId]) => {
    // Hiding an import must retain its frozen offer and eventual completion view.
    if (applyingProviderId !== null || done) {
      return undefined;
    }
    binding = null;
    publish();
    if (!active || isClosed || guarded || !client || !admin || !agentId) {
      return undefined;
    }
    const controller = new AbortController();
    abortPlan = controller;
    void (async () => {
      try {
        const plan = await client.request<MigrationsMemoryPlanResult>(
          "migrations.memory.plan",
          { agentId, overwrite: false },
          { signal: controller.signal },
        );
        const context = host.context;
        if (
          controller.signal.aborted ||
          disposed ||
          !host.isConnected ||
          context?.gateway.snapshot.client !== client ||
          currentAgentId(context) !== agentId ||
          plan.agentId !== agentId
        ) {
          return;
        }
        const providers = offeredProviders(plan);
        if (providers.length === 0) {
          if (!plan.providers.some((provider) => provider.error)) {
            setGuardDone();
            closed = true;
            publish();
          }
          return;
        }
        binding = { client, agentId, plan };
        selectedByProvider = Object.fromEntries(
          providers.map((provider) => [provider.providerId, true]),
        );
        results = {};
        done = false;
        publish();
      } catch {
        // Planning is an optional, silent onboarding offer.
      }
    })();
    return () => {
      controller.abort();
      if (abortPlan === controller) {
        abortPlan = undefined;
      }
    };
  });
  const liveBinding = () => {
    revision();
    const context = props.context;
    return binding?.client === context?.gateway.snapshot.client &&
      binding?.agentId === currentAgentId(context)
      ? binding
      : null;
  };
  const plan = createMemo(() => liveBinding()?.plan ?? null);
  const providers = createMemo(() => offeredProviders(plan()));
  const view = createMemo(() => {
    revision();
    return { selectedByProvider, applyingProviderId, results, done };
  });
  const isVisible = () => {
    revision();
    const snapshot = props.context?.gateway.snapshot;
    return (
      props.active &&
      !closed &&
      !guardIsDone() &&
      snapshot?.phase === "connected" &&
      snapshot.client &&
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
      providers().length > 0
    );
  };
  const finish = () => {
    setGuardDone();
    closed = true;
    publish();
  };
  const importSelected = async () => {
    const current = liveBinding();
    if (!current || applyingProviderId !== null || done) {
      return;
    }
    const selected = offeredProviders(current.plan).filter(
      (provider) => selectedByProvider[provider.providerId],
    );
    if (selected.length === 0) {
      return;
    }
    for (const provider of selected) {
      const context = host.context;
      if (
        disposed ||
        !host.isConnected ||
        closed ||
        context?.gateway.snapshot.client !== current.client ||
        currentAgentId(context) !== current.agentId
      ) {
        results[provider.providerId] = {
          kind: "error",
          message: t("onboarding.memoryImport.connectionChanged"),
        };
        publish();
        continue;
      }
      const itemIds = plannedItems(provider).map((item) => item.id);
      const planFingerprint = provider.planFingerprint;
      if (!planFingerprint || itemIds.length === 0) {
        continue;
      }
      applyingProviderId = provider.providerId;
      publish();
      try {
        const result = await current.client.request<MigrationsMemoryApplyResult>(
          "migrations.memory.apply",
          {
            idempotencyKey: generateUUID(),
            agentId: current.agentId,
            providerId: provider.providerId,
            planFingerprint,
            itemIds,
            overwrite: false,
          },
        );
        results[provider.providerId] = {
          kind: result.summary.errors > 0 || result.summary.conflicts > 0 ? "partial" : "success",
          result,
        };
      } catch (error) {
        results[provider.providerId] = {
          kind: "error",
          message: formatUiError(error, t("onboarding.memoryImport.unknownError")),
        };
      }
      publish();
    }
    applyingProviderId = null;
    done =
      host.context?.gateway.snapshot.client === current.client &&
      currentAgentId(host.context) === current.agentId;
    publish();
    if (!done) {
      setPlanRequest((value) => value + 1);
    }
  };
  const disconnect = () => {
    abortPlan?.abort();
    binding = null;
    publish();
    queueMicrotask(() => {
      if (!disposed && host.isConnected) {
        setPlanRequest((value) => value + 1);
      }
    });
  };
  host.addEventListener("onboarding-memory-disconnect", disconnect);
  onCleanup(() => {
    disposed = true;
    abortPlan?.abort();
    host.removeEventListener("onboarding-memory-disconnect", disconnect);
  });

  function Provider(providerProps: { provider: MemoryMigrationProviderPlan }) {
    const result = () => view().results[providerProps.provider.providerId];
    const conflicts = () =>
      providerProps.provider.items.filter((item) => item.status === "conflict").length;
    return (
      <li
        class="onboarding-memory-import__provider"
        data-provider-id={providerProps.provider.providerId}
      >
        <label>
          <input
            type="checkbox"
            checked={view().selectedByProvider[providerProps.provider.providerId] ?? false}
            disabled={view().applyingProviderId !== null || view().done}
            onChange={(event) => {
              selectedByProvider[providerProps.provider.providerId] = event.currentTarget.checked;
              publish();
            }}
          />
          <span class="onboarding-memory-import__provider-copy">
            <strong>{providerProps.provider.label}</strong>
            <code title={providerProps.provider.source ?? ""}>
              {providerProps.provider.source ?? t("onboarding.memoryImport.sourceUnavailable")}
            </code>
            <small>
              {t("onboarding.memoryImport.plannedCount", {
                count: String(plannedItems(providerProps.provider).length),
              })}
              <Show when={conflicts() > 0}>
                <span>
                  {t("onboarding.memoryImport.alreadyImported", { count: String(conflicts()) })}
                </span>
              </Show>
            </small>
          </span>
        </label>
        <div class="onboarding-memory-import__provider-status" aria-live="polite">
          <Show
            when={view().applyingProviderId === providerProps.provider.providerId}
            fallback={
              result()?.kind === "success"
                ? providerResultMessage(result())
                : result() && <span role="alert">{providerResultMessage(result())}</span>
            }
          >
            {t("onboarding.memoryImport.importingProvider")}
          </Show>
        </div>
      </li>
    );
  }
  const total = (field: "migrated" | "skipped") => {
    revision();
    return Object.values(results).reduce(
      (sum, result) => sum + (result.kind === "error" ? 0 : result.result.summary[field]),
      0,
    );
  };
  const busy = () => view().applyingProviderId !== null;
  const hasSelected = () =>
    providers().some((provider) => view().selectedByProvider[provider.providerId]);
  const actions = (): ImportAction[] => (view().done ? ["continue"] : ["import", "skip", "review"]);
  const actionLabels = () => ({
    continue: t("common.continue"),
    import: t(busy() ? "common.importing" : "onboarding.memoryImport.import"),
    skip: t("onboarding.memoryImport.skip"),
    review: t("onboarding.memoryImport.reviewDetails"),
  });
  const runAction = (action: ImportAction) => {
    if (action === "import") {
      void importSelected();
      return;
    }
    finish();
    if (action === "review") {
      host.context?.navigate("memory-import");
    }
  };
  return (
    <Show when={isVisible()}>
      <openclaw-modal-dialog
        class="onboarding-memory-import-dialog"
        label={t("onboarding.memoryImport.title")}
        description={t("onboarding.memoryImport.body")}
        onModal-cancel={(event: Event) => {
          if (applyingProviderId !== null) {
            event.preventDefault();
          } else {
            finish();
          }
        }}
      >
        <section class="onboarding-memory-import">
          <header>
            <h2>
              {view().done
                ? t("onboarding.memoryImport.doneTitle")
                : t("onboarding.memoryImport.title")}
            </h2>
            <p>
              {view().done
                ? t("onboarding.memoryImport.doneBody", {
                    migrated: String(total("migrated")),
                    skipped: String(total("skipped")),
                  })
                : t("onboarding.memoryImport.body")}
            </p>
          </header>
          <ul>
            <For each={providers()}>{(provider) => <Provider provider={provider} />}</For>
          </ul>
          <footer>
            <For each={actions()}>
              {(action) => (
                <button
                  class={[
                    "btn",
                    {
                      primary: action === "import" || action === "continue",
                      "btn--ghost onboarding-memory-import__review": action === "review",
                    },
                  ]}
                  type="button"
                  data-test-id={
                    action === "review" ? undefined : `onboarding-memory-import-${action}`
                  }
                  disabled={
                    action !== "continue" && (busy() || (action === "import" && !hasSelected()))
                  }
                  onClick={() => runAction(action)}
                >
                  {actionLabels()[action]}
                </button>
              )}
            </For>
          </footer>
        </section>
      </openclaw-modal-dialog>
    </Show>
  );
}

export const OnboardingMemoryImport = defineSolidBridge<Props>(
  "openclaw-onboarding-memory-import",
  (props, host) => (
    <OnboardingMemoryImportContent context={props.context} active={props.active} host={host} />
  ),
  {
    properties: {
      context: { default: undefined, attribute: false },
      active: { default: false, type: Boolean },
    },
    disconnected: (host) => host.dispatchEvent(new Event("onboarding-memory-disconnect")),
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-onboarding-memory-import": OnboardingMemoryImportElement;
  }
}
