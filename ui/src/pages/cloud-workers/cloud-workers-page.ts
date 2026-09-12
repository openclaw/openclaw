import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type { EnvironmentsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import {
  renderDocsLink,
  renderLearnMoreLink,
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsPageHeader,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsToggleRow,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { CloudWorkerConfigSave } from "./cloud-worker-config-save.ts";
import {
  buildCloudWorkerDeletePatch,
  buildCloudWorkerUpsertPatch,
  cloudWorkerProfileStatus,
  createCloudWorkerDraft,
  readCloudWorkerProfiles,
  validateCloudWorkerDraft,
  type CloudWorkerProfileDraft,
  type ConfiguredCloudWorkerProfile,
} from "./cloud-worker-config.ts";
import { renderCloudWorkerRepositories } from "./cloud-worker-repositories.ts";
import "./cloud-worker-snapshots.ts";

registerSettingsEnglish();

const CLOUD_WORKERS_DOCS_URL = "https://docs.openclaw.ai/gateway/cloud-workers";
type ProfileSummary = NonNullable<EnvironmentsListResult["profiles"]>[number];
type EditorState = { kind: "add" } | { kind: "edit"; profileId: string } | null;

function formControlValue(event: Event): string {
  const target = event.currentTarget;
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
    ? target.value
    : "";
}

class CloudWorkersPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private view: "profiles" | "snapshots" = "profiles";
  @state() private advertisedProfiles = new Map<string, ProfileSummary>();
  @state() private catalogLoaded = false;
  @state() private catalogLoading = false;
  @state() private catalogError: string | null = null;
  @state() private editor: EditorState = null;
  @state() private draft: CloudWorkerProfileDraft = createCloudWorkerDraft();

  private readonly configSave = new CloudWorkerConfigSave(this);

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.resetGatewayState(),
    onSnapshot: (change) => {
      if (change.initial) {
        this.resetGatewayState();
      }
    },
    ensureInitialData: () => void this.loadCatalog(),
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

  private resetGatewayState() {
    this.configSave.update({ busy: false });
    this.advertisedProfiles = new Map();
    this.catalogLoaded = false;
    this.catalogLoading = false;
    this.catalogError = null;
  }

  private async loadCatalog() {
    if (this.catalogLoading || this.catalogLoaded) {
      return;
    }
    const scope = this.gateway.capture();
    if (
      !scope ||
      !canCallGatewayMethod(this.gateway.snapshot, "environments.list", "operator.admin")
    ) {
      this.catalogLoaded = true;
      return;
    }
    this.catalogLoading = true;
    this.catalogError = null;
    try {
      const result = await scope.client.request<EnvironmentsListResult>("environments.list", {});
      if (!this.gateway.isCurrent(scope)) {
        return;
      }
      this.advertisedProfiles = new Map(
        (result.profiles ?? []).map((profile) => [profile.id, profile]),
      );
      this.catalogLoaded = true;
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.catalogError = formatUiError(error);
        this.catalogLoaded = true;
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.catalogLoading = false;
      }
    }
  }

  private editableConfig(): Record<string, unknown> | null {
    return resolveEditableSnapshotConfig(this.context?.runtimeConfig.state.configSnapshot);
  }

  private profiles(): ConfiguredCloudWorkerProfile[] {
    return readCloudWorkerProfiles(this.editableConfig());
  }

  private hasManageAccess(): boolean {
    return canCallGatewayMethod(this.gateway.snapshot, "config.patch", "operator.admin");
  }

  private canManage(): boolean {
    const configState = this.context?.runtimeConfig.state;
    return Boolean(
      this.hasManageAccess() &&
      configState?.configSnapshot?.hash &&
      !configState.configLoading &&
      !configState.configSaving &&
      !this.configSave.state.busy,
    );
  }

  private openAdd() {
    if (!this.canManage()) {
      return;
    }
    this.editor = { kind: "add" };
    this.draft = createCloudWorkerDraft();
    this.configSave.update({ error: null, notice: null });
  }

  private openEdit(profile: ConfiguredCloudWorkerProfile) {
    if (!this.canManage()) {
      return;
    }
    if (profile.providerId !== "crabbox" || !profile.machineClass) {
      this.context.navigate("advanced", { search: "?section=cloudWorkers" });
      return;
    }
    this.editor = { kind: "edit", profileId: profile.id };
    this.draft = createCloudWorkerDraft(profile);
    this.configSave.update({ error: null, notice: null });
  }

  private closeEditor() {
    if (this.configSave.state.busy) {
      return;
    }
    this.editor = null;
    this.configSave.update({ error: null });
  }

  private patchDraft(patch: Partial<CloudWorkerProfileDraft>) {
    this.draft = { ...this.draft, ...patch };
    this.configSave.update({ error: null });
  }

  private async saveProfile(draft: CloudWorkerProfileDraft) {
    const scope = this.gateway.capture();
    const runtimeConfig = this.context.runtimeConfig;
    const editingId = this.editor?.kind === "edit" ? this.editor.profileId : null;
    const config = this.editableConfig();
    if (!scope || !this.editor || !config || !this.canManage()) {
      return;
    }
    const currentProfiles = Object.fromEntries(
      this.profiles().map((profile) => [profile.id, true]),
    );
    const validationError = validateCloudWorkerDraft(draft, currentProfiles, editingId);
    if (validationError) {
      this.configSave.update({ error: t(`cloudWorkersPage.errors.${validationError}`) });
      return;
    }
    const profileId = editingId ?? draft.id;
    const isCurrent = () =>
      this.gateway.isCurrent(scope) && this.context.runtimeConfig === runtimeConfig;
    await this.configSave.save(runtimeConfig, isCurrent, {
      build: (base) => buildCloudWorkerUpsertPatch(base, draft, editingId),
      note: `cloud workers: ${editingId ? "update" : "add"} ${profileId}`,
      canDispatch: isCurrent,
      failed: () => t("cloudWorkersPage.errors.saveFailed"),
      success: () => {
        this.editor = null;
        return `${t("labsPage.restartRequired")} ${t("cloudWorkersPage.snapshots.buildAfterRestart")}`;
      },
    });
  }

  private async deleteProfile(profile: ConfiguredCloudWorkerProfile) {
    const gateway = this.context.gateway;
    const client = gateway.snapshot.client;
    const gatewayUrl = gateway.connection.gatewayUrl;
    const runtimeConfig = this.context.runtimeConfig;
    if (
      !this.canManage() ||
      !(await showConfirmDialog({
        title: t("cloudWorkersPage.deleteTitle"),
        message: t("cloudWorkersPage.deleteConfirm", { profile: profile.id }),
        confirmLabel: t("common.delete"),
        danger: true,
      }))
    ) {
      return;
    }
    const scope = this.gateway.capture();
    if (
      !scope ||
      scope.client !== client ||
      this.context.gateway !== gateway ||
      gateway.connection.gatewayUrl !== gatewayUrl ||
      this.context.runtimeConfig !== runtimeConfig ||
      !this.canManage()
    ) {
      this.configSave.update({ error: t("cloudWorkersPage.errors.deleteFailed") });
      return;
    }
    const isCurrent = () =>
      this.gateway.isCurrent(scope) && this.context.runtimeConfig === runtimeConfig;
    await this.configSave.save(runtimeConfig, isCurrent, {
      build: (base) => buildCloudWorkerDeletePatch(base, profile.id),
      note: `cloud workers: delete ${profile.id}`,
      canDispatch: isCurrent,
      failed: () => t("cloudWorkersPage.errors.deleteFailed"),
      success: () => {
        if (this.editor?.kind === "edit" && this.editor.profileId === profile.id) {
          this.editor = null;
        }
        return t("labsPage.restartRequired");
      },
    });
  }

  private profileDescription(profile: ConfiguredCloudWorkerProfile): string {
    if (profile.providerId !== "crabbox") {
      return t("cloudWorkersPage.providerFact", {
        provider: profile.providerId || t("common.unknown"),
      });
    }
    return [
      t("cloudWorkersPage.backendFact", { backend: profile.backend || t("common.unknown") }),
      t("cloudWorkersPage.classFact", { value: profile.machineClass || t("common.unknown") }),
      ...(profile.target && profile.target !== "linux"
        ? [
            t("cloudWorkersPage.operatingSystemFact", {
              value:
                this.advertisedProfiles
                  .get(profile.id)
                  ?.operatingSystems?.find((system) => system.id === profile.target)?.label ??
                profile.target,
            }),
          ]
        : []),
      t("cloudWorkersPage.ttlFact", { value: profile.ttl || t("common.unknown") }),
      t("cloudWorkersPage.idleFact", { value: profile.idleTimeout || t("common.unknown") }),
      t("cloudWorkersPage.desktopFact", {
        value: profile.desktop ? t("common.enabled") : t("common.disabled"),
      }),
    ].join(" · ");
  }

  private renderProfile(profile: ConfiguredCloudWorkerProfile) {
    const status = cloudWorkerProfileStatus(
      profile.id,
      this.advertisedProfiles,
      this.catalogLoaded,
    );
    const statusControl =
      status === "advertised"
        ? renderSettingsStatus({ kind: "ok", label: t("cloudWorkersPage.advertised") })
        : status === "restart-required"
          ? renderSettingsStatus({ kind: "warn", label: t("cloudWorkersPage.restartRequired") })
          : renderSettingsStatus({ kind: "muted", label: t("common.loading") });
    const canManage = this.canManage();
    return renderSettingsRow({
      title: html`<code>${profile.id}</code>`,
      description: this.profileDescription(profile),
      control: html`
        ${statusControl}
        <button
          class="btn btn--sm"
          type="button"
          ?disabled=${!canManage}
          @click=${() => this.openEdit(profile)}
        >
          ${t("cloudWorkersPage.editAction")}
        </button>
        <button
          class="btn btn--sm danger"
          type="button"
          ?disabled=${!canManage}
          @click=${() => void this.deleteProfile(profile)}
        >
          ${t("common.delete")}
        </button>
      `,
    });
  }

  private renderDraftInput(
    field:
      | "backend"
      | "machineClass"
      | "ttl"
      | "idleTimeout"
      | "binary"
      | "setupEnv"
      | "readyWorkers"
      | "suspendAfter",
    options: {
      description?: ReturnType<typeof html>;
      placeholder?: string;
      type?: "text" | "number";
    } = {},
  ) {
    return renderSettingsRow({
      title: t(`cloudWorkersPage.fields.${field}`),
      description: options.description ?? t(`cloudWorkersPage.fields.${field}Help`),
      control: html`<input
        class="settings-input mono"
        aria-label=${t(`cloudWorkersPage.fields.${field}`)}
        placeholder=${options.placeholder ?? nothing}
        type=${options.type ?? nothing}
        min=${field === "readyWorkers" ? "0" : nothing}
        step=${field === "readyWorkers" ? "1" : nothing}
        autocomplete="off"
        spellcheck="false"
        .value=${this.draft[field]}
        ?disabled=${this.configSave.state.busy}
        @input=${(event: Event) => this.patchDraft({ [field]: formControlValue(event) })}
      />`,
    });
  }

  private renderEditor() {
    if (!this.editor) {
      return nothing;
    }
    const busy = this.configSave.state.busy;
    const canSave = this.canManage();
    const editing = this.editor.kind === "edit";
    const operatingSystems = editing
      ? (this.advertisedProfiles.get(this.draft.id)?.operatingSystems ?? [])
      : [];
    const unadvertisedTarget =
      this.draft.target && !operatingSystems.some((system) => system.id === this.draft.target);
    return renderSettingsSection(
      {
        title: editing ? t("cloudWorkersPage.editProfile") : t("cloudWorkersPage.addProfile"),
      },
      [
        renderSettingsRow({
          title: t("cloudWorkersPage.fields.profileId"),
          description: t("cloudWorkersPage.fields.profileIdHelp"),
          control: editing
            ? renderSettingsValue(this.draft.id, { mono: true })
            : html`<input
                class="settings-input mono"
                aria-label=${t("cloudWorkersPage.fields.profileId")}
                autocomplete="off"
                spellcheck="false"
                .value=${this.draft.id}
                ?disabled=${busy}
                @input=${(event: Event) => this.patchDraft({ id: formControlValue(event) })}
              />`,
        }),
        this.renderDraftInput("backend", {
          description: html`${t("cloudWorkersPage.fields.backendHelp")}
          ${renderDocsLink(CLOUD_WORKERS_DOCS_URL, t("cloudWorkersPage.providerList"))}`,
          placeholder: t("cloudWorkersPage.fields.backendPlaceholder"),
        }),
        ...(operatingSystems.length >= 2 || unadvertisedTarget
          ? [
              renderSettingsRow({
                title: t("cloudWorkersPage.fields.operatingSystem"),
                description: t("cloudWorkersPage.fields.operatingSystemHelp"),
                control: html`<select
                  class="settings-select"
                  aria-label=${t("cloudWorkersPage.fields.operatingSystem")}
                  .value=${this.draft.target}
                  ?disabled=${busy}
                  @change=${(event: Event) => {
                    const target = formControlValue(event);
                    if (!operatingSystems.find((system) => system.id === target)?.disabledReason) {
                      this.patchDraft({ target });
                    }
                  }}
                >
                  <option value="" ?selected=${!this.draft.target}>
                    ${t("cloudWorkersPage.fields.providerDefault")}
                  </option>
                  ${operatingSystems.map(
                    (system) => html`
                      <option
                        value=${system.id}
                        ?selected=${this.draft.target === system.id}
                        ?disabled=${Boolean(system.disabledReason)}
                      >
                        ${system.label}${system.disabledReason ? ` — ${system.disabledReason}` : ""}
                      </option>
                    `,
                  )}
                  ${
                    unadvertisedTarget
                      ? html`
                          <option value=${this.draft.target} selected>${this.draft.target}</option>
                        `
                      : nothing
                  }
                </select>`,
              }),
            ]
          : []),
        this.renderDraftInput("machineClass"),
        this.renderDraftInput("ttl", {
          placeholder: t("cloudWorkersPage.fields.ttlPlaceholder"),
        }),
        this.renderDraftInput("idleTimeout", {
          placeholder: t("cloudWorkersPage.fields.idleTimeoutPlaceholder"),
        }),
        renderSettingsRow({
          title: t("cloudWorkersPage.fields.setup"),
          description: t("cloudWorkersPage.fields.setupHelp"),
          stacked: true,
          control: html`<textarea
            class="settings-input mono"
            aria-label=${t("cloudWorkersPage.fields.setup")}
            placeholder=${t("cloudWorkersPage.fields.setupPlaceholder")}
            autocomplete="off"
            spellcheck="false"
            .value=${this.draft.setup}
            ?disabled=${busy}
            @input=${(event: Event) => this.patchDraft({ setup: formControlValue(event) })}
          ></textarea>`,
        }),
        renderSettingsToggleRow({
          title: t("cloudWorkersPage.fields.desktop"),
          description: t("cloudWorkersPage.fields.desktopHelp"),
          checked: this.draft.desktop,
          disabled: busy,
          onChange: (desktop) => this.patchDraft({ desktop }),
        }),
        this.renderDraftInput("binary", {
          placeholder: t("cloudWorkersPage.fields.binaryPlaceholder"),
        }),
        renderSettingsSection({ title: t("cloudWorkersPage.advanced") }, [
          renderSettingsRow({
            title: t("cloudWorkersPage.fields.warmImage"),
            description: t("cloudWorkersPage.fields.warmImageHelp"),
            control: html`<select
              class="settings-select"
              aria-label=${t("cloudWorkersPage.fields.warmImage")}
              .value=${this.draft.warmImage}
              ?disabled=${busy}
              @change=${(event: Event) => {
                const value = formControlValue(event);
                if (value === "auto" || value === "on" || value === "off") {
                  this.patchDraft({ warmImage: value });
                }
              }}
            >
              ${(["auto", "on", "off"] as const).map(
                (value) => html`
                  <option value=${value} ?selected=${this.draft.warmImage === value}>
                    ${t(`cloudWorkersPage.warmImage.${value}`)}
                  </option>
                `,
              )}
            </select>`,
          }),
          ...(["setupEnv", "readyWorkers", "suspendAfter"] as const).map((field) =>
            this.renderDraftInput(field, { type: field === "readyWorkers" ? "number" : "text" }),
          ),
        ]),
        ...(this.configSave.state.error
          ? [
              renderSettingsRow({
                title: t("cloudWorkersPage.errors.title"),
                description: html`<span role="alert">${this.configSave.state.error}</span>`,
              }),
            ]
          : []),
        renderSettingsRow({
          title: t("cloudWorkersPage.fields.actions"),
          description: t("cloudWorkersPage.fields.actionsHelp"),
          control: html`
            <button
              class="btn primary"
              type="button"
              ?disabled=${!canSave}
              @click=${() => void this.saveProfile(this.draft)}
            >
              ${busy ? t("common.saving") : t("common.save")}
            </button>
            <button class="btn" type="button" ?disabled=${busy} @click=${() => this.closeEditor()}>
              ${t("common.cancel")}
            </button>
          `,
        }),
      ],
    );
  }

  override render() {
    const profiles = this.profiles();
    const canManage = this.canManage();
    const addAction = canManage
      ? html`<button class="btn btn--sm primary" type="button" @click=${() => this.openAdd()}>
          ${t("cloudWorkersPage.addProfile")}
        </button>`
      : undefined;
    const rows = profiles.length
      ? profiles.map((profile) => this.renderProfile(profile))
      : renderSettingsEmpty(t("cloudWorkersPage.empty"));
    const body = renderSettingsPage(html`
      ${
        !this.hasManageAccess()
          ? html`<div class="callout warning" role="note">
              ${t("cloudWorkersPage.adminRequired")}
            </div>`
          : nothing
      }
      ${
        this.catalogError
          ? html`<div class="callout warning" role="status">
              ${t("cloudWorkersPage.catalogFailed", { error: this.catalogError })}
            </div>`
          : nothing
      }
      ${
        this.configSave.state.error && !this.editor
          ? html`<div class="callout warning" role="alert">${this.configSave.state.error}</div>`
          : nothing
      }
      ${
        this.configSave.state.notice
          ? html`<div class="callout warning" role="status">${this.configSave.state.notice}</div>`
          : nothing
      }
      ${renderSettingsSection(
        {
          title: t("cloudWorkersPage.sectionTitle"),
          description: t("cloudWorkersPage.sectionDescription"),
          actions: addAction,
          count: profiles.length,
        },
        rows,
      )}
      ${this.renderEditor()} ${renderCloudWorkerRepositories(canManage)}
    `);
    return html`
      ${renderSettingsPageHeader({
        title: titleForRoute("cloud-workers"),
        subtitle: html`${t("cloudWorkersPage.intro")} ${renderLearnMoreLink(CLOUD_WORKERS_DOCS_URL)}`,
      })}
      ${renderSettingsWorkspace(html`
        ${renderSettingsPage(
          renderSettingsSegmented({
            mode: "buttons",
            value: this.view,
            ariaLabel: t("cloudWorkersPage.snapshots.viewLabel"),
            options: [
              { value: "profiles", label: t("cloudWorkersPage.sectionTitle") },
              { value: "snapshots", label: t("cloudWorkersPage.snapshots.title") },
            ],
            onChange: (value) => {
              this.view = value;
            },
          }),
        )}
        ${this.view === "profiles" ? body : html`<openclaw-cloud-worker-snapshots></openclaw-cloud-worker-snapshots>`}
      `)}
    `;
  }
}

if (!customElements.get("openclaw-cloud-workers-page")) {
  customElements.define("openclaw-cloud-workers-page", CloudWorkersPage);
}
