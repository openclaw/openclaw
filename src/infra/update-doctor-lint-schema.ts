import { z } from "zod";

export const UpdateDoctorLintFindingSchema = z.object({
  checkId: z.string().refine((value) => value.trim().length > 0),
  message: z.string(),
  source: z.string().optional(),
  errorCode: z.string().optional(),
  fixHint: z.string().optional(),
  severity: z.string().optional(),
  path: z.string().optional(),
  requirement: z.string().optional(),
});
export type UpdateDoctorLintFinding = z.infer<typeof UpdateDoctorLintFindingSchema>;
