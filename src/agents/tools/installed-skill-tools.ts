import { Type } from "typebox";
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
  return [
    {
      name: "skills_search",
      label: "Search Installed Skills",
      description:
        "Find relevant installed, eligible skills by task or exact name, including skills omitted from the prompt directory. Returns metadata only. Does not search ClawHub or install anything.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 1000 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }),
      execute: async (_id, args, signal) => {
        signal?.throwIfAborted();
        const params = asToolParamsRecord(args);
        return jsonResult(
          searchInstalledSkills(
            skills,
            readToolStringParam(params, "query", { required: true }),
            readNumberParam(params, "limit"),
          ),
        );
      },
    },
    {
      name: "skills_read",
      label: "Read Installed Skill",
      description:
        "Load complete SKILL.md instructions for an exact installed skill name. Use a known name directly; search is not required first. Does not execute the skill or grant additional tool permissions.",
      parameters: Type.Object({ name: Type.String({ minLength: 1 }) }),
      execute: async (_id, args, signal) => {
        const params = asToolParamsRecord(args);
        const name = readToolStringParam(params, "name", { required: true });
        const content = await readInstalledSkill(skills, name, signal);
        return { content: [{ type: "text", text: content }], details: { name, content } };
      },
    },
  ];
}
