import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { resolveThinkingProfile } from "../../auto-reply/thinking.js";
import type { ThinkingCatalogEntry } from "../../auto-reply/thinking.shared.js";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";
import type { ProviderThinkingRegistry } from "../provider-thinking.types.js";
import { resolveProviderContractProvidersForPluginIds } from "./registry.js";

// Rows that set compat.defaultThinkingLevel own their thinking profile; no provider hook runs.
// Each expectation is the profile the deleted provider hook returned for that row.
const EXPECTED: Record<string, { levels: string[]; defaultLevel: string }> = {
  "deepseek/deepseek-flash": deepSeekV4(),
  "deepseek/deepseek-v4-flash": deepSeekV4(),
  "deepseek/deepseek-v4-flash-vision-exp": deepSeekV4(),
  "deepseek/deepseek-v4-pro": deepSeekV4(),
  "kimi/k3": kimiK3(true),
  "kimi/k3-256k": kimiK3(true),
  "kimi/k3.1-pro": kimiK3(false),
  "kimi/k3.1-pro-highspeed": kimiK3(false),
  "mistral/mistral-medium-3-5": mistralReasoning(),
  "mistral/mistral-small-2603": mistralReasoning(),
  "mistral/mistral-small-latest": mistralReasoning(),
  "particle/particle-ai/particle-1": deepSeekV4(),
  "moonshot/kimi-k2.7-code": { levels: ["low:on"], defaultLevel: "low" },
  "moonshot/kimi-k2.7-code-highspeed": { levels: ["low:on"], defaultLevel: "low" },
  "moonshot/kimi-k3": { levels: ["max"], defaultLevel: "max" },
  "moonshot/kimi-k3.1-pro": { levels: ["max"], defaultLevel: "max" },
  "moonshot/kimi-k3.1-pro-highspeed": { levels: ["max"], defaultLevel: "max" },
  "xai/grok-4.7": { levels: ["low", "medium", "high", "xhigh"], defaultLevel: "high" },
  "xai/grok-4.6": { levels: ["low", "medium", "high", "xhigh"], defaultLevel: "high" },
  "xai/grok-4.5": { levels: ["low", "medium", "high"], defaultLevel: "high" },
  "xai/grok-build-0.1": { levels: ["off"], defaultLevel: "off" },
  "xai/grok-4.3": { levels: ["off", "minimal", "low", "medium", "high"], defaultLevel: "low" },
  "xai/grok-4.20-0309-reasoning": { levels: ["off"], defaultLevel: "off" },
};

function kimiK3(off: boolean) {
  const levels = ["minimal", "low", "medium", "adaptive", "high", "xhigh", "max"];
  return { levels: off ? ["off", ...levels] : levels, defaultLevel: "high" };
}

function mistralReasoning() {
  return {
    levels: ["off", "minimal", "low", "medium", "adaptive", "high", "xhigh", "max"],
    defaultLevel: "off",
  };
}

function deepSeekV4() {
  return {
    levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    defaultLevel: "high",
  };
}

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function readRowsOwningThinking(): ThinkingCatalogEntry[] {
  const files = listGitTrackedFiles({ repoRoot, pathspecs: "extensions" }) ?? [];
  return files
    .filter((file) => /^extensions\/[^/]+\/openclaw\.plugin\.json$/.test(file))
    .flatMap((file) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8")) as {
        modelCatalog?: {
          providers?: Record<string, { api?: string; models?: ThinkingCatalogEntry[] }>;
        };
      };
      return Object.entries(manifest.modelCatalog?.providers ?? {}).flatMap(([provider, catalog]) =>
        (catalog.models ?? [])
          .filter((row) => row.compat?.defaultThinkingLevel)
          .map((row) => Object.assign({}, row, { provider, api: row.api ?? catalog.api })),
      );
    });
}

// Every provider gets a hook that returns a wrong profile; rows that own their profile skip it.
function wrongHookRegistry(rows: readonly ThinkingCatalogEntry[]): ProviderThinkingRegistry {
  return {
    providers: [...new Set(rows.map((row) => row.provider))].map((id) => ({
      provider: { id, resolveThinkingProfile: () => ({ levels: [{ id: "off" }] }) },
    })),
  };
}

function resolve(row: ThinkingCatalogEntry, registry: ProviderThinkingRegistry) {
  const profile = resolveThinkingProfile({
    provider: row.provider,
    model: row.id,
    catalog: [row],
    agentRuntime: "openclaw",
    providerPolicySource: registry,
  });
  return {
    levels: profile.levels
      .filter(({ id }) => id !== "ultra")
      .map(({ id, label }) => (label === id ? id : `${id}:${label}`)),
    defaultLevel: profile.defaultLevel,
  };
}

it("resolves every row that owns its thinking profile to its recorded profile", () => {
  const rows = readRowsOwningThinking();
  const registry = wrongHookRegistry(rows);
  const actual = Object.fromEntries(
    rows.map((row) => [`${row.provider}/${row.id}`, resolve(row, registry)]),
  );
  expect(actual).toEqual(EXPECTED);
});

it("sends a row without a default thinking level to its provider hook", () => {
  const rows = readRowsOwningThinking();
  const row = expectDefined(rows[0], "a row that owns its thinking profile");
  const { defaultThinkingLevel: _owned, ...compat } = row.compat ?? {};
  expect(resolve({ ...row, compat }, wrongHookRegistry(rows))).toEqual({
    levels: ["off"],
    defaultLevel: undefined,
  });
});

// Plugins that still resolve thinking in code. Each serves routes or runtimes its rows cannot
// describe yet (rowless aggregator or cloud routes, unlisted releases, runtime-dependent ladders).
// A new provider states its profile on its manifest rows instead; remove an entry when its hook goes.
const PLUGINS_WITH_THINKING_HOOKS = new Set([
  "amazon-bedrock",
  "anthropic",
  "anthropic-vertex",
  "baseten",
  "clawrouter",
  "fireworks",
  "github-copilot",
  "google",
  "kimi-coding",
  "meta",
  "microsoft-foundry",
  "minimax",
  "moonshot",
  "ollama",
  "openai",
  "opencode",
  "opencode-go",
  "openrouter",
  "qwen",
  "vercel-ai-gateway",
  "vllm",
  "xai",
  "xiaomi",
  "zai",
]);

// A hook is registered on the provider, or exported from the plugin's policy artifact, which the
// thinking resolver loads before plugin runtime.
async function listPluginsWithThinkingHooks(): Promise<string[]> {
  const files = listGitTrackedFiles({ repoRoot, pathspecs: "extensions" }) ?? [];
  const withHooks: string[] = [];
  for (const file of files.filter((f) => /^extensions\/[^/]+\/openclaw\.plugin\.json$/.test(f))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8")) as {
      id: string;
      providers?: unknown[];
    };
    if ((manifest.providers?.length ?? 0) === 0) {
      continue;
    }
    const pluginDir = path.dirname(file);
    const policyPath = path.join(repoRoot, pluginDir, "provider-policy-api.ts");
    const policy = fs.existsSync(policyPath)
      ? ((await import(policyPath)) as { resolveThinkingProfile?: unknown })
      : undefined;
    if (
      typeof policy?.resolveThinkingProfile === "function" ||
      resolveProviderContractProvidersForPluginIds([manifest.id]).some(
        (provider) => provider.resolveThinkingProfile,
      )
    ) {
      withHooks.push(path.basename(pluginDir));
    }
  }
  return withHooks.toSorted((a, b) => a.localeCompare(b));
}

it("adds no provider thinking hook where catalog rows can own the profile", async () => {
  expect(
    await listPluginsWithThinkingHooks(),
    "Put the thinking profile on manifest rows (compat.defaultThinkingLevel / compat.thinkingLevels; src/plugins/AGENTS.md). A hook needs a reason rows cannot express; then update this list.",
  ).toEqual([...PLUGINS_WITH_THINKING_HOOKS].toSorted((a, b) => a.localeCompare(b)));
}, 120_000);
