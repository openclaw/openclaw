import { readConfigFileSnapshot, replaceConfigFile } from "../../config/config.js";
import { validateConfigObjectWithPlugins } from "../../config/validation.js";
import { stripUnknownConfigKeys } from "../doctor-config-analysis.js";
import { migrateLegacyConfig } from "./shared/legacy-config-migrate.js";

type ConfigSnapshot = Awaited<ReturnType<typeof readConfigFileSnapshot>>;

export async function repairLegacyConfigForUpdateChannel(params: {
  configSnapshot: ConfigSnapshot;
  jsonMode: boolean;
}): Promise<{ snapshot: ConfigSnapshot; repaired: boolean }> {
  const migrated = migrateLegacyConfig(params.configSnapshot.parsed);
  if (!migrated.config) {
    return { snapshot: params.configSnapshot, repaired: false };
  }

  const stripped = stripUnknownConfigKeys(migrated.config);
  const validated = validateConfigObjectWithPlugins(stripped.config);
  if (!validated.ok) {
    return { snapshot: params.configSnapshot, repaired: false };
  }

  await replaceConfigFile({
    nextConfig: validated.config,
    baseHash: params.configSnapshot.hash,
    writeOptions: {
      allowConfigSizeDrop: true,
      skipOutputLogs: params.jsonMode,
    },
  });

  const snapshot = await readConfigFileSnapshot();
  return { snapshot, repaired: snapshot.valid };
}
