import { ContextConsumer } from "@lit/context";
import { html, nothing, type ReactiveControllerHost } from "lit";
import { ref } from "lit/directives/ref.js";
import { applicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentTargetLabel } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { formatUiError } from "../lib/format-error.ts";
import { profileAvatarUrl, profileDirectory } from "../lib/profile-directory.ts";
import { GatewayPageController } from "../lit/gateway-page-controller.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { icons } from "./icons.ts";
import { searchablePeopleMenu } from "./searchable-people-menu.ts";
import {
  renderSessionOwnerAvatar,
  sessionSelfOwner,
  type SessionCreatedActor,
  type SessionOwnerOption,
} from "./session-owner-chip.ts";
import { syncDropdownItemRadio } from "./web-awesome.ts";

type SessionOwnerMenuParams = {
  currentOwner: SessionCreatedActor | null;
  disabled: boolean;
  disabledReason?: string;
};

/** Assignment uses the Gateway directory, independently of session filters and presence. */
export class SessionOwnerMenu {
  private readonly context;
  private readonly connection;
  private searchGeneration = 0;

  constructor(host: ReactiveControllerHost & HTMLElement) {
    this.context = new ContextConsumer(host, { context: applicationContext, subscribe: true });
    this.connection = new GatewayPageController(host, {
      getGateway: () => this.context.value?.gateway,
      invalidateRequests: () => {
        this.searchGeneration += 1;
      },
    });
    new SubscriptionsController(host).watchStore(() => this.context.value?.agents);
    new SubscriptionsController(host).watchStore(() => this.directory);
  }

  private get directory() {
    const gateway = this.context.value?.gateway;
    return gateway ? profileDirectory(gateway) : undefined;
  }

  readonly load = () => {
    this.searchGeneration += 1;
    void this.directory?.load(true);
  };

  private ownerOptions() {
    const context = this.context.value;
    const self = sessionSelfOwner(context?.gateway.snapshot.selfUser);
    // Keep a same-connection directory during refresh, never a previous Gateway's result.
    const directory = this.directory?.result;
    const owners: SessionOwnerOption[] = (directory?.profiles ?? [])
      .filter((profile) => !profile.mergedInto && profile.id !== self?.id)
      .map((profile) => ({
        type: "human",
        id: profile.id,
        identity: { type: "profile", id: profile.id },
        label:
          profile.displayName?.trim() ||
          profile.githubIdentity?.login ||
          profile.emails[0] ||
          profile.id,
        avatarUrl: profileAvatarUrl(profile),
      }));
    for (const agent of context?.agents.state.agentsList?.agents ?? []) {
      const identity = context?.agentIdentity.get(agent.id);
      owners.push({
        type: "agent",
        id: agent.id,
        identity: { type: "agent", id: agent.id },
        label: normalizeAgentTargetLabel(agent, identity),
        avatarUrl: resolveAgentAvatarUrl(agent, identity) ?? undefined,
      });
    }
    owners.sort(
      (left, right) =>
        left.type.localeCompare(right.type) ||
        (left.label ?? left.id).localeCompare(right.label ?? right.id) ||
        left.id.localeCompare(right.id),
    );
    if (self) {
      owners.unshift(self);
    }
    return {
      self,
      owners: [...new Map(owners.map((owner) => [owner.type + ":" + owner.id, owner])).values()],
      directory,
    };
  }

  get snapshot() {
    return {
      ...this.ownerOptions(),
      searchGeneration: this.searchGeneration,
      connected: Boolean(this.connection.capture()),
      loading: this.profiles.status === TaskStatus.PENDING,
      error: this.profiles.status === TaskStatus.ERROR ? this.profiles.error : undefined,
    };
  }

  get multipleOwners(): boolean {
    return this.ownerOptions().owners.length > 1;
  }

  render(params: SessionOwnerMenuParams, inline = false) {
    const { self, owners, directory } = this.ownerOptions();
    const currentOwner = params.currentOwner;
    const currentOwnerId = currentOwner?.identity?.id ?? currentOwner?.id;
    // A recorded owner remains checked while discovery is pending or unavailable;
    // this fallback is not an eligible directory entry for counting assignees.
    if (
      !directory &&
      currentOwner?.type === "human" &&
      currentOwnerId &&
      !owners.some((owner) => owner.type === "human" && owner.id === currentOwnerId)
    ) {
      owners.push({ ...currentOwner, type: "human", id: currentOwnerId });
    }
    const slot = inline ? nothing : "submenu";
    return html`
      ${searchablePeopleMenu(
        owners.map((owner) => ({
          text: [
            owner.label,
            owner.id,
            owner.type,
            owner === self ? t("sessionsView.assignToMe") : "",
          ].join(" "),
          render: () => {
            const checked = owner.type === currentOwner?.type && owner.id === currentOwnerId;
            return html`<wa-dropdown-item
              slot=${slot}
              class="session-menu__item"
              value=${`assign-owner:${owner.type}:${encodeURIComponent(owner.id)}`}
              role="menuitemradio"
              aria-checked=${String(checked)}
              ${ref((element) => syncDropdownItemRadio(element, checked))}
              ?disabled=${params.disabled || checked}
              title=${params.disabledReason ?? nothing}
            >
              <span slot="icon" class="session-menu__avatar" aria-hidden="true"
                >${renderSessionOwnerAvatar(owner)}</span
              >
              <span class="session-menu__text"
                >${owner === self ? t("sessionsView.assignToMe") : (owner.label ?? owner.id)}</span
              >
              ${
                checked
                  ? html`<span slot="details" class="session-menu__check" aria-hidden="true"
                      >${icons.check}</span
                    >`
                  : nothing
              }
            </wa-dropdown-item>`;
          },
        })),
        this.searchGeneration,
        inline ? undefined : "submenu",
      )}
      ${this.renderStatus(inline)}
    `;
  }

  renderStatus(inline = false) {
    if (!this.connection.capture()) {
      return nothing;
    }
    const slot = inline ? nothing : "submenu";
    const directory = this.directory;
    if (directory?.loading) {
      return html`<wa-dropdown-item slot=${slot} disabled
        >${t("common.loading")}</wa-dropdown-item
      >`;
    }
    return directory?.error
      ? html`
          <div slot=${slot} class="session-menu__info" role="alert">
            ${formatUiError(directory.error, t("common.failed"))}
          </div>
          <wa-dropdown-item slot=${slot} class="session-menu__item" value="reload-owners">
            <span class="session-menu__text">${t("common.retry")}</span>
          </wa-dropdown-item>
        `
      : nothing;
  }
}
