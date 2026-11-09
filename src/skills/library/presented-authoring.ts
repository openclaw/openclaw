import type { SessionToolDiscoveryPresentation } from "../../config/sessions/tool-discovery.types.js";
import { SkillLibraryError } from "../skill-library-error.js";
import type { SkillLibraryAuthoringCapability } from "./authoring.js";

/**
 * Keeps a conversation's library tool shape on turns without a live grant.
 *
 * A saved presentation declares skill_library and keeps Workshop's personal or workspace
 * default, as the human turn did. It grants nothing: library calls refuse, and Workshop
 * keeps the ordinary no-grant rule, so this neither revokes nor widens workspace access.
 */
export function resolvePresentedSkillLibraryAuthoring(
  authoring: SkillLibraryAuthoringCapability | undefined,
  presentation: SessionToolDiscoveryPresentation["workshop"],
): SkillLibraryAuthoringCapability | undefined {
  if (authoring || !presentation) {
    return authoring;
  }
  return {
    target: "personal",
    defaultTarget: presentation.defaultTarget,
    multipleProfiles: presentation.multipleProfiles,
    bind: () => {},
    invoke: async () => {
      throw new SkillLibraryError(
        "AUTHORITY_EXPIRED",
        "Skill authoring needs a fresh message from the person requesting the change.",
      );
    },
  };
}
