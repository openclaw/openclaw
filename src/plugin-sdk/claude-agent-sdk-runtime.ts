// Private runtime facade for official providers sharing Claude Agent SDK execution.
import type { CliBackendPlugin } from "./cli-backend.js";
import { loadBundledPluginPublicSurfaceModuleSyncCore } from "./facade-loader.js";

export type ClaudeAgentSdkCliBackendOptions = {
  /** Stable runtime id; the default is the bundled Anthropic runtime. */
  backendId?: string;
  /** Canonical provider whose configured models this runtime executes. */
  modelProvider?: string;
  /** Model used by the optional live CLI smoke contract. */
  defaultModelRef?: string;
  /** Explicit provider-owned endpoint, applied after inherited routing is cleared. */
  endpoint?: string;
  /** Z.AI's Anthropic-compatible endpoint requires bearer-token authentication. */
  apiKeyAsAuthToken?: boolean;
  /** Z.AI model ids are already literal Claude Code model ids. */
  modelAliases?: Record<string, string>;
  /** Only Anthropic's Claude catalog uses the `[1m]` model selector. */
  supportsOneMillionModelSuffix?: boolean;
  /** Whether subscription credentials must dispatch through this backend. */
  subscriptionAuthDispatch?: boolean;
  ensureDynamicSystemPromptSectionsSupport?: () => Promise<void>;
  supportsDynamicSystemPromptSections?: () => boolean;
};

/** Anthropic owns execution; the host supplies its packaged runtime to provider plugins. */
export function buildClaudeAgentSdkCliBackend(
  options: ClaudeAgentSdkCliBackendOptions = {},
): CliBackendPlugin {
  const owner = loadBundledPluginPublicSurfaceModuleSyncCore<{
    buildClaudeAgentSdkCliBackend: (options: ClaudeAgentSdkCliBackendOptions) => CliBackendPlugin;
  }>({ dirName: "anthropic", artifactBasename: "api.js" });
  return owner.buildClaudeAgentSdkCliBackend(options);
}
