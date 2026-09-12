import { z } from "zod";
import { SkillEntrySchema } from "./zod-schema.root-support.js";

export const SkillsConfigSchema = z.strictObject({
  allowBundled: z.array(z.string()).optional(),
  load: z
    .strictObject({
      extraDirs: z.array(z.string()).optional(),
      allowSymlinkTargets: z.array(z.string()).optional(),
      watch: z.boolean().optional(),
    })
    .optional(),
  install: z
    .strictObject({
      preferBrew: z.boolean().optional(),
      nodeManager: z.enum(["npm", "pnpm", "yarn", "bun"]).optional(),
      allowUploadedArchives: z.boolean().optional(),
    })
    .optional(),
  limits: z
    .strictObject({
      maxCandidatesPerRoot: z.number().int().min(1).optional(),
      maxSkillsLoadedPerSource: z.number().int().min(1).optional(),
      maxSkillsInPrompt: z.number().int().min(0).optional(),
      maxSkillsPromptChars: z.number().int().min(0).optional(),
      maxSkillFileBytes: z.number().int().min(0).optional(),
    })
    .optional(),
  workshop: z
    .strictObject({
      autonomous: z
        .strictObject({ mode: z.enum(["off", "propose", "auto"]).optional() })
        .optional(),
      approvalPolicy: z.enum(["pending", "auto"]).optional(),
      maxPending: z.number().int().min(1).optional(),
      maxSkillBytes: z.number().int().min(1).optional(),
    })
    .optional(),
  entries: z.record(z.string(), SkillEntrySchema).optional(),
});
