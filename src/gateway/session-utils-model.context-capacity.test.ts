import { afterEach, expect, test } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { getSessionDefaults } from "./session-utils-model.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";

afterEach(() => {
  resetConfigRuntimeState();
  resetPluginRuntimeStateForTest();
});

test.each([{ provider: "anthropic", model: "claude-opus-5", runtime: "openclaw" }])(
  "session rows project the selected catalog context window for $provider",
  ({ provider, model, runtime }) => {
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
    expect(defaults.agentRuntime?.id).toBe(runtime);
    expect(defaults).toMatchObject({ contextWindow: "1m", contextTokens: 1_000_000 });
    expect(row).toMatchObject({ contextWindow: "200k", contextTokens: 200_000 });
    expect(row.contextWindows).toEqual(catalog[0]?.contextWindows);
  },
);

test.each([
  { projection: "defaults", nativeDonor: true, expected: 320_000 },
  { projection: "defaults", nativeDonor: false, expected: 200_000 },
  { projection: "row", nativeDonor: true, expected: 64_000 },
  { projection: "row", nativeDonor: false, expected: undefined },
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
