import { describe, expect, it, vi } from "vitest";
import { executeExtensionHostLoaderPipeline } from "./loader-pipeline.js";

describe("extension host loader pipeline", () => {
  it("threads preflight data through execution setup and session run", () => {
    const session = {} as never;
    const createApi = vi.fn() as never;
    const loadModule = vi.fn() as never;
    const registry = { plugins: [] } as never;
    const resultRegistry = { plugins: [{ id: "demo" }] } as never;

    const result = executeExtensionHostLoaderPipeline({
      preflight: {
        cacheHit: false,
        env: { TEST: "1" },
        config: { plugins: { enabled: true } },
        logger: { info() {}, warn() {}, error() {} },
        validateOnly: true,
        normalizedConfig: {
          enabled: true,
          allow: [],
          loadPaths: [],
          entries: {},
          slots: {},
        },
        cacheKey: "cache-key",
      },
      workspaceDir: "/workspace",
      cache: false,
      coreGatewayHandlers: { ping: vi.fn() as never },
      warningCache: new Set<string>(),
      createRuntime: vi.fn(() => ({}) as never) as never,
      prepareExecution: vi.fn(() => ({
        registry,
        createApi,
        loadModule,
        session,
        orderedCandidates: [{ rootDir: "/plugins/a" }],
        manifestByRoot: new Map([["/plugins/a", { rootDir: "/plugins/a" }]]),
      })) as never,
      runSession: vi.fn(() => resultRegistry) as never,
    });

    expect(result).toBe(resultRegistry);
  });
});
