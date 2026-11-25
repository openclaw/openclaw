// Vitest extension provider openai config wires the extension provider openai test shard.
import type { ViteUserConfig } from "vitest/config";
import { createExtensionVitestConfig } from "./vitest.extension-config.ts";
import { providerOpenAiExtensionTestRoots } from "./vitest.extension-provider-paths.mjs";

export function createExtensionProviderOpenAiVitestConfig(
  env: Record<string, string | undefined> = process.env,
): ViteUserConfig {
  return createExtensionVitestConfig("provider-openai", providerOpenAiExtensionTestRoots, env);
}

export default createExtensionProviderOpenAiVitestConfig();
