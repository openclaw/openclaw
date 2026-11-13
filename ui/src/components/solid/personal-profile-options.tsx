import { For } from "solid-js";
import {
  GATEWAY_OWNER_PROFILE_ID,
  type UserProfile,
} from "../../../../packages/gateway-protocol/src/schema/users.js";
import { userProfileDisplayName } from "../../../../src/shared/user-profile-display-name.js";

export function personalProfileChoices(profiles: readonly UserProfile[] = []) {
  return profiles.filter((person) => person.id !== GATEWAY_OWNER_PROFILE_ID && !person.mergedInto);
}

/** Selection and new/keep choices belong to each enrollment surface. */
export function PersonalProfileOptions(props: { profiles?: readonly UserProfile[] }) {
  return (
    <For each={personalProfileChoices(props.profiles)} keyed={(person) => person.id}>
      {(person) => (
        <option value={person().id}>
          {userProfileDisplayName(
            person().id,
            person().displayName,
            person().githubIdentity?.login,
          )}
        </option>
      )}
    </For>
  );
}
