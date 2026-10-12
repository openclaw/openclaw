import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  seedSkillLibrarySelection,
  type PreparedSkillLibrarySession,
} from "../skills/library/selection.js";
import type { GatewayClient } from "./server-methods/shared-types.js";
import type { TrustedSessionCreation } from "./session-creation-provenance.js";

/** Selection is prepared from this request's real principal, never reconstructed from provenance. */
export async function prepareSkillLibrarySessionCreation(
  client: GatewayClient | null | undefined,
  cfg: OpenClawConfig | (() => OpenClawConfig),
  creation: TrustedSessionCreation,
  prepared?: PreparedSkillLibrarySession,
): Promise<TrustedSessionCreation> {
  if (
    !client?.authenticatedUserProfile ||
    client.internal?.syntheticClient ||
    creation.via === "spawn"
  ) {
    return creation;
  }
  prepared?.assertCurrent();
  return {
    ...creation,
    skillLibrarySelections:
      prepared?.selections ??
      (await seedSkillLibrarySelection({
        profileId: client.authenticatedUserProfile.profileId,
        scopes: client.connect.scopes ?? [],
        getConfig: typeof cfg === "function" ? cfg : () => cfg,
        assertCurrent: () => {},
      })),
  };
}
