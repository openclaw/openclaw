import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  seedSkillLibrarySelection,
  type PreparedSkillLibrarySession,
} from "../skills/library/selection.js";
import { currentOwnerDevicePrincipal } from "./openclaw-id/tunnel-principal.js";
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
  // A linked owner device seeds with the owner's library permissions (OCF-510).
  const ownerDevice = currentOwnerDevicePrincipal(client) !== undefined;
  const presentation = prepared?.presentation;
  return {
    ...creation,
    // First chat sends have no row for an authoring patch yet. Commit their
    // prompt facts with creation so a restart does not drop the listed tool.
    ...(presentation?.profileId && presentation.defaultTarget !== "unavailable"
      ? {
          skillLibraryPromptListing: {
            multipleProfiles: presentation.multipleProfiles,
            defaultTarget: presentation.defaultTarget,
          },
        }
      : {}),
    skillLibrarySelections:
      prepared?.selections ??
      (await seedSkillLibrarySelection({
        profileId: client.authenticatedUserProfile.profileId,
        scopes: client.connect.scopes ?? [],
        ...(ownerDevice ? { ownerDevice } : {}),
        getConfig: typeof cfg === "function" ? cfg : () => cfg,
        assertCurrent: () => {
          if (ownerDevice && currentOwnerDevicePrincipal(client) === undefined) {
            throw new Error("OpenClaw ID owner device changed. Reconnect and try again.");
          }
        },
      })),
  };
}
