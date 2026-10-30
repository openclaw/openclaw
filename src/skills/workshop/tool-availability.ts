import type { SessionToolDiscoveryPresentation } from "../../config/sessions/tool-discovery.types.js";
import type { SkillLibraryAuthoringCapability } from "../library/authoring.js";

/** A saved declaration may remain visible; execution still requires its own live authority. */
export function resolveSkillWorkshopToolConstructionBlock(context: {
  sandboxed?: boolean;
  libraryAuthoring?: SkillLibraryAuthoringCapability;
  presentation?: SessionToolDiscoveryPresentation["workshop"];
}): { detail: string; fix: string } | undefined {
  if (context.sandboxed && !context.libraryAuthoring && !context.presentation) {
    return {
      detail:
        '"skill_workshop" is unavailable in a sandboxed run without library-authoring authority.',
      fix: "Use a non-sandboxed session for this agent, or a human turn with host-granted library-authoring authority. The openclaw skills workshop CLI is also available.",
    };
  }
  return undefined;
}
