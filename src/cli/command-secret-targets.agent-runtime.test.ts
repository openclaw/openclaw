// Agent runtime target tests cover optional tool credentials without broad command-target fixtures.
import { describe, expect, it, vi } from "vitest";

const firecrawlPath = "plugins.entries.firecrawl.config.webFetch.apiKey";
const exaPath = "plugins.entries.exa.config.webSearch.apiKey";
const dottedExaPath = 'plugins.entries["exa.internal"].config.webSearch.apiKey';

// mock-isolation: use synthetic plugin entries without production manifest or registry discovery.
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
    const firecrawlValue = config.plugins?.entries?.firecrawl?.config?.webFetch?.apiKey;
    const exaValue = config.plugins?.entries?.exa?.config?.webSearch?.apiKey;
    const dottedExaValue = config.plugins?.entries?.["exa.internal"]?.config?.webSearch?.apiKey;
    const targets: Array<[string, string[], unknown]> = [
      [firecrawlPath, firecrawlPath.split("."), firecrawlValue],
      [exaPath, exaPath.split("."), exaValue],
      [
        dottedExaPath,
        ["plugins", "entries", "exa.internal", "config", "webSearch", "apiKey"],
        dottedExaValue,
      ],
    ];
    return targets
      .filter(([path, , value]) => ids.has(path) && value !== undefined)
      .map(([path, pathSegments, value]) => ({ entry: { id: path }, path, pathSegments, value }));
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
              webFetch: {
                apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" },
              },
            },
          },
          exa: {
            config: {
              webSearch: { apiKey: "inline-key" },
            },
          },
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
