import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferred } from "@solidjs/signals";
import type { JSX } from "@solidjs/web";
import {
  action,
  createMemo,
  createOptimistic,
  Errored,
  For,
  isPending,
  Loading,
  onSettled,
  refresh,
  Show,
} from "solid-js";
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
import { createPageRequest } from "../../lib/page-request.ts";
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
  unverified: { kind: "warn", labelKey: "modelProviders.installedAgents.status.unverified" },
} as const;

type InstalledInventory = {
  agents: InstalledAgent[] | null;
  failure?: { error: unknown };
};

type InstalledAgentsOptions = {
  gateway: GatewayPageBinding;
  context: ApplicationContext;
};

type PresentToggle = (
  pending: Promise<unknown>,
  enabled: boolean,
  isCurrent: () => boolean,
  retired: Promise<void>,
) => Promise<void>;

export function createInstalledAgents(options: InstalledAgentsOptions) {
  const context = options.context;
  const gatewayState = projectGateway(context.gateway);
  const config = projectRuntimeConfig(context.runtimeConfig);
  const overlays = projectOwner(context.overlays, (source) => source.snapshot);
  let publish: (() => void) | undefined;
  const notify = () => publish?.();
  let installed: InstalledAgent[] | null = null;
  let listClient: GatewayBrowserClient | null | undefined;
  let listEpoch = -1;
  let inventory: { value: InstalledInventory | Promise<InstalledInventory> } = {
    value: { agents: installed },
  };
  let finishListRead: ((outcome: InstalledInventory) => void) | undefined;
  const currentList = () =>
    listClient !== null &&
    listClient !== undefined &&
    options.gateway.isCurrent({ client: listClient, epoch: listEpoch });
  const listRequest = createPageRequest(notify, {
    task: (client: GatewayBrowserClient, { signal }) =>
      client.request<{ agents: InstalledAgent[] }>(INSTALLED_AGENTS_METHOD, {}, { signal }),
    onComplete: (result) => {
      if (currentList()) {
        installed = result.agents;
      }
      finishListRead?.({ agents: installed });
      finishListRead = undefined;
    },
    onError: (error) => {
      finishListRead?.({
        agents: installed,
        ...(currentList() ? { failure: { error } } : {}),
      });
      finishListRead = undefined;
    },
  });
  // Admission stays synchronous; expected values belong to each row's presentation.
  const pending = new Set<string>();
  let presentationLifetime = Promise.withResolvers<void>();
  let presentationIdentity = {
    epoch: options.gateway.epoch,
    agentId: context.settingsAgentSelection.state.selectedId,
    selectionRevision: context.settingsAgentSelection.intentRevision,
  };
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
        void presentEnablementStep(target, wizard.runner.answer(value, includeValue));
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
      inventory,
      pending,
      messages,
      enablement,
      presentationIdentity,
    }),
    subscribe: (_, listener) => {
      publish = listener;
      return () => (publish = undefined);
    },
    equality: "revision",
  });
  const presentationScope = createMemo(() => projection.read().presentationIdentity);
  const wizardPresentation = createMemo(() => {
    presentationScope();
    const [saving, setSaving] = createOptimistic(false);
    return { saving, setSaving };
  });
  const presentStep = action(function* (
    display: ReturnType<typeof wizardPresentation>,
    target: NonNullable<typeof enablement>,
    operation: Promise<unknown>,
    retired: Promise<void>,
  ) {
    try {
      if (isCurrentEnablement(target)) {
        display.setSaving(true);
      }
      yield Promise.race([operation, retired]);
    } catch (error) {
      if (isCurrentEnablement(target)) {
        messages.set(target.agent.id, { kind: "error", text: modelProviderErrorMessage(error) });
        notify();
      }
    }
  });

  async function presentEnablementStep(
    target: NonNullable<typeof enablement>,
    step: Promise<unknown>,
  ) {
    const display = wizardPresentation();
    const retired = presentationLifetime.promise;
    const operation = step.then(() => reconcileEnablement(target));
    await Promise.resolve();
    return presentStep(display, target, operation, retired);
  }

  function synchronize(): void {
    const gateway = options.gateway;
    const selection = context.settingsAgentSelection;
    if (
      presentationIdentity.epoch !== gateway.epoch ||
      presentationIdentity.agentId !== selection.state.selectedId ||
      presentationIdentity.selectionRevision !== selection.intentRevision
    ) {
      presentationIdentity = {
        epoch: gateway.epoch,
        agentId: selection.state.selectedId,
        selectionRevision: selection.intentRevision,
      };
      pending.clear();
      messages.clear();
      closeEnablement();
    }
    if (enablement && !isCurrentEnablement(enablement)) {
      closeEnablement();
    }
    const client = gateway.connected && available() ? gateway.client : null;
    if (client !== listClient || gateway.epoch !== listEpoch) {
      void load(client, gateway.epoch);
    }
  }

  function cancel(): void {
    listRequest.cancel();
    // Retire the display even when the canceled transport never settles.
    finishListRead?.({ agents: installed });
    finishListRead = undefined;
    inventory = { value: { agents: installed } };
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
    const completion = Promise.withResolvers<InstalledInventory>();
    inventory = { value: completion.promise };
    finishListRead = completion.resolve;
    await listRequest.run(client);
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
    inventory = { value: { agents: installed } };
    notify();
  }

  function filterProviders(cards: ModelProviderCard[]): ModelProviderCard[] {
    return cards.filter(
      (card) => !projection.read().agents?.some((agent) => agent.runtimeId === card.id),
    );
  }

  function available(): boolean {
    if (!options.gateway.connected && installed !== null) {
      return true;
    }
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
    // Retirement must precede publication; pending actions park reactive cleanup.
    presentationLifetime.resolve();
    presentationLifetime = Promise.withResolvers<void>();
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

  function setEnabled(agent: InstalledAgent, enabled: boolean, present: PresentToggle): boolean {
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
    const retired = presentationLifetime.promise;
    const presentAdmitted = async (operation: Promise<unknown>, isCurrent: () => boolean) => {
      // The owner publishes admission before Solid opens its presentation lane.
      await Promise.resolve();
      return present(operation, enabled, isCurrent, retired);
    };
    if (enabled) {
      const target = {
        ...scope,
        agentId,
        selectionRevision,
        agent,
      };
      enablement = target;
      pending.add(agent.id);
      messages.delete(agent.id);
      const step = wizard.runner.startRuntime(
        {
          agentId,
          runtimeId: agent.runtimeId,
          configPatch: {
            plugins: { entries: { acpx: { config: { nativeAgents: { [agent.id]: true } } } } },
          },
        },
        agent.name,
      );
      notify();
      const operation = presentEnablementStep(target, step);
      void presentAdmitted(operation, () => isCurrentEnablement(target));
      return true;
    }
    // The post-write read retires any list request started before this mutation.
    pending.add(agent.id);
    const isCurrent = () => options.gateway.isCurrent(scope);
    const isCurrentAgent = () =>
      selection.state.selectedId === agentId && selection.intentRevision === selectionRevision;
    const operation = runModelProviderConfigMutation(
      {
        runtimeConfig: context.runtimeConfig,
        isCurrentClient: isCurrent,
        isCurrentAgent,
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
    void presentAdmitted(operation, () => isCurrent() && isCurrentAgent());
    return true;
  }

  function renderAgent(
    props: { agent: InstalledAgent },
    getCards: () => readonly ModelProviderCard[],
  ) {
    const view = createMemo(() => {
      const snapshot = projection.read();
      const agent = props.agent;
      const configObject = currentConfigObject(config.read().state);
      const entries = asRecord(asRecord(configObject?.plugins)?.entries);
      const nativeConfig = asRecord(asRecord(entries?.acpx)?.config);
      const configuredEnabled = asRecord(nativeConfig?.nativeAgents)?.[agent.id];
      // The admitted wizard retains its enabled intent at human-input checkpoints.
      const enabling = snapshot.enablement?.agent.id === agent.id && snapshot.pending.has(agent.id);
      const enabled =
        enabling || (typeof configuredEnabled === "boolean" ? configuredEnabled : agent.enabled);
      const card = getCards().find((entry) => entry.id === agent.runtimeId);
      // Rows render only for detected apps; missing ones share one line below the list.
      let status: { kind: "ok" | "muted" | "warn" | "danger"; labelKey: string } =
        INSTALLATION_STATUS[agent.installation === "unverified" ? "unverified" : "installed"];
      let hint = "";
      if (agent.installation === "unverified") {
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
        pending: snapshot.pending.has(agent.id),
        enabled,
        status,
        hint,
        blocked:
          blockedReason() !== null || modelProviderConfigBusy(context) || enablement !== null,
        message: snapshot.messages.get(agent.id),
      };
    });
    const presentation = createMemo(() => {
      presentationScope();
      const [enabled, setEnabledValue] = createOptimistic(() => view().enabled);
      const [saving, setSaving] = createOptimistic(false);
      return { enabled, setEnabledValue, saving, setSaving };
    });
    const presentToggle = action(function* (
      display: ReturnType<typeof presentation>,
      operation: Promise<unknown>,
      expected: boolean,
      isCurrent: () => boolean,
      retired: Promise<void>,
    ) {
      try {
        if (isCurrent()) {
          display.setSaving(true);
          display.setEnabledValue(expected);
        }
        yield Promise.race([operation, retired]);
        if (isCurrent()) {
          yield refresh(display.enabled);
        }
      } catch (error) {
        if (isCurrent()) {
          messages.set(props.agent.id, { kind: "error", text: modelProviderErrorMessage(error) });
          notify();
        }
      }
    });
    const busy = () => presentation().saving() || view().pending;
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
              when={!busy()}
              fallback={<SettingsStatus kind="muted" label={t("modelProviders.saving")} />}
            >
              <SettingsStatus kind={view().status.kind} label={t(view().status.labelKey)} />
              <Show when={view().hint}>
                <br />
                {view().hint}
              </Show>
            </Show>
          }
          checked={presentation().enabled()}
          disabled={busy() || view().blocked}
          onChange={(checked) => {
            const display = presentation();
            return setEnabled(props.agent, checked, (...args) => presentToggle(display, ...args));
          }}
        />
        <Show when={view().message}>
          {(message) => (
            <div
              class={["callout", message().kind, "model-providers__installed-agent-message"]}
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
      const InventorySection = (props: { checking: boolean; children?: JSX.Element }) => {
        const label = () =>
          t(
            props.checking
              ? "modelProviders.installedAgents.checking"
              : "modelProviders.installedAgents.check",
          );
        return (
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
              <openclaw-tooltip prop:content={label()}>
                <button
                  type="button"
                  class="btn btn--icon btn--ghost btn--xs model-providers__refresh-button"
                  aria-label={label()}
                  disabled={props.checking || view().pending.size > 0}
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
            {props.children}
          </SettingsSection>
        );
      };
      const InventoryContent = () => {
        const read = createMemo(() => view().inventory);
        // Refresh may retain rows, but must not hold scope retirement or live config updates.
        const displayedInventory = createDeferred(() => read().value);
        const checking = () => isPending(displayedInventory);
        const detected = createMemo(() =>
          (displayedInventory().agents ?? []).filter((agent) => agent.installation !== "missing"),
        );
        const missing = createMemo(() =>
          (displayedInventory().agents ?? []).filter((agent) => agent.installation === "missing"),
        );
        const outcome = createMemo(() => {
          const failure = displayedInventory().failure;
          if (failure) {
            throw failure.error;
          }
          return null;
        });
        return (
          <InventorySection checking={checking()}>
            <Errored
              fallback={(error) => (
                <Show when={!checking()}>
                  <div class="settings-row">
                    <div class="settings-row__text">
                      <span class="settings-row__desc provider-usage__error" role="alert">
                        {modelProviderErrorMessage(error())}
                      </span>
                    </div>
                    <div class="settings-row__control">
                      <button class="btn btn--sm" onClick={() => void load()}>
                        {t("common.retry")}
                      </button>
                    </div>
                  </div>
                </Show>
              )}
            >
              {outcome()}
            </Errored>
            <Show when={view().agents !== null}>
              <For
                each={detected()}
                keyed={(agent) => agent.id}
                fallback={
                  <Show when={missing().length === 0}>
                    <SettingsEmpty message={t("modelProviders.installedAgents.empty")} />
                  </Show>
                }
              >
                {(agent) => <AgentRow agent={agent()} />}
              </For>
              <Show when={missing().length > 0}>
                <p class="model-providers__agents-missing" data-installed-agents-missing>
                  {t("modelProviders.installedAgents.notDetected", {
                    names: missing()
                      .map((agent) => agent.name)
                      .join(", "),
                  })}
                </p>
              </Show>
            </Show>
          </InventorySection>
        );
      };
      return (
        <Show when={view().available}>
          <div class="model-providers__installed-agents">
            <Loading fallback={<InventorySection checking />}>
              <InventoryContent />
            </Loading>
          </div>
          <Show when={view().enablement}>
            <WizardLogin
              controller={wizard}
              busy={wizardPresentation().saving()}
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
  onSettled(() => () => {
    presentationLifetime.resolve();
    publish = undefined;
    enablement = null;
    listClient = undefined;
    cancel();
  });
  return {
    get initialized() {
      const snapshot = projection.read();
      return !available() || snapshot.agents !== null || (currentList() && !listRequest.pending);
    },
    synchronize,
    subscribe,
    reset,
    filterProviders,
    available,
    render,
  };
}
