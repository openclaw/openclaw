import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, For, onCleanup, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasProviderBrandIcon } from "../../components/provider-icon-data.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { ProviderBrandIcon } from "../../components/solid/provider-icon.tsx";
import {
  SettingsEmpty,
  SettingsSection,
  SettingsStatus,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";
import { createWizardLogin, WizardLogin } from "../../components/wizard-login-controller.tsx";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { i18nRevision, t } from "../../lib/reactive/i18n.ts";
import { projectOwner, projectSource } from "../../lib/reactive/projection.ts";
import {
  modelProviderConfigBusy,
  modelProviderConfigMutationBlockedReason,
  modelProviderErrorMessage,
  runModelProviderConfigMutation,
  type ModelProviderRowMessage,
} from "./config-mutation.ts";
import type { ModelProviderCard } from "./data.ts";

const INSTALLED_AGENTS_METHOD = "acpx.agents.list";

type InstalledAgent = {
  id: string;
  name: string;
  runtimeId: string;
  installation: "installed" | "missing" | "unverified";
  enabled: boolean;
};

const INSTALLATION_STATUS = {
  installed: { kind: "muted", labelKey: "modelProviders.installedAgents.status.installed" },
  missing: { kind: "muted", labelKey: "modelProviders.installedAgents.status.missing" },
  unverified: { kind: "warn", labelKey: "modelProviders.installedAgents.status.unverified" },
} as const;

type InstalledAgentsOptions = {
  gateway: GatewayPageBinding;
  context: ApplicationContext;
};

export function createInstalledAgents(options: InstalledAgentsOptions) {
  const context = options.context;
  const gatewayState = projectGateway(context.gateway);
  const config = projectRuntimeConfig(context.runtimeConfig);
  const overlays = projectOwner(context.overlays, (source) => source.snapshot);
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  let installed: InstalledAgent[] | null = null;
  let listRequest: AbortController | null = null;
  let listClient: GatewayBrowserClient | null | undefined;
  let listEpoch = -1;
  let loadError: string | null = null;
  /** Requested enabled state per agent while its config write is unsettled. */
  const pending = new Map<string, boolean>();
  const messages = new Map<string, ModelProviderRowMessage>();
  let enablement: {
    client: GatewayBrowserClient;
    epoch: number;
    agentId: string;
    selectionRevision: number;
    agent: InstalledAgent;
  } | null = null;

  const wizard = createWizardLogin({
    getClient: () => enablement?.client ?? null,
    getAgentId: () => enablement?.agentId ?? null,
    onClose: () => closeEnablement(),
    onAnswer: (value, includeValue) => {
      const target = enablement;
      if (target && isCurrentEnablement(target)) {
        void wizard.runner.answer(value, includeValue).then(() => reconcileEnablement(target));
      }
    },
    onBackgroundCompletion: async () => {
      const target = enablement;
      if (target) {
        await reconcileEnablement(target);
      }
    },
    requestFailedMessage: () => t("modelProviders.requestFailed"),
    sessionExpiredMessage: () => t("modelProviders.installedAgents.sessionExpired"),
    finishingMessage: () => t("modelProviders.saving"),
  });
  const projection = projectSource(null, {
    read: () => ({
      agents: installed,
      error: loadError,
      loading: listRequest !== null,
      pending,
      messages,
      enablement,
    }),
    subscribe: (_, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    equality: "revision",
  });

  function synchronize(): void {
    const gateway = options.gateway;
    if (enablement && !isCurrentEnablement(enablement)) {
      closeEnablement();
    }
    const client = gateway.connected && available() ? gateway.client : null;
    if (client !== listClient || gateway.epoch !== listEpoch) {
      void load(client, gateway.epoch);
    }
  }

  function cancel(): void {
    const request = listRequest;
    listRequest = null;
    request?.abort();
    loadError = null;
  }

  async function load(
    client = options.gateway.connected && available() ? options.gateway.client : null,
    epoch = options.gateway.epoch,
  ): Promise<void> {
    cancel();
    listClient = client;
    listEpoch = epoch;
    if (!client) {
      notify();
      return;
    }
    const request = new AbortController();
    listRequest = request;
    notify();
    try {
      const result = await client.request<{ agents: InstalledAgent[] }>(
        INSTALLED_AGENTS_METHOD,
        {},
        { signal: request.signal },
      );
      if (listRequest === request && options.gateway.isCurrent({ client, epoch })) {
        installed = result.agents;
      }
    } catch (error) {
      if (listRequest === request && options.gateway.isCurrent({ client, epoch })) {
        loadError = modelProviderErrorMessage(error);
      }
    } finally {
      if (listRequest === request) {
        listRequest = null;
        notify();
      }
    }
  }

  function subscribe(gateway: ApplicationContext["gateway"]): () => void {
    return gateway.subscribeEvents((event) => {
      if (event.event === "config.changed" && installed !== null && pending.size === 0) {
        void load();
      }
    });
  }

  /** Writes from a previous connection cannot settle here, so their state goes too. */
  function reset(resetOptions: { preserveVisibleData?: boolean } = {}): void {
    closeEnablement();
    cancel();
    listClient = null;
    listEpoch = options.gateway.epoch;
    pending.clear();
    messages.clear();
    if (!resetOptions.preserveVisibleData) {
      installed = null;
    }
    notify();
  }

  function filterProviders(cards: ModelProviderCard[]): ModelProviderCard[] {
    return cards.filter(
      (card) => !projection.read().agents?.some((agent) => agent.runtimeId === card.id),
    );
  }

  function available(): boolean {
    return canCallGatewayMethod(
      gatewayState.read().snapshot,
      INSTALLED_AGENTS_METHOD,
      "operator.read",
    );
  }

  function blockedReason(): string | null {
    i18nRevision();
    config.read();
    gatewayState.read();
    overlays.read();
    return modelProviderConfigMutationBlockedReason(context);
  }

  function isCurrentEnablement(target: NonNullable<typeof enablement>): boolean {
    const selection = context.settingsAgentSelection;
    return (
      enablement === target &&
      options.gateway.isCurrent(target) &&
      selection.state.selectedId === target.agentId &&
      selection.intentRevision === target.selectionRevision
    );
  }

  function closeEnablement(): void {
    const target = enablement;
    enablement = null;
    wizard.reset();
    if (target) {
      pending.delete(target.agent.id);
    }
    notify();
  }

  async function reconcileEnablement(target: NonNullable<typeof enablement>): Promise<void> {
    const phase = wizard.runner.state.phase;
    if (
      !isCurrentEnablement(target) ||
      (phase !== "done" && phase !== "error" && phase !== "cancelled")
    ) {
      return;
    }
    try {
      await context.runtimeConfig.refresh();
      if (isCurrentEnablement(target)) {
        await load(target.client, target.epoch);
      }
    } catch (error) {
      if (isCurrentEnablement(target)) {
        messages.set(target.agent.id, {
          kind: "warning",
          text: modelProviderErrorMessage(error),
        });
      }
    } finally {
      if (isCurrentEnablement(target)) {
        pending.delete(target.agent.id);
        notify();
      }
    }
  }

  function setEnabled(agent: InstalledAgent, enabled: boolean): boolean {
    const scope = options.gateway.capture();
    const selection = context.settingsAgentSelection;
    const agentId = selection.state.selectedId;
    const selectionRevision = selection.intentRevision;
    if (
      !scope ||
      blockedReason() ||
      modelProviderConfigBusy(context) ||
      pending.has(agent.id) ||
      enablement !== null ||
      !agentId
    ) {
      return false;
    }
    if (enabled) {
      const target = {
        ...scope,
        agentId,
        selectionRevision,
        agent,
      };
      enablement = target;
      pending.set(agent.id, true);
      messages.delete(agent.id);
      void wizard.runner
        .startRuntime(
          {
            agentId,
            runtimeId: agent.runtimeId,
            configPatch: {
              plugins: { entries: { acpx: { config: { nativeAgents: { [agent.id]: true } } } } },
            },
          },
          agent.name,
        )
        .then(() => reconcileEnablement(target));
      notify();
      return true;
    }
    // The post-write read retires any list request started before this mutation.
    pending.set(agent.id, enabled);
    const isCurrent = () => options.gateway.isCurrent(scope);
    void runModelProviderConfigMutation(
      {
        runtimeConfig: context.runtimeConfig,
        isCurrentClient: isCurrent,
        isCurrentAgent: () =>
          selection.state.selectedId === agentId && selection.intentRevision === selectionRevision,
        setBusy: (busy) => {
          if (!busy) {
            pending.delete(agent.id);
          }
          notify();
        },
        setMessage: (message) => {
          if (message) {
            messages.set(agent.id, message);
          } else {
            messages.delete(agent.id);
          }
          notify();
        },
      },
      {
        raw: {
          plugins: { entries: { acpx: { config: { nativeAgents: { [agent.id]: enabled } } } } },
        },
        note: t("modelProviders.installedAgents.note"),
      },
    ).then(() => {
      if (isCurrent()) {
        pending.delete(agent.id);
        void load();
      }
    });
    return true;
  }

  function renderAgent(
    props: { agent: InstalledAgent },
    getCards: () => readonly ModelProviderCard[],
  ) {
    const view = createMemo(() => {
      const snapshot = projection.read();
      const agent = props.agent;
      const requested = snapshot.pending.get(agent.id);
      const configObject = currentConfigObject(config.read().state);
      const entries = asRecord(asRecord(configObject?.plugins)?.entries);
      const nativeConfig = asRecord(asRecord(entries?.acpx)?.config);
      const configuredEnabled = asRecord(nativeConfig?.nativeAgents)?.[agent.id];
      const enabled =
        requested ?? (typeof configuredEnabled === "boolean" ? configuredEnabled : agent.enabled);
      const card = getCards().find((entry) => entry.id === agent.runtimeId);
      let status: { kind: "ok" | "muted" | "warn" | "danger"; labelKey: string } =
        INSTALLATION_STATUS[agent.installation];
      let hint = "";
      if (agent.installation === "missing") {
        hint = t("modelProviders.installedAgents.installHint", { name: agent.name });
      } else if (agent.installation === "unverified") {
        hint = t("modelProviders.installedAgents.unverifiedHint");
      } else if (!enabled) {
        hint = t("modelProviders.installedAgents.disabledHint");
      } else if (card?.catalogStatus === "auth-rejected") {
        status = { kind: "danger", labelKey: "modelProviders.installedAgents.status.signIn" };
        hint = t("modelProviders.installedAgents.signInHint", { name: agent.name });
      } else if (card?.catalogStatus === "unavailable") {
        status = { kind: "warn", labelKey: "modelProviders.status.modelsUnavailable" };
        hint = t("modelProviders.installedAgents.discoveryHint", { name: agent.name });
      } else if (card?.checkingModels) {
        status = { kind: "muted", labelKey: "modelProviders.installedAgents.status.discovering" };
      } else if (card && card.availableModelCount > 0) {
        status = { kind: "ok", labelKey: "modelProviders.installedAgents.status.modelsAvailable" };
      } else {
        hint = t("modelProviders.installedAgents.signInHint", { name: agent.name });
      }
      return {
        agent,
        pending: requested,
        enabled,
        status,
        hint,
        blocked:
          blockedReason() !== null || modelProviderConfigBusy(context) || enablement !== null,
        message: snapshot.messages.get(agent.id),
      };
    });
    return (
      <div class="model-providers__installed-agent" data-installed-agent={props.agent.id}>
        <SettingsToggleRow
          icon={
            <Show
              when={hasProviderBrandIcon(view().agent.id)}
              fallback={
                <span class="model-providers__icon model-providers__agent-icon" aria-hidden="true">
                  <Icon name="terminal" />
                </span>
              }
            >
              <ProviderBrandIcon provider={view().agent.id} class="model-providers__icon" />
            </Show>
          }
          title={view().agent.name}
          ariaLabel={t("modelProviders.installedAgents.toggle", { name: view().agent.name })}
          description={
            <Show
              when={view().pending === undefined}
              fallback={<SettingsStatus kind="muted" label={t("modelProviders.saving")} />}
            >
              <SettingsStatus kind={view().status.kind} label={t(view().status.labelKey)} />
              <Show when={view().hint}>
                <br />
                {view().hint}
              </Show>
            </Show>
          }
          checked={view().enabled}
          disabled={view().blocked || view().pending !== undefined}
          onChange={(checked) => setEnabled(props.agent, checked)}
        />
        <Show when={view().message}>
          {(message) => (
            <div
              class={`callout ${message().kind} model-providers__installed-agent-message`}
              role={message().kind === "error" ? "alert" : "status"}
            >
              {message().text}
            </div>
          )}
        </Show>
      </div>
    );
  }

  function render(getCards: () => readonly ModelProviderCard[], retryDiscovery: () => void) {
    const AgentRow = (props: { agent: InstalledAgent }) => renderAgent(props, getCards);
    const InstalledAgents = () => {
      const view = createMemo(() => ({
        ...projection.read(),
        available: available(),
        blockedReason: blockedReason(),
      }));
      const checkLabel = () =>
        t(
          view().loading
            ? "modelProviders.installedAgents.checking"
            : "modelProviders.installedAgents.check",
        );
      return (
        <Show when={view().available}>
          <div class="model-providers__installed-agents">
            <SettingsSection
              title={t("modelProviders.installedAgents.title")}
              description={
                <>
                  {t("modelProviders.installedAgents.description")}
                  <Show when={view().blockedReason}>
                    <br />
                    {view().blockedReason}
                  </Show>
                </>
              }
              actions={
                <openclaw-tooltip prop:content={checkLabel()}>
                  <button
                    type="button"
                    class="btn btn--icon btn--ghost btn--xs model-providers__refresh-button"
                    aria-label={checkLabel()}
                    disabled={view().loading || view().pending.size > 0}
                    onClick={() => {
                      void load();
                      retryDiscovery();
                    }}
                  >
                    <Icon name="refresh" />
                  </button>
                </openclaw-tooltip>
              }
            >
              <Show when={view().error}>
                <div class="settings-row">
                  <div class="settings-row__text">
                    <span class="settings-row__desc provider-usage-error" role="alert">
                      {view().error}
                    </span>
                  </div>
                  <div class="settings-row__control">
                    <button
                      class="btn btn--sm"
                      disabled={view().loading}
                      onClick={() => void load()}
                    >
                      {t("common.retry")}
                    </button>
                  </div>
                </div>
              </Show>
              <Show when={view().agents !== null}>
                <For
                  each={view().agents ?? []}
                  keyed={(agent) => agent.id}
                  fallback={<SettingsEmpty message={t("modelProviders.installedAgents.empty")} />}
                >
                  {(agent) => <AgentRow agent={agent()} />}
                </For>
              </Show>
            </SettingsSection>
          </div>
          <Show when={view().enablement}>
            <WizardLogin
              controller={wizard}
              options={{
                mode: "prepare",
                doneMessage: t("modelProviders.installedAgents.enabled", {
                  name: view().enablement?.agent.name ?? "",
                }),
              }}
            />
          </Show>
        </Show>
      );
    };
    return <InstalledAgents />;
  }
  onCleanup(() => {
    listeners.clear();
    enablement = null;
    cancel();
    listClient = undefined;
  });
  return {
    get initialized() {
      const snapshot = projection.read();
      return !available() || snapshot.agents !== null || snapshot.error !== null;
    },
    synchronize,
    subscribe,
    reset,
    filterProviders,
    available,
    render,
  };
}
