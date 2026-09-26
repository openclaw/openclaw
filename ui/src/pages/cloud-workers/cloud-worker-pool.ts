import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type {
  EnvironmentSummary,
  EnvironmentsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import {
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsSummary,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatDurationHuman } from "../../lib/format-duration.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";

registerSettingsEnglish();

type PoolState = "ready" | "preparing" | "releasing" | "attention";
type Preparation = NonNullable<EnvironmentSummary["preparation"]>;
type PreparedEnvironment = EnvironmentSummary & {
  preparation: Preparation & { details: NonNullable<Preparation["details"]> };
  worker: NonNullable<EnvironmentSummary["worker"]>;
};

function poolState(environment: PreparedEnvironment, now: number): PoolState {
  const worker = environment.worker;
  if (environment.status === "error") {
    return "attention";
  }
  if (worker.destroyRequestedAtMs !== undefined || environment.status === "stopping") {
    return "releasing";
  }
  if (environment.preparation.details.expiresAtMs <= now || environment.status === "unavailable") {
    return "attention";
  }
  if (worker.state === "ready") {
    return "ready";
  }
  return environment.status === "starting" ? "preparing" : "attention";
}

class CloudWorkerPool extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private result: EnvironmentsListResult | null = null;
  @state() private error: string | null = null;
  @state() private loading = false;
  @state() private updatedAt: number | null = null;
  private request: AbortController | undefined;
  private readonly polling = new PollController(
    this,
    10_000,
    () => void this.load(),
    false,
    "visible",
  );

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => {
      this.request?.abort();
      this.request = undefined;
      this.polling.stop();
      this.result = null;
      this.error = null;
      this.loading = false;
      this.updatedAt = null;
    },
    ensureInitialData: () => {
      if (this.canRead()) {
        this.polling.start();
        void this.load();
      }
    },
    onPageActivation: () => void this.load(),
  });

  private canRead() {
    return canCallGatewayMethod(this.gateway.snapshot, "environments.list", "operator.admin");
  }

  private async load() {
    const scope = this.gateway.capture();
    if (!scope || !this.canRead() || this.loading || document.visibilityState === "hidden") {
      return;
    }
    const request = new AbortController();
    this.request = request;
    this.loading = true;
    try {
      const result = await scope.client.request<EnvironmentsListResult>(
        "environments.list",
        { includePreparedDetails: true },
        { signal: request.signal },
      );
      if (this.gateway.isCurrent(scope)) {
        this.result = result;
        this.error = null;
        this.updatedAt = Date.now();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.loading = false;
        this.request = undefined;
      }
    }
  }

  private renderWorker(environment: PreparedEnvironment, now: number) {
    const { worker, preparation } = environment;
    const { details } = preparation;
    const category = poolState(environment, now);
    const expired = details.expiresAtMs <= now;
    const label =
      category === "releasing"
        ? t("cloudWorkersPage.pool.releasing")
        : worker.state === "failed" || worker.state === "orphaned"
          ? t(`cloudWorkersPage.snapshots.buildStates.${worker.state}`)
          : expired
            ? t("cloudWorkersPage.pool.expired")
            : category === "attention"
              ? t("cloudWorkersPage.pool.unavailable")
              : t(`cloudWorkersPage.pool.${category}`);
    return renderSettingsRow({
      title: details.project?.label ?? t("cloudWorkersPage.pool.unknownProject"),
      description: html`
        ${
          details.project?.baseCommit
            ? html`<code>${details.project.baseCommit.slice(0, 8)}</code> · `
            : nothing
        }
        ${t(`cloudWorkersPage.pool.${preparation.purpose}`)} ·
        ${t("cloudWorkersPage.pool.age", { age: formatDurationHuman(worker.ageMs) })}
        <br />
        <time datetime=${new Date(details.expiresAtMs).toISOString()}>
          ${t(expired ? "cloudWorkersPage.pool.expiredAt" : "cloudWorkersPage.pool.expiresAt", {
            time: formatRelativeTimestamp(details.expiresAtMs),
          })}
        </time>
        ${worker.error ? html`<br /><span>${worker.error}</span>` : nothing}
      `,
      stackedOnNarrow: true,
      control: renderSettingsStatus({
        kind: category === "ready" ? "ok" : category === "attention" ? "warn" : "accent",
        label,
      }),
    });
  }

  override render() {
    if (!this.gateway.connected) {
      return renderSettingsPage(renderSettingsEmpty(t("cloudWorkersPage.pool.offline")));
    }
    if (!this.canRead()) {
      return renderSettingsPage(renderSettingsEmpty(t("cloudWorkersPage.pool.adminRequired")));
    }
    const now = Date.now();
    const pool = this.result?.preparedPool;
    const reserved = new Set(pool?.reservedEnvironmentIds);
    const rows = (this.result?.environments ?? []).filter(
      (environment): environment is PreparedEnvironment =>
        environment.preparation?.details !== undefined &&
        environment.worker !== undefined &&
        environment.worker.state !== "destroyed" &&
        (reserved.has(environment.id) ||
          (environment.preparation.details.consumedAtMs === null &&
            environment.worker.attachedSessionIds.length === 0)),
    );
    const groups = new Map<string, PreparedEnvironment[]>();
    for (const row of rows) {
      const profileId = row.worker.profileId ?? "";
      const group = groups.get(profileId) ?? [];
      group.push(row);
      groups.set(profileId, group);
    }
    return renderSettingsPage(html`
      ${renderSettingsSection(
        {
          title: t("cloudWorkersPage.pool.title"),
          description: t("cloudWorkersPage.pool.description"),
          actions: html`<button
            class="btn btn--sm"
            type="button"
            ?disabled=${this.loading}
            @click=${() => void this.load()}
          >
            ${t("common.refresh")}
          </button>`,
          notice: this.error
            ? html`<div class="callout warning" role="alert">
                ${t("cloudWorkersPage.pool.refreshFailed", { error: this.error })}
                ${
                  this.updatedAt !== null
                    ? t("cloudWorkersPage.pool.lastUpdated", {
                        time: formatRelativeTimestamp(this.updatedAt),
                      })
                    : nothing
                }
              </div>`
            : nothing,
        },
        renderSettingsRow({
          title: pool
            ? pool.maxTotal === 0
              ? t("cloudWorkersPage.pool.disabledCapacity", { count: String(reserved.size) })
              : t("cloudWorkersPage.pool.capacity", {
                  used: String(reserved.size),
                  limit: String(pool.maxTotal),
                })
            : t(this.loading ? "common.loading" : "cloudWorkersPage.pool.inventoryUnavailable"),
          description:
            pool?.maxTotal === 0
              ? t("cloudWorkersPage.pool.disabled")
              : t("cloudWorkersPage.pool.capacityHelp"),
        }),
      )}
      ${
        pool
          ? renderSettingsSummary(
              (["ready", "preparing", "releasing", "attention"] as const).map((category) => ({
                label: t(`cloudWorkersPage.pool.${category}`),
                value: rows.filter((row) => poolState(row, now) === category).length,
              })),
            )
          : nothing
      }
      ${[...groups]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([profileId, workers]) => {
          const profile = this.result?.profiles?.find((entry) => entry.id === profileId);
          return renderSettingsSection(
            {
              title: profileId || t("cloudWorkersPage.snapshots.unlabeledProfile"),
              description:
                profile?.readyWorkers !== undefined
                  ? t("cloudWorkersPage.pool.target", { count: String(profile.readyWorkers) })
                  : undefined,
              count: workers.length,
            },
            workers.map((worker) => this.renderWorker(worker, now)),
          );
        })}
      ${pool && rows.length === 0 ? renderSettingsEmpty(t("cloudWorkersPage.pool.empty")) : nothing}
    `);
  }
}

if (!customElements.get("openclaw-cloud-worker-pool")) {
  customElements.define("openclaw-cloud-worker-pool", CloudWorkerPool);
}
