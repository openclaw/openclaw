import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

export const DEFERRED_PLUGIN_MIGRATION_RUN_PREFIX = "deferred-plugin-migration:";

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

/** Doctor can reword guidance without changing the requirements protecting retained inputs. */
export function sameDeferredPluginMigrationInputs(
  current: readonly DeferredPluginMigration[],
  expected: readonly DeferredPluginMigration[],
) {
  const inputs = (pending: readonly DeferredPluginMigration[]) =>
    pending.map(({ reason: _reason, command: _command, ...fields }) => fields);
  return isDeepStrictEqual(inputs(current), inputs(expected));
}
