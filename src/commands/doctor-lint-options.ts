import { z } from "zod";

const DoctorLintCliOptionsSchema = z.strictObject({
  json: z.boolean().optional(),
  severityMin: z.string().optional(),
  skipIds: z.array(z.string()).readonly().optional(),
  onlyIds: z.array(z.string()).readonly().optional(),
  allowExec: z.boolean().optional(),
  deep: z.boolean().optional(),
  includeAllChecks: z.boolean().optional(),
  updateReadiness: z.literal("post-plugin").optional(),
});

export type DoctorLintCliOptions = Readonly<z.infer<typeof DoctorLintCliOptionsSchema>>;

/** Private CLI→worker stdin handoff: the later worker shares the CLI's validation-command budget anchor. */
export const DoctorLintWorkerInputSchema = z.strictObject({
  options: DoctorLintCliOptionsSchema,
  commandStartedAtMs: z.number().int().optional(),
});

export type DoctorLintWorkerInput = Readonly<z.infer<typeof DoctorLintWorkerInputSchema>>;
