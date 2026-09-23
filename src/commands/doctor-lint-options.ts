import { z } from "zod";

export const DoctorLintCliOptionsSchema = z.strictObject({
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
