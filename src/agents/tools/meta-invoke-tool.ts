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

function formatMetaPlanCatalogForPrompt(catalog: MetaSkillCatalog): string {
  return catalog.plans
    .map((plan) => {
      const triggers = plan.triggers.map((trigger) => trigger.pattern).filter(Boolean);
      const triggerText =
        triggers.length > 0 ? ` Triggers: ${triggers.join(", ")}.` : " No declared triggers.";
      return `- ${plan.name}: ${plan.description}.${triggerText}`;
    })
    .join("\n");
}

function createMetaInvokeToolSchema(catalog: MetaSkillCatalog) {
  const catalogDescription = formatMetaPlanCatalogForPrompt(catalog);
  return Type.Object(
    {
      skill_name: Type.String({
        description: [
          "Registered meta skill name to invoke.",
          catalogDescription ? `Available meta skills:\n${catalogDescription}` : undefined,
        ]
          .filter(Boolean)
          .join("\n\n"),
      }),
      input: Type.Optional(
        Type.Object(
          {},
          {
            additionalProperties: true,
            description:
              "Optional plain-object input for the selected meta skill. Include fields requested by the selected skill's trigger, clarification, workflow description, or pending user_input pause.",
          },
        ),
      ),
    },
    { additionalProperties: false },
  );
}

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
    description: [
      "Run a registered meta skill workflow by name with optional structured input.",
      "Use this when the user request matches a cataloged meta skill trigger or description.",
      "If a previous meta skill invocation paused for user_input and the user now supplies the requested fields, call the same meta skill with those fields to resume the paused run.",
      formatMetaPlanCatalogForPrompt(options.catalog),
    ]
      .filter(Boolean)
      .join("\n\n"),
    parameters: createMetaInvokeToolSchema(options.catalog),
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
