import path from "node:path";
import { z } from "zod";
import type {
  UpdateDoctorInput,
  UpdatePostCoreInput,
  UpdatePluginCohortSettlementInput,
  UpdatePluginCohortCommitInput,
} from "./update-command-migrated-types.js";

export type DecodedUpdatePostCoreInput = Omit<UpdatePostCoreInput, "executor"> & {
  executor: unknown;
};
export type DecodedUpdateDoctorInput = Omit<UpdateDoctorInput, "executor"> & {
  executor: unknown;
};
export type DecodedUpdatePluginCohortSettlementInput = Omit<
  UpdatePluginCohortSettlementInput,
  "executor"
> & { executor: unknown };

const base = {
  // The delegated-executor owner admits this separately from the command's data.
  executor: z.unknown(),
  runId: z.string(),
  root: z.string(),
  busyTimeoutMs: z.number().optional(),
  requester: z
    .object({
      channel: z.string().optional(),
      accountId: z.string().optional(),
      senderId: z.string().optional(),
      authorizationSource: z.string().optional(),
    })
    .optional(),
  originalRecoveryCapture: z
    .object({
      directory: z.string(),
      manifestPath: z.string(),
      manifestSha256: z.string(),
    })
    .optional(),
};
const postCoreInput = z.object({
  ...base,
  opts: z.object({
    json: z.boolean().optional(),
    restart: z.boolean().optional(),
    yes: z.boolean().optional(),
    acceptCapabilities: z.boolean().optional(),
    fullIntegrityCheck: z.boolean().optional(),
    timeout: z.string().optional(),
  }),
});
const doctorInput = z.object({
  ...base,
  configInputHash: z.string(),
  repair: z.boolean(),
  retirementOnly: z.literal(true).optional(),
  fullIntegrityCheck: z.boolean().optional(),
  yes: z.boolean().optional(),
  workspaceSuggestions: z.boolean().optional(),
  postCoreSchemaRepair: z.literal(true).optional(),
  serviceInspectionDeadlineAtMs: z.number().int().optional(),
  databaseGenerations: z.record(z.string(), z.string().nullable()).optional(),
  databasePluginOwners: z
    .record(
      z.string(),
      z.object({
        id: z.string(),
        rootDir: z.string(),
        source: z.string(),
        origin: z.enum(["bundled", "global", "workspace", "config"]),
      }),
    )
    .optional(),
});
const pluginCohortSettlementInput = z.strictObject({
  executor: z.unknown(),
  runId: z.uuid(),
  transactionId: z.uuid(),
});
const pluginCohortCommitInput = z.strictObject({
  runId: z.uuid(),
  transactionId: z.uuid(),
  installKey: z
    .string()
    .min(1)
    .max(32_768)
    .refine((value) => path.isAbsolute(value)),
});

/** Decode command data once; transported identity never grants execution authority. */
export function readUpdatePostCoreInput(value: unknown): DecodedUpdatePostCoreInput {
  return postCoreInput.parse(value);
}

export function readUpdateDoctorInput(value: unknown): DecodedUpdateDoctorInput {
  return doctorInput.parse(value);
}

export function readUpdatePluginCohortSettlementInput(
  value: unknown,
): DecodedUpdatePluginCohortSettlementInput {
  return pluginCohortSettlementInput.parse(value);
}

export function readUpdatePluginCohortCommitInput(value: unknown): UpdatePluginCohortCommitInput {
  return pluginCohortCommitInput.parse(value);
}
