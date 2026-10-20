// Agent runtime target tests cover optional tool credentials without broad command-target fixtures.
import { describe, expect, it, vi } from "vitest";

const firecrawlPath = "plugins.entries.firecrawl.config.webFetch.apiKey";
const exaPath = "plugins.entries.exa.config.webSearch.apiKey";
const dottedExaPath = 'plugins.entries["exa.internal"].config.webSearch.apiKey';

vi.mock("../secrets/target-registry.js", () => ({
  listSecretTargetRegistryEntries: () => [
    { id: firecrawlPath, pathPatternSegments: firecrawlPath.split(".") },
    { id: exaPath, pathPatternSegments: exaPath.split(".") },
    {
      id: dottedExaPath,
      pathPatternSegments: ["plugins", "entries", "exa.internal", "config", "webSearch", "apiKey"],
    },
    {
      id: "plugins.entries.example.config.accounts[].token",
      pathPatternSegments: ["plugins", "entries", "example", "config", "accounts[]", "token"],
    },
    { id: "plugins.entries.example.config.other.apiKey" },
  ],
  discoverConfigSecretTargetsByIds: (
    config: {
      plugins?: {
        entries?: Record<string, { config?: Record<string, Record<string, unknown>> }>;
      };
    },
    targetIds: Iterable<string>,
  ) => {
    const ids = new Set(targetIds);
    return (
      [
        [firecrawlPath, "firecrawl", "webFetch"],
        [exaPath, "exa", "webSearch"],
        [dottedExaPath, "exa.internal", "webSearch"],
      ] as const
    ).flatMap(([path, plugin, capability]) => {
      const value = config.plugins?.entries?.[plugin]?.config?.[capability]?.apiKey;
      return ids.has(path) && value !== undefined
        ? [
            {
              entry: { id: path },
              path,
              pathSegments: ["plugins", "entries", plugin, "config", capability, "apiKey"],
              value,
            },
          ]
        : [];
    });
  },
}));

const { getAgentRuntimeCommandSecretTargetIds, getAgentRuntimeOptionalCommandSecretPaths } =
  await import("./command-secret-targets.js");

describe("agent runtime command secret targets", () => {
  it("marks only configured web SecretRefs optional for generic agent startup", () => {
    const paths = getAgentRuntimeOptionalCommandSecretPaths({
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webFetch: { apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" } },
            },
          },
          exa: { config: { webSearch: { apiKey: "inline-key" } } },
          "exa.internal": {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "INTERNAL_EXA_API_KEY" },
              },
            },
          },
        },
      },
    } as never);

    expect(paths).toEqual(new Set([firecrawlPath, dottedExaPath]));
    const runtimeTargetIds = getAgentRuntimeCommandSecretTargetIds({ config: {} });
    expect(runtimeTargetIds.has(firecrawlPath)).toBe(true);
    expect(runtimeTargetIds.has(dottedExaPath)).toBe(true);
  });
});
