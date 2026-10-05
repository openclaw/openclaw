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
import {
  asToolParamsRecord,
  jsonResult,
  readNumberParam,
  readToolStringParam,
  type AnyAgentTool,
} from "./common.js";

export function createInstalledSkillTools(skills: readonly InstalledSkill[]): AnyAgentTool[] {
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
        parameters: Type.Object({
          query: Type.String({ minLength: 1, maxLength: 1000 }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        }),
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
          "Load complete SKILL.md instructions for an exact installed skill name. Use a known name directly; search is not required first. Omit relativePath for instructions; use it for a bounded companion under a non-sandbox local Gateway skill directory. Other placements remain instruction-only. Does not execute the skill or grant additional tool permissions.",
        parameters: Type.Object({
          name: Type.String({ minLength: 1 }),
          relativePath: Type.Optional(Type.String({ minLength: 1 })),
        }),
        execute: async (_id, args, signal) => {
          const params = asToolParamsRecord(args);
          const name = readToolStringParam(params, "name", { required: true });
          const relativePath = readToolStringParam(params, "relativePath", {
            required: params.relativePath !== undefined || params.relative_path !== undefined,
            trim: false,
          });
          const content = await readInstalledSkill(skills, name, signal, relativePath);
          return { content: [{ type: "text", text: content }], details: { name, content } };
        },
      },
      readerBinding,
    ),
  ];
}
