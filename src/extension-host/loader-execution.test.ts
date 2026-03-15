import { describe, expect, it, vi } from "vitest";
import { prepareExtensionHostLoaderExecution } from "./loader-execution.js";

describe("extension host loader execution", () => {
  it("composes runtime, registry, bootstrap, module loader, and session setup", () => {
    const runtime = {} as never;
    const registry = { plugins: [], diagnostics: [] } as never;
    const createApi = vi.fn() as never;
    const loadModule = vi.fn() as never;
    const session = { registry } as never;

    const result = prepareExtensionHostLoaderExecution({
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
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      warningCache: new Set<string>(),
      setCachedRegistry: vi.fn(),
      activateRegistry: vi.fn(),
      createRuntime: vi.fn(() => runtime) as never,
      createRegistry: vi.fn(() => ({ registry, createApi })) as never,
      bootstrapLoad: vi.fn(() => ({
        provenance: { loadPathMatcher: { exact: new Set(), dirs: [] }, installRules: new Map() },
        orderedCandidates: [{ rootDir: "/plugins/a" }],
        manifestByRoot: new Map([["/plugins/a", { rootDir: "/plugins/a" }]]),
      })) as never,
      createModuleLoader: vi.fn(() => loadModule) as never,
      createSession: vi.fn(() => session) as never,
    });

    expect(result.registry).toBe(registry);
    expect(result.createApi).toBe(createApi);
    expect(result.loadModule).toBe(loadModule);
    expect(result.session).toBe(session);
    expect(result.orderedCandidates).toEqual([{ rootDir: "/plugins/a" }]);
    expect(result.manifestByRoot.get("/plugins/a")?.rootDir).toBe("/plugins/a");
  });
});
