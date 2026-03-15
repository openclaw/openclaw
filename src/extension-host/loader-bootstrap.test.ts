import { describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { bootstrapExtensionHostPluginLoad } from "./loader-bootstrap.js";

describe("extension host loader bootstrap", () => {
  it("pushes manifest diagnostics, logs discovery warnings, and orders candidates", () => {
    const warnings: string[] = [];
    const registry = createEmptyPluginRegistry();

    const result = bootstrapExtensionHostPluginLoad({
      config: {},
      env: process.env,
      cacheKey: "cache-key",
      normalizedConfig: {
        enabled: true,
        allow: [],
        loadPaths: [],
        entries: {},
        slots: {},
      },
      warningCache: new Set<string>(),
      logger: {
        info: () => {},
        warn: (message) => warnings.push(message),
        error: () => {},
      },
      registry,
      discoverPlugins: () => ({
        candidates: [
          {
            idHint: "b",
            source: "/plugins/b.ts",
            rootDir: "/plugins/b",
            origin: "workspace",
          },
          {
            idHint: "a",
            source: "/plugins/a.ts",
            rootDir: "/plugins/a",
            origin: "workspace",
          },
        ],
        diagnostics: [],
      }),
      loadManifestRegistry: () => ({
        diagnostics: [{ level: "warn", message: "manifest warning" }],
        plugins: [
          {
            id: "a",
            rootDir: "/plugins/a",
            source: "/plugins/a.ts",
            origin: "workspace",
          } as never,
          {
            id: "b",
            rootDir: "/plugins/b",
            source: "/plugins/b.ts",
            origin: "workspace",
          } as never,
        ],
      }),
      resolveDiscoveryPolicy: () => ({
        warningMessages: ["open allowlist warning"],
      }),
      buildProvenanceIndex: () => ({
        loadPathMatcher: { exact: new Set(), dirs: [] },
        installRules: new Map(),
      }),
      compareDuplicateCandidateOrder: ({ left, right }) => left.idHint.localeCompare(right.idHint),
    });

    expect(registry.diagnostics).toEqual([{ level: "warn", message: "manifest warning" }]);
    expect(warnings).toEqual(["open allowlist warning"]);
    expect(result.orderedCandidates.map((candidate) => candidate.idHint)).toEqual(["a", "b"]);
    expect(result.manifestByRoot.get("/plugins/a")?.id).toBe("a");
  });
});
