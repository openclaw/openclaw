// Vitest extension signal config wires the extension signal test shard.
import { createSingleChannelExtensionVitestConfig } from "./vitest.extension-config.ts";

export function createExtensionSignalVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const config = createSingleChannelExtensionVitestConfig("signal", env);
  config.test = {
    ...config.test,
    setupFiles: [...(config.test?.setupFiles ?? []), "test/setup.signal.ts"],
  };
  return config;
}

export default createExtensionSignalVitestConfig();
