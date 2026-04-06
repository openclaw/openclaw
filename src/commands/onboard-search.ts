import type { OpenClawConfig } from "../config/config.js";
import {
  applySearchKey,
  applySearchProviderSelection,
  hasExistingKey,
  hasKeyInEnv,
  listSearchProviderOptions,
  resolveExistingKey,
  resolveSearchProviderOptions,
  runSearchSetupFlow,
} from "../flows/search-setup.js";
import type { SetupSearchOptions } from "../flows/search-setup.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { promptCodexNativeWebSearchSetup } from "./web-search-codex-setup.js";

export {
  applySearchKey,
  applySearchProviderSelection,
  hasExistingKey,
  hasKeyInEnv,
  listSearchProviderOptions,
  resolveExistingKey,
  resolveSearchProviderOptions,
  runSearchSetupFlow as setupManagedSearch,
} from "../flows/search-setup.js";
export type { SearchProvider, SetupSearchOptions } from "../flows/search-setup.js";

export async function setupSearch(
  config: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  opts?: SetupSearchOptions,
): Promise<OpenClawConfig> {
  const codexSetup = await promptCodexNativeWebSearchSetup({
    config,
    prompter,
  });
  if (!codexSetup.configureManagedProvider) {
    return codexSetup.config;
  }
  return runSearchSetupFlow(codexSetup.config, runtime, prompter, opts);
}
