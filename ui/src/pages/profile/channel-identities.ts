import { consume } from "@lit/context";
import { initialState, Task } from "@lit/task";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import {
  GATEWAY_OWNER_PROFILE_ID,
  type UsersLinkChannelIdentityParams,
  type UsersListChannelIdentitiesResult,
  type UsersListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomContentsElement } from "../../lit/openclaw-element.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";

registerProfileEnglish();

export class ChannelIdentities extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;
  @state() private opened = false;
  @state() private profileId = "";
  @state() private busy = false;
  @state() private error: string | null = null;
  private hello: ApplicationContext["gateway"]["snapshot"]["hello"] = null;
  private selfId: string | undefined;
  private readonly connection = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.reset(),
    onSnapshot: ({ snapshot }) => {
      if (snapshot.hello !== this.hello || snapshot.selfUser?.id !== this.selfId) {
        this.hello = snapshot.hello;
        this.selfId = snapshot.selfUser?.id;
        this.connection.invalidate();
        this.reset();
      }
    },
  });
  private get canAdmin() {
    const auth = this.connection.snapshot?.hello?.auth;
    return (
      this.connection.connected && Boolean(auth?.scopes) && hasOperatorAdminAccess(auth ?? null)
    );
  }
  private readonly people = new Task(this, {
    args: () => [this.connection.epoch, this.opened, this.canAdmin] as const,
    task: ([, opened, canAdmin]) =>
      opened && canAdmin && this.connection.client
        ? this.connection.client.request<UsersListResult>("users.list", {})
        : initialState,
  });
  private readonly identities = new Task(this, {
    args: () => [this.connection.epoch, this.profileId, this.canAdmin] as const,
    task: ([, profileId, canAdmin]) =>
      profileId && canAdmin && this.connection.client
        ? this.connection.client.request<UsersListChannelIdentitiesResult>(
            "users.listChannelIdentities",
            { profileId },
          )
        : initialState,
  });

  private reset() {
    this.opened = false;
    this.profileId = "";
    this.busy = false;
    this.error = null;
  }

  private async change(link: UsersLinkChannelIdentityParams, unlink = false) {
    const scope = this.connection.capture();
    if (!scope || !this.canAdmin || this.busy || link.profileId !== this.profileId) {
      return;
    }
    this.busy = true;
    this.error = null;
    try {
      await scope.client.request(
        unlink ? "users.unlinkChannelIdentity" : "users.linkChannelIdentity",
        link,
      );
      if (this.connection.isCurrent(scope)) {
        await this.identities.run();
      }
    } catch (error) {
      if (this.connection.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.connection.isCurrent(scope)) {
        this.busy = false;
      }
    }
  }

  private renderError(error: unknown, retry: () => void) {
    return html`<div class="settings-row" role="alert">
      <span class="settings-row__desc">${formatUiError(error)}</span>
      <button class="btn btn--sm" @click=${retry}>${t("common.retry")}</button>
    </div>`;
  }

  private renderLinks({ links }: UsersListChannelIdentitiesResult) {
    return html`
      ${
        links.length
          ? links.map((link) => {
              const label = Object.values(link.identity).join(" · ");
              return renderSettingsRow({
                title: `${link.identity.channelId} · ${link.identity.accountId}`,
                description: link.identity.senderId,
                control: html`<button
                  class="btn btn--sm"
                  ?disabled=${this.busy}
                  aria-label=${t("profilePage.channelIdentities.unlinkLabel", { identity: label })}
                  @click=${() => void this.change(link, true)}
                >
                  ${t("profilePage.channelIdentities.unlink")}
                </button>`,
              });
            })
          : renderSettingsEmpty(t("profilePage.channelIdentities.empty"))
      }
      ${keyed(
        this.profileId,
        html`<form
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            const form = event.currentTarget;
            if (!(form instanceof HTMLFormElement)) {
              return;
            }
            const fields = new FormData(form);
            void this.change({
              profileId: this.profileId,
              identity: {
                channelId: normalizeOptionalString(fields.get("channelId")) ?? "",
                accountId: normalizeOptionalString(fields.get("accountId")) ?? "",
                senderId: normalizeOptionalString(fields.get("senderId")) ?? "",
              },
            });
          }}
        >
          ${(["channelId", "accountId", "senderId"] as const).map((field) =>
            renderSettingsRow({
              title: t(`profilePage.channelIdentities.${field}`),
              stackedOnNarrow: true,
              control: html`<input
                class="settings-input"
                name=${field}
                required
                maxlength="512"
                aria-label=${t(`profilePage.channelIdentities.${field}`)}
                ?disabled=${this.busy}
              />`,
            }),
          )}
          ${renderSettingsRow({
            title: nothing,
            description: t("profilePage.channelIdentities.verify"),
            stackedOnNarrow: true,
            control: html`<button class="btn btn--sm" type="submit" ?disabled=${this.busy}>
              ${this.busy ? t("common.saving") : t("profilePage.channelIdentities.link")}
            </button>`,
          })}
        </form>`,
      )}
    `;
  }

  override render() {
    if (!this.canAdmin) {
      return nothing;
    }
    return html`<div id=${PROFILE_SETTINGS_TARGET_IDS.channelIdentities}>
      ${renderSettingsSection(
        {
          title: t("profilePage.channelIdentities.title"),
          description: t("profilePage.channelIdentities.description"),
        },
        !this.opened
          ? renderSettingsRow({
              title: nothing,
              control: html`<button
                class="btn btn--sm"
                @click=${() => {
                  this.opened = true;
                }}
              >
                ${t("profilePage.channelIdentities.manage")}
              </button>`,
            })
          : html`
              ${this.people.render({
                pending: () => renderSettingsEmpty(t("common.loading")),
                error: (error) => this.renderError(error, () => void this.people.run()),
                complete: ({ profiles }) =>
                  renderSettingsRow({
                    title: t("profilePage.channelIdentities.person"),
                    stackedOnNarrow: true,
                    control: html`<select
                      class="settings-select"
                      aria-label=${t("profilePage.channelIdentities.person")}
                      .value=${this.profileId}
                      ?disabled=${this.busy}
                      @change=${(event: Event) => {
                        if (!(event.currentTarget instanceof HTMLSelectElement)) {
                          return;
                        }
                        this.profileId = event.currentTarget.value;
                        this.error = null;
                      }}
                    >
                      <option value="">${t("profilePage.channelIdentities.choosePerson")}</option>
                      ${profiles
                        .filter(
                          (profile) =>
                            !profile.mergedInto && profile.id !== GATEWAY_OWNER_PROFILE_ID,
                        )
                        .map(
                          (profile) => html` <option value=${profile.id}>
                            ${profile.displayName ? `${profile.displayName} · ` : ""}${profile.emails[0] || profile.id}${profile.role ? ` (${profile.role})` : ""}
                          </option>`,
                        )}
                    </select>`,
                  }),
              })}
              ${
                this.profileId
                  ? this.identities.render({
                      pending: () => renderSettingsEmpty(t("common.loading")),
                      error: (error) => this.renderError(error, () => void this.identities.run()),
                      complete: (result) => this.renderLinks(result),
                    })
                  : nothing
              }
              ${this.error ? html`<div class="settings-row" role="alert">${this.error}</div>` : nothing}
            `,
      )}
    </div>`;
  }
}

if (!customElements.get("openclaw-channel-identities")) {
  customElements.define("openclaw-channel-identities", ChannelIdentities);
}
