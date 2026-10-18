import {
  createEffect,
  createMemo,
  createSignal,
  createStore,
  For,
  onCleanup,
  Show,
} from "solid-js";
import type {
  MemoryMigrationProviderPlan,
  MigrationsMemoryApplyResult,
  MigrationsMemoryPlanResult,
} from "../../../packages/gateway-protocol/src/schema/migrations.js";
import type { ApplicationContext } from "../app/context.ts";
import { hasOperatorAdminAccess } from "../app/operator-access.ts";
import { formatUiError, formatUiExternalText } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { generateUUID } from "../lib/uuid.ts";
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

function OnboardingMemoryImportContent(props: Props, host: OnboardingMemoryImportElement) {
  const [planRequest, setPlanRequest] = createSignal(0);
  const sources = createMemo(() =>
    projectSource(props.context, {
      read: (context) => context,
      subscribe(context, notify) {
        const releases = [context?.gateway, context?.agents, context?.agentSelection].map(
          (source) => source?.subscribe(notify),
        );
        return () => releases.forEach((release) => release?.());
      },
      equality: "revision",
    }),
  );
  // Selection and admission stay synchronous for same-turn changes and cancellation.
  let selectedByProvider: Record<string, boolean> = {};
  const [selection, setSelection] = createSignal(selectedByProvider, { equals: false });
  const [results, setResults] = createStore<Record<string, ProviderResult>>({});
  const recordResult = (providerId: string, result: ProviderResult) =>
    setResults((draft) => {
      draft[providerId] = result;
    });
  let applyingProviderId: string | null = null;
  const [applying, setApplying] = createSignal<string | null>(null);
  let done = false;
  const [isDone, setDone] = createSignal(false);
  let closed = false;
  const [isClosed, setClosed] = createSignal(false);
  let binding: PlanBinding | null = null;
  const [offer, setOffer] = createSignal<PlanBinding | null>(null);
  let abortPlan: AbortController | undefined;
  let agentsListRequest: ApplicationContext["agents"] | undefined;
  let disposed = false;

  createEffect(
    () => {
      const context = sources().read();
      return { context, list: context?.agents.state.agentsList };
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
      const context = sources().read();
      const snapshot = context?.gateway.snapshot;
      return [
        props.active,
        isClosed(),
        guardIsDone(),
        snapshot?.phase === "connected" ? snapshot.client : null,
        snapshot ? hasOperatorAdminAccess(snapshot.hello?.auth ?? null) : false,
        currentAgentId(context),
        planRequest(),
      ] as const;
    },
    { equals: (left, right) => left.every((value, index) => value === right[index]) },
  );
  createEffect(planInputs, ([active, closedInput, guarded, client, admin, agentId]) => {
    // Hiding an import must retain its frozen offer and eventual completion view.
    if (applyingProviderId !== null || done) {
      return undefined;
    }
    setOffer((binding = null));
    if (!active || closedInput || guarded || !client || !admin || !agentId) {
      return undefined;
    }
    const controller = new AbortController();
    abortPlan = controller;
    void client
      .request<MigrationsMemoryPlanResult>(
        "migrations.memory.plan",
        { agentId, overwrite: false },
        { signal: controller.signal },
      )
      .then((plan) => {
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
            finish();
          }
          return;
        }
        setOffer((binding = { client, agentId, plan }));
        selectedByProvider = Object.fromEntries(
          providers.map((provider) => [provider.providerId, true]),
        );
        setSelection(selectedByProvider);
        setResults(() => ({}));
        setDone((done = false));
      })
      .catch(() => {
        // Planning is an optional, silent onboarding offer.
      });
    return () => {
      controller.abort();
      if (abortPlan === controller) {
        abortPlan = undefined;
      }
    };
  });
  const currentBinding = (candidate: PlanBinding | null) => {
    const context = props.context;
    return candidate?.client === context?.gateway.snapshot.client &&
      candidate?.agentId === currentAgentId(context)
      ? candidate
      : null;
  };
  const providers = createMemo(() => {
    sources().read();
    return offeredProviders(currentBinding(offer())?.plan ?? null);
  });
  const isVisible = () => {
    const [active, closedInput, guarded, client, admin] = planInputs();
    return active && !closedInput && !guarded && client && admin && providers().length > 0;
  };
  const finish = () => {
    setGuardDone();
    setClosed((closed = true));
  };
  const importSelected = async () => {
    const current = currentBinding(binding);
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
        recordResult(provider.providerId, {
          kind: "error",
          message: t("onboarding.memoryImport.connectionChanged"),
        });
        continue;
      }
      const itemIds = plannedItems(provider).map((item) => item.id);
      const planFingerprint = provider.planFingerprint;
      if (!planFingerprint || itemIds.length === 0) {
        continue;
      }
      setApplying((applyingProviderId = provider.providerId));
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
        recordResult(provider.providerId, {
          kind: result.summary.errors > 0 || result.summary.conflicts > 0 ? "partial" : "success",
          result,
        });
      } catch (error) {
        recordResult(provider.providerId, {
          kind: "error",
          message: formatUiError(error, t("onboarding.memoryImport.unknownError")),
        });
      }
    }
    setApplying((applyingProviderId = null));
    done =
      host.context?.gateway.snapshot.client === current.client &&
      currentAgentId(host.context) === current.agentId;
    setDone(done);
    if (!done) {
      setPlanRequest((value) => value + 1);
    }
  };
  const disconnect = () => {
    abortPlan?.abort();
    setOffer((binding = null));
    queueMicrotask(() => {
      if (!disposed && host.isConnected) {
        setPlanRequest((value) => value + 1);
      }
    });
  };
  const stopDisconnect = listen(host, "onboarding-memory-disconnect", disconnect);
  onCleanup(() => {
    disposed = true;
    abortPlan?.abort();
    stopDisconnect();
  });

  function Provider(providerProps: { provider: MemoryMigrationProviderPlan }) {
    const result = () => results[providerProps.provider.providerId];
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
            checked={selection()[providerProps.provider.providerId] ?? false}
            disabled={applying() !== null || isDone()}
            onChange={(event) => {
              selectedByProvider[providerProps.provider.providerId] = event.currentTarget.checked;
              setSelection(selectedByProvider);
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
            when={applying() === providerProps.provider.providerId}
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
  const total = (field: "migrated" | "skipped") =>
    Object.values(results).reduce(
      (sum, result) => sum + (result.kind === "error" ? 0 : result.result.summary[field]),
      0,
    );
  const busy = () => applying() !== null;
  const hasSelected = () => providers().some((provider) => selection()[provider.providerId]);
  const actions = (): ImportAction[] => (isDone() ? ["continue"] : ["import", "skip", "review"]);
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
              {isDone()
                ? t("onboarding.memoryImport.doneTitle")
                : t("onboarding.memoryImport.title")}
            </h2>
            <p>
              {isDone()
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
          <openclaw-modal-actions class="onboarding-memory-import__actions">
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
          </openclaw-modal-actions>
        </section>
      </openclaw-modal-dialog>
    </Show>
  );
}

export const OnboardingMemoryImport = defineSolidBridge<Props>(
  "openclaw-onboarding-memory-import",
  OnboardingMemoryImportContent,
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
