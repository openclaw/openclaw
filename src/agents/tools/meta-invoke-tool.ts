import { Type } from "typebox";
import type { MetaSkillCatalog } from "../../skills/meta/catalog.js";
import type { MetaRunResult, RunMetaPlanOptions } from "../../skills/meta/runner.js";
import type { MetaPlan } from "../../skills/meta/types.js";
import {
  type AnyAgentTool,
  ToolInputError,
  asToolParamsRecord,
  readStringParam,
  textResult,
} from "./common.js";

const MetaInvokeToolSchema = Type.Object(
  {
    skill_name: Type.String({
      description: "Registered meta skill name.",
    }),
    input: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: true,
          description: "Optional plain-object input for the meta skill.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

export type MetaInvokeRunPlan = (
  options: Pick<RunMetaPlanOptions, "plan" | "input"> & {
    parentToolCallId?: string;
  },
) => Promise<MetaRunResult>;

function findMetaPlanByName(catalog: MetaSkillCatalog, name: string): MetaPlan | undefined {
  return catalog.plans.find((plan) => plan.name === name);
}

function readInputParam(params: Record<string, unknown>): Record<string, unknown> {
  const input = params.input;
  if (input === undefined) {
    return {};
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolInputError("input must be an object");
  }
  return input as Record<string, unknown>;
}

export function createMetaInvokeTool(options: {
  catalog: MetaSkillCatalog;
  runPlan: MetaInvokeRunPlan;
}): AnyAgentTool {
  return {
    label: "Meta Invoke",
    name: "meta_invoke",
    displaySummary: "Invoke a registered meta skill.",
    description: "Run a registered meta skill by name with optional structured input.",
    parameters: MetaInvokeToolSchema,
    execute: async (toolCallId, args) => {
      const params = asToolParamsRecord(args);
      const skillName = readStringParam(params, "skill_name", { required: true });

      const plan = findMetaPlanByName(options.catalog, skillName);
      if (!plan) {
        throw new ToolInputError(`Unknown meta skill: ${skillName}`);
      }

      const input = readInputParam(params);
      const result = await options.runPlan({
        plan,
        input,
        parentToolCallId: toolCallId,
      });

      return textResult(result.finalText, {
        status: result.status,
        skillName: plan.name,
        steps: result.steps,
        outputs: result.outputs,
      });
    },
  };
}
