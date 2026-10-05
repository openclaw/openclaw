import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { upgradeRecipeMaintenanceBindingSchema } from "../../infra/upgrade-recipes/maintenance-contract.js";
import type { UpdateCommandChildGrant } from "./update-command-executor-children.js";

// A new private receiver capability, separate from observation-only admission protocol 1.
export const UPDATE_RECIPE_MAINTENANCE_CAPABILITY = "openclaw.upgrade-maintenance.v1" as const;
const identity = z.string().min(1).max(4096);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

/** Transport shape only. Live original/receiver lease rows and PID/start authorize effects. */
const executorGrant = z.custom<UpdateCommandChildGrant>(
  (value) =>
    isRecord(value) &&
    typeof value.runId === "string" &&
    typeof value.root === "string" &&
    typeof value.databasePath === "string" &&
    typeof value.childKey === "string" &&
    typeof value.originalChildKey === "string" &&
    isRecord(value.parent) &&
    isRecord(value.originalParent) &&
    isRecord(value.spawner) &&
    isRecord(value.databaseIdentity),
  "A modern original-owner child grant is required",
);
export const updateRecipeMaintenanceInputSchema = z.strictObject({
  capability: z.literal(UPDATE_RECIPE_MAINTENANCE_CAPABILITY),
  executor: executorGrant,
  binding: upgradeRecipeMaintenanceBindingSchema,
  expected: z.strictObject({
    version: identity,
    buildId: identity,
    runtimeExecutable: identity,
    installationRoot: identity,
    stateRoot: identity,
    configPath: identity,
    configHash: digest,
    configSourceDigest: digest,
    profile: identity,
  }),
  port: z.number().int().min(1).max(65535),
  timeoutMs: z.number().int().min(1).max(300000),
  stateVersions: z
    .array(
      z.strictObject({
        path: identity,
        userVersion: z.number().int().nonnegative().nullable(),
        contentVersion: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1)
    .max(1000),
});
export type UpdateRecipeMaintenanceInput = z.infer<typeof updateRecipeMaintenanceInputSchema>;
