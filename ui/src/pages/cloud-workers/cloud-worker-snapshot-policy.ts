import { consume } from "@lit/context";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { parseDurationMs } from "../../../../src/cli/parse-duration.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderSettingsRow, renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomContentsElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { CloudWorkerConfigSave } from "./cloud-worker-config-save.ts";

registerSettingsEnglish();

type PolicyDraft = { refreshAfter: string; retainUnused: string; keepPrevious: "0" | "1" };

class CloudWorkerSnapshotPolicy extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;
  @state() private draft: PolicyDraft | null = null;
  @state() private saved = false;

  private readonly configSave = new CloudWorkerConfigSave(this);

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => {
      this.draft = null;
      this.configSave.update({ busy: false, error: null });
      this.saved = false;
    },
  });
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.runtimeConfig,
    (runtimeConfig) => {
      void runtimeConfig.ensureLoaded();
      return runtimeConfig.subscribe(() => this.requestUpdate());
    },
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private policy(): PolicyDraft {
    let value: unknown = resolveEditableSnapshotConfig(
      this.context?.runtimeConfig.state.configSnapshot,
    );
    for (const key of ["plugins", "entries", "crabbox", "config", "warmImages"]) {
      value = isRecord(value) ? value[key] : undefined;
    }
    const policy = isRecord(value) ? value : {};
    return {
      refreshAfter: typeof policy.refreshAfter === "string" ? policy.refreshAfter : "24h",
      retainUnused: typeof policy.retainUnused === "string" ? policy.retainUnused : "14d",
      keepPrevious: policy.keepPrevious === 1 ? "1" : "0",
    };
  }

  private canSave() {
    const config = this.context?.runtimeConfig.state;
    return Boolean(
      canCallGatewayMethod(this.gateway.snapshot, "config.patch", "operator.admin") &&
      config?.configSnapshot?.hash &&
      !config.configLoading &&
      !config.configSaving &&
      !this.configSave.state.busy,
    );
  }

  private edit(patch: Partial<PolicyDraft>) {
    this.draft = { ...(this.draft ?? this.policy()), ...patch };
    this.configSave.update({ error: null });
    this.saved = false;
  }

  private async save() {
    const scope = this.gateway.capture();
    const runtimeConfig = this.context.runtimeConfig;
    if (!scope || !this.canSave()) {
      return;
    }
    const draft = this.draft ?? this.policy();
    for (const [key, minimum] of [
      ["refreshAfter", 3_600_000],
      ["retainUnused", 86_400_000],
    ] as const) {
      if (
        !/^[1-9][0-9]{0,7}(m|h|d)(?![\s\S])/.test(draft[key]) ||
        parseDurationMs(draft[key]) < minimum
      ) {
        this.configSave.update({ error: t(`cloudWorkersPage.snapshots.${key}Invalid`) });
        return;
      }
    }
    this.saved = false;
    const isCurrent = () =>
      this.gateway.isCurrent(scope) && this.context.runtimeConfig === runtimeConfig;
    await this.configSave.save(runtimeConfig, isCurrent, {
      build: () => ({
        patch: {
          plugins: {
            entries: {
              crabbox: {
                config: {
                  warmImages: {
                    refreshAfter: draft.refreshAfter,
                    retainUnused: draft.retainUnused,
                    keepPrevious: Number(draft.keepPrevious),
                  },
                },
              },
            },
          },
        },
      }),
      note: "cloud workers: update snapshot retention policy",
      canDispatch: () =>
        isCurrent() &&
        canCallGatewayMethod(this.gateway.snapshot, "config.patch", "operator.admin"),
      failed: () => t("cloudWorkersPage.snapshots.policySaveFailed"),
      success: () => {
        this.draft = null;
        this.saved = true;
      },
    });
  }

  override render() {
    const draft = this.draft ?? this.policy();
    const disabled = !this.canSave();
    return renderSettingsSection(
      {
        title: t("cloudWorkersPage.snapshots.retentionPolicy"),
        description: t("cloudWorkersPage.snapshots.retentionHelp"),
      },
      html`
        ${(["refreshAfter", "retainUnused"] as const).map((key) =>
          renderSettingsRow({
            title: t(`cloudWorkersPage.snapshots.${key}`),
            description: t(`cloudWorkersPage.snapshots.${key}Help`),
            control: html`<input
              class="settings-input"
              aria-label=${t(`cloudWorkersPage.snapshots.${key}`)}
              .value=${draft[key]}
              ?disabled=${disabled}
              @input=${(event: Event) => {
                if (event.currentTarget instanceof HTMLInputElement) {
                  this.edit({ [key]: event.currentTarget.value });
                }
              }}
            />`,
          }),
        )}
        ${renderSettingsRow({
          title: t("cloudWorkersPage.snapshots.keepPrevious"),
          control: html`<select
            class="settings-select"
            aria-label=${t("cloudWorkersPage.snapshots.keepPrevious")}
            .value=${draft.keepPrevious}
            ?disabled=${disabled}
            @change=${(event: Event) => {
              if (event.currentTarget instanceof HTMLSelectElement) {
                this.edit({ keepPrevious: event.currentTarget.value === "1" ? "1" : "0" });
              }
            }}
          >
            <option value="0" ?selected=${draft.keepPrevious === "0"}>
              ${t("cloudWorkersPage.snapshots.keepNone")}
            </option>
            <option value="1" ?selected=${draft.keepPrevious === "1"}>
              ${t("cloudWorkersPage.snapshots.keepOne")}
            </option>
          </select>`,
        })}
        ${renderSettingsRow({
          title: t("cloudWorkersPage.snapshots.policyRestart"),
          control: html`<button
            class="btn btn--sm"
            type="button"
            ?disabled=${disabled}
            @click=${() => void this.save()}
          >
            ${t("cloudWorkersPage.snapshots.savePolicy")}
          </button>`,
        })}
        ${this.configSave.state.error ? html`<div class="callout warning" role="alert">${this.configSave.state.error}</div>` : nothing}
        ${this.saved ? html`<div class="callout" role="status">${t("cloudWorkersPage.snapshots.policySaved")}</div>` : nothing}
      `,
    );
  }
}

if (!customElements.get("openclaw-cloud-worker-snapshot-policy")) {
  customElements.define("openclaw-cloud-worker-snapshot-policy", CloudWorkerSnapshotPolicy);
}
