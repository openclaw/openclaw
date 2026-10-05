import path from "node:path";
import { z } from "zod";
import {
  UPDATE_RUN_PHASES,
  UPDATE_RUN_STATUSES,
} from "../../../packages/gateway-protocol/src/update-run-vocabulary.js";
import type { UpgradeRecipeMaintenanceReceipt } from "./maintenance-contract.js";
import { upgradeRecipeMaintenanceBindingSchema } from "./maintenance-contract.js";
import type { UpgradeRecipeStepReceipt } from "./receipts-contract.js";
import { upgradeRecipeStepBindingSchema } from "./receipts-contract.js";
import type { VerifiedUpgradeRecipeRunnerBundle } from "./runner-bundle-contract.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && path.resolve(value) === value);
const artifact = z.strictObject({
  path: absolutePath,
  sha256: digest,
  length: z.number().int().positive().safe(),
});
export const retainedUpgradeRecipeRunSchema = z.strictObject({
  schemaVersion: z.literal(1),
  binding: upgradeRecipeMaintenanceBindingSchema,
  nativeAuthority: z.strictObject({
    installKey: absolutePath,
    databasePath: absolutePath,
    databaseIdentity: z.string().min(1).max(4096),
    parentIdentity: z.string().min(1).max(4096),
  }),
  ledgerAuthority: z.strictObject({
    databasePath: absolutePath,
    databaseIdentity: z.string().regex(/^\d+:\d+$/u),
    parentIdentity: z.string().regex(/^\d+:\d+$/u),
  }),
  /** Journal correlation only; recovery still requires fresh original-run native admission. */
  originalNativeOwner: z.string().min(1).max(4096),
  originalRecoveryCapture: z
    .strictObject({
      directory: absolutePath,
      manifestPath: absolutePath,
      manifestSha256: digest,
    })
    .optional(),
  planArtifact: artifact,
  configArtifact: artifact,
  authorizationArtifact: artifact,
  runner: z.strictObject({
    root: absolutePath,
    manifestDigest: digest,
    closureDigest: digest,
    runtimePath: absolutePath,
    entrypointPath: absolutePath,
  }),
  stepBindings: z.array(upgradeRecipeStepBindingSchema).max(128),
});
export const originalRunSchema = z.strictObject({
  runId: z.uuid(),
  status: z.enum(UPDATE_RUN_STATUSES),
  phase: z.enum(UPDATE_RUN_PHASES),
  /** Exact reference stored by the original control owner, not size-limited history detail. */
  retainedEvidenceSha256: digest,
});
export type RetainedUpgradeRecipeRun = z.infer<typeof retainedUpgradeRecipeRunSchema>;
export type OriginalUpgradeRecipeRun = z.infer<typeof originalRunSchema>;

export type UpgradeRecipeRecoveryPorts = {
  readOriginalRun: (runId: string) => Promise<OriginalUpgradeRecipeRun | null>;
  readRetainedEnvelope: (runId: string) => Promise<Uint8Array>;
  readArtifact: (artifact: RetainedUpgradeRecipeRun["planArtifact"]) => Promise<Uint8Array>;
  /** Authenticate original durable admission and apply current known revocations; no new target selection. */
  verifyRetainedAuthorization: (
    retained: RetainedUpgradeRecipeRun,
    bytes: Uint8Array,
  ) => Promise<void>;
  /** Validate the original approved plan digest/config bindings, not merely JSON syntax. */
  verifyRetainedPlanAndConfig: (
    retained: RetainedUpgradeRecipeRun,
    plan: Uint8Array,
    config: Uint8Array,
  ) => Promise<void>;
  verifyRetainedRunner: (
    retained: RetainedUpgradeRecipeRun,
  ) => Promise<VerifiedUpgradeRecipeRunnerBundle>;
  /** Existing recovery owner refuses foreign/legacy/unadmitted journals, including missing-canonical publication. */
  assertOriginalRecoveryOwner: (retained: RetainedUpgradeRecipeRun) => Promise<void>;
  readReceipts: (retained: RetainedUpgradeRecipeRun) => Promise<{
    maintenance: UpgradeRecipeMaintenanceReceipt | null;
    steps: UpgradeRecipeStepReceipt[];
  }>;
};
