import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillLibraryAuthoringCapability } from "../../skills/library/authoring.js";
import { resolveSkillWorkshopToolConstructionBlock } from "../../skills/workshop/tool-availability.js";
import type { AnyAgentTool } from "./common.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

/** Run-scoped Workshop authority chosen by the run owner, never by tool arguments. */
export type SkillWorkshopRunOptions = {
  /** Originating session of a background review; turns on the review guard. */
  reviewOf?: string;
};

/**
 * Builds the Workshop tool for this run, or none.
 *
 * A personal-default library turn authors only through `skill_library`. A
 * workspace-default turn keeps Workshop, guarded by the capability's current
 * admin authority; that guard also admits sandboxed runs.
 */
export function createConfiguredSkillWorkshopTool(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  runId?: string;
  run?: SkillWorkshopRunOptions;
  libraryAuthoring?: SkillLibraryAuthoringCapability;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const { libraryAuthoring, sandboxed } = params;
  if (
    libraryAuthoring?.defaultTarget === "personal" ||
    resolveSkillWorkshopToolConstructionBlock({ sandboxed, libraryAuthoring })
  ) {
    return null;
  }
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const runId = normalizeOptionalString(params.runId);
  const workshop = createSkillWorkshopTool({
    config: params.config,
    agentId: params.agentId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
    ...(params.run?.reviewOf ? { reviewOf: params.run.reviewOf } : {}),
  });
  if (!libraryAuthoring) {
    return workshop;
  }
  return {
    ...workshop,
    execute: (id, raw, ...rest) => {
      libraryAuthoring.assertWorkspaceCurrent?.({ sandboxed });
      return workshop.execute(id, raw, ...rest);
    },
  };
}
