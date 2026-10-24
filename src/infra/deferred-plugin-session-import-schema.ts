import { z } from "zod";
import type { LegacySessionStoreTarget } from "../config/sessions/legacy-store-inspection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { MigrationArtifactSchema } from "./session-sqlite-migration-artifact.js";

export const DeferredPluginSessionImportSchema = z.object({
  databaseIdentity: z.string(),
  superseded: z.literal("different-database").optional(),
  pluginIds: z.array(z.string()),
  sources: z.array(
    z.object({ path: z.string(), identity: MigrationArtifactSchema.shape.identity }),
  ),
  settledSources: z
    .array(
      z.object({
        path: z.string(),
        identity: MigrationArtifactSchema.shape.identity,
        reason: z.string(),
      }),
    )
    .optional(),
});
export type DeferredPluginSessionImport = z.infer<typeof DeferredPluginSessionImportSchema>;

export type SessionImportSource = {
  cfg: OpenClawConfig;
  target: LegacySessionStoreTarget;
  sqlitePath: string;
  env: NodeJS.ProcessEnv;
};
