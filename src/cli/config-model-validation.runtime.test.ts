import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveModelAsync } from "../agents/embedded-agent-runner/model.js";
import {
  acquireReadOnlyPreparedModelRuntime,
  prepareModelRuntimeSnapshot,
  PreparedModelRuntimeOwnerNotPublishedError,
} from "../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  clearPluginLoaderCache,
  loadOpenClawPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { checkTouchedTextModelRefs } from "./config-model-validation.js";

const primary = "pin-alpha/exact-supported";
const fallback = "pin-beta/exact-supported";
const providerIds = ["pin-alpha", "pin-beta", "pin-unrelated"];

async function clearRuntimeState() {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearPluginLoaderCache();
}

async function withProviderFixtures(
  run: (fixture: {
    config: OpenClawConfig;
    state: OpenClawTestState;
    imported: (provider: string) => boolean;
    resolved: (provider: string) => unknown;
  }) => Promise<void>,
  options: {
    aliases?: Record<string, string>;
    runtimeAliases?: Record<string, string>;
    provider?: string;
  } = {},
) {
  await withOpenClawTestState(
    {
      label: "config-model-runtime",
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      },
    },
    async (state) => {
      const imported = (provider: string) => fs.existsSync(state.path(`${provider}.imported`));
      const resolved = (provider: string): unknown => {
        const file = state.path(`${provider}.resolved`);
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
      };
      const normalizationProvider = options.provider ?? "pin-alpha";
      const fixtureProviderIds = [normalizationProvider, "pin-beta", "pin-unrelated"];
      const plugins = fixtureProviderIds.map((id) => {
        const modelContexts =
          id === normalizationProvider && (options.aliases || options.runtimeAliases)
            ? {
                "exact-supported": 65536,
                middle: 32000,
                final: 4096,
                ...(options.runtimeAliases
                  ? {
                      entry: 12000,
                      "runtime-selected": 48000,
                      "middle-runtime": 64000,
                      "final-runtime": 96000,
                    }
                  : {}),
              }
            : { "exact-supported": 32000 };
        const plugin = writePlugin({
          id,
          dir: state.path("plugins", id),
          body: `
const fs = require("node:fs");
const modelContexts = ${JSON.stringify(modelContexts)};
const runtimeAliases = ${JSON.stringify(id === normalizationProvider ? options.runtimeAliases : undefined)};
fs.writeFileSync(${JSON.stringify(state.path(`${id}.imported`))}, "loaded");
module.exports = {
  id: ${JSON.stringify(id)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(id)},
      label: ${JSON.stringify(id)},
      auth: [],
      ...(runtimeAliases ? { normalizeModelId({ modelId }) { return runtimeAliases[modelId]; } } : {}),
      normalizeResolvedModel({ model }) {
        fs.writeFileSync(${JSON.stringify(state.path(`${id}.resolved`))}, JSON.stringify({
          provider: model.provider, id: model.id, contextWindow: model.contextWindow,
        }));
        return model;
      },
      resolveDynamicModel({ modelId }) {
        if (modelId === "resolution-error") {
          throw new Error("fixture dynamic resolution failed");
        }
        const contextWindow = modelContexts[modelId];
        if (contextWindow === undefined) return undefined;
        return {
          id: modelId,
          name: modelId,
          provider: ${JSON.stringify(id)},
          api: "openai-completions",
          baseUrl: "https://provider.invalid/v1",
          reasoning: false,
          input: ["text"],
          contextWindow,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
      },
    });
  },
};`,
        });
        fs.writeFileSync(
          path.join(plugin.dir, "openclaw.plugin.json"),
          JSON.stringify({
            id,
            configSchema: { type: "object", additionalProperties: false, properties: {} },
            providers: [id],
            modelCatalog: { providers: { [id]: { models: [{ id: "catalog-model" }] } } },
            ...(id === normalizationProvider && options.aliases
              ? { modelIdNormalization: { providers: { [id]: { aliases: options.aliases } } } }
              : {}),
          }),
        );
        return plugin;
      });
      const config: OpenClawConfig = {
        agents: {
          defaults: { workspace: state.workspaceDir, model: { primary } },
          entries: { main: { default: true } },
        },
        plugins: {
          allow: fixtureProviderIds,
          load: { paths: plugins.map((plugin) => plugin.file) },
          entries: Object.fromEntries(fixtureProviderIds.map((id) => [id, { enabled: true }])),
        },
      };
      try {
        await run({ config, state, imported, resolved });
      } finally {
        await clearRuntimeState();
      }
    },
  );
}

describe("config model validation with provider runtime", () => {
  beforeEach(async () => {
    await clearRuntimeState();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Unexpected network request during config model validation");
    });
  });

  afterEach(async () => {
    try {
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await clearRuntimeState();
    }
  });

  afterAll(cleanupPluginLoaderFixturesForTest);

  it.each(
    (["primary", "fallback"] as const).flatMap((kind) =>
      [
        { input: "entry", expected: "middle", contextWindow: 32000 },
        { input: "middle", expected: "final", contextWindow: 4096 },
        { input: "exact-supported", expected: "exact-supported", contextWindow: 65536 },
      ].map((model) => Object.assign({ kind }, model)),
    ),
  )(
    "materializes cold $kind input $input exactly once",
    async ({ kind, input, expected, contextWindow }) => {
      await withProviderFixtures(
        async ({ config, imported, resolved }) => {
          const value = `pin-alpha/${input}`;
          config.agents!.defaults!.model =
            kind === "primary" ? { primary: value } : { primary, fallbacks: [value] };
          const original = structuredClone(config);
          expect(providerIds.some(imported)).toBe(false);

          const result = await checkTouchedTextModelRefs({
            config,
            touchedPaths: [
              ["agents", "defaults", "model", kind === "primary" ? "primary" : "fallbacks"],
            ],
          });

          expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
          expect(resolved("pin-alpha")).toEqual({
            provider: "pin-alpha",
            id: expected,
            contextWindow,
          });
          expect(config).toEqual(original);
          expect(imported("pin-unrelated")).toBe(false);
        },
        { aliases: { entry: "middle", middle: "final" } },
      );
    },
  );

  it.each(
    (["primary", "fallback"] as const).flatMap((kind) =>
      [
        { ambient: "matching", mixed: false, expected: "runtime-selected", contextWindow: 48000 },
        { ambient: "matching", mixed: true, expected: "middle-runtime", contextWindow: 64000 },
        { ambient: "foreign", mixed: false, expected: "entry", contextWindow: 12000 },
        { ambient: "foreign", mixed: true, expected: "middle", contextWindow: 32000 },
      ].map((mode) => Object.assign({ kind }, mode)),
    ),
  )(
    "applies manifest normalization before runtime hooks for $kind ($ambient, mixed: $mixed)",
    async ({ kind, ambient, mixed, expected, contextWindow }) => {
      await withProviderFixtures(
        async ({ config, state, imported, resolved }) => {
          config.agents!.defaults!.model =
            kind === "primary"
              ? { primary: "pin-alpha/entry" }
              : { primary, fallbacks: ["pin-alpha/entry"] };
          const original = structuredClone(config);
          const ambientConfig = structuredClone(config);
          if (ambient === "foreign") {
            ambientConfig.plugins!.entries!["pin-alpha"] = { enabled: false };
          }
          loadOpenClawPlugins({
            config: ambientConfig,
            workspaceDir: state.workspaceDir,
            onlyPluginIds: [ambient === "matching" ? "pin-alpha" : "pin-beta"],
            activate: true,
          });

          const result = await checkTouchedTextModelRefs({
            config,
            touchedPaths: [
              ["agents", "defaults", "model", kind === "primary" ? "primary" : "fallbacks"],
            ],
          });

          expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
          expect(resolved("pin-alpha")).toEqual({
            provider: "pin-alpha",
            id: expected,
            contextWindow,
          });
          expect(config).toEqual(original);
          expect(imported("pin-unrelated")).toBe(false);
        },
        {
          ...(mixed ? { aliases: { entry: "middle", middle: "final" } } : {}),
          runtimeAliases: {
            entry: "runtime-selected",
            middle: "middle-runtime",
            final: "final-runtime",
          },
        },
      );
    },
  );

  it("normalizes an unqualified primary through the default provider before validation", async () => {
    await withProviderFixtures(
      async ({ config, resolved, imported }) => {
        config.agents!.defaults!.model = { primary: "entry" };
        const original = structuredClone(config);
        const result = await checkTouchedTextModelRefs({
          config,
          touchedPaths: [["agents", "defaults", "model", "primary"]],
        });
        expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
        expect(resolved(DEFAULT_PROVIDER)).toEqual({
          provider: DEFAULT_PROVIDER,
          id: "middle",
          contextWindow: 32000,
        });
        expect(config).toEqual(original);
        expect(imported("pin-unrelated")).toBe(false);
      },
      { provider: DEFAULT_PROVIDER, aliases: { entry: "middle", middle: "final" } },
    );
  });

  it("resolves an uncataloged fixture pin when its provider runtime is prepared", async () => {
    await withProviderFixtures(async ({ config, state, imported }) => {
      const lease = await acquireReadOnlyPreparedModelRuntime({
        config,
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        loadRuntimePlugins: true,
        runtimePluginSelections: [{ provider: "pin-alpha", modelId: "exact-supported" }],
      });
      try {
        const prepared = lease.snapshot;
        expect(prepared.modelCatalog.entries).not.toContainEqual(
          expect.objectContaining({ provider: "pin-alpha", id: "exact-supported" }),
        );
        const result = await resolveModelAsync(
          "pin-alpha",
          "exact-supported",
          state.agentDir(),
          config,
          {
            ...prepared.createStores(),
            agentId: "main",
            workspaceDir: state.workspaceDir,
            preparedModelRuntime: prepared,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.model).toMatchObject({ provider: "pin-alpha", id: "exact-supported" });
        expect(imported("pin-alpha")).toBe(true);
        expect(imported("pin-beta")).toBe(false);
        expect(imported("pin-unrelated")).toBe(false);
      } finally {
        lease.release();
      }
    });
  });

  it("accepts a fresh supported exact primary without changing the input or loading unrelated plugins", async () => {
    await withProviderFixtures(async ({ config, imported }) => {
      const original = structuredClone(config);
      expect(providerIds.some(imported)).toBe(false);

      const result = await checkTouchedTextModelRefs({
        config,
        touchedPaths: [["agents", "defaults", "model", "primary"]],
      });

      expect(config).toEqual(original);
      expect(imported("pin-unrelated")).toBe(false);
      expect(result).toEqual({ refsChecked: 1, refsTotal: 1, errors: [] });
    });
  });

  it.each([
    { modelId: "unsupported", refsChecked: 1, error: "Unknown model: pin-alpha/unsupported" },
    {
      modelId: "resolution-error",
      refsChecked: 0,
      error: "Unable to validate model reference: fixture dynamic resolution failed",
    },
  ])(
    "rejects $modelId and releases its isolated runtime owner",
    async ({ modelId, refsChecked, error }) => {
      await withProviderFixtures(async ({ config, state, imported }) => {
        config.agents!.defaults!.model = { primary: `pin-alpha/${modelId}` };

        const result = await checkTouchedTextModelRefs({
          config,
          touchedPaths: [["agents", "defaults", "model", "primary"]],
        });

        expect(result).toEqual({
          refsChecked,
          refsTotal: 1,
          errors: [expect.stringContaining(error)],
        });
        expect(imported("pin-unrelated")).toBe(false);
        await expect(
          prepareModelRuntimeSnapshot({
            config,
            agentId: "main",
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            readOnly: true,
            loadRuntimePlugins: true,
            runtimePluginSelections: [{ provider: "pin-alpha", modelId, agentId: "main" }],
          }),
        ).rejects.toBeInstanceOf(PreparedModelRuntimeOwnerNotPublishedError);
      });
    },
  );

  it("validates distinct primary and fallback providers for every inheriting agent in one operation", async () => {
    await withProviderFixtures(async ({ config, state, imported }) => {
      config.agents!.defaults!.model = { primary, fallbacks: [fallback] };
      config.agents!.entries!.ops = { workspace: state.workspaceDir };
      const original = structuredClone(config);

      const result = await checkTouchedTextModelRefs({
        config,
        touchedPaths: [["agents", "defaults", "model"]],
      });

      expect(config).toEqual(original);
      expect(imported("pin-unrelated")).toBe(false);
      expect(result).toEqual({ refsChecked: 4, refsTotal: 4, errors: [] });
    });
  });

  it.each(["disabled", "denied", "not allowed"] as const)(
    "rejects a %s provider even when an ambient registry has its hook",
    async (policy) => {
      await withProviderFixtures(async ({ config, state, imported }) => {
        const ambient = loadOpenClawPlugins({
          config,
          workspaceDir: state.workspaceDir,
          onlyPluginIds: ["pin-alpha"],
          activate: true,
        });
        expect(ambient.providers).toContainEqual(
          expect.objectContaining({
            provider: expect.objectContaining({
              id: "pin-alpha",
              resolveDynamicModel: expect.any(Function),
            }),
          }),
        );
        const blocked = structuredClone(config);
        if (policy === "disabled") {
          blocked.plugins!.entries!["pin-alpha"] = { enabled: false };
        } else if (policy === "denied") {
          blocked.plugins!.deny = ["pin-alpha"];
        } else {
          blocked.plugins!.allow = ["pin-beta", "pin-unrelated"];
        }

        const result = await checkTouchedTextModelRefs({
          config: blocked,
          touchedPaths: [["agents", "defaults", "model", "primary"]],
        });

        expect(result).toEqual({
          refsChecked: 1,
          refsTotal: 1,
          errors: [expect.stringContaining("Unknown model: pin-alpha/exact-supported")],
        });
        expect(imported("pin-unrelated")).toBe(false);
      });
    },
  );
});
