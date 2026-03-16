import type { OpenClawConfig } from "../../config/config.js";
import type { WebSearchProviderPlugin } from "../../plugins/types.js";
import { createWebSearchTool as createLegacyWebSearchTool } from "./web-search-core.js";

type ConfiguredWebSearchProvider = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["search"]
>["provider"];

function cloneWithDescriptors<T extends object>(value: T | undefined): T {
  const next = Object.create(Object.getPrototypeOf(value ?? {})) as T;
  if (value) {
    Object.defineProperties(next, Object.getOwnPropertyDescriptors(value));
  }
  return next;
}

function withForcedProvider(
  config: OpenClawConfig | undefined,
  provider: ConfiguredWebSearchProvider,
): OpenClawConfig {
  const next = cloneWithDescriptors(config ?? {});
  const tools = cloneWithDescriptors(next.tools ?? {});
  const web = cloneWithDescriptors(tools.web ?? {});
  const search = cloneWithDescriptors(web.search ?? {});

  search.provider = provider;
  web.search = search;
  tools.web = web;
  next.tools = tools;

  return next;
}

export function createPluginBackedWebSearchProvider(
  provider: Omit<WebSearchProviderPlugin, "createTool"> & {
    id: ConfiguredWebSearchProvider;
  },
): WebSearchProviderPlugin {
  return {
    ...provider,
    createTool: (ctx) => {
      const tool = createLegacyWebSearchTool({
        config: withForcedProvider(ctx.config, provider.id),
        runtimeWebSearch: ctx.runtimeMetadata,
      });
      if (!tool) {
        return null;
      }
      return {
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>,
        execute: async (args) => {
          const result = await tool.execute(`web-search:${provider.id}`, args);
          return (result.details ?? {}) as Record<string, unknown>;
        },
      };
    },
  };
}

export function getTopLevelCredentialValue(searchConfig?: Record<string, unknown>): unknown {
  return searchConfig?.apiKey;
}

export function setTopLevelCredentialValue(
  searchConfigTarget: Record<string, unknown>,
  value: unknown,
): void {
  searchConfigTarget.apiKey = value;
}

export function getScopedCredentialValue(
  searchConfig: Record<string, unknown> | undefined,
  key: string,
): unknown {
  const scoped = searchConfig?.[key];
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    return undefined;
  }
  return (scoped as Record<string, unknown>).apiKey;
}

export function setScopedCredentialValue(
  searchConfigTarget: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const scoped = searchConfigTarget[key];
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    searchConfigTarget[key] = { apiKey: value };
    return;
  }
  (scoped as Record<string, unknown>).apiKey = value;
}
