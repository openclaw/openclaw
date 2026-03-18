import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeWebSearchMetadata } from "../../secrets/runtime-web-tools.types.js";
import {
  __testing as runtimeTesting,
  resolveWebSearchDefinition,
} from "../../web-search/runtime.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { SEARCH_CACHE } from "./web-search-provider-common.js";

export function createWebSearchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
}): AnyAgentTool | null {
  const resolved = resolveWebSearchDefinition({
    config: options?.config,
    sandboxed: options?.sandboxed,
    runtimeWebSearch: options?.runtimeWebSearch,
  });
  if (!resolved) {
    return null;
  }
  return {
    label: "Web Search",
    name: "web_search",
    description: resolved.definition.description,
    parameters: resolved.definition.parameters,
    execute: async (_toolCallId, args) => jsonResult(await resolved.definition.execute(args)),
  };
}

export const __testing = {
  SEARCH_CACHE,
  ...runtimeTesting,
};
