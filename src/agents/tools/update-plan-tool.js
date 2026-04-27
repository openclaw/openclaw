import { Type } from "typebox";
import { stringEnum } from "../schema/typebox.js";
import { describeUpdatePlanTool, UPDATE_PLAN_TOOL_DISPLAY_SUMMARY, } from "../tool-description-presets.js";
import { ToolInputError, readStringParam } from "./common.js";
const PLAN_STEP_STATUSES = ["pending", "in_progress", "completed"];
const UpdatePlanToolSchema = Type.Object({
    explanation: Type.Optional(Type.String({
        description: "Optional short note explaining what changed in the plan.",
    })),
    plan: Type.Array(Type.Object({
        step: Type.String({ description: "Short plan step." }),
        status: stringEnum(PLAN_STEP_STATUSES, {
            description: 'One of "pending", "in_progress", or "completed".',
        }),
    }, { additionalProperties: true }), {
        minItems: 1,
        description: "Ordered list of plan steps. At most one step may be in_progress.",
    }),
});
function readPlanSteps(params) {
    const rawPlan = params.plan;
    if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
        throw new ToolInputError("plan required");
    }
    const steps = rawPlan.map((entry, index) => {
        if (!entry || typeof entry !== "object") {
            throw new ToolInputError(`plan[${index}] must be an object`);
        }
        const stepParams = entry;
        const step = readStringParam(stepParams, "step", {
            required: true,
            label: `plan[${index}].step`,
        });
        const status = readStringParam(stepParams, "status", {
            required: true,
            label: `plan[${index}].status`,
        });
        if (!PLAN_STEP_STATUSES.includes(status)) {
            throw new ToolInputError(`plan[${index}].status must be one of ${PLAN_STEP_STATUSES.join(", ")}`);
        }
        return {
            step,
            status: status,
        };
    });
    const inProgressCount = steps.filter((entry) => entry.status === "in_progress").length;
    if (inProgressCount > 1) {
        throw new ToolInputError("plan can contain at most one in_progress step");
    }
    return steps;
}
export function createUpdatePlanTool() {
    return {
        label: "Update Plan",
        name: "update_plan",
        displaySummary: UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
        description: describeUpdatePlanTool(),
        parameters: UpdatePlanToolSchema,
        execute: async (_toolCallId, args) => {
            const params = args;
            const explanation = readStringParam(params, "explanation");
            const plan = readPlanSteps(params);
            return {
                content: [],
                details: {
                    status: "updated",
                    ...(explanation ? { explanation } : {}),
                    plan,
                },
            };
        },
    };
}
