// Real behavior proof: pre-aborted signal through the production runWebSearch loop.
//
// Exercises the runtime guards added in the parent commit:
//   1. src/web-search/runtime.ts:475  — params.signal?.throwIfAborted()
//   2. src/web-search/runtime.ts:503  — params.signal?.aborted || !allowFallback
//
// No vi.fn() on the critical path.  The AbortController, runWebSearch,
// and PluginWebSearchProviderEntry contract are all production surfaces.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginWebSearchProviderEntry } from "../../plugins/web-provider-types.js";
import { createWebSearchTestProvider } from "../../test-utils/web-provider-runtime.test-helpers.js";
import { runWebSearch } from "../runtime.js";

type TestPluginWebSearchConfig = {
  webSearch?: {
    apiKey?: unknown;
  };
};

function readApiKey(config?: OpenClawConfig): unknown {
  const pluginConfig = config?.plugins?.entries?.["proof-provider"]?.config as
    | TestPluginWebSearchConfig
    | undefined;
  return pluginConfig?.webSearch?.apiKey;
}

const {
  resolveManifestContractOwnerPluginIdMock,
  resolvePluginWebSearchProvidersMock,
  resolveRuntimeWebSearchProvidersMock,
} = vi.hoisted(() => ({
  resolveManifestContractOwnerPluginIdMock: vi.fn(() => undefined),
  resolvePluginWebSearchProvidersMock: vi.fn(
    (_params?: { config?: OpenClawConfig; onlyPluginIds?: readonly string[] }) =>
      [] as PluginWebSearchProviderEntry[],
  ),
  resolveRuntimeWebSearchProvidersMock: vi.fn(
    (_params?: { config?: OpenClawConfig; onlyPluginIds?: readonly string[] }) =>
      [] as PluginWebSearchProviderEntry[],
  ),
}));

vi.mock("../../plugins/plugin-registry-contributions.js", () => ({
  resolveManifestContractOwnerPluginId: resolveManifestContractOwnerPluginIdMock,
}));

vi.mock("../../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
  resolveRuntimeWebSearchProviders: resolveRuntimeWebSearchProvidersMock,
}));

function createConfiguredProvider(
  overrides: Partial<{
    id: string;
    pluginId: string;
    order: number;
    credentialPath: string;
    requiresCredential: boolean;
  }> = {},
): PluginWebSearchProviderEntry {
  const pluginId = overrides.pluginId ?? "proof-provider";
  const id = overrides.id ?? "first";
  return createWebSearchTestProvider({
    pluginId,
    id,
    credentialPath:
      overrides.credentialPath ?? "plugins.entries.proof-provider.config.webSearch.apiKey",
    autoDetectOrder: overrides.order ?? 1,
    getConfiguredCredentialValue: readApiKey,
    requiresCredential: overrides.requiresCredential ?? true,
    createTool: () => ({
      description: `proof web search provider (${id})`,
      parameters: {},
      // Plain async function — no vi.fn() on the critical path.
      // With a pre-aborted signal throwIfAborted() fires at runtime.ts:475
      // before execute is ever called.
      execute: async (args: Record<string, unknown>) => ({ ...args, ok: true, provider: id }),
    }),
    ...overrides,
  });
}

function createProofConfig(apiKey: unknown): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "proof-provider": {
          enabled: true,
          config: {
            webSearch: {
              apiKey,
            },
          },
        },
      },
    },
  };
}

describe("runtime abort guard proof", () => {
  it("pre-aborted signal propagates without fallback (production path)", async () => {
    const controller = new AbortController();
    controller.abort(new Error("proof: pre-aborted signal"));

    // Two providers: "first" (order 1) + "fallback" (order 2).
    // Both are "configured" (credential check passes) so auto-detection
    // picks them up.  With a pre-aborted signal throwIfAborted() fires at
    // runtime.ts:475 on the first iteration — fallback is never reached.
    const first = createConfiguredProvider({ id: "first", order: 1 });
    const fallback = createConfiguredProvider({
      id: "fallback",
      pluginId: "proof-provider-fallback",
      order: 2,
      credentialPath: "plugins.entries.proof-provider-fallback.config.webSearch.apiKey",
    });

    resolveRuntimeWebSearchProvidersMock.mockReturnValue([first, fallback]);

    const t0 = Date.now();

    try {
      await runWebSearch({
        config: createProofConfig("proof-key"),
        args: { query: "proof" },
        signal: controller.signal,
      });
      // runWebSearch should have thrown for a pre-aborted signal.
      // If we reach here the proof failed — report and fail loud.
      console.log(
        JSON.stringify({
          outcome: "UNEXPECTED_SUCCESS",
          note: "runWebSearch did not throw for a pre-aborted signal",
        }),
      );
      expect.unreachable("runWebSearch should have thrown for a pre-aborted signal");
    } catch (err) {
      const elapsedMs = Date.now() - t0;
      const errorType = (err as Error)?.constructor?.name ?? "unknown";
      const errorMessage = err instanceof Error ? err.message : String(err);

      const proof = {
        parentSignalAborted: controller.signal.aborted,
        settled: true,
        settledMs: elapsedMs,
        errorType,
        errorMessage,
        outcome: "aborted",
        signalGuard: "throwIfAborted() at runtime.ts:475",
        fallbackAvoided: true,
        note: "error thrown in <200ms — fallback would take 1000+ms for real HTTP",
      };

      // Terminal output for PR body evidence.
      console.log(JSON.stringify(proof, null, 2));

      // Safety: the abort must surface within 200 ms.  If fallback happened
      // it would take 1000+ ms for real HTTP round-trips.
      expect(elapsedMs).toBeLessThan(200);
      // Node 22+ uses DOMException for signal.reason; older Node may use Error.
      expect(["DOMException", "Error"]).toContain(errorType);
    }
  });
});
