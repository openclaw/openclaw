import { initialState, Task, TaskStatus } from "@lit/task";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import { hasProviderBrandIcon, renderProviderBrandIcon } from "../../components/provider-icon.ts";
import {
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsToggleRow,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
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
  gateway: GatewayPageController;
  getContext: () => ApplicationContext;
};

export class InstalledAgentsController {
  private agents: InstalledAgent[] | null = null;
  private readonly list: Task<readonly [GatewayBrowserClient | null, number], InstalledAgent[]>;
  /** Requested enabled state per agent while its config write is unsettled. */
  private readonly pending = new Map<string, boolean>();
  private readonly messages = new Map<string, ModelProviderRowMessage>();

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: InstalledAgentsOptions,
  ) {
    this.list = new Task(host, {
      args: () =>
        [
          options.gateway.connected && this.available() ? options.gateway.client : null,
          options.gateway.epoch,
        ] as const,
      task: async ([client], { signal }) => {
        if (!client) {
          return initialState;
        }
        const result = await client.request<{ agents: InstalledAgent[] }>(
          INSTALLED_AGENTS_METHOD,
          {},
          { signal },
        );
        return result.agents;
      },
      onComplete: (agents) => {
        this.agents = agents;
      },
    });
  }

  private get loading() {
    return this.list.status === TaskStatus.PENDING;
  }

  private get error() {
    return this.list.status === TaskStatus.ERROR
      ? modelProviderErrorMessage(this.list.error)
      : null;
  }

  subscribe(gateway: ApplicationContext["gateway"]): () => void {
    return gateway.subscribeEvents((event) => {
      if (event.event === "config.changed" && this.agents !== null && this.pending.size === 0) {
        void this.list.run();
      }
    });
  }

  /** Writes from a previous connection cannot settle here, so their state goes too. */
  reset(options: { preserveVisibleData?: boolean } = {}): void {
    void this.list.run([null, this.options.gateway.epoch]);
    this.pending.clear();
    this.messages.clear();
    if (!options.preserveVisibleData) {
      this.agents = null;
    }
  }

  filterProviders(cards: ModelProviderCard[]): ModelProviderCard[] {
    return cards.filter((card) => !this.agents?.some((agent) => agent.runtimeId === card.id));
  }

  private available(): boolean {
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
    // Task discards an older list result when the post-write read starts.
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
        key: `installed-agent:${agent.id}`,
        raw: {
          plugins: { entries: { acpx: { config: { nativeAgents: { [agent.id]: enabled } } } } },
        },
        note: t("modelProviders.installedAgents.note"),
      },
    ).then(() => {
      if (isCurrent()) {
        void this.list.run();
      }
    });
    return true;
  }

  private renderAgent(
    agent: InstalledAgent,
    blocked: boolean,
    configuredEnabled: unknown,
    card: ModelProviderCard | undefined,
  ) {
    const pending = this.pending.get(agent.id);
    const enabled =
      pending ?? (typeof configuredEnabled === "boolean" ? configuredEnabled : agent.enabled);
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
    const message = this.messages.get(agent.id);
    return html`
      <div class="model-providers__installed-agent" data-installed-agent=${agent.id}>
        ${renderSettingsToggleRow({
          icon: hasProviderBrandIcon(agent.id)
            ? renderProviderBrandIcon(agent.id, { className: "model-providers__icon" })
            : html`<span
                class="model-providers__icon model-providers__agent-icon"
                aria-hidden="true"
                >${icons.terminal}</span
              >`,
          title: agent.name,
          ariaLabel: t("modelProviders.installedAgents.toggle", { name: agent.name }),
          description:
            pending === undefined
              ? html`${renderSettingsStatus({ kind: status.kind, label: t(status.labelKey) })}${
                  hint ? html`<br />${hint}` : nothing
                }`
              : renderSettingsStatus({ kind: "muted", label: t("modelProviders.saving") }),
          checked: enabled,
          disabled: blocked || pending !== undefined,
          onChange: (checked) => this.setEnabled(agent, checked),
        })}
        ${
          message
            ? html`<div
                class="callout ${message.kind} model-providers__installed-agent-message"
                role=${message.kind === "error" ? "alert" : "status"}
              >
                ${message.text}
              </div>`
            : nothing
        }
      </div>
    `;
  }

  render(cards: readonly ModelProviderCard[], retryDiscovery: () => void) {
    if (!this.available()) {
      return nothing;
    }
    const blockedReason = this.blockedReason();
    const blocked = blockedReason !== null || modelProviderConfigBusy(this.options.getContext());
    const config = currentConfigObject(this.options.getContext().runtimeConfig.state);
    const entries = asRecord(asRecord(config?.plugins)?.entries);
    const nativeConfig = asRecord(asRecord(entries?.acpx)?.config);
    const nativeFlags = asRecord(nativeConfig?.nativeAgents);
    const errorRow = this.error
      ? html`<div class="settings-row">
          <div class="settings-row__text">
            <span class="settings-row__desc provider-usage-error" role="alert">${this.error}</span>
          </div>
          <div class="settings-row__control">
            <button
              class="btn btn--sm"
              ?disabled=${this.loading}
              @click=${() => void this.list.run()}
            >
              ${t("common.retry")}
            </button>
          </div>
        </div>`
      : nothing;
    const rows =
      this.agents === null
        ? this.error
          ? errorRow
          : renderSettingsLoadingSkeleton({ rows: 4 })
        : html`${errorRow}${
            this.agents.length === 0
              ? renderSettingsEmpty(t("modelProviders.installedAgents.empty"))
              : this.agents.map((agent) =>
                  this.renderAgent(
                    agent,
                    blocked,
                    nativeFlags?.[agent.id],
                    cards.find((card) => card.id === agent.runtimeId),
                  ),
                )
          }`;
    const checkLabel = this.loading
      ? t("modelProviders.installedAgents.checking")
      : t("modelProviders.installedAgents.check");
    return html`
      <div class="model-providers__installed-agents">
        ${renderSettingsSection(
          {
            title: t("modelProviders.installedAgents.title"),
            description: html`${t("modelProviders.installedAgents.description")}${
              blockedReason ? html`<br />${blockedReason}` : nothing
            }`,
            actions: html`
              <openclaw-tooltip .content=${checkLabel}>
                <button
                  type="button"
                  class="btn btn--icon btn--ghost btn--xs model-providers__refresh-button"
                  aria-label=${checkLabel}
                  ?disabled=${this.loading || this.pending.size > 0}
                  @click=${() => {
                    void this.list.run();
                    retryDiscovery();
                  }}
                >
                  ${icons.refresh}
                </button>
              </openclaw-tooltip>
            `,
          },
          rows,
        )}
      </div>
    `;
  }
}
