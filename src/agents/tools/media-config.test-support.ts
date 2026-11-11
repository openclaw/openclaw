import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function configWithDefaults(
  defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>,
): OpenClawConfig {
  const config = { agents: { defaults } };
  setRuntimeConfigSnapshot(config, config);
  return config;
}
