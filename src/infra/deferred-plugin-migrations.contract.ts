import { z } from "zod";

export const deferredPluginMigrationSchema = z.object({
  pluginId: z.string().min(1),
  reason: z.string().min(1),
  command: z.string().min(1),
  requiresStateMigration: z.literal(true).optional(),
  requiresDoctorInspection: z.literal(true).optional(),
  configPaths: z.array(z.array(z.string().min(1)).min(1)).optional(),
  validationExcludedPaths: z.array(z.array(z.string().min(1)).min(1)).optional(),
});

export type DeferredPluginMigration = z.infer<typeof deferredPluginMigrationSchema>;

export type DeferredPluginMigrationReadOperations = {
  "plugins.deferredMigrations.read": {
    input: undefined;
    output: { type: "plugins.deferredMigrations.read"; pending: DeferredPluginMigration[] };
  };
};
