import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, For, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasProviderBrandIcon } from "../../components/provider-icon-data.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { ProviderBrandIcon } from "../../components/solid/provider-icon.tsx";
import {
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsSection,
  SettingsStatus,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import {
  modelProviderConfigBusy,
  modelProviderConfigMutationBlockedReason,
  modelProviderErrorMessage,
  runModelProviderConfigMutation,
  type ModelProviderRowMessage,
} from "./config-mutation.ts";
import type { ModelProviderCard } from "./data.ts";
import type { ControllerHost } from "./page-controller.ts";

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
  gateway: GatewayPageController;
  getContext: () => ApplicationContext;
};

export class InstalledAgentsController {
  private agents: InstalledAgent[] | null = null;
  private request: AbortController | null = null;
  private listClient: GatewayBrowserClient | null | undefined;
  private listEpoch = -1;
  private error: string | null = null;
  /** Requested enabled state per agent while its config write is unsettled. */
  private readonly pending = new Map<string, boolean>();
  private readonly messages = new Map<string, ModelProviderRowMessage>();

  constructor(
    private readonly host: ControllerHost,
    private readonly options: InstalledAgentsOptions,
  ) {
    host.addController(this);
  }

  private get loading(): boolean {
    return this.request !== null;
  }

  hostUpdate(): void {
    const gateway = this.options.gateway;
    const client = gateway.connected && this.available() ? gateway.client : null;
    if (client !== this.listClient || gateway.epoch !== this.listEpoch) {
      void this.load(client, gateway.epoch);
    }
  }

  hostDisconnected(): void {
    this.cancel();
    this.listClient = undefined;
  }

  private cancel(): void {
    const request = this.request;
    this.request = null;
    request?.abort();
    this.error = null;
  }

  private async load(
    client = this.options.gateway.connected && this.available()
      ? this.options.gateway.client
      : null,
    epoch = this.options.gateway.epoch,
  ): Promise<void> {
    this.cancel();
    this.listClient = client;
    this.listEpoch = epoch;
    if (!client) {
      this.host.requestUpdate();
      return;
    }
    const request = new AbortController();
    this.request = request;
    this.host.requestUpdate();
    try {
      const result = await client.request<{ agents: InstalledAgent[] }>(
        INSTALLED_AGENTS_METHOD,
        {},
        { signal: request.signal },
      );
      if (this.request === request && this.options.gateway.isCurrent({ client, epoch })) {
        this.agents = result.agents;
      }
    } catch (error) {
      if (this.request === request && this.options.gateway.isCurrent({ client, epoch })) {
        this.error = modelProviderErrorMessage(error);
      }
    } finally {
      if (this.request === request) {
        this.request = null;
        this.host.requestUpdate();
      }
    }
  }

  subscribe(gateway: ApplicationContext["gateway"]): () => void {
    return gateway.subscribeEvents((event) => {
      if (event.event === "config.changed" && this.agents !== null && this.pending.size === 0) {
        void this.load();
      }
    });
  }

  /** Writes from a previous connection cannot settle here, so their state goes too. */
  reset(options: { preserveVisibleData?: boolean } = {}): void {
    this.cancel();
    this.listClient = null;
    this.listEpoch = this.options.gateway.epoch;
    this.pending.clear();
    this.messages.clear();
    if (!options.preserveVisibleData) {
      this.agents = null;
    }
    this.host.requestUpdate();
  }

  filterProviders(cards: ModelProviderCard[]): ModelProviderCard[] {
    return cards.filter((card) => !this.agents?.some((agent) => agent.runtimeId === card.id));
  }

  available(): boolean {
    return canCallGatewayMethod(
      this.options.getContext().gateway.snapshot,
      INSTALLED_AGENTS_METHOD,
      "operator.read",
    );
  }

  private blockedReason(): string | null {
    return modelProviderConfigMutationBlockedReason(this.options.getContext());
  }

  private setEnabled(agent: InstalledAgent, enabled: boolean): boolean {
    const scope = this.options.gateway.capture();
    if (
      !scope ||
      this.blockedReason() ||
      modelProviderConfigBusy(this.options.getContext()) ||
      this.pending.has(agent.id)
    ) {
      return false;
    }
    // The post-write read retires any list request started before this mutation.
    this.pending.set(agent.id, enabled);
    const isCurrent = () => this.options.gateway.isCurrent(scope);
    void runModelProviderConfigMutation(
      {
        runtimeConfig: this.options.getContext().runtimeConfig,
        isCurrentClient: isCurrent,
        isCurrentAgent: () => true,
        setBusy: (busy) => {
          if (!busy) {
            this.pending.delete(agent.id);
          }
          this.host.requestUpdate();
        },
        setMessage: (message) => {
          if (message) {
            this.messages.set(agent.id, message);
          } else {
            this.messages.delete(agent.id);
          }
          this.host.requestUpdate();
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
        void this.load();
      }
    });
    return true;
  }

  private renderAgent(
    props: { agent: InstalledAgent },
    getCards: () => readonly ModelProviderCard[],
    revision: () => unknown,
  ) {
    const view = createMemo(() => {
      revision();
      const agent = props.agent;
      const pending = this.pending.get(agent.id);
      const config = currentConfigObject(this.options.getContext().runtimeConfig.state);
      const entries = asRecord(asRecord(config?.plugins)?.entries);
      const nativeConfig = asRecord(asRecord(entries?.acpx)?.config);
      const configuredEnabled = asRecord(nativeConfig?.nativeAgents)?.[agent.id];
      const enabled =
        pending ?? (typeof configuredEnabled === "boolean" ? configuredEnabled : agent.enabled);
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
        pending,
        enabled,
        status,
        hint,
        blocked:
          this.blockedReason() !== null || modelProviderConfigBusy(this.options.getContext()),
        message: this.messages.get(agent.id),
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
          onChange={(checked) => this.setEnabled(props.agent, checked)}
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

  render(
    getCards: () => readonly ModelProviderCard[],
    retryDiscovery: () => void,
    revision: () => unknown,
  ) {
    const AgentRow = (props: { agent: InstalledAgent }) =>
      this.renderAgent(props, getCards, revision);
    const InstalledAgents = () => {
      const view = createMemo(() => {
        revision();
        return {
          available: this.available(),
          agents: this.agents,
          error: this.error,
          loading: this.loading,
          pending: this.pending.size > 0,
          blockedReason: this.blockedReason(),
        };
      });
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
                    disabled={view().loading || view().pending}
                    onClick={() => {
                      void this.load();
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
                      onClick={() => void this.load()}
                    >
                      {t("common.retry")}
                    </button>
                  </div>
                </div>
              </Show>
              <Show
                when={view().agents !== null}
                fallback={
                  <Show when={!view().error}>
                    <SettingsLoadingSkeleton rows={4} />
                  </Show>
                }
              >
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
        </Show>
      );
    };
    return <InstalledAgents />;
  }
}
