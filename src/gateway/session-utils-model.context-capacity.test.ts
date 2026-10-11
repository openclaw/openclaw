import { afterEach, expect, test } from "vitest";
import { getContextWindowCaches, providerContextTokenCacheKey } from "../agents/context-cache.js";
import { resetConfigRuntimeState } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { projectSessionPatchResult, getSessionDefaults } from "./session-utils-model.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";

afterEach(() => {
  resetConfigRuntimeState();
  resetPluginRuntimeStateForTest();
});

test.each([
  { provider: "anthropic", model: "claude-opus-5", runtime: "openclaw", stale: false },
  { provider: "github-copilot", model: "published-row-fixture", runtime: "openclaw", stale: true },
])(
  "session rows project the selected catalog context window for $provider (stale=$stale)",
  ({ provider, model, runtime, stale }) => {
    const key = providerContextTokenCacheKey(provider, model);
    const caches = getContextWindowCaches();
    if (stale) {
      caches.discoveredTokenCache.set(key, 128_000);
      caches.contextWindowCache.set(key, 128_000);
    }
    try {
      const catalog = [
        {
          provider,
          id: model,
          name: "Selectable Model",
          contextWindow: 1_000_000,
          contextWindows: [
            { id: "200k", label: "200K", contextWindow: 200_000 },
            { id: "1m", label: "1M", contextWindow: 1_000_000 },
          ],
          contextWindowDefault: "1m",
        },
      ];
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: `${provider}/${model}` },
            ...(runtime === "openclaw"
              ? { models: { [`${provider}/${model}`]: { agentRuntime: { id: runtime } } } }
              : {}),
          },
        },
      };
      const defaults = getSessionDefaults(cfg, catalog);
      const row = buildGatewaySessionRow({
        cfg,
        agentId: "main",
        storePath: "",
        store: {},
        key: "agent:main:main",
        lightweightListRow: true,
        skipTranscriptUsageFallback: true,
        entry: { sessionId: "ctx", updatedAt: 1, contextWindow: "200k" },
        modelCatalog: catalog,
      });
      expect(row).toMatchObject({ contextWindow: "200k", contextTokens: 200_000 });
      expect(defaults.agentRuntime?.id).toBe(runtime);
      expect(defaults).toMatchObject({ contextWindow: "1m", contextTokens: 1_000_000 });
      expect(row.contextWindows).toEqual(catalog[0]?.contextWindows);
    } finally {
      caches.discoveredTokenCache.delete(key);
      caches.contextWindowCache.delete(key);
    }
  },
);

test.each([
  { projection: "defaults", nativeDonor: true, expected: 320_000 },
  { projection: "defaults", nativeDonor: false, expected: 200_000 },
  { projection: "row", nativeDonor: true, expected: 64_000 },
  { projection: "row", nativeDonor: false, expected: undefined },
  { projection: "patch", nativeDonor: true, expected: undefined },
  { projection: "patch", nativeDonor: false, expected: undefined },
])(
  "native capacity $projection with native donor $nativeDonor",
  ({ projection, nativeDonor, expected }) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
        },
      },
    };
    const apiEntry = {
      provider: "openai",
      id: "gpt-5.6-sol",
      name: "API Model",
      contextWindow: 1_000_000,
      contextTokens: 872_000,
      contextWindows: [
        { id: "200k", label: "200K", contextWindow: 200_000 },
        { id: "1m", label: "1M", contextWindow: 1_000_000 },
      ],
      contextWindowDefault: "1m",
    };
    const catalog = [
      apiEntry,
      ...(nativeDonor
        ? [
            {
              ...apiEntry,
              name: "Native Model",
              nativeRuntime: "codex",
              contextWindow: 384_000,
              contextTokens: 320_000,
              contextWindows: [
                { id: "64k", label: "64K", contextWindow: 64_000 },
                { id: "384k", label: "384K", contextWindow: 384_000 },
              ],
              contextWindowDefault: "384k",
            },
          ]
        : []),
    ];
    if (projection === "patch") {
      const result = projectSessionPatchResult({
        cfg,
        canonicalKey: "agent:main:main",
        targetAgentId: "main",
        preparedAcpMeta: null,
        storePath: "",
        entry: { sessionId: "native-capacity", updatedAt: 1, contextWindow: "64k" },
        modelCatalog: catalog,
      });
      expect(result.resolved).toBeDefined();
      if (!result.resolved) {
        throw new Error("Session patch omitted resolved model metadata");
      }
      expect(result.resolved.agentRuntime?.id).toBe("codex");
      expect(result.resolved.contextWindow).toBe(nativeDonor ? "64k" : undefined);
      expect(result.resolved.contextWindows).toEqual(
        nativeDonor ? catalog[1]?.contextWindows : undefined,
      );
      return;
    }
    const result =
      projection === "defaults"
        ? getSessionDefaults(cfg, catalog)
        : buildGatewaySessionRow({
            cfg,
            agentId: "main",
            storePath: "",
            store: {},
            key: "agent:main:main",
            lightweightListRow: true,
            skipTranscriptUsageFallback: true,
            entry: { sessionId: "native-capacity", updatedAt: 1, contextWindow: "64k" },
            modelCatalog: catalog,
          });
    expect(result.agentRuntime?.id).toBe("codex");
    expect(result.contextTokens).toBe(expected);
  },
);
