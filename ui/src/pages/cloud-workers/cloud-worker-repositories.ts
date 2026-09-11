import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomContentsElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { CloudWorkerConfigSave } from "./cloud-worker-config-save.ts";
import { readCloudWorkerProfiles } from "./cloud-worker-config.ts";
import {
  buildCloudWorkerPreparedPoolPatch,
  buildCloudWorkerRepositoryDeletePatch,
  buildCloudWorkerRepositoryUpsertPatch,
  readCloudWorkerPreparedPool,
  readCloudWorkerRepositories,
  type CloudWorkerRepository,
  type CloudWorkerRepositoryPatch,
} from "./cloud-worker-repositories-config.ts";

registerSettingsEnglish();

class CloudWorkerRepositories extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ type: Boolean }) canManage = false;
  @state() private editor: {
    original: CloudWorkerRepository | null;
    draft: CloudWorkerRepository;
  } | null = null;
  @state() private poolDraft: string | null = null;

  private readonly configSave = new CloudWorkerConfigSave(this);

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => {
      this.editor = null;
      this.poolDraft = null;
      this.configSave.update({ busy: false, error: null, notice: null });
    },
  });
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.runtimeConfig,
    (runtimeConfig) => runtimeConfig.subscribe(() => this.requestUpdate()),
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private config() {
    return resolveEditableSnapshotConfig(this.context?.runtimeConfig.state.configSnapshot);
  }

  private editable() {
    return this.canManage && !this.configSave.state.busy;
  }

  private async save(
    build: (config: Readonly<Record<string, unknown>>) => CloudWorkerRepositoryPatch,
  ): Promise<boolean> {
    const scope = this.gateway.capture();
    const runtimeConfig = this.context.runtimeConfig;
    if (!scope || !this.editable()) {
      return false;
    }
    const isCurrent = () =>
      this.gateway.isCurrent(scope) && this.context.runtimeConfig === runtimeConfig;
    return this.configSave.save(runtimeConfig, isCurrent, {
      build,
      note: "cloud workers: update repository defaults or prepared pool",
      canDispatch: () =>
        isCurrent() &&
        canCallGatewayMethod(this.gateway.snapshot, "config.patch", "operator.admin"),
      failed: () => t("cloudWorkersPage.errors.settingsSaveFailed"),
      success: () => t("labsPage.restartRequired"),
    });
  }

  private openEditor(mapping?: CloudWorkerRepository) {
    if (!this.editable()) {
      return;
    }
    this.editor = {
      original: mapping ?? null,
      draft: mapping ?? {
        repository: "",
        profileId: readCloudWorkerProfiles(this.config())[0]?.id ?? "",
      },
    };
    this.configSave.update({ error: null, notice: null });
  }

  private changeDraft(patch: Partial<CloudWorkerRepository>) {
    if (this.editor) {
      this.editor = { ...this.editor, draft: { ...this.editor.draft, ...patch } };
      this.configSave.update({ error: null });
    }
  }

  private async saveRepository() {
    const editor = this.editor;
    if (
      editor &&
      (await this.save((base) =>
        buildCloudWorkerRepositoryUpsertPatch(base, editor.draft, editor.original),
      ))
    ) {
      this.editor = null;
    }
  }

  private async savePool() {
    const value = this.poolDraft ?? readCloudWorkerPreparedPool(this.config());
    if (await this.save(() => buildCloudWorkerPreparedPoolPatch(value))) {
      this.poolDraft = null;
    }
  }

  private renderEditor() {
    if (!this.editor) {
      return nothing;
    }
    const draft = this.editor.draft;
    const profiles = readCloudWorkerProfiles(this.config());
    const missingProfile = !profiles.some((profile) => profile.id === draft.profileId);
    return renderSettingsSection(
      {
        title: t(
          this.editor.original === null
            ? "cloudWorkersPage.addRepository"
            : "cloudWorkersPage.editRepository",
        ),
      },
      [
        renderSettingsRow({
          title: t("cloudWorkersPage.repositoryIdentity"),
          description: t("cloudWorkersPage.repositoryIdentityHelp"),
          control: html`<input
            class="settings-input mono"
            aria-label=${t("cloudWorkersPage.repositoryIdentity")}
            autocomplete="off"
            spellcheck="false"
            .value=${draft.repository}
            ?disabled=${!this.editable()}
            @input=${(event: Event) => {
              if (event.currentTarget instanceof HTMLInputElement) {
                this.changeDraft({ repository: event.currentTarget.value });
              }
            }}
          />`,
        }),
        renderSettingsRow({
          title: t("cloudWorkersPage.repositoryProfile"),
          control: html`<select
            class="settings-select"
            aria-label=${t("cloudWorkersPage.repositoryProfile")}
            .value=${draft.profileId}
            ?disabled=${!this.editable()}
            @change=${(event: Event) => {
              if (event.currentTarget instanceof HTMLSelectElement) {
                this.changeDraft({ profileId: event.currentTarget.value });
              }
            }}
          >
            ${missingProfile ? html`<option value=${draft.profileId} selected>${draft.profileId || t("cloudWorkersPage.selectProfile")}</option>` : nothing}
            ${profiles.map((profile) => html`<option value=${profile.id} ?selected=${draft.profileId === profile.id}>${profile.id}</option>`)}
          </select>`,
        }),
        missingProfile
          ? html`<div class="callout warning" role="alert">
              ${t("cloudWorkersPage.errors.repositoryProfile")}
            </div>`
          : nothing,
        renderSettingsRow({
          title: t("cloudWorkersPage.saveRepository"),
          control: html` <button
              class="btn btn--sm"
              type="button"
              ?disabled=${this.configSave.state.busy}
              @click=${() => {
                this.editor = null;
                this.configSave.update({ error: null });
              }}
            >
              ${t("common.cancel")}
            </button>
            <button
              class="btn btn--sm primary"
              type="button"
              ?disabled=${!this.editable()}
              @click=${() => void this.saveRepository()}
            >
              ${t("cloudWorkersPage.saveRepository")}
            </button>`,
        }),
      ],
    );
  }

  override render() {
    const config = this.config();
    const repositories = readCloudWorkerRepositories(config);
    const editable = this.editable();
    return html`
      ${renderSettingsSection(
        {},
        renderSettingsRow({
          title: t("cloudWorkersPage.preparedPool"),
          description: t("cloudWorkersPage.preparedPoolHelp"),
          control: html`<input
              class="settings-input"
              type="number"
              min="0"
              step="1"
              aria-label=${t("cloudWorkersPage.preparedPool")}
              .value=${this.poolDraft ?? readCloudWorkerPreparedPool(config)}
              ?disabled=${!editable}
              @input=${(event: Event) => {
                if (event.currentTarget instanceof HTMLInputElement) {
                  this.poolDraft = event.currentTarget.value;
                  this.configSave.update({ error: null });
                }
              }}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void this.savePool();
                }
              }}
            />
            <button
              class="btn btn--sm"
              type="button"
              ?disabled=${!editable}
              @click=${() => void this.savePool()}
            >
              ${t("cloudWorkersPage.savePool")}
            </button>`,
        }),
      )}
      ${renderSettingsSection(
        {
          title: t("cloudWorkersPage.repositories"),
          description: t("cloudWorkersPage.repositoriesHelp"),
          count: repositories.length,
          actions: html`<button
            class="btn btn--sm primary"
            type="button"
            ?disabled=${!editable}
            @click=${() => this.openEditor()}
          >
            ${t("cloudWorkersPage.addRepository")}
          </button>`,
        },
        repositories.length
          ? repositories.map((mapping) =>
              renderSettingsRow({
                title: html`<code>${mapping.repository}</code>`,
                description: mapping.profileId,
                control: html` <button
                    class="btn btn--sm"
                    type="button"
                    ?disabled=${!editable}
                    @click=${() => this.openEditor(mapping)}
                  >
                    ${t("cloudWorkersPage.editAction")}
                  </button>
                  <button
                    class="btn btn--sm danger"
                    type="button"
                    ?disabled=${!editable}
                    @click=${() => void this.save((base) => buildCloudWorkerRepositoryDeletePatch(base, mapping))}
                  >
                    ${t("common.delete")}
                  </button>`,
              }),
            )
          : renderSettingsEmpty(t("cloudWorkersPage.repositoriesEmpty")),
      )}
      ${this.renderEditor()}
      ${this.configSave.state.error ? html`<div class="callout warning" role="alert">${this.configSave.state.error}</div>` : nothing}
      ${this.configSave.state.notice ? html`<div class="callout warning" role="status">${this.configSave.state.notice}</div>` : nothing}
    `;
  }
}

if (!customElements.get("openclaw-cloud-worker-repositories")) {
  customElements.define("openclaw-cloud-worker-repositories", CloudWorkerRepositories);
}

export function renderCloudWorkerRepositories(canManage: boolean) {
  return html`<openclaw-cloud-worker-repositories
    .canManage=${canManage}
  ></openclaw-cloud-worker-repositories>`;
}
