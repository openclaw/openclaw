import { Match, Show, Switch } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { isAdminRole, participantTools, type RoleDefinition } from "./role-catalog.ts";

export const PERMISSION_KEYS = {
  "read-only": "readOnly",
  guarded: "guarded",
  workspace: "workspace",
  full: "full",
} as const;

function othersLabel(definition: RoleDefinition) {
  return t("rolesOptions.others." + definition.sessions.others + ".label");
}

/** One line for the role list: session reach, sandbox, agents and admin. */
export function roleFacts(definition: RoleDefinition, agentCount: number): string {
  const parts = [
    definition.sessions.others === "invited"
      ? t("rolesOptions.others.invited.label") +
        " · " +
        t("rolesOptions.access." + (definition.sessions.maxInvitedAccess ?? "read") + ".label")
      : othersLabel(definition),
  ];
  if (definition.sandbox === "required") {
    parts.push(t("rolesPage.summarySandboxed"));
  }
  if (Array.isArray(definition.agents)) {
    parts.push(definition.agents.join(", ") || t("rolesPage.summaryNoAgents"));
  } else if (agentCount > 1) {
    parts.push(t("rolesPage.allAgents"));
  }
  return parts.join(" · ");
}

/** What someone with the role can do, split into their own sessions and other people's. */
export function RoleSummary(props: {
  definition: RoleDefinition;
  agentName: (id: string) => string;
}) {
  const d = () => props.definition;
  const agents = () => {
    const value = d().agents;
    return value === "*"
      ? t("rolesPage.summaryAnyAgent")
      : value.map(props.agentName).join(", ") || t("rolesPage.summaryNoAgents");
  };
  const canStart = () =>
    d().scopes.some((scope) =>
      ["operator.sessions.write", "operator.write", "operator.admin"].includes(scope),
    );
  const access = () =>
    t("rolesOptions.access." + (d().sessions.maxInvitedAccess ?? "read") + ".label");
  const permission = () =>
    t(
      "rolesOptions.permission." +
        PERMISSION_KEYS[d().sessions.invitedPermission ?? "workspace"] +
        ".label",
    );
  return (
    <div class="roles-summary">
      <div class="roles-summary__column">
        <h3>{t("rolesPage.ownSessions")}</h3>
        <ul>
          <Show
            when={canStart()}
            fallback={<li class="roles-summary__muted">{t("rolesPage.summaryCannotStart")}</li>}
          >
            <li>{t("rolesPage.summaryStart", { agents: agents() })}</li>
          </Show>
          <li>
            {d().sandbox === "required"
              ? t("rolesPage.summarySandboxed")
              : t("rolesPage.summaryInheritSandbox")}
          </li>
          <Show when={isAdminRole(d())}>
            <li class="roles-summary__danger">{t("rolesPage.summaryAdmin")}</li>
          </Show>
        </ul>
      </div>
      <div class="roles-summary__column">
        <h3>{t("rolesPage.othersSessions")}</h3>
        <ul>
          <Switch>
            <Match when={d().sessions.others === "none"}>
              <li class="roles-summary__muted">{t("rolesPage.summaryNone")}</li>
            </Match>
            <Match when={d().sessions.others === "invited"}>
              <li>{t("rolesPage.summaryInvited")}</li>
              <li>{t("rolesPage.summaryInvitedAccess", { access: access() })}</li>
              <Show when={d().sessions.maxInvitedAccess === "send"}>
                <li>
                  {t("rolesPage.summaryInvitedTurns", {
                    permission: permission(),
                    count: String(participantTools(d()).length),
                  })}
                </li>
              </Show>
            </Match>
            <Match when={d().sessions.others === "view"}>
              <li>{t("rolesPage.summaryView")}</li>
            </Match>
            <Match when={d().sessions.others === "suggest"}>
              <li>{t("rolesPage.summarySuggest")}</li>
            </Match>
            <Match when={d().sessions.others === "write"}>
              <li>{t("rolesPage.summaryWrite")}</li>
            </Match>
          </Switch>
          <li class="roles-summary__muted">{t("rolesPage.summaryPrivate")}</li>
        </ul>
      </div>
    </div>
  );
}
