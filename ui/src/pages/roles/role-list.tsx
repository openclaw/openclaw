import { For, Show } from "solid-js";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import {
  SettingsEmpty,
  SettingsNavRow,
  SettingsRow,
  SettingsSection,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { buildDefaultRole, isAdminRole } from "./role-catalog.ts";
import { RoleFacepile } from "./role-person.tsx";
import { roleFacts } from "./role-summary.tsx";
import type { RolesState } from "./use-roles.ts";

export function RoleList(props: {
  roles: RolesState;
  onOpen: (name: string) => void;
  onCreate: () => void;
}) {
  const context = useApplication();
  const catalog = () => props.roles.catalog();
  const agentCount = () => context.agents.state.agentsList?.agents.length ?? 0;
  const changeDefault = async (select: HTMLSelectElement) => {
    const name = select.value;
    const previous = catalog().defaultRole ?? "";
    if (!name || name === previous) {
      select.value = previous;
      return;
    }
    if (
      !previous &&
      !(await showConfirmDialog({
        title: t("rolesPage.defaultRole"),
        message: t("rolesPage.defaultRoleConfirm", { role: name }),
        confirmLabel: t("rolesPage.save"),
      }))
    ) {
      select.value = previous;
      return;
    }
    if (
      !(await props.roles.patch(
        (base) => buildDefaultRole(base, name),
        "Set default role " + name,
        t("rolesPage.saved"),
      ))
    ) {
      select.value = catalog().defaultRole ?? "";
    }
  };
  return (
    <>
      <SettingsSection title={t("rolesPage.newPeople")}>
        <SettingsRow
          title={t("rolesPage.defaultRole")}
          description={t("rolesPage.defaultRoleDescription")}
          stackedOnNarrow
          control={
            <SettingsSelect
              aria-label={t("rolesPage.defaultRole")}
              value={catalog().defaultRole ?? ""}
              disabled={!props.roles.editable()}
              options={[
                ...(catalog().defaultRole
                  ? []
                  : [{ value: "", label: t("rolesPage.defaultRoleNone") }]),
                ...catalog().roles.map((role) => ({ value: role.name, label: role.name })),
              ]}
              onChange={(event) => void changeDefault(event.currentTarget)}
            />
          }
        />
        <SettingsRow
          title={t("rolesPage.githubMappings")}
          description={t("rolesPage.githubMappingsDescription")}
          control={
            <SettingsValue
              value={t("rolesPage.githubMappingsCount", {
                count: String(Object.keys(catalog().githubMappings).length),
              })}
            />
          }
        />
      </SettingsSection>
      <SettingsSection
        title={t("rolesPage.rolesHeading")}
        count={catalog().roles.length}
        actions={
          <button
            type="button"
            class="btn btn--sm primary"
            disabled={!props.roles.editable()}
            onClick={() => props.onCreate()}
          >
            {t("rolesPage.newRole")}
          </button>
        }
      >
        <Show
          when={catalog().roles.length}
          fallback={<SettingsEmpty message={t("rolesPage.empty")} />}
        >
          <For each={catalog().roles}>
            {(role) => {
              const people = () => props.roles.people().get(role.name) ?? [];
              return (
                <SettingsNavRow
                  title={
                    <span class="roles-list__title">
                      {role.name}
                      <Show when={role.name === catalog().defaultRole}>
                        <span class="chip roles-chip">{t("rolesPage.defaultBadge")}</span>
                      </Show>
                      <Show when={isAdminRole(role.definition)}>
                        <span class="chip chip-warn roles-chip">{t("rolesPage.adminBadge")}</span>
                      </Show>
                    </span>
                  }
                  description={roleFacts(role.definition, agentCount())}
                  control={
                    <span class="roles-list__people">
                      <RoleFacepile people={people()} />
                      <span>
                        {people().length === 1
                          ? t("rolesPage.peopleCountOne")
                          : t("rolesPage.peopleCount", { count: String(people().length) })}
                      </span>
                    </span>
                  }
                  onClick={() => props.onOpen(role.name)}
                />
              );
            }}
          </For>
        </Show>
      </SettingsSection>
    </>
  );
}
