import type { SkillLibrarySelection } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateReadCaller } from "../../state/openclaw-state-read.types.js";

export async function readSkillLibrarySelectionDescriptions(
  selections: readonly Pick<SkillLibrarySelection, "skillId" | "revision">[],
  caller: OpenClawStateReadCaller,
) {
  const result = await executeExistingOpenClawStateRead(
    { path: caller.context.admission.databasePath, env: caller.context.environment },
    {
      type: "skills.library.descriptions",
      input: selections.map(({ skillId, revision }) => ({ skillId, revision })),
    },
    caller,
  );
  if (result === undefined) {
    return undefined;
  }
  if (result.ok && result.type === "skills.library.descriptions") {
    return result.value;
  }
  throw new Error("Unexpected skill library descriptions result");
}

export async function readSkillLibrarySelectionManifests(
  selections: readonly Pick<SkillLibrarySelection, "skillId" | "revision">[],
  caller: OpenClawStateReadCaller,
) {
  if (!selections.length) {
    return [];
  }
  const result = await executeExistingOpenClawStateRead(
    { path: caller.context.admission.databasePath, env: caller.context.environment },
    {
      type: "skills.library.manifests",
      input: selections.map(({ skillId, revision }) => ({ skillId, revision })),
    },
    caller,
  );
  if (result === undefined) {
    return undefined;
  }
  if (result.ok && result.type === "skills.library.manifests") {
    return result.value;
  }
  throw new Error("Unexpected skill library manifests result");
}
