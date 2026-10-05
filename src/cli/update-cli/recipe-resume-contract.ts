import { z } from "zod";
import { UpdateRunRecordSchema } from "../../infra/update-run-schema.js";
import { updateRecipeMaintenanceInputSchema } from "./update-recipe-maintenance-contract.js";

export const UPDATE_RECIPE_RESUME_CAPABILITY = "openclaw.upgrade-recipe-resume.v1" as const;
export const recipeResumeInputSchema = z.strictObject({
  capability: z.literal(UPDATE_RECIPE_RESUME_CAPABILITY),
  runId: z.uuid(),
  ledgerPath: z.string().min(1).max(4096),
  resultPath: z.string().min(1).max(4096),
  executor: updateRecipeMaintenanceInputSchema.shape.executor,
});
type RecipeResumeInput = z.infer<typeof recipeResumeInputSchema>;
export type RecipeResumeInputWithoutExecutor = Omit<RecipeResumeInput, "executor">;
export const recipeResumeResultSchema = z.strictObject({
  capability: z.literal(UPDATE_RECIPE_RESUME_CAPABILITY),
  runId: z.uuid(),
  terminalRunId: z.uuid(),
  outcome: z.literal("completed"),
  managedServiceVerified: z.literal(true),
  result: z.strictObject({
    runId: z.uuid(),
    status: z.literal("ok"),
    mode: z.literal("npm"),
    root: z.string().min(1).max(4096),
    after: z.strictObject({ version: z.string().min(1), buildId: z.string().min(1) }),
    steps: z.array(z.never()).length(0),
    durationMs: z.number().nonnegative().finite(),
    verification: UpdateRunRecordSchema.shape.verification.omit({
      recovery: true,
      rollbackOutcome: true,
    }),
  }),
});
export type RecipeResumeResult = z.infer<typeof recipeResumeResultSchema>;
