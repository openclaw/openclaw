import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillLibraryAuthoringCapability } from "../../skills/library/authoring.js";
import type { AnyAgentTool } from "./common.js";
import { createLibrarySkillWorkshopTool } from "./skill-workshop-tool-library.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

/** Run-scoped Workshop authority chosen by the run owner, never by tool arguments. */
export type SkillWorkshopRunOptions = {
  /** Originating session of a background review; turns on the review guard. */
  reviewOf?: string;
  libraryAuthoring?: SkillLibraryAuthoringCapability;
};

export function createConfiguredSkillWorkshopTool(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  runId?: string;
  run?: SkillWorkshopRunOptions;
}): AnyAgentTool {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const runId = normalizeOptionalString(params.runId);
  const createWorkshop = () =>
    createSkillWorkshopTool({
      config: params.config,
      agentId: params.agentId,
      ...(sessionKey ? { sessionKey } : {}),
      ...(runId ? { runId } : {}),
      ...(params.run?.reviewOf ? { reviewOf: params.run.reviewOf } : {}),
    });
  const libraryAuthoring = params.run?.libraryAuthoring;
  if (!libraryAuthoring) {
    return createWorkshop();
  }
  return createLibrarySkillWorkshopTool(
    libraryAuthoring,
    libraryAuthoring.defaultTarget === "workspace" ? createWorkshop() : undefined,
  );
}
