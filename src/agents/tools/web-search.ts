import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeWebSearchMetadata } from "../../secrets/runtime-web-tools.types.js";
import {
  resolveWebSearchDefinition,
  resolveWebSearchProviderId,
} from "../../web-search/runtime.js";
import { resolveUrlAllowlist } from "./web-shared.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import {
  applyUrlAllowlistToPayload,
  filterResultsByAllowlist,
  SEARCH_CACHE,
} from "./web-search-provider-common.js";

export function createWebSearchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
}): AnyAgentTool | null {
  const resolved = resolveWebSearchDefinition(options);
  if (!resolved) {
    return null;
  }
  const urlAllowlist = resolveUrlAllowlist(options?.config?.tools?.web);
  return {
    label: "Web Search",
    name: "web_search",
    description: resolved.definition.description,
    parameters: resolved.definition.parameters,
    execute: async (_toolCallId, args) => {
      const result = await resolved.definition.execute(args);
      const filtered = applyUrlAllowlistToPayload(result, urlAllowlist);
      return jsonResult(filtered);
    },
  };
}

export const __testing = {
  SEARCH_CACHE,
  applyUrlAllowlistToPayload,
  filterResultsByAllowlist,
  resolveSearchProvider: (search?: Parameters<typeof resolveWebSearchProviderId>[0]["search"]) =>
    resolveWebSearchProviderId({ search }),
};
