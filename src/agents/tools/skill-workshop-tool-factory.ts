import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionToolDiscoveryPresentation } from "../../config/sessions/tool-discovery.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillLibraryAuthoringCapability } from "../../skills/library/authoring.js";
import { SkillLibraryError } from "../../skills/skill-library-error.js";
import { resolveSkillWorkshopToolConstructionBlock } from "../../skills/workshop/tool-availability.js";
import type { AnyAgentTool } from "./common.js";
import { createLibrarySkillWorkshopDeclaration } from "./skill-workshop-tool-declaration.js";
import { createLibrarySkillWorkshopTool } from "./skill-workshop-tool-library.js";
import {
  SKILL_WORKSHOP_DESCRIPTION,
  SkillWorkshopToolSchema,
} from "./skill-workshop-tool-schema.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

/** Run-scoped Workshop authority chosen by the run owner, never by tool arguments. */
export type SkillWorkshopRunOptions = {
  /** Originating session of a background review; turns on the review guard. */
  reviewOf?: string;
  libraryAuthoring?: SkillLibraryAuthoringCapability;
  presentation?: SessionToolDiscoveryPresentation["workshop"];
};

/** Session tool-list step: omits Workshop when this run may neither present nor execute it. */
export function createSessionSkillWorkshopTool(
  params: Omit<Parameters<typeof createConfiguredSkillWorkshopTool>[0], "config"> & {
    config?: OpenClawConfig;
  },
): AnyAgentTool | null {
  const { config } = params;
  return resolveSkillWorkshopToolConstructionBlock({
    sandboxed: params.sandboxed,
    libraryAuthoring: params.run?.libraryAuthoring,
    presentation: params.run?.presentation,
  }) || !config
    ? null
    : createConfiguredSkillWorkshopTool({ ...params, config });
}

export function createConfiguredSkillWorkshopTool(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  runId?: string;
  run?: SkillWorkshopRunOptions;
  sandboxed?: boolean;
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
  const execution = libraryAuthoring
    ? createLibrarySkillWorkshopTool(
        libraryAuthoring,
        libraryAuthoring.defaultTarget === "workspace" ? createWorkshop() : undefined,
        { sandboxed: params.sandboxed },
      )
    : createWorkshop();
  const presentation = params.run?.presentation;
  if (!presentation) {
    return execution;
  }
  return {
    ...execution,
    ...createLibrarySkillWorkshopDeclaration(
      presentation,
      presentation.defaultTarget === "workspace"
        ? { description: SKILL_WORKSHOP_DESCRIPTION, parameters: SkillWorkshopToolSchema }
        : undefined,
    ),
    execute: async (id, raw, ...rest) => {
      const personal =
        presentation.defaultTarget === "personal" ||
        (raw !== null && typeof raw === "object" && "target" in raw);
      if (
        (personal && !libraryAuthoring) ||
        (!personal && libraryAuthoring?.defaultTarget === "personal") ||
        (!personal && !libraryAuthoring && params.sandboxed)
      ) {
        throw new SkillLibraryError(
          "AUTHORITY_EXPIRED",
          "Skill authoring needs a fresh message from the person requesting the change.",
        );
      }
      return execution.execute(id, raw, ...rest);
    },
  };
}
