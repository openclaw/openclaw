import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import {
  GATEWAY_OWNER_PROFILE_ID,
  type UserProfile,
} from "../../../../packages/gateway-protocol/src/schema/users.js";
import { userProfileDisplayName } from "../../../../src/shared/user-profile-display-name.js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import {
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsNavRow,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SettingsSegmented,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { registerRouteSubtitlesEnglish } from "../../i18n/locales/en-route-subtitles.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { profileDirectory } from "../../lib/profile-directory.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { peopleCopy as copy, PolicyFact, RolePolicy } from "./role-policy.tsx";

registerEnglishCatalog(registerProfileEnglish);
registerRouteSubtitlesEnglish();
const personName = (person: UserProfile) =>
  userProfileDisplayName(person.id, person.displayName, person.githubIdentity?.login) ||
  copy("person");
const roleSource = (person: UserProfile) =>
  copy(person.id === GATEWAY_OWNER_PROFILE_ID ? "owner" : (person.roleSource ?? "unknown"));

export function PeoplePage(props: { routeData: string | undefined }) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const directory = profileDirectory(context.gateway);
  const people = projectOwner(directory, (source) => source);
  const config = projectRuntimeConfig(context.runtimeConfig);
  const [peopleQuery, setPeopleQuery] = createSignal("");
  const [rolesQuery, setRolesQuery] = createSignal("");
  const query = createMemo(() => new URLSearchParams(props.routeData));
  const personId = () => query().get("person") ?? "";
  const snapshot = () => gateway.read().snapshot;
  const connected = () => snapshot().phase === "connected";
  const canList = () => canCallGatewayMethod(snapshot(), "users.list", "operator.read");
  const canReadPolicy = () => canCallGatewayMethod(snapshot(), "config.get", "operator.read");
  // Policy reads belong to the page lifetime, including connection/access gains.
  onSettled(() => {
    const ensurePolicy = () => {
      if (canReadPolicy()) {
        void context.runtimeConfig.ensureDisplayLoaded();
      }
    };
    ensurePolicy();
    return gateway.subscribe(ensurePolicy);
  });
  const selectedView = () => (query().get("view") === "roles" ? "roles" : "people");
  const selfId = () => snapshot().selfUser?.identity?.id;
  const requestedId = () => personId() || selfId() || "";
  const rows = createMemo(() =>
    canList()
      ? (people.read().result?.profiles ?? [])
          .filter((person) => !person.mergedInto)
          .toSorted((a, b) => personName(a).localeCompare(personName(b)))
      : [],
  );
  const selectedPerson = createMemo(() => {
    people.read();
    return canList() ? directory.get(requestedId()) : undefined;
  });
  const matchingPeople = createMemo(() =>
    rows().filter((person) =>
      (personName(person) + " " + (person.effectiveRole ?? ""))
        .toLowerCase()
        .includes(peopleQuery().trim().toLowerCase()),
    ),
  );
  const roles = createMemo(() => {
    const state = config.read().state;
    if (
      !canReadPolicy() ||
      !state.connected ||
      state.client !== snapshot().client ||
      state.lastError
    ) {
      return undefined;
    }
    const runtime = state.configSnapshot?.runtimeConfig;
    return runtime
      ? (asOptionalRecord(asOptionalRecord(runtime.gateway)?.roles) ?? null)
      : undefined;
  });
  const definitions = createMemo(() => asOptionalRecord(roles()?.definitions));
  const names = createMemo(() => Object.keys(definitions() ?? {}).toSorted());
  const selectedRole = () =>
    query().get("role") ||
    (typeof roles()?.default === "string" ? String(roles()?.default) : (names()[0] ?? ""));
  const selectedPolicy = () =>
    asOptionalRecord(
      definitions()?.[
        selectedView() === "roles" ? selectedRole() : (selectedPerson()?.effectiveRole ?? "")
      ],
    );
  const navigate = (view: "people" | "roles", id = "") => {
    const search = new URLSearchParams();
    if (view === "roles") {
      search.set("view", "roles");
      if (id) {
        search.set("role", id);
      }
    } else if (id) {
      search.set("person", id);
    }
    context.navigate("people", {
      pathname: pathForRoute("people", context.basePath),
      search: search.size ? "?" + search.toString() : "",
    });
  };
  const policyUnavailable = () =>
    copy(
      roles() === null
        ? "rolesOff"
        : config.read().state.configLoading
          ? "policyLoading"
          : "policyUnavailable",
    );
  const refresh = () => {
    void directory.load(true);
    if (canReadPolicy()) {
      void context.runtimeConfig.refreshDisplay();
    }
  };
  return (
    <>
      <SettingsPageHeader
        title={titleForRoute("people")}
        subtitle={subtitleForRoute("people")}
        actions={
          <>
            <SettingsSegmented
              mode="buttons"
              value={selectedView()}
              options={[
                { value: "people", label: copy("peopleView") },
                { value: "roles", label: copy("rolesView") },
              ]}
              ariaLabel={copy("viewBy")}
              onChange={(view) => navigate(view)}
            />
            <button
              type="button"
              class="btn"
              disabled={!connected() || people.read().loading}
              onClick={refresh}
            >
              {t("common.refresh")}
            </button>
          </>
        }
      />
      <SettingsWorkspace>
        <SettingsPage wide>
          <div class="people-permissions settings-stack">
            <Show when={connected()} fallback={<SettingsEmpty message={copy("offline")} />}>
              <Show
                when={selectedView() === "people" && (!personId() || requestedId() === selfId())}
              >
                <SettingsSection
                  title={copy("thisConnection")}
                  description={copy("connectionHint")}
                >
                  <PolicyFact
                    title={copy("scopes")}
                    value={snapshot().hello?.auth?.scopes?.join(", ") || copy("none")}
                  />
                  <PolicyFact
                    title={copy("otherSessions")}
                    value={
                      snapshot().hello?.auth?.sessionCap
                        ? copy("others." + snapshot().hello?.auth?.sessionCap)
                        : copy("noReportedCap")
                    }
                  />
                </SettingsSection>
              </Show>
              <Show
                when={canList()}
                fallback={
                  <SettingsSection title={copy("peopleView")}>
                    <SettingsEmpty
                      message={
                        personId() && requestedId() !== selfId()
                          ? copy("personUnavailable")
                          : copy("directoryDenied")
                      }
                    />
                    <SettingsNavRow
                      title={copy("thisConnection")}
                      onClick={() => navigate("people")}
                    />
                  </SettingsSection>
                }
              >
                <div class="people-permissions__columns">
                  <div class="settings-stack">
                    <input
                      type="search"
                      class="settings-input"
                      aria-label={copy(selectedView() === "roles" ? "searchRoles" : "searchPeople")}
                      placeholder={copy(
                        selectedView() === "roles" ? "searchRoles" : "searchPeople",
                      )}
                      value={selectedView() === "roles" ? rolesQuery() : peopleQuery()}
                      onInput={(event) =>
                        selectedView() === "roles"
                          ? setRolesQuery(event.currentTarget.value)
                          : setPeopleQuery(event.currentTarget.value)
                      }
                    />
                    <Show
                      when={selectedView() === "people"}
                      fallback={
                        <SettingsSection title={copy("rolesView")} count={names().length}>
                          <Show
                            when={definitions()}
                            fallback={<SettingsEmpty message={policyUnavailable()} />}
                          >
                            <For
                              each={names().filter((name) =>
                                name.toLowerCase().includes(rolesQuery().trim().toLowerCase()),
                              )}
                              fallback={<SettingsEmpty message={copy("noMatches")} />}
                            >
                              {(name) => (
                                <SettingsNavRow
                                  title={name}
                                  description={
                                    name === roles()?.default ? copy("defaultRole") : undefined
                                  }
                                  selected={name === selectedRole()}
                                  onClick={() => navigate("roles", name)}
                                />
                              )}
                            </For>
                          </Show>
                        </SettingsSection>
                      }
                    >
                      <SettingsSection title={copy("directory")} count={rows().length}>
                        <Show
                          when={people.read().result}
                          fallback={
                            people.read().loading ? (
                              <SettingsLoadingSkeleton rows={3} />
                            ) : (
                              <SettingsEmpty message={copy("unavailable")} />
                            )
                          }
                        >
                          <For
                            each={matchingPeople()}
                            keyed={(person) => person.id}
                            fallback={<SettingsEmpty message={copy("noMatches")} />}
                          >
                            {(person) => (
                              <SettingsNavRow
                                title={personName(person())}
                                description={
                                  person().id === GATEWAY_OWNER_PROFILE_ID
                                    ? copy("owner")
                                    : (person().effectiveRole ?? copy("noRole"))
                                }
                                selected={person().id === selectedPerson()?.id}
                                onClick={() => navigate("people", person().id)}
                              />
                            )}
                          </For>
                        </Show>
                      </SettingsSection>
                    </Show>
                  </div>
                  <div class="settings-stack">
                    <Show
                      when={selectedView() === "roles" || selectedPerson()}
                      fallback={
                        people.read().loading ? (
                          <SettingsLoadingSkeleton rows={4} />
                        ) : (
                          <SettingsEmpty
                            message={copy(requestedId() ? "personUnavailable" : "choosePerson")}
                          />
                        )
                      }
                    >
                      <Show when={selectedView() === "people" && selectedPerson()}>
                        {(person) => (
                          <SettingsSection title={personName(person())}>
                            <Show
                              when={person().id !== GATEWAY_OWNER_PROFILE_ID}
                              fallback={<PolicyFact title={copy("role")} value={copy("owner")} />}
                            >
                              <PolicyFact
                                title={copy("assignedRole")}
                                value={person().role ?? copy("noRole")}
                              />
                              <PolicyFact
                                title={copy("role")}
                                value={person().effectiveRole ?? copy("noRole")}
                                description={roleSource(person())}
                              />
                            </Show>
                          </SettingsSection>
                        )}
                      </Show>
                      <Show
                        when={
                          selectedView() !== "people" ||
                          selectedPerson()?.id !== GATEWAY_OWNER_PROFILE_ID
                        }
                        fallback={<SettingsEmpty message={copy("ownerPolicy")} />}
                      >
                        <Show
                          when={selectedPolicy()}
                          fallback={<SettingsEmpty message={policyUnavailable()} />}
                        >
                          {(policy) => (
                            <RolePolicy
                              name={
                                selectedView() === "roles"
                                  ? selectedRole()
                                  : (selectedPerson()?.effectiveRole ?? "")
                              }
                              policy={policy()}
                            />
                          )}
                        </Show>
                      </Show>
                      <Show when={selectedView() === "roles" && selectedPolicy()}>
                        <SettingsSection title={copy("members")} description={copy("membersHint")}>
                          <Show
                            when={people.read().result}
                            fallback={
                              people.read().loading ? (
                                <SettingsLoadingSkeleton rows={3} />
                              ) : (
                                <SettingsEmpty message={copy("unavailable")} />
                              )
                            }
                          >
                            <For
                              each={rows().filter(
                                (person) =>
                                  person.id !== GATEWAY_OWNER_PROFILE_ID &&
                                  person.effectiveRole === selectedRole(),
                              )}
                              keyed={(person) => person.id}
                              fallback={<SettingsEmpty message={copy("noMembers")} />}
                            >
                              {(person) => (
                                <SettingsNavRow
                                  title={personName(person())}
                                  description={roleSource(person())}
                                  onClick={() => navigate("people", person().id)}
                                />
                              )}
                            </For>
                          </Show>
                        </SettingsSection>
                      </Show>
                    </Show>
                  </div>
                </div>
              </Show>
            </Show>
          </div>
        </SettingsPage>
      </SettingsWorkspace>
    </>
  );
}
