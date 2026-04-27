import { hermesMigrationProvider } from "./providers/hermes.js";
import type { MigrationDetection, MigrationProvider, MigrationProviderId } from "./types.js";

const builtInMigrationProviders: MigrationProvider[] = [hermesMigrationProvider];

export function listMigrationProviders(): MigrationProvider[] {
  return [...builtInMigrationProviders];
}

export function getMigrationProvider(providerId: MigrationProviderId): MigrationProvider {
  const provider = builtInMigrationProviders.find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw new Error(`Unknown migration provider: ${providerId}`);
  }
  return provider;
}

export async function detectMigrationSources(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MigrationDetection[]> {
  const results = await Promise.all(
    builtInMigrationProviders.map((provider) => provider.detect(env)),
  );
  return results.flat();
}
