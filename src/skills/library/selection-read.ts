import type { SkillLibrarySelection } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";

export async function readSkillLibrarySelectionDescriptions(
  selections: readonly Pick<SkillLibrarySelection, "skillId" | "revision">[],
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env">,
) {
  const result = await executeExistingOpenClawStateRead(options, {
    type: "skills.library.descriptions",
    input: selections.map(({ skillId, revision }) => ({ skillId, revision })),
  });
  return result?.value;
}

export async function readSkillLibrarySelectionManifests(
  selections: readonly Pick<SkillLibrarySelection, "skillId" | "revision">[],
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env">,
) {
  if (!selections.length) {
    return [];
  }
  const result = await executeExistingOpenClawStateRead(options, {
    type: "skills.library.manifests",
    input: selections.map(({ skillId, revision }) => ({ skillId, revision })),
  });
  return result?.value;
}
