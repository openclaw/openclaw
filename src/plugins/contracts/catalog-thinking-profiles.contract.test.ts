import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { resolveThinkingProfile } from "../../auto-reply/thinking.js";
import type { ThinkingCatalogEntry } from "../../auto-reply/thinking.shared.js";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";
import type { ProviderThinkingRegistry } from "../provider-thinking.types.js";

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
