import type { DatabasePortPluginOwners } from "./database-engine/port-descriptor.js";
import {
  readUnchangedUpdateDatabaseGeneration,
  type SqliteDatabaseGenerationReceipt,
} from "./update-database-generations.js";
import { readUpdatePhysicalDatabaseGenerations } from "./update-physical-database-generations.js";

/** Re-reads after capture; a matching receipt avoids a private image. */
export async function rereadUpdatePhysicalDatabaseGeneration(
  pathname: string,
  receipt?: SqliteDatabaseGenerationReceipt,
  pluginOwners?: DatabasePortPluginOwners,
): Promise<{ generation?: string; emptyReaderAlternate?: string }> {
  // A failed reuse propagates: the caller keeps manual recovery instead of copying again.
  const unchanged = receipt && readUnchangedUpdateDatabaseGeneration(pathname, receipt);
  if (unchanged) {
    return { generation: unchanged };
  }
  const alternates: Record<string, string> = {};
  const generations = await readUpdatePhysicalDatabaseGenerations(
    [pathname],
    pluginOwners,
    alternates,
  );
  return {
    generation: generations[pathname] ?? undefined,
    emptyReaderAlternate: alternates[pathname],
  };
}
