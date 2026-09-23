import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import type {
  PluginCredentialDescriptor,
  PluginCredentialInspection,
  PluginsCredentialsInspectResult,
} from "../../../../packages/gateway-protocol/src/schema/plugin-credentials.ts";
import {
  isSecretRef,
  isValidSecretRef,
  type SecretRef,
} from "../../../../src/secrets/ref-contract.ts";
import type { ConfigNodeRenderParams } from "../../components/config-form.node.shared.ts";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { REDACTED_SENTINEL } from "../../lib/config-form-utils.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import "./credential-editor.css";

registerPluginManagementEnglish();
const credentialSources = ["env", "file", "exec", "store"] as const;

export type PluginCredentialEditorContext = {
  pluginId: string;
  baseHash: string | null;
  gateway: GatewayPageController;
  canInspect: boolean;
  saveError?: string | null;
  /** Adapter awaits the owning config write or protected credential operation. */
  onCommit: (
    path: Array<string | number>,
    value: unknown,
  ) => Promise<boolean | { saved: true; warning?: string }>;
  onDiscard: () => Promise<boolean>;
};
type CredentialField = Pick<ConfigNodeRenderParams, "path" | "value" | "disabled" | "onPatch"> & {
  descriptionId?: string;
};

export class PluginCredentialEditor extends OpenClawLightDomElement {
  @property({ attribute: false }) field!: CredentialField;
  @property({ attribute: false }) descriptor!: PluginCredentialDescriptor;
  @property({ attribute: false }) context!: PluginCredentialEditorContext;
  @state() private inspection: PluginCredentialInspection | null = null;
  @state() private loading = false;
  @state() private error = "";
  @state() private warning = "";
  @state() private dialogOpen = false;
  @state() private reference: SecretRef = { source: "env", provider: "default", id: "" };
  @state() private literal = "";
  @state() private revealed = false;
  @state() private saving = false;
  @state() private cancelling = false;
  private referenceSubmitted = false;
  private generation = 0;
  private identity = "";
  private fieldIdentity = "";
  private binding: GatewayPageController | undefined;
  private connection: GatewayConnectionScope | null = null;

  override willUpdate(_changed: PropertyValues<this>) {
    if (!this.context || !this.field || !this.descriptor) {
      return;
    }
    const identity = JSON.stringify([
      this.context.pluginId,
      this.field.path,
      this.context.baseHash,
      this.context.gateway.epoch,
      this.context.canInspect,
    ]);
    if (identity === this.identity && this.binding === this.context.gateway) {
      return;
    }
    const fieldIdentity = JSON.stringify([this.context.pluginId, this.field.path]);
    const sourceChanged =
      this.binding !== this.context.gateway ||
      this.fieldIdentity !== fieldIdentity ||
      !this.context.canInspect ||
      (this.connection && !this.context.gateway.isCurrent(this.connection));
    const wasOpen = this.dialogOpen;
    this.identity = identity;
    this.fieldIdentity = fieldIdentity;
    this.binding = this.context.gateway;
    this.revealed = false;
    // Other settings can advance the revision before this field's blur commit.
    // Only retiring the field or connection may discard its uncommitted key.
    if (sourceChanged) {
      this.warning = "";
      this.literal = "";
      this.dialogOpen = false;
      this.saving = false;
      this.cancelling = false;
      this.referenceSubmitted = false;
      this.reference = { source: "env", provider: "default", id: "" };
    }
    this.inspection = null;
    this.generation++;
    if (wasOpen && !this.saving && !sourceChanged) {
      this.error = t("pluginsPage.credentials.stale");
      this.loading = false;
      return;
    }
    void this.inspect();
  }

  override disconnectedCallback() {
    this.generation++;
    this.inspection = null;
    this.revealed = false;
    this.literal = "";
    this.reference = { source: "env", provider: "default", id: "" };
    this.referenceSubmitted = false;
    this.warning = "";
    super.disconnectedCallback();
  }

  private async inspect(reveal = false) {
    const { gateway, pluginId, baseHash, canInspect } = this.context;
    const connection = gateway.capture();
    const generation = ++this.generation;
    this.connection = connection;
    this.error = "";
    this.loading = false;
    if (!canInspect || !connection || !baseHash) {
      return;
    }
    this.loading = true;
    try {
      const result = await connection.client.request<PluginsCredentialsInspectResult>(
        "plugins.credentials.inspect",
        { pluginId, path: this.field.path, baseHash, ...(reveal ? { reveal: true } : {}) },
      );
      if (generation !== this.generation || !gateway.isCurrent(connection)) {
        return;
      }
      if (result.baseHash !== this.context.baseHash) {
        this.error = t("pluginsPage.credentials.stale");
        return;
      }
      this.inspection =
        result.credential.kind === "literal" && !reveal ? { kind: "literal" } : result.credential;
      this.revealed =
        reveal && result.credential.kind === "literal" && result.credential.value !== undefined;
      if (this.dialogOpen && result.credential.kind === "reference") {
        this.reference = { ...result.credential.ref };
      }
    } catch (error) {
      if (generation === this.generation && gateway.isCurrent(connection)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (generation === this.generation && gateway.isCurrent(connection)) {
        this.loading = false;
      }
    }
  }

  private toggleReveal() {
    if (this.revealed) {
      this.revealed = false;
      if (this.inspection?.kind === "literal") {
        this.inspection = { kind: "literal" };
      }
    } else if (this.literal) {
      this.revealed = true;
    } else {
      void this.inspect(true);
    }
  }

  private openReference() {
    this.referenceSubmitted = false;
    const value = this.inspection;
    if (value?.kind === "reference") {
      this.reference = { ...value.ref };
    } else {
      this.reference = { source: "env", provider: "default", id: "" };
    }
    this.dialogOpen = true;
  }

  private async patch(value: string | SecretRef) {
    if (
      this.field.disabled ||
      this.saving ||
      !this.context.canInspect ||
      !this.connection ||
      !this.context.gateway.isCurrent(this.connection)
    ) {
      return;
    }
    const gateway = this.context.gateway;
    const connection = this.connection;
    const owner = JSON.stringify([this.context.pluginId, this.field.path]);
    const current = () =>
      this.isConnected &&
      this.context.gateway === gateway &&
      gateway.isCurrent(connection) &&
      JSON.stringify([this.context.pluginId, this.field.path]) === owner;
    this.saving = true;
    this.referenceSubmitted ||= this.dialogOpen;
    this.error = "";
    this.warning = "";
    try {
      const acknowledged = await this.context.onCommit(this.field.path, value);
      if (!current()) {
        return;
      }
      if (typeof acknowledged === "boolean" ? acknowledged : acknowledged.saved) {
        this.referenceSubmitted = false;
        this.dialogOpen = false;
        this.literal = "";
        await this.inspect();
        if (current() && typeof acknowledged !== "boolean") {
          this.warning = acknowledged.warning ?? "";
        }
      } else {
        this.error = this.context.saveError || t("pluginsPage.credentials.saveFailed");
      }
    } catch (error) {
      if (current()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (current()) {
        this.saving = false;
      }
    }
  }

  private async cancelReference() {
    if (this.saving || this.cancelling) {
      return;
    }
    if (!this.referenceSubmitted) {
      this.dialogOpen = false;
      return;
    }
    const gateway = this.context.gateway;
    const connection = this.connection;
    const owner = this.fieldIdentity;
    const current = () =>
      this.isConnected &&
      this.context.gateway === gateway &&
      connection !== null &&
      gateway.isCurrent(connection) &&
      this.fieldIdentity === owner;
    this.cancelling = true;
    try {
      const discarded = await this.context.onDiscard();
      if (!current()) {
        return;
      }
      if (discarded) {
        this.referenceSubmitted = false;
        this.dialogOpen = false;
        await this.inspect();
      } else {
        this.error = this.context.saveError || t("configView.discardUnconfirmed");
      }
    } catch (error) {
      if (current()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (current()) {
        this.cancelling = false;
      }
    }
  }

  private renderDialog() {
    if (!this.dialogOpen) {
      return nothing;
    }
    const environment = this.inspection?.kind === "environment" ? this.inspection.envVar : null;
    const blocked =
      this.field.disabled || this.loading || this.saving || this.cancelling || !this.inspection;
    const failure = this.error || this.context.saveError;
    return html`<openclaw-modal-dialog
      .label=${`${t("pluginsPage.credentials.referenceTitle")}: ${this.descriptor.label}`}
      @modal-cancel=${(event: Event) => {
        event.preventDefault();
        void this.cancelReference();
      }}
    >
      <section class="plugin-credential__dialog">
        <h2>${t("pluginsPage.credentials.referenceTitle")}</h2>
        ${
          environment
            ? html`<p>${t("pluginsPage.credentials.environmentHelp", { name: environment })}</p>`
            : html`
                <p>${t("pluginsPage.credentials.referenceHelp")}</p>
                <label
                  >${t("pluginsPage.credentials.source")}<select
                    autofocus
                    class="settings-input"
                    aria-label=${t("pluginsPage.credentials.source")}
                    .value=${this.reference.source}
                    ?disabled=${blocked}
                    @change=${(event: Event) => {
                      if (event.currentTarget instanceof HTMLSelectElement) {
                        const value = event.currentTarget.value;
                        const source = credentialSources.find((entry) => entry === value);
                        if (source) {
                          this.reference = { ...this.reference, source };
                        }
                      }
                    }}
                  >
                    ${credentialSources.map((source) => html`<option value=${source} ?selected=${source === this.reference.source}>${t(`pluginsPage.credentials.sources.${source}`)}</option>`)}
                  </select></label
                >
                <label
                  >${t("pluginsPage.credentials.provider")}<input
                    class="settings-input"
                    .value=${this.reference.provider}
                    ?disabled=${blocked}
                    @input=${(event: Event) => {
                      if (event.currentTarget instanceof HTMLInputElement) {
                        this.reference = { ...this.reference, provider: event.currentTarget.value };
                      }
                    }}
                /></label>
                <label
                  >${t("pluginsPage.credentials.identifier")}<input
                    class="settings-input"
                    .value=${this.reference.id}
                    ?disabled=${blocked}
                    @input=${(event: Event) => {
                      if (event.currentTarget instanceof HTMLInputElement) {
                        this.reference = { ...this.reference, id: event.currentTarget.value };
                      }
                    }}
                /></label>
                <p class="muted">${t(`pluginsPage.credentials.help.${this.reference.source}`)}</p>
                ${this.inspection?.kind === "reference" && this.inspection.unresolved ? html`<p class="callout warn">${t("pluginsPage.credentials.unresolved")}</p>` : nothing}
              `
        }
        ${failure ? html`<p role="alert" class="callout danger">${failure}</p>` : nothing}
        <footer>
          <button
            class="btn"
            ?disabled=${this.saving || this.cancelling}
            @click=${() => this.cancelReference()}
          >
            ${t("common.cancel")}
          </button>
          ${!this.inspection && !this.loading ? html`<button class="btn" @click=${() => this.inspect()}>${t("common.retry")}</button>` : nothing}
          ${environment ? nothing : html`<button class="btn primary" ?disabled=${blocked || !isValidSecretRef(this.reference)} @click=${() => this.patch({ ...this.reference })}>${this.saving ? t("common.saving") : t("common.save")}</button>`}
        </footer>
      </section>
    </openclaw-modal-dialog>`;
  }

  override render() {
    if (!this.field || !this.descriptor || !this.context) {
      return nothing;
    }
    const credential = this.inspection;
    const configured = this.field.value === REDACTED_SENTINEL || credential?.kind === "literal";
    const reference = credential?.kind === "reference" || isSecretRef(this.field.value);
    const environment = credential?.kind === "environment";
    const disabled =
      this.field.disabled ||
      this.saving ||
      !this.context.canInspect ||
      !this.context.gateway.connected ||
      !this.context.baseHash;
    return html`<div class="plugin-credential">
      ${
        reference || environment
          ? html`<div class="plugin-credential__reference">
              <span
                >${environment ? t("pluginsPage.credentials.environment", { name: credential.envVar }) : t("pluginsPage.credentials.fromSource", { source: credential?.kind === "reference" ? credential.ref.source : isSecretRef(this.field.value) ? this.field.value.source : "" })}</span
              >
              ${credential?.kind === "reference" ? html`<code>${credential.ref.id}</code>` : nothing}
              <button
                class="btn btn--sm"
                aria-label=${`${t(environment ? "pluginsPage.credentials.viewSource" : "pluginsPage.credentials.editReference")}: ${this.descriptor.label}`}
                aria-describedby=${ifDefined(this.field.descriptionId)}
                ?disabled=${this.loading || !credential || !this.context.canInspect}
                @click=${() => this.openReference()}
              >
                ${t(environment ? "pluginsPage.credentials.viewSource" : "pluginsPage.credentials.editReference")}
              </button>
            </div>`
          : html`
              <div
                class="plugin-credential__input settings-secret"
                @focusout=${(event: FocusEvent) => {
                  if (
                    event.relatedTarget instanceof Element &&
                    event.relatedTarget.closest(".plugin-credential__input") === event.currentTarget
                  ) {
                    return;
                  }
                  if (this.literal) {
                    void this.patch(this.literal);
                  }
                }}
              >
                <input
                  class="settings-input"
                  aria-label=${this.descriptor.label}
                  aria-describedby=${ifDefined(this.field.descriptionId)}
                  autocomplete="off"
                  spellcheck="false"
                  type=${this.revealed ? "text" : "password"}
                  .value=${this.literal || (this.revealed && credential?.kind === "literal" ? (credential.value ?? "") : "")}
                  placeholder=${configured ? t("pluginsPage.credentials.stored") : (this.descriptor.placeholder ?? "")}
                  ?disabled=${disabled}
                  @input=${(event: Event) => {
                    if (event.currentTarget instanceof HTMLInputElement) {
                      this.literal = event.currentTarget.value;
                    }
                  }}
                  @keydown=${(event: KeyboardEvent) => {
                    if (event.key === "Enter" && this.literal) {
                      event.preventDefault();
                      void this.patch(this.literal);
                    }
                  }}
                />
                <button
                  class="settings-secret__toggle"
                  type="button"
                  aria-label=${`${t(this.revealed ? "pluginsPage.credentials.hide" : "pluginsPage.credentials.reveal")}: ${this.descriptor.label}`}
                  aria-pressed=${this.revealed}
                  ?disabled=${disabled || this.loading || (!this.literal && credential?.kind !== "literal")}
                  @click=${() => this.toggleReveal()}
                >
                  ${this.revealed ? icons.eyeOff : icons.eye}
                </button>
              </div>
              <div class="plugin-credential__links">
                ${this.descriptor.signupUrl ? html`<a href=${this.descriptor.signupUrl} target="_blank" rel="noopener noreferrer">${t("pluginsPage.credentials.signup")}${icons.externalLink}</a>` : nothing}<button
                  class="btn btn--ghost btn--sm"
                  aria-label=${`${t("pluginsPage.credentials.useReference")}: ${this.descriptor.label}`}
                  aria-describedby=${ifDefined(this.field.descriptionId)}
                  ?disabled=${disabled || this.loading || !credential || !this.context.canInspect}
                  @click=${() => this.openReference()}
                >
                  ${t("pluginsPage.credentials.useReference")}
                </button>
              </div>
              ${configured ? html`<small>${t("pluginsPage.credentials.replace")}</small>` : nothing}
            `
      }
      ${this.loading ? html`<span role="status" class="muted">${t("common.loading")}</span>` : nothing}
      ${credential?.kind === "invalid" ? html`<span role="alert">${t("pluginsPage.credentials.invalidStored")}</span>` : nothing}
      ${this.warning ? html`<div class="callout warn" role="status">${this.warning}</div>` : nothing}
      ${!this.dialogOpen && (this.error || (!this.warning && this.context.saveError)) ? html`<div role="alert">${this.error || this.context.saveError}<button class="btn btn--sm" @click=${() => (this.literal ? this.patch(this.literal) : this.inspect())}>${t("common.retry")}</button></div>` : nothing}
      ${this.renderDialog()}
    </div>`;
  }
}
customElements.define("openclaw-plugin-credential-editor", PluginCredentialEditor);

export function renderPluginCredential(
  field: CredentialField,
  descriptor: PluginCredentialDescriptor,
  context: PluginCredentialEditorContext,
): TemplateResult {
  return html`<openclaw-plugin-credential-editor
    .field=${field}
    .descriptor=${descriptor}
    .context=${context}
  ></openclaw-plugin-credential-editor>`;
}
