import { Type } from "typebox";
import {
  bindAgentToolAvailability,
  getAgentToolAvailabilityBinding,
  type AgentToolAvailabilityBinding,
} from "../agent-tool-availability.js";
import {
  readInstalledSkill,
  searchInstalledSkills,
  type InstalledSkill,
} from "../installed-skill-catalog.js";
import { createSkillInstructionPage } from "../skill-instruction-page.js";
import { rememberSkillInstructionDelivery } from "../skill-instruction-result.js";
import type { ToolResultBudget } from "../tool-result-limits.js";
import {
  asToolParamsRecord,
  jsonResult,
  readNumberParam,
  readToolStringParam,
  type AnyAgentTool,
} from "./common.js";

const SkillsSearchSchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 1000 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
});
const SkillsReadSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  relativePath: Type.Optional(Type.String({ minLength: 1 })),
  cursor: Type.Optional(Type.String({ minLength: 1 })),
});

export function createInstalledSkillTools(
  skills: readonly InstalledSkill[],
  budget?: ToolResultBudget,
): AnyAgentTool[] {
  if (skills.length === 0) {
    return [];
  }
  const readerBinding: AgentToolAvailabilityBinding = { prepare() {} };
  let readAuthority: object | undefined;
  return [
    bindAgentToolAvailability<AnyAgentTool>(
      {
        name: "skills_search",
        label: "Search Installed Skills",
        description:
          "Find relevant installed, eligible skills by task or exact name, including skills omitted from the prompt directory. Searches names and descriptions, plus bounded instruction text when skill reads are allowed. Returns metadata only; coverage reports any incomplete body indexing. Read the selected skill's whole instructions before applying it. Does not search ClawHub or install anything.",
        parameters: SkillsSearchSchema,
        execute: async (_id, args, signal) => {
          signal?.throwIfAborted();
          const params = asToolParamsRecord(args);
          const authority = readAuthority;
          return jsonResult(
            await searchInstalledSkills(
              skills,
              readToolStringParam(params, "query", { required: true }),
              readNumberParam(params, "limit"),
              signal,
              () => authority !== undefined && readAuthority === authority,
            ),
          );
        },
      },
      {
        prepare(_tool, callableTools) {
          const reader = callableTools.get("skills_read");
          if (reader && getAgentToolAvailabilityBinding(reader) === readerBinding) {
            readAuthority ??= {};
          } else {
            // A regrant gets a new identity; work started under a revoked grant stays revoked.
            readAuthority = undefined;
          }
        },
      },
    ),
    bindAgentToolAvailability<AnyAgentTool>(
      {
        name: "skills_read",
        label: "Read Installed Skill",
        description:
          "Read a bounded page of SKILL.md instructions for an exact installed skill name; search is not required first. Optional relativePath reads a UTF-8 text companion (up to 256 KiB) inside a local skill directory. Restricted placements are instruction-only. Pass nextCursor as cursor until it is null; read every page before applying instructions. Does not execute files or grant command permissions.",
        parameters: SkillsReadSchema,
        execute: async (_id, args, signal) => {
          const params = asToolParamsRecord(args);
          const name = readToolStringParam(params, "name", { required: true });
          const relativePath = readToolStringParam(params, "relativePath", {
            required: params.relativePath !== undefined || params.relative_path !== undefined,
            trim: false,
          });
          const instructions = await readInstalledSkill(skills, name, signal, relativePath);
          const result = createSkillInstructionPage(instructions, params.cursor, budget);
          if (
            relativePath === undefined &&
            result.details.startByte === 0 &&
            result.details.nextCursor === null
          ) {
            rememberSkillInstructionDelivery(result, instructions.content);
          }
          return result;
        },
      },
      readerBinding,
    ),
  ];
}
