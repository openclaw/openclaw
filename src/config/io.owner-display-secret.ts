import type { OpenClawConfig } from "./config.js";

export type OwnerDisplaySecretPersistState = {
  pendingByPath: Map<string, string>;
  persistInFlight: Set<string>;
  persistWarned: Set<string>;
};

export function persistGeneratedOwnerDisplaySecret(params: {
  config: OpenClawConfig;
  configPath: string;
  generatedSecret?: string;
  logger: Pick<typeof console, "warn">;
  state: OwnerDisplaySecretPersistState;
  persistConfig: (
    config: OpenClawConfig,
    options: { expectedConfigPath: string },
  ) => Promise<unknown>;
}): OpenClawConfig {
  const { config, configPath, generatedSecret, logger, state, persistConfig } = params;
  if (!generatedSecret) {
    state.pendingByPath.delete(configPath);
    state.persistWarned.delete(configPath);
    return config;
  }

  state.pendingByPath.set(configPath, generatedSecret);
  if (!state.persistInFlight.has(configPath)) {
    state.persistInFlight.add(configPath);
    void persistConfig(config, { expectedConfigPath: configPath })
      .then(() => {
        state.pendingByPath.delete(configPath);
        state.persistWarned.delete(configPath);
      })
      .catch((err) => {
        if (!state.persistWarned.has(configPath)) {
          state.persistWarned.add(configPath);
          logger.warn(
            `Failed to persist auto-generated commands.ownerDisplaySecret at ${configPath}: ${String(err)}`,
          );
        }
      })
      .finally(() => {
        state.persistInFlight.delete(configPath);
      });
  }

  return config;
}
