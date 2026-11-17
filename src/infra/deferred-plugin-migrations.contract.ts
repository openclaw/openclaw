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

/**
 * Obligations are one record per plugin, so list order carries no meaning: rows read
 * back by ID and Doctor's in-memory retained-first list describe the same generation.
 */
export function sameDeferredPluginMigrationInputs(
  current: readonly DeferredPluginMigration[],
  expected: readonly DeferredPluginMigration[],
) {
  const inputs = (pending: readonly DeferredPluginMigration[]) =>
    pending
      .map(({ reason: _reason, command: _command, ...fields }) => fields)
      .toSorted((left, right) =>
        left.pluginId < right.pluginId ? -1 : left.pluginId > right.pluginId ? 1 : 0,
      );
  return isDeepStrictEqual(inputs(current), inputs(expected));
}
