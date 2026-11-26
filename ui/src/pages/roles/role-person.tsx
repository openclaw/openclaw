import { For, Show } from "solid-js";
import {
  personActivityLink,
  personActivityRouting,
} from "../../components/person-activity-link.ts";
import {
  IdentityAvatarImage,
  createIdentityAvatarPresentation,
} from "../../components/solid/identity-avatar-image.tsx";
import { useIdentityAvatarView } from "../../components/solid/identity-avatar-view.ts";
import { profileAvatarUrl } from "../../lib/profile-directory.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { RoleProfile } from "./use-roles.ts";

export function profileLabel(profile: RoleProfile): string {
  return profile.displayName ?? profile.githubIdentity?.login ?? profile.emails[0] ?? profile.id;
}

export function RoleAvatar(props: { profile: RoleProfile }) {
  const view = useIdentityAvatarView(() => ({
    id: props.profile.id,
    identity: { type: "profile", id: props.profile.id },
    name: profileLabel(props.profile),
    profileAvatarUrl: profileAvatarUrl(props.profile),
  }));
  const presentation = createIdentityAvatarPresentation(view);
  return (
    <span
      class={["roles-avatar", presentation.classes()]}
      data-avatar-state={presentation.state()}
      aria-hidden="true"
    >
      <Show when={Boolean(view().imageUrl)}>
        <IdentityAvatarImage view={view()} onStateChange={presentation.onStateChange} ariaHidden />
      </Show>
      <span class="roles-avatar__initials">{view().fallback.initials}</span>
    </span>
  );
}

export function roleSourceLabel(profile: RoleProfile): string {
  switch (profile.roleSource) {
    case "githubLogin":
      return t("rolesPage.sourceGithubLogin");
    case "default":
      return t("rolesPage.sourceDefault");
    default:
      return t("rolesPage.sourceAssigned");
  }
}

/** A person's name and avatar, linked to their page in People. */
export function RolePerson(props: { profile: RoleProfile }) {
  const context = useApplication();
  const link = () =>
    personActivityLink(
      props.profile.id,
      personActivityRouting(context),
      profileLabel(props.profile),
    );
  return (
    <span class="roles-person">
      <RoleAvatar profile={props.profile} />
      <span class="roles-person__text">
        <Show
          when={link()}
          fallback={<span class="roles-person__name">{profileLabel(props.profile)}</span>}
        >
          {(target) => (
            <a
              class="roles-person__name"
              href={target().href}
              onClick={(event) => target().open(event)}
            >
              {profileLabel(props.profile)}
            </a>
          )}
        </Show>
        <span class="roles-person__source">{roleSourceLabel(props.profile)}</span>
      </span>
    </span>
  );
}

export function RoleFacepile(props: { people: readonly RoleProfile[] }) {
  return (
    <span class="roles-facepile" aria-hidden="true">
      <For each={props.people.slice(0, 3)}>{(profile) => <RoleAvatar profile={profile} />}</For>
    </span>
  );
}
