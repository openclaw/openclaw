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
  formatSkillInstructions,
  rememberSkillInstructionDelivery,
  type SkillInstructionResult,
} from "../skill-instruction-result.js";
import {
  resolveToolResultBudget,
  toolResultFitsBudget,
  type ToolResultBudget,
} from "../tool-result-limits.js";
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
});

// Covers the deferred dispatch envelope that wraps this text as a JSON string.
const DISPATCH_ENVELOPE_RESERVE_CHARS = 512;

function fitsModelOutput(text: string, budget: ToolResultBudget): boolean {
  return toolResultFitsBudget(JSON.stringify(text), {
    maxChars: budget.maxChars - DISPATCH_ENVELOPE_RESERVE_CHARS,
    maxContextChars: budget.maxContextChars - DISPATCH_ENVELOPE_RESERVE_CHARS * 2,
  });
}

/**
 * Fit SKILL.md text to the model output budget. An oversized document returns its
 * first lines and names the `read` call that continues it, instead of letting a
 * generic output cap remove the middle without a way to recover it.
 */
function formatSkillInstructionsForModel(
  instructions: SkillInstructionResult,
  budget: ToolResultBudget | undefined,
  readCallable: boolean,
): { text: string; whole: boolean } {
  const text = formatSkillInstructions(instructions);
  if (!budget || instructions.relativePath !== undefined || fitsModelOutput(text, budget)) {
    return { text, whole: true };
  }
  const lines = instructions.content.split("\n");
  const header = formatSkillInstructions({ ...instructions, content: "" });
  const render = (shown: number) => {
    const notice = readCallable
      ? `[Skill instructions incomplete: showing lines 1-${shown} of ${lines.length}. Before acting, read the rest with read(${JSON.stringify({ path: instructions.location, offset: shown + 1 })}) and follow each continuation until the end.]`
      : `[Skill instructions incomplete: showing lines 1-${shown} of ${lines.length}. Before acting, read the rest of ${instructions.location} from line ${shown + 1} with an available file tool. If none can read it, tell the user that this skill is too large to load and should move detail into references/ files.]`;
    return `${header}${lines.slice(0, shown).join("\n")}\n\n${notice}`;
  };
  // Accepted edge case: a single line larger than the budget shows no lines; read
  // continues long lines with its own cursor.
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fitsModelOutput(render(middle), budget)) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { text: render(low), whole: false };
}

export function createInstalledSkillTools(
  skills: readonly InstalledSkill[],
  options?: { modelContextWindowTokens?: number },
): AnyAgentTool[] {
  if (skills.length === 0) {
    return [];
  }
  const budget = resolveToolResultBudget(options?.modelContextWindowTokens);
  let readCallable = false;
  const readerBinding: AgentToolAvailabilityBinding = {
    prepare(_tool, callableTools) {
      readCallable = callableTools.has("read");
    },
  };
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
          "Load complete SKILL.md instructions for an exact installed skill name; search is not required first. Optional relativePath reads a UTF-8 text companion (up to 256 KiB) inside a local skill directory. Restricted placements are instruction-only. Does not execute files or grant command permissions.",
        parameters: SkillsReadSchema,
        execute: async (_id, args, signal) => {
          const params = asToolParamsRecord(args);
          const name = readToolStringParam(params, "name", { required: true });
          const relativePath = readToolStringParam(params, "relativePath", {
            required: params.relativePath !== undefined || params.relative_path !== undefined,
            trim: false,
          });
          const instructions = await readInstalledSkill(skills, name, signal, relativePath);
          const { text, whole } = formatSkillInstructionsForModel(
            instructions,
            budget,
            readCallable,
          );
          // Details keep the complete document for Code Mode values; only model text pages.
          const result = {
            content: [{ type: "text" as const, text }],
            details: instructions,
          };
          if (relativePath === undefined && whole) {
            rememberSkillInstructionDelivery(result, instructions.content);
          }
          return result;
        },
      },
      readerBinding,
    ),
  ];
}
