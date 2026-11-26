import { createMemo, createSignal, For, Show } from "solid-js";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { Checkbox } from "../../components/solid/checkbox.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import {
  SettingsEmpty,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectAgents } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  ADMIN_SCOPE,
  DEFAULT_PARTICIPANT_TOOLS,
  buildRoleEdit,
  normalizeRoleDefinition,
  participantTools,
  roleIssues,
  sameDefinition,
  type InvitedAccess,
  type InvitedPermission,
  type RoleDefinition,
  type SessionsOthers,
} from "./role-catalog.ts";
import { RolePerson } from "./role-person.tsx";
import { PERMISSION_KEYS, RoleSummary } from "./role-summary.tsx";
import type { RolesState } from "./use-roles.ts";

const OTHERS: readonly SessionsOthers[] = ["none", "invited", "view", "suggest", "write"];
const ACCESS: readonly InvitedAccess[] = ["read", "suggest", "send"];
const PERMISSIONS: readonly InvitedPermission[] = ["read-only", "guarded", "workspace", "full"];

/** Scope IDs in display order, with their copy key. */
const ROLE_SCOPES = [
  ["operator.sessions.read", "sessionsRead"],
  ["operator.sessions.write", "sessionsWrite"],
  ["operator.questions", "questions"],
  ["operator.approvals", "approvals"],
  ["operator.talk", "talk"],
  ["operator.read", "read"],
  ["operator.write", "write"],
  ["operator.cron", "cron"],
  ["operator.pairing", "pairing"],
  ["operator.talk.secrets", "talkSecrets"],
  ["operator.session-share.read", "shareRead"],
  ["operator.session-share.steer", "shareSteer"],
  [ADMIN_SCOPE, "admin"],
] as const;

const TOOL_WARNINGS: Readonly<Record<string, string>> = {
  exec: "rolesPage.execWarning",
  github_publish: "rolesPage.publishWarning",
};

function RawId(props: { children: string }) {
  return <code class="roles-raw">{props.children}</code>;
}

function toggle(list: readonly string[], id: string, on: boolean) {
  const next = new Set(list);
  if (on) {
    next.add(id);
  } else {
    next.delete(id);
  }
  return [...next];
}

export function RoleEditor(props: {
  roles: RolesState;
  name: string;
  definition: RoleDefinition;
  onBack: () => void;
  onDuplicate: () => void;
  onAssign: () => void;
  onDelete: () => void;
}) {
  const context = useApplication();
  const agents = projectAgents(context.agents);
  const agentRows = () => agents.read().agentsList?.agents ?? [];
  const agentName = (id: string) => {
    const agent = agentRows().find((row) => row.id === id);
    return agent?.identity?.name ?? agent?.name ?? id;
  };
  // Untouched, the editor shows the Gateway's definition. The first edit copies it as the base
  // that Save checks the Gateway still holds.
  const [draft, setDraft] = createSignal<RoleDefinition | null>(null, { ownedWrite: true });
  const [base, setBase] = createSignal<RoleDefinition | null>(null, { ownedWrite: true });
  const view = () => draft() ?? props.definition;
  const edit = (change: (role: RoleDefinition) => void) => {
    setBase((previous) => previous ?? structuredClone(props.definition));
    setDraft((previous) => {
      const next = structuredClone(previous ?? props.definition);
      change(next);
      return next;
    });
  };
  const dirty = createMemo(() => {
    const current = draft();
    return (
      current !== null && !sameDefinition(normalizeRoleDefinition(current), base() ?? undefined)
    );
  });
  const changedElsewhere = createMemo(
    () => draft() !== null && !sameDefinition(props.definition, base() ?? undefined),
  );
  const issues = createMemo(() => roleIssues(view()));
  const people = () => props.roles.people().get(props.name) ?? [];
  const isDefault = () => props.roles.catalog().defaultRole === props.name;
  const editable = () => props.roles.editable();
  const tools = () => participantTools(view());
  const reconnectMessage = () =>
    people().length === 0
      ? t("rolesPage.unsavedNobody")
      : people().length === 1
        ? t("rolesPage.unsavedReconnectOne")
        : t("rolesPage.unsavedReconnect", { count: String(people().length) });
  const discard = () => {
    setDraft(null);
    setBase(null);
    props.roles.clearMessages();
  };
  const save = async () => {
    const current = draft();
    const from = base();
    if (!current || !from) {
      return;
    }
    const name = props.name;
    const next = normalizeRoleDefinition(current);
    if (
      await props.roles.patch(
        (config) => buildRoleEdit(config, name, from, next),
        "Edit role " + name,
        t("rolesPage.saved"),
      )
    ) {
      discard();
    }
  };
  const back = async () => {
    if (
      !dirty() ||
      (await showConfirmDialog({
        title: t("rolesPage.unsaved"),
        message: t("rolesPage.discardConfirm"),
        confirmLabel: t("rolesPage.discard"),
        danger: true,
      }))
    ) {
      props.onBack();
    }
  };
  return (
    <div class="roles-editor">
      <button type="button" class="roles-back" onClick={() => void back()}>
        <Icon name="arrowLeft" /> {t("rolesPage.back")}
      </button>
      <SettingsPageHeader
        stacked
        title={props.name}
        subtitle={<RawId>{"gateway.roles.definitions." + props.name}</RawId>}
        actions={
          <>
            <button
              type="button"
              class="btn btn--sm"
              disabled={!editable()}
              onClick={() => props.onDuplicate()}
            >
              <Icon name="copy" /> {t("rolesPage.duplicate")}
            </button>
            <button
              type="button"
              class="btn btn--sm"
              disabled={!editable()}
              onClick={() => props.onAssign()}
            >
              <Icon name="userPlus" /> {t("rolesPage.assignPeople")}
            </button>
          </>
        }
      />
      <Show when={changedElsewhere() && dirty()}>
        <InlineAlert
          tone="warning"
          action={
            <button type="button" class="btn btn--sm" onClick={discard}>
              {t("rolesPage.reload")}
            </button>
          }
        >
          {t("rolesPage.errors.changed")}
        </InlineAlert>
      </Show>
      <Show when={props.roles.state().error}>
        {(error) => <InlineAlert tone="danger">{error()}</InlineAlert>}
      </Show>
      <SettingsSection
        title={t("rolesPage.summaryTitle")}
        description={t("rolesPage.summaryDescription")}
      >
        <RoleSummary definition={view()} agentName={agentName} />
      </SettingsSection>
      <SettingsSection
        title={t("rolesPage.peopleHeading")}
        count={people().length}
        actions={
          <button
            type="button"
            class="btn btn--sm"
            disabled={!editable()}
            onClick={() => props.onAssign()}
          >
            {t("rolesPage.assignPeople")}
          </button>
        }
      >
        <Show
          when={people().length}
          fallback={<SettingsEmpty message={t("rolesPage.peopleEmpty")} />}
        >
          <For each={people()}>
            {(profile) => <SettingsRow title={<RolePerson profile={profile} />} />}
          </For>
        </Show>
      </SettingsSection>
      <SettingsSection title={t("rolesPage.sessionsHeading")}>
        <SettingsRow
          title={t("rolesPage.others")}
          description={
            <>
              {t("rolesOptions.others." + view().sessions.others + ".description")}{" "}
              <RawId>sessions.others</RawId>
            </>
          }
          stackedOnNarrow
          control={
            <SettingsSelect
              aria-label={t("rolesPage.others")}
              value={view().sessions.others}
              disabled={!editable()}
              options={OTHERS.map((value) => ({
                value,
                label: t("rolesOptions.others." + value + ".label"),
              }))}
              onChange={(event) => {
                const value = OTHERS.find((option) => option === event.currentTarget.value);
                if (!value) {
                  return;
                }
                edit((role) => {
                  role.sessions.others = value;
                  if (value === "invited") {
                    role.sessions.maxInvitedAccess ??= "read";
                  }
                });
              }}
            />
          }
        />
        <SettingsToggleRow
          title={t("rolesPage.sandbox")}
          description={
            <>
              {view().sandbox === "required"
                ? t("rolesPage.sandboxRequired")
                : t("rolesPage.sandboxInherit")}{" "}
              <RawId>sandbox</RawId>
            </>
          }
          checked={view().sandbox === "required"}
          disabled={!editable()}
          onChange={(on) =>
            edit((role) => {
              if (on) {
                role.sandbox = "required";
              } else {
                delete role.sandbox;
              }
            })
          }
        />
        <SettingsRow
          title={t("rolesPage.agents")}
          description={
            <>
              {t("rolesPage.agentsDescription")} <RawId>agents</RawId>
            </>
          }
          stacked
          control={
            <div
              class={["roles-checks", { "roles-checks--invalid": issues().includes("noAgents") }]}
            >
              <label class="roles-check">
                <Checkbox
                  checked={view().agents === "*"}
                  disabled={!editable()}
                  onChange={(event) => {
                    const all = event.currentTarget.checked;
                    edit((role) => {
                      role.agents = all ? "*" : agentRows().map((row) => row.id);
                    });
                  }}
                />
                {t("rolesPage.allAgents")}
              </label>
              <For each={agentRows()}>
                {(agent) => (
                  <label class="roles-check">
                    <Checkbox
                      checked={view().agents === "*" || view().agents.includes(agent.id)}
                      disabled={!editable() || view().agents === "*"}
                      onChange={(event) => {
                        const on = event.currentTarget.checked;
                        edit((role) => {
                          role.agents = toggle(
                            role.agents === "*" ? [] : role.agents,
                            agent.id,
                            on,
                          );
                        });
                      }}
                    />
                    {agentName(agent.id)}
                  </label>
                )}
              </For>
              <Show when={issues().includes("noAgents")}>
                <span class="roles-error" role="alert">
                  {t("rolesPage.issueNoAgents")}
                </span>
              </Show>
            </div>
          }
        />
      </SettingsSection>
      <SettingsSection
        title={t("rolesPage.invitedHeading")}
        description={t("rolesPage.invitedDescription")}
      >
        <Show
          when={view().sessions.others === "invited"}
          fallback={<SettingsEmpty message={t("rolesPage.invitedUnused")} />}
        >
          <SettingsRow
            title={t("rolesPage.maxInvitedAccess")}
            description={
              <>
                {t("rolesPage.maxInvitedAccessDescription")}{" "}
                <RawId>sessions.maxInvitedAccess</RawId>
              </>
            }
            stackedOnNarrow
            control={
              <SettingsSegmented
                ariaLabel={t("rolesPage.maxInvitedAccess")}
                value={view().sessions.maxInvitedAccess ?? "read"}
                disabled={!editable()}
                options={ACCESS.map((value) => ({
                  value,
                  label: t("rolesOptions.access." + value + ".label"),
                  title: t("rolesOptions.access." + value + ".description"),
                }))}
                onChange={(value) => edit((role) => void (role.sessions.maxInvitedAccess = value))}
              />
            }
          />
          <Show when={view().sessions.maxInvitedAccess === "send"}>
            <SettingsRow
              title={t("rolesPage.invitedPermission")}
              description={
                <>
                  {t(
                    "rolesOptions.permission." +
                      PERMISSION_KEYS[view().sessions.invitedPermission ?? "workspace"] +
                      ".description",
                  )}{" "}
                  {t("rolesPage.invitedPermissionDescription")}{" "}
                  <RawId>sessions.invitedPermission</RawId>
                </>
              }
              stackedOnNarrow
              control={
                <SettingsSelect
                  aria-label={t("rolesPage.invitedPermission")}
                  value={view().sessions.invitedPermission ?? "workspace"}
                  disabled={!editable()}
                  options={PERMISSIONS.map((value) => ({
                    value,
                    label: t("rolesOptions.permission." + PERMISSION_KEYS[value] + ".label"),
                  }))}
                  onChange={(event) => {
                    const value = PERMISSIONS.find(
                      (option) => option === event.currentTarget.value,
                    );
                    if (!value) {
                      return;
                    }
                    edit((role) => {
                      if (value === "workspace") {
                        delete role.sessions.invitedPermission;
                      } else {
                        role.sessions.invitedPermission = value;
                      }
                    });
                  }}
                />
              }
            />
            <SettingsRow
              title={t("rolesPage.tools")}
              description={t("rolesPage.toolsDescription", { count: String(tools().length) })}
              stacked
              control={
                <div class="roles-tools">
                  <SettingsSegmented
                    ariaLabel={t("rolesPage.tools")}
                    value={view().sessions.invitedTools ? "custom" : "default"}
                    disabled={!editable()}
                    options={[
                      { value: "default", label: t("rolesPage.toolsDefault") },
                      { value: "custom", label: t("rolesPage.toolsCustom") },
                    ]}
                    onChange={(value) =>
                      edit((role) => {
                        if (value === "custom") {
                          // The explicit list replaces defaults plus additions; both can't be set.
                          role.sessions.invitedTools = [...participantTools(role)];
                          delete role.sessions.invitedAlsoAllow;
                        } else {
                          delete role.sessions.invitedTools;
                        }
                      })
                    }
                  />
                  <p class="roles-hint">
                    {view().sessions.invitedTools
                      ? t("rolesPage.toolsCustomHint")
                      : t("rolesPage.toolsDefaultHint")}{" "}
                    <RawId>sessions.invitedTools</RawId>
                  </p>
                  <div class="roles-tools__grid">
                    <For each={DEFAULT_PARTICIPANT_TOOLS}>
                      {(tool) => (
                        <label class="roles-tool">
                          <Checkbox
                            checked={tools().includes(tool)}
                            disabled={!editable() || !view().sessions.invitedTools}
                            onChange={(event) => {
                              const on = event.currentTarget.checked;
                              edit((role) => {
                                role.sessions.invitedTools = toggle(
                                  role.sessions.invitedTools ?? [],
                                  tool,
                                  on,
                                );
                              });
                            }}
                          />
                          <span class="roles-tool__text">
                            <span>
                              {t("rolesTools." + tool)} <RawId>{tool}</RawId>
                            </span>
                            <Show when={TOOL_WARNINGS[tool] && tools().includes(tool)}>
                              <span class="roles-warning">
                                <Icon name="alertTriangle" /> {t(TOOL_WARNINGS[tool] ?? "")}
                              </span>
                            </Show>
                          </span>
                        </label>
                      )}
                    </For>
                  </div>
                  <p class="roles-hint roles-hint--locked">
                    <Icon name="lock" /> {t("rolesPage.toolsLockedHint")}
                  </p>
                </div>
              }
            />
          </Show>
        </Show>
      </SettingsSection>
      <SettingsSection
        title={t("rolesPage.scopesHeading")}
        description={t("rolesPage.scopesDescription")}
      >
        <Show when={issues().includes("noScopes")}>
          <span class="roles-error roles-error--section" role="alert">
            {t("rolesPage.issueNoScopes")}
          </span>
        </Show>
        <For each={ROLE_SCOPES}>
          {([scope, key]) => (
            <label
              class={[
                "settings-row",
                "roles-scope",
                { "roles-scope--danger": scope === ADMIN_SCOPE && view().scopes.includes(scope) },
              ]}
            >
              <Checkbox
                checked={view().scopes.includes(scope)}
                disabled={!editable()}
                onChange={(event) => {
                  const on = event.currentTarget.checked;
                  edit((role) => {
                    role.scopes = toggle(role.scopes, scope, on);
                  });
                }}
              />
              <span class="settings-row__text">
                <span class="settings-row__title">
                  {t("rolesScopes." + key + ".label")} <RawId>{scope}</RawId>
                </span>
                <span class="settings-row__desc">{t("rolesScopes." + key + ".description")}</span>
                <Show when={scope === ADMIN_SCOPE && view().scopes.includes(scope)}>
                  <span class="roles-warning">
                    <Icon name="alertTriangle" /> {t("rolesPage.adminWarning")}
                  </span>
                </Show>
              </span>
            </label>
          )}
        </For>
      </SettingsSection>
      <SettingsSection title={t("rolesPage.removeHeading")}>
        <SettingsRow
          title={t("rolesPage.deleteRole")}
          description={
            isDefault()
              ? t("rolesPage.deleteDefault")
              : people().length
                ? t("rolesPage.deletePeople", { count: String(people().length) })
                : t("rolesPage.deleteNobody")
          }
          control={
            <button
              type="button"
              class="btn btn--sm danger"
              disabled={!editable() || isDefault()}
              onClick={() => props.onDelete()}
            >
              {t("rolesPage.delete")}
            </button>
          }
        />
      </SettingsSection>
      <Show when={dirty()}>
        <div class="roles-savebar" role="region" aria-label={t("rolesPage.unsaved")}>
          <div class="roles-savebar__text">
            <strong>{t("rolesPage.unsaved")}</strong>
            <span>{issues().length ? t("rolesPage.issuesTitle") : reconnectMessage()}</span>
          </div>
          <button type="button" class="btn btn--sm" disabled={props.roles.busy()} onClick={discard}>
            {t("rolesPage.discard")}
          </button>
          <button
            type="button"
            class="btn btn--sm primary"
            disabled={!editable() || issues().length > 0}
            aria-busy={props.roles.busy() ? "true" : undefined}
            onClick={() => void save()}
          >
            <Show when={props.roles.busy()}>
              <span class="btn__spinner" aria-hidden="true" />{" "}
            </Show>
            {props.roles.busy() ? t("rolesPage.saving") : t("rolesPage.save")}
          </button>
        </div>
      </Show>
    </div>
  );
}
