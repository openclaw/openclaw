import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type {
  UsersPersonalFileGetResult,
  UsersPersonalFileSetResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { renderSettingsEmpty, renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerPersonalInstructionsEnglish } from "../../i18n/locales/en-personal-instructions.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";

registerPersonalInstructionsEnglish();

export class PersonalInstructions extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;

  @state() private agentId = "";
  @state() private file: UsersPersonalFileGetResult | null = null;
  @state() private draft = "";
  @state() private busy: "load" | "save" | null = null;
  @state() private error: string | null = null;
  @state() private saved = false;
  private client: GatewayBrowserClient | null = null;
  private profileId: string | null = null;
  private connectionId: string | null = null;
  private gatewayUrl: string | null = null;
  private available = false;
  private multipleProfiles = false;
  private generation = 0;
  private subscriptions: Array<() => void> = [];
  private drafts = new Map<string, { file: UsersPersonalFileGetResult; content: string }>();

  override connectedCallback() {
    super.connectedCallback();
    this.subscriptions = [
      this.context.gateway.subscribe(() => this.syncContext()),
      this.context.agents.subscribe(() => this.syncContext()),
      this.context.settingsAgentSelection.subscribe(() => this.syncContext()),
    ];
    this.syncContext();
    void this.context.agents.ensureList();
  }

  override disconnectedCallback() {
    this.subscriptions.forEach((unsubscribe) => unsubscribe());
    this.subscriptions = [];
    this.generation += 1;
    this.client = null;
    this.available = false;
    super.disconnectedCallback();
  }

  private get agents() {
    return this.context.agents.state?.agentsList?.agents ?? [];
  }

  private get dirty() {
    return this.file !== null && this.draft !== this.file.content;
  }

  private syncContext() {
    const snapshot = this.context.gateway.snapshot;
    const connected = snapshot.phase === "connected";
    // Hello can arrive before profile resolution. Keep the draft private until
    // identity is known, then restore it only for the same person and Gateway.
    // A reconnect keeps the old hash so concurrent edits still conflict.
    const profileId = snapshot.selfUser?.id ?? this.profileId;
    const gatewayUrl = this.context.gateway.connection.gatewayUrl;
    const connectionId = snapshot.hello?.server?.connId ?? null;
    this.multipleProfiles = snapshot.hello?.policy?.hasMultipleSessionSharingIdentities === true;
    const available =
      connected &&
      this.multipleProfiles &&
      Boolean(snapshot.selfUser?.id) &&
      hasOperatorReadAccess(snapshot.hello?.auth ?? null);
    const identityChanged = profileId !== this.profileId || gatewayUrl !== this.gatewayUrl;
    const sourceChanged =
      identityChanged ||
      snapshot.client !== this.client ||
      connectionId !== this.connectionId ||
      available !== this.available;
    if (sourceChanged) {
      this.generation += 1;
      this.client = snapshot.client;
      this.connectionId = connectionId;
      this.gatewayUrl = gatewayUrl;
      this.profileId = profileId;
      this.available = available;
      this.busy = null;
      this.error = null;
      this.saved = false;
      if (identityChanged) {
        this.file = null;
        this.draft = "";
        this.agentId = "";
        this.drafts.clear();
      }
    }
    // Settings owns the target. Keep unsaved drafts scoped to this person,
    // Gateway and agent rather than blocking or reverting the global selector.
    const selectedId = this.context.settingsAgentSelection.state.selectedId;
    const nextAgentId = this.agents.some((agent) => agent.id === selectedId) ? selectedId! : "";
    const agentChanged = nextAgentId !== this.agentId;
    if (agentChanged) {
      if (this.dirty && this.file) {
        this.drafts.set(this.agentId, { file: this.file, content: this.draft });
      } else {
        this.drafts.delete(this.agentId);
      }
      this.generation += 1;
      this.busy = null;
      this.error = null;
      this.saved = false;
      this.agentId = nextAgentId;
      const pending = this.drafts.get(nextAgentId);
      this.drafts.delete(nextAgentId);
      this.file = pending?.file ?? null;
      this.draft = pending?.content ?? "";
    }
    if (this.available && this.agentId && !this.dirty && (sourceChanged || agentChanged)) {
      void this.load();
    }
    this.requestUpdate();
  }

  private async load() {
    const client = this.client;
    const agentId = this.agentId;
    const profileId = this.profileId;
    if (!client || !this.available || !agentId || this.busy) {
      return;
    }
    const generation = ++this.generation;
    this.busy = "load";
    this.error = null;
    this.saved = false;
    try {
      const file = await client.request<UsersPersonalFileGetResult>("users.personalFile.get", {
        agentId,
      });
      if (generation !== this.generation) {
        return;
      }
      if (file.agentId !== agentId || file.profileId !== profileId) {
        throw new Error(t("profilePage.personalInstructions.contextChanged"));
      }
      this.file = file;
      this.draft = file.content;
      this.drafts.delete(agentId);
    } catch (error) {
      if (generation === this.generation) {
        this.error = formatUiError(error);
      }
    } finally {
      if (generation === this.generation) {
        this.busy = null;
      }
    }
  }

  private async save() {
    const client = this.client;
    const file = this.file;
    if (
      !client ||
      !file ||
      !this.available ||
      this.busy ||
      !this.dirty ||
      file.agentId !== this.agentId ||
      this.draft.length > 4000 ||
      !this.agents.some((agent) => agent.id === file.agentId)
    ) {
      return;
    }
    const generation = ++this.generation;
    const content = this.draft;
    this.busy = "save";
    this.error = null;
    this.saved = false;
    try {
      const result = await client.request<UsersPersonalFileSetResult>("users.personalFile.set", {
        agentId: file.agentId,
        content,
        expectedHash: file.hash,
      });
      if (generation !== this.generation) {
        return;
      }
      if (result.agentId !== file.agentId || result.profileId !== file.profileId) {
        throw new Error(t("profilePage.personalInstructions.contextChanged"));
      }
      this.file = result;
      this.draft = result.content;
      this.drafts.delete(result.agentId);
      this.saved = true;
    } catch (error) {
      if (generation === this.generation) {
        this.error = formatUiError(error);
      }
    } finally {
      if (generation === this.generation) {
        this.busy = null;
      }
    }
  }

  private reload() {
    if (this.dirty && !window.confirm(t("profilePage.personalInstructions.discard"))) {
      return;
    }
    void this.load();
  }

  override render() {
    if (!this.multipleProfiles) {
      return nothing;
    }
    return html`<div id=${PROFILE_SETTINGS_TARGET_IDS.personalInstructions}>
      ${renderSettingsSection(
        {
          title: t("profilePage.personalInstructions.title"),
          description: t("profilePage.personalInstructions.description"),
        },
        !this.available
          ? renderSettingsEmpty(t("profilePage.personalInstructions.signIn"))
          : !this.agents.length
            ? renderSettingsEmpty(t("profilePage.personalInstructions.noAgents"))
            : html`
                <div class="personal-instructions">
                  ${
                    this.file
                      ? html`
                          <textarea
                            id="personal-instructions-content"
                            class="settings-input personal-instructions__editor"
                            rows="7"
                            .value=${this.draft}
                            ?disabled=${this.busy !== null}
                            aria-label=${t("profilePage.personalInstructions.title")}
                            aria-describedby="personal-instructions-guidance"
                            @input=${(event: Event) => {
                              if (!(event.currentTarget instanceof HTMLTextAreaElement)) {
                                return;
                              }
                              this.draft = event.currentTarget.value;
                              this.saved = false;
                            }}
                          ></textarea>
                          <div id="personal-instructions-guidance" class="settings-row__desc">
                            ${t("profilePage.personalInstructions.guidance", { count: String(this.draft.length) })}
                            ${this.file.missing ? t("profilePage.personalInstructions.missing") : nothing}
                          </div>
                          ${this.draft.length > 4000 ? html`<div role="alert">${t("profilePage.personalInstructions.tooLong")}</div>` : nothing}
                        `
                      : nothing
                  }
                  ${this.error ? html`<div class="personal-instructions__error" role="alert">${this.error} ${t("profilePage.personalInstructions.failureHint")}</div>` : nothing}
                  <div class="personal-instructions__actions">
                    <button
                      class="btn"
                      ?disabled=${!this.file || !this.dirty || this.busy !== null || this.draft.length > 4000 || !this.agents.some((agent) => agent.id === this.agentId)}
                      @click=${() => void this.save()}
                    >
                      ${this.busy === "save" ? t("common.saving") : t("common.save")}
                    </button>
                    ${
                      this.error
                        ? html`<button
                            class="btn"
                            ?disabled=${this.busy !== null}
                            @click=${() => this.reload()}
                          >
                            ${t("profilePage.personalInstructions.reload")}
                          </button>`
                        : nothing
                    }
                    <span class="settings-row__desc" role="status"
                      >${this.dirty ? t("profilePage.personalInstructions.dirty") : this.saved ? t("profilePage.personalInstructions.saved") : nothing}</span
                    >
                  </div>
                </div>
              `,
      )}
    </div>`;
  }
}

if (!customElements.get("openclaw-personal-instructions")) {
  customElements.define("openclaw-personal-instructions", PersonalInstructions);
}
