import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import type { PluginWebSearchProviderEntry } from "../plugins/web-provider-types.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";
import { createWebSearchTestProvider } from "../test-utils/web-provider-runtime.test-helpers.js";
import { runWebSearch } from "./runtime.js";

const { resolveProviders } = vi.hoisted(() => ({
  resolveProviders: vi.fn<() => PluginWebSearchProviderEntry[]>(() => []),
}));
vi.mock("../plugins/plugin-registry-contributions.js", () => ({
  resolveManifestContractOwnerPluginId: () => undefined,
}));
vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolveProviders,
  resolveRuntimeWebSearchProviders: resolveProviders,
}));

describe("web search OAuth and environment auto-detection", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    resolveProviders.mockReset();
    clearRuntimeAuthProfileStoreSnapshots();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "OAuth before environment",
      oauth: true,
      failGrok: false,
      pin: undefined,
      order: ["grok"],
    },
    {
      name: "environment fallback after OAuth failure",
      oauth: true,
      failGrok: true,
      pin: undefined,
      order: ["grok", "tavily"],
    },
    {
      name: "environment only",
      oauth: false,
      failGrok: false,
      pin: undefined,
      order: ["tavily"],
    },
    {
      name: "explicit environment provider",
      oauth: true,
      failGrok: false,
      pin: "tavily",
      order: ["tavily"],
    },
  ])("preserves $name", async ({ oauth, failGrok, pin, order }) => {
    vi.stubEnv("TAVILY_API_KEY", "tavily-synthetic-key");
    const agentDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-web-search-order-"));
    tempDirs.push(agentDir);
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir,
        store: {
          version: 1,
          profiles: oauth
            ? {
                "xai:default": {
                  type: "oauth",
                  provider: "xai",
                  access: "synthetic-access",
                  refresh: "synthetic-refresh",
                  expires: Date.now() + 3_600_000,
                },
              }
            : {},
        },
      },
    ]);
    const attempts: string[] = [];
    resolveProviders.mockReturnValue([
      createWebSearchTestProvider({
        pluginId: "xai",
        id: "grok",
        authProviderId: "xai",
        credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
        autoDetectOrder: 30,
        createTool: () => ({
          description: "grok",
          parameters: {},
          execute: async () => {
            attempts.push("grok");
            if (failGrok) {
              throw new Error("grok search failed");
            }
            return { answer: "OAuth result" };
          },
        }),
      }),
      createWebSearchTestProvider({
        pluginId: "tavily",
        id: "tavily",
        credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
        autoDetectOrder: 70,
        createTool: () => ({
          description: "tavily",
          parameters: {},
          execute: async () => {
            attempts.push("tavily");
            return { answer: "environment result" };
          },
        }),
      }),
    ]);
    const runtimeWebSearch: RuntimeWebSearchMetadata = {
      providerSource: pin ? "configured" : "auto-detect",
      selectedProvider: "tavily",
      selectedProviderKeySource: "env",
      diagnostics: [],
    };
    await expect(
      runWebSearch({
        agentDir,
        config: pin ? { tools: { web: { search: { provider: pin } } } } : {},
        runtimeWebSearch,
        args: { query: "OAuth and environment ordering" },
      }),
    ).resolves.toMatchObject({ provider: order.at(-1) });
    expect(attempts).toEqual(order);
  });
});
