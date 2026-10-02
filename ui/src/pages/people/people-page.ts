import { consume } from "@lit/context";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  UserProfile,
  UsersListResult,
} from "../../../../packages/gateway-protocol/src/schema/users.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/schema/users.js";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderConnectionAccess } from "../../components/connection-access.ts";
import {
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
  renderSettingsNavRow,
  renderSettingsPage,
  renderSettingsPageHeader,
  renderSettingsRow,
  renderSettingsSegmented,
  renderSettingsSection,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { canonicalPersonProfile, canReadPersonProfile } from "../../lib/person-profile.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { personName, renderDirectorySearch, renderRoleMembers } from "./directory.ts";
import { profileRoleChoice, renderConfiguredRolePolicy, type RoleCatalog } from "./role-policy.ts";

registerProfileEnglish();
const copy = (key: string) => t(`profilePage.people.${key}`);
type RolePolicyState =
  | { kind: "loading" | "unavailable" | "off" }
  | { kind: "ready"; catalog: RoleCatalog };

export class PeoplePage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context!: ApplicationContext;
  @property() personId = "";
  @property() view: "people" | "roles" = "people";
  @property() roleName = "";
  @state() private peopleQuery = "";
  @state() private rolesQuery = "";
  @state() private profiles: UserProfile[] | null = null;
  @state() private selfProfile: UserProfile | null = null;
  @state() private loading = false;
  @state() private failed = false;
  private requestId = 0;
  private source: unknown;
  private grantKey = "";
  private readonly connection = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.clear(),
    onSnapshot: ({ snapshot, initial }) => {
      const key = JSON.stringify([
        snapshot.phase,
        snapshot.hello?.auth?.role,
        snapshot.hello?.auth?.scopes,
        snapshot.hello?.auth?.sessionCap,
        snapshot.selfUser?.identity,
      ]);
      if (this.source !== snapshot.hello || this.grantKey !== key) {
        this.source = snapshot.hello;
        this.grantKey = key;
        this.clear();
        void this.load(!initial);
      }
    },
  });

  constructor() {
    super();
    new SubscriptionsController(this)
      .watchStore(() => this.context?.runtimeConfig)
      .effect(
        () => this.context?.gateway,
        (gateway) =>
          gateway.subscribeEvents((event) => {
            if (
              event.event === "sessions.changed" &&
              asOptionalRecord(event.payload)?.reason === "profile-identity"
            ) {
              this.clear();
              void this.load();
            }
          }),
      );
  }

  private clear() {
    this.requestId += 1;
    this.profiles = null;
    this.selfProfile = null;
    this.loading = false;
    this.failed = false;
  }

  private canList() {
    return canCallGatewayMethod(this.context.gateway.snapshot, "users.list", "operator.read");
  }

  private canReadConfig() {
    return canCallGatewayMethod(this.context.gateway.snapshot, "config.get", "operator.read");
  }

  private async load(refresh = false) {
    const scope = this.connection.capture();
    if (!scope || this.loading) {
      return;
    }
    const gateway = this.context.gateway;
    const hello = gateway.snapshot.hello;
    const revision = gateway.connectionRevision;
    const requestId = ++this.requestId;
    const isCurrent = () =>
      this.isConnected &&
      this.connection.isCurrent(scope) &&
      requestId === this.requestId &&
      gateway === this.context.gateway &&
      hello === gateway.snapshot.hello &&
      revision === gateway.connectionRevision;
    this.loading = true;
    this.failed = false;
    this.profiles = null;
    this.selfProfile = null;
    if (this.canReadConfig()) {
      void (
        refresh ? this.context.runtimeConfig.refresh() : this.context.runtimeConfig.ensureLoaded()
      ).catch(() => undefined);
    }
    try {
      if (this.canList()) {
        const result = await scope.client.request<UsersListResult>("users.list", {});
        if (isCurrent() && this.canList()) {
          this.profiles = result.profiles;
        }
      } else {
        const selfId = gateway.snapshot.selfUser?.identity?.id;
        if (selfId && canReadPersonProfile(gateway, selfId)) {
          const profile = await gateway.loadSelfProfile();
          if (isCurrent() && canReadPersonProfile(gateway, selfId)) {
            this.selfProfile = profile;
          }
        }
      }
    } catch {
      if (isCurrent()) {
        this.failed = true;
      }
    } finally {
      if (isCurrent()) {
        this.loading = false;
      }
    }
  }

  private selectPerson(profileId: string) {
    this.context.navigate("people", {
      pathname: pathForRoute("people", this.context.basePath),
      search: `?person=${encodeURIComponent(profileId)}`,
    });
  }

  private fact(title: string, value: unknown, description?: string) {
    return renderSettingsRow({
      title,
      description,
      stackedOnNarrow: true,
      control: renderSettingsValue(value),
    });
  }

  private rolePolicyState(): RolePolicyState {
    const config = this.context.runtimeConfig.state;
    if (
      !this.canReadConfig() ||
      !config.connected ||
      config.client !== this.context.gateway.snapshot.client
    ) {
      return { kind: "unavailable" };
    }
    if (config.configLoading) {
      return { kind: "loading" };
    }
    const runtime = config.configSnapshot?.runtimeConfig;
    if (!runtime || config.lastError) {
      return { kind: "unavailable" };
    }
    const value = asOptionalRecord(runtime.gateway)?.roles;
    if (value === undefined) {
      return { kind: "off" };
    }
    const roles = asOptionalRecord(value);
    const definitions = asOptionalRecord(roles?.definitions);
    if (!roles || !definitions) {
      return { kind: "unavailable" };
    }
    return {
      kind: "ready",
      catalog: {
        definitions,
        defaultName: typeof roles.default === "string" ? roles.default : null,
      },
    };
  }

  private policy(profile: UserProfile) {
    const policyState = this.rolePolicyState();
    if (policyState.kind !== "ready") {
      return renderSettingsSection(
        { title: copy("policy") },
        renderSettingsEmpty(
          copy(
            policyState.kind === "off"
              ? profile.id === GATEWAY_OWNER_PROFILE_ID
                ? "ownerPolicy"
                : "rolesOff"
              : policyState.kind === "loading"
                ? "policyLoading"
                : "policyUnavailable",
          ),
        ),
      );
    }
    const choice = profileRoleChoice(profile, policyState.catalog);
    if (choice.kind !== "role") {
      return renderSettingsSection(
        { title: copy("policy") },
        renderSettingsEmpty(copy(choice.kind === "owner" ? "ownerPolicy" : "noPolicy")),
      );
    }
    return renderConfiguredRolePolicy(
      choice.name,
      choice.definition,
      choice.source === "assigned"
        ? undefined
        : copy(choice.source === "retired" ? "retiredPolicy" : "defaultPolicy"),
    );
  }

  private selectView(view: "people" | "roles", roleName?: string) {
    const search = new URLSearchParams();
    if (view === "roles") {
      search.set("view", "roles");
      if (roleName) {
        search.set("role", roleName);
      }
    } else if (this.personId) {
      search.set("person", this.personId);
    }
    this.context.navigate("people", {
      pathname: pathForRoute("people", this.context.basePath),
      search: search.size ? `?${search}` : "",
    });
  }

  private renderRoles() {
    const policyState = this.rolePolicyState();
    if (policyState.kind !== "ready") {
      return renderSettingsSection(
        { title: copy("roles") },
        html`
          ${renderSettingsEmpty(copy(policyState.kind === "off" ? "rolesOff" : policyState.kind === "loading" ? "policyLoading" : "rolesUnavailable"))}
          ${renderSettingsNavRow({ title: copy("peopleView"), onClick: () => this.selectView("people") })}
        `,
      );
    }
    const catalog = policyState.catalog;
    const names = Object.keys(catalog.definitions).toSorted((a, b) => a.localeCompare(b));
    const matching = names.filter((name) =>
      name.toLowerCase().includes(this.rolesQuery.trim().toLowerCase()),
    );
    const selected =
      this.roleName ||
      (catalog.defaultName && names.includes(catalog.defaultName) ? catalog.defaultName : names[0]);
    const definition =
      selected && Object.hasOwn(catalog.definitions, selected)
        ? asOptionalRecord(catalog.definitions[selected])
        : undefined;
    const directory =
      this.canList() && !this.loading && !this.failed && this.profiles
        ? this.profiles.filter((person) => !person.mergedInto)
        : null;
    const choices = directory?.map((person) => ({
      person,
      choice: profileRoleChoice(person, catalog),
    }));
    const assigned = choices?.filter(
      ({ choice }) =>
        choice.kind === "role" && choice.name === selected && choice.source === "assigned",
    );
    const fallback = choices?.filter(
      ({ choice }) =>
        choice.kind === "role" && choice.name === selected && choice.source !== "assigned",
    );
    const outside = choices?.filter(({ choice }) => choice.kind !== "role");
    const members = (title: string, entries: typeof choices) =>
      renderRoleMembers(title, entries, this.loading, (id) => this.selectPerson(id));
    return html`<div class="settings-directory-detail">
      <div class="settings-stack">
        ${renderDirectorySearch(this.rolesQuery, copy("searchRoles"), (query) => {
          this.rolesQuery = query;
        })}
        ${renderSettingsSection(
          { title: copy("roles"), count: names.length },
          names.length
            ? matching.length
              ? matching.map((name) =>
                  renderSettingsNavRow({
                    title: name,
                    description: name === catalog.defaultName ? copy("defaultRole") : undefined,
                    selected: name === selected,
                    onClick: () => this.selectView("roles", name),
                  }),
                )
              : renderSettingsEmpty(copy("noMatches"))
            : renderSettingsEmpty(copy("noRoles")),
        )}
      </div>
      <div class="settings-stack">
        ${
          selected && definition
            ? renderConfiguredRolePolicy(
                selected,
                definition,
                copy(selected === catalog.defaultName ? "defaultRole" : "configuredRole"),
                copy("roleCeilingHint"),
              )
            : renderSettingsEmpty(copy("roleUnavailable"))
        }
        ${selected && definition ? html`${members(copy("assignedPeople"), assigned)}${members(copy("defaultPeople"), fallback)}` : nothing}
        ${outside?.length ? members(copy("outsideRoles"), outside) : nothing}
      </div>
    </div>`;
  }

  override render() {
    const connected = this.connection.connected;
    const selfId = this.context?.gateway.snapshot.selfUser?.identity?.id;
    const requestedId = this.personId || selfId || "";
    const profile = this.profiles
      ? canonicalPersonProfile(this.profiles, requestedId)
      : this.selfProfile?.id === requestedId
        ? this.selfProfile
        : null;
    const showSelf =
      this.view === "people" && (!this.personId || Boolean(selfId && profile?.id === selfId));
    const directory = this.profiles
      ?.filter((person) => !person.mergedInto)
      .toSorted((a, b) => (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id));
    const matches = directory?.filter((person) =>
      `${personName(person)} ${person.role ?? ""}`
        .toLowerCase()
        .includes(this.peopleQuery.trim().toLowerCase()),
    );
    return html`
      ${renderSettingsPageHeader({
        title: titleForRoute("people"),
        subtitle: subtitleForRoute("people"),
        actions: html`${renderSettingsSegmented({
            mode: "buttons",
            value: this.view,
            options: [
              { value: "people", label: copy("peopleView") },
              { value: "roles", label: copy("rolesView") },
            ],
            ariaLabel: copy("viewBy"),
            onChange: (view) => this.selectView(view),
          })}<button
            class="btn"
            ?disabled=${!connected || this.loading}
            @click=${() => void this.load(true)}
          >
            ${t("common.refresh")}
          </button>`,
      })}
      ${renderSettingsWorkspace(
        renderSettingsPage(
          !connected
            ? renderSettingsEmpty(copy("offline"))
            : html`
                ${
                  showSelf
                    ? html`
                        ${renderConnectionAccess({
                          scopes: this.context.gateway.snapshot.hello?.auth?.scopes ?? null,
                          reconnect: () => this.context.gateway.connect(),
                        })}
                        ${renderSettingsSection(
                          { title: copy("thisConnection") },
                          this.fact(
                            copy("otherSessions"),
                            this.context.gateway.snapshot.hello?.auth?.sessionCap
                              ? copy(
                                  `others.${this.context.gateway.snapshot.hello.auth.sessionCap}`,
                                )
                              : copy("noReportedCap"),
                            copy("sessionHint"),
                          ),
                        )}
                      `
                    : nothing
                }
                ${
                  this.view === "roles"
                    ? this.renderRoles()
                    : html`<div class="settings-directory-detail">
                        <div class="settings-stack">
                          ${
                            this.canList()
                              ? renderDirectorySearch(
                                  this.peopleQuery,
                                  copy("searchPeople"),
                                  (query) => {
                                    this.peopleQuery = query;
                                  },
                                )
                              : nothing
                          }
                          ${renderSettingsSection(
                            { title: copy("directory") },
                            this.loading
                              ? renderSettingsLoadingSkeleton({ rows: 3 })
                              : this.failed
                                ? renderSettingsEmpty(copy("unavailable"))
                                : !this.canList()
                                  ? html` ${renderSettingsEmpty(copy("directoryDenied"))}
                                    ${renderSettingsNavRow({
                                      title: copy("thisConnection"),
                                      onClick: () =>
                                        this.context.navigate("people", {
                                          pathname: pathForRoute("people", this.context.basePath),
                                          search: "",
                                        }),
                                    })}`
                                  : !directory?.length
                                    ? renderSettingsEmpty(copy("empty"))
                                    : !matches?.length
                                      ? renderSettingsEmpty(copy("noMatches"))
                                      : matches.map((person) =>
                                          renderSettingsNavRow({
                                            title: personName(person),
                                            description:
                                              person.id === GATEWAY_OWNER_PROFILE_ID
                                                ? copy("owner")
                                                : (person.role ?? copy("unassigned")),
                                            selected: profile?.id === person.id,
                                            onClick: () => this.selectPerson(person.id),
                                          }),
                                        ),
                          )}
                        </div>
                        <div class="settings-stack">
                          ${
                            profile
                              ? html`
                                  ${renderSettingsSection(
                                    { title: profile.displayName?.trim() || copy("person") },
                                    this.fact(
                                      copy("assignedRole"),
                                      profile.id === GATEWAY_OWNER_PROFILE_ID
                                        ? copy("owner")
                                        : (profile.role ?? copy("unassigned")),
                                    ),
                                  )}
                                  ${this.policy(profile)}
                                `
                              : this.loading
                                ? renderSettingsLoadingSkeleton({ rows: 4 })
                                : renderSettingsEmpty(
                                    copy(requestedId ? "personUnavailable" : "choosePerson"),
                                  )
                          }
                        </div>
                      </div>`
                }
              `,
          { wide: true },
        ),
      )}
    `;
  }
}

if (!customElements.get("openclaw-people-page")) {
  customElements.define("openclaw-people-page", PeoplePage);
}
