import { consume } from "@lit/context";
import { TaskStatus } from "@lit/task";
import type { SessionsStorageStatusResult } from "@openclaw/gateway-protocol";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";
import {
  renderLearnMoreLink,
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsToggleRow,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatByteSize, formatDateTimeMs } from "../../lib/format.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { ConfigStatusController } from "./config-status-controller.ts";
import { SESSION_STORAGE_SETTINGS_TARGET_ID } from "./settings-targets.ts";

registerSettingsEnglish();

function storageSize(bytes: number) {
  return formatByteSize(bytes, {
    style: "iec",
    maxUnit: "tera",
    separator: " ",
    fractionDigits: (_value, unit) => (unit === "byte" ? 0 : 1),
  });
}

function externalizedTranscripts(count: number): string {
  return count > 0 ? t("configView.sessionStorage.externalized", { count: String(count) }) : "";
}

class SessionStorageSettings extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context!: ApplicationContext;
  @property({ type: Boolean }) mutationDisabled = false;
  @property({ attribute: false }) editor: TemplateResult | typeof nothing = nothing;
  @property({ type: Boolean }) advancedExpanded = false;

  @state() private ageDraft: string | null = null;
  @state() private runError: string | null = null;
  @state() private runOutcome: string | null = null;
  @state() private runOperation: object | null = null;
  private followingRun = false;

  private readonly status = new ConfigStatusController<SessionsStorageStatusResult>(this, {
    getContext: () => this.context,
    method: "sessions.storage.status",
    permission: "admin",
    revision: "appliedConfigHash",
    retireOnConfigReplacement: true,
    handshakeDependencies: true,
    onInvalidate: () => this.retireRequests(),
    onComplete: (status) => this.observeMaintenance(status),
    onError: () => {
      this.maintenancePoll.stop();
      this.runOutcome = null;
    },
  });

  private retireRequests() {
    this.status.task.abort();
    this.maintenancePoll.stop();
    this.followingRun = false;
    this.ageDraft = null;
    this.runOperation = null;
    this.runError = null;
    this.runOutcome = null;
  }

  private readonly maintenancePoll = new PollController(
    this,
    2_000,
    () => {
      if (!this.status.client) {
        this.maintenancePoll.stop();
      } else if (this.status.task.status !== TaskStatus.PENDING) {
        void this.status.task.run();
      }
    },
    false,
  );

  private observeMaintenance(status: SessionsStorageStatusResult) {
    if (status.maintenance.running) {
      this.followingRun = true;
      this.maintenancePoll.start();
      return;
    }
    this.maintenancePoll.stop();
    if (this.followingRun) {
      this.runOutcome = status.maintenance.lastError
        ? null
        : [
            t("configView.sessionStorage.runCompleted", {
              count: String(status.maintenance.archivedTranscripts),
            }),
            externalizedTranscripts(status.maintenance.externalizedTranscripts),
          ]
            .filter(Boolean)
            .join(" ");
      this.runError = null;
      this.followingRun = false;
    }
  }

  override disconnectedCallback() {
    this.retireRequests();
    this.status.subscriptions.clear();
    super.disconnectedCallback();
  }

  private get disabled() {
    const config = this.context.runtimeConfig;
    return (
      this.mutationDisabled ||
      this.runOperation !== null ||
      !this.status.client ||
      !config.canSet ||
      !config.state.connected ||
      config.state.configLoading ||
      config.state.configSaving ||
      config.state.configApplying ||
      (config.state.configFormMode === "raw" && config.state.configFormDirty)
    );
  }

  private get coldStorage() {
    const config = this.context.runtimeConfig.state;
    const session = asNullableRecord(
      asNullableRecord(config.configForm ?? config.configSnapshot?.config)?.session,
    );
    const coldStorage = asNullableRecord(asNullableRecord(session?.maintenance)?.coldStorage);
    return {
      enabled: coldStorage?.enabled === true,
      afterDays: typeof coldStorage?.afterDays === "number" ? coldStorage.afterDays : 30,
    };
  }

  private get canRun() {
    const config = this.context.runtimeConfig.state;
    const session = asNullableRecord(asNullableRecord(config.configSnapshot?.config)?.session);
    const coldStorage = asNullableRecord(asNullableRecord(session?.maintenance)?.coldStorage);
    const result = this.status.task.value;
    return (
      !this.disabled &&
      this.ageDraft === null &&
      !config.configFormDirty &&
      !config.configNeedsApply &&
      typeof config.configSnapshot?.appliedConfigHash === "string" &&
      coldStorage?.enabled === true &&
      this.status.task.status === TaskStatus.COMPLETE &&
      result?.isCurrent() === true &&
      !result.status.maintenance.running
    );
  }

  private async runNow() {
    const client = this.status.client;
    const scope = this.status.gateway.capture();
    if (!this.canRun || !client || !scope) {
      return;
    }
    const operation = {};
    const gateway = this.context.gateway;
    const hello = gateway.snapshot.hello;
    this.runOperation = operation;
    this.runError = null;
    this.runOutcome = null;
    const isCurrent = () =>
      this.runOperation === operation &&
      this.status.client === client &&
      this.status.gateway.isCurrent(scope) &&
      this.context.gateway === gateway &&
      gateway.snapshot.hello === hello;
    try {
      const result = await client.request<SessionsStorageStatusResult>("sessions.storage.run", {});
      if (!isCurrent()) {
        return;
      }
      this.followingRun = true;
      this.runOutcome = result.maintenance.running
        ? t("configView.sessionStorage.runStarted")
        : null;
      this.observeMaintenance(result);
      await this.status.task.run();
    } catch (error) {
      if (isCurrent()) {
        this.runError = formatUiError(error);
      }
    } finally {
      if (isCurrent()) {
        this.runOperation = null;
      }
    }
  }

  private setAge(event: Event) {
    // SAFETY: The native number input calls this synchronously from its own change binding.
    const input = event.currentTarget as HTMLInputElement;
    if (this.ageDraft !== null && !this.disabled && input.reportValidity()) {
      this.context.runtimeConfig.patchForm(
        ["session", "maintenance", "coldStorage", "afterDays"],
        input.valueAsNumber,
      );
      this.ageDraft = null;
    }
  }

  private renderInventory(status: SessionsStorageStatusResult) {
    const totals = status.agents.reduce(
      (sum, agent) => ({
        transcripts: sum.transcripts + agent.hotTranscripts + agent.coldTranscripts,
        cold: sum.cold + agent.coldTranscripts,
        database: sum.database + agent.databaseBytes,
        wal: sum.wal + agent.walBytes,
        archives: sum.archives + agent.archiveBytes,
        embedded: sum.embedded + agent.embeddedArchiveBytes,
      }),
      { transcripts: 0, cold: 0, database: 0, wal: 0, archives: 0, embedded: 0 },
    );
    const externalized = externalizedTranscripts(status.maintenance.externalizedTranscripts);
    return html`
      ${renderSettingsRow({
        title: t("configView.sessionStorage.transcripts"),
        description: t("configView.sessionStorage.transcriptCounts", {
          hot: String(totals.transcripts - totals.cold),
          cold: String(totals.cold),
        }),
        control: renderSettingsValue(String(totals.transcripts)),
      })}
      ${renderSettingsRow({
        title: t("configView.sessionStorage.database"),
        description: t("configView.sessionStorage.walSize", { size: storageSize(totals.wal) }),
        control: renderSettingsValue(storageSize(totals.database)),
      })}
      ${renderSettingsRow({
        title: t("configView.sessionStorage.archives"),
        control: renderSettingsValue(storageSize(totals.archives)),
      })}
      ${renderSettingsRow({
        title: t("configView.sessionStorage.embeddedArchives"),
        description: t("configView.sessionStorage.embeddedArchivesHint"),
        control: renderSettingsValue(storageSize(totals.embedded)),
      })}
      ${
        status.agents.length > 1
          ? html`<details class="settings-row settings-row--stacked">
              <summary>${t("configView.sessionStorage.byAgent")}</summary>
              ${status.agents.map((agent) =>
                renderSettingsRow({
                  title: agent.agentId,
                  description: t("configView.sessionStorage.agentCounts", {
                    hot: String(agent.hotTranscripts),
                    cold: String(agent.coldTranscripts),
                    database: storageSize(agent.databaseBytes),
                    wal: storageSize(agent.walBytes),
                    archives: storageSize(agent.archiveBytes),
                    embedded: storageSize(agent.embeddedArchiveBytes),
                  }),
                }),
              )}
            </details>`
          : nothing
      }
      ${renderSettingsRow({
        title: t("configView.sessionStorage.worker"),
        description: status.maintenance.running
          ? t("configView.sessionStorage.runningProgress", {
              archived: String(status.maintenance.archivedTranscripts),
              externalized: String(status.maintenance.externalizedTranscripts),
            })
          : status.maintenance.lastCompletedAt
            ? [
                t("configView.sessionStorage.completed", {
                  time: formatDateTimeMs(status.maintenance.lastCompletedAt),
                  count: String(status.maintenance.archivedTranscripts),
                }),
                externalized,
              ]
                .filter(Boolean)
                .join(" ")
            : t("configView.sessionStorage.notRun"),
        control: renderSettingsStatus({
          kind: status.maintenance.lastError
            ? "danger"
            : status.maintenance.running
              ? "accent"
              : "muted",
          label: t(
            status.maintenance.running
              ? "configView.sessionStorage.running"
              : status.maintenance.lastError
                ? "configView.sessionStorage.failed"
                : "configView.sessionStorage.idle",
          ),
        }),
      })}
      ${
        status.maintenance.lastError
          ? renderSettingsEmpty(html`<span role="alert">${status.maintenance.lastError}</span>`)
          : nothing
      }
    `;
  }

  override render() {
    const result = this.status.task.value;
    const status =
      this.status.task.status !== TaskStatus.ERROR && result?.isCurrent() ? result.status : null;
    const coldStorage = this.coldStorage;
    return html`
      ${renderSettingsPage(html`
        <div class="settings-stack" id=${SESSION_STORAGE_SETTINGS_TARGET_ID}>
          ${renderSettingsSection(
            {
              title: t("configView.sessionStorage.title"),
              description: t("configView.sessionStorage.description"),
              actions: html`<button
                class="btn"
                ?disabled=${!this.status.client || this.status.task.status === TaskStatus.PENDING}
                @click=${() => void this.status.task.run()}
              >
                ${t("common.refresh")}
              </button>`,
            },
            status
              ? this.renderInventory(status)
              : renderSettingsEmpty(
                  this.status.task.status === TaskStatus.ERROR
                    ? html`<span role="alert"
                        >${formatUiError(this.status.task.error)}
                        ${t("configView.sessionStorage.refreshAfterError")}</span
                      >`
                    : t(
                        this.status.client
                          ? "common.loading"
                          : this.context.gateway.snapshot.phase === "connected"
                            ? "configView.sessionStorage.adminRequired"
                            : "configView.sessionStorage.disconnected",
                      ),
                ),
          )}
          ${renderSettingsSection(
            { title: t("configView.sessionStorage.automatic") },
            html`
              ${renderSettingsToggleRow({
                title: t("configView.sessionStorage.enabled"),
                description: t("configView.sessionStorage.enabledHint"),
                checked: coldStorage.enabled,
                disabled: this.disabled,
                onChange: (enabled) => {
                  if (!this.disabled) {
                    this.context.runtimeConfig.patchForm(
                      ["session", "maintenance", "coldStorage", "enabled"],
                      enabled,
                    );
                  }
                },
              })}
              ${renderSettingsRow({
                title: t("configView.sessionStorage.afterDays"),
                description: t("configView.sessionStorage.afterDaysHint"),
                control: html`<input
                  type="number"
                  class="settings-input"
                  aria-label=${t("configView.sessionStorage.afterDays")}
                  min="1"
                  max=${Number.MAX_SAFE_INTEGER}
                  step="1"
                  required
                  ?disabled=${this.disabled}
                  .value=${live(this.ageDraft ?? String(coldStorage.afterDays))}
                  @input=${(event: Event) => {
                    // SAFETY: This handler is bound directly to the native number input.
                    this.ageDraft = (event.currentTarget as HTMLInputElement).value;
                  }}
                  @change=${(event: Event) => this.setAge(event)}
                  @blur=${() => {
                    if (this.ageDraft === String(coldStorage.afterDays)) {
                      this.ageDraft = null;
                    }
                  }}
                />`,
              })}
              ${renderSettingsRow({
                title: t("configView.sessionStorage.runNow"),
                description: t("configView.sessionStorage.runHint"),
                control: html`<button
                  class="btn"
                  ?disabled=${!this.canRun}
                  @click=${() => void this.runNow()}
                >
                  ${t(
                    this.runOperation !== null || status?.maintenance.running
                      ? "configView.sessionStorage.running"
                      : "configView.sessionStorage.runNow",
                  )}
                </button>`,
              })}
              ${
                this.runError && this.runError !== status?.maintenance.lastError
                  ? renderSettingsEmpty(html`<span role="alert">${this.runError}</span>`)
                  : this.runOutcome
                    ? renderSettingsEmpty(html`<span role="status">${this.runOutcome}</span>`)
                    : nothing
              }
            `,
          )}
          <p class="settings-page__intro">${t("configView.sessionStorage.backupHint")}</p>
          ${renderLearnMoreLink("https://docs.openclaw.ai/gateway/config-agents/sessions#cold-storage")}
        </div>
      `)}
      <details
        class="settings-page"
        ?open=${this.advancedExpanded}
        ${shellLayoutTraits({ settingsPage: true })}
      >
        <summary class="settings-section__heading">
          ${t("configView.sessionStorage.advanced")}
        </summary>
        ${this.editor}
      </details>
    `;
  }
}

if (!customElements.get("openclaw-session-storage-settings")) {
  customElements.define("openclaw-session-storage-settings", SessionStorageSettings);
}
