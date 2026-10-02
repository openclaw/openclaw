import { html } from "lit";
import type { UserProfile } from "../../../../packages/gateway-protocol/src/schema/users.js";
import {
  renderSettingsEmpty,
  renderSettingsNavRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { ProfileRoleChoice } from "./role-policy.ts";

export function personName(person: UserProfile): string {
  return (
    person.displayName?.trim() || person.githubIdentity?.login || t("profilePage.people.person")
  );
}

export function renderDirectorySearch(
  query: string,
  label: string,
  onChange: (query: string) => void,
) {
  return html`<input
    type="search"
    class="settings-input"
    aria-label=${label}
    placeholder=${label}
    .value=${query}
    @input=${(event: Event) => {
      if (event.currentTarget instanceof HTMLInputElement) {
        onChange(event.currentTarget.value);
      }
    }}
  />`;
}

export function renderRoleMembers(
  title: string,
  entries: Array<{ person: UserProfile; choice: ProfileRoleChoice }> | undefined,
  loading: boolean,
  select: (id: string) => void,
) {
  const copy = (key: string) => t(`profilePage.people.${key}`);
  return renderSettingsSection(
    { title, count: entries?.length },
    entries === undefined
      ? renderSettingsEmpty(copy(loading ? "membersLoading" : "membersUnavailable"))
      : !entries.length
        ? renderSettingsEmpty(copy("noRoleMembers"))
        : entries.map(({ person, choice }) =>
            renderSettingsNavRow({
              title: personName(person),
              description:
                choice.kind === "owner"
                  ? copy("owner")
                  : choice.kind === "unresolved"
                    ? copy("noPolicy")
                    : choice.source === "retired"
                      ? t("profilePage.people.retiredAssignment", { role: person.role ?? "" })
                      : undefined,
              onClick: () => select(person.id),
            }),
          ),
  );
}
