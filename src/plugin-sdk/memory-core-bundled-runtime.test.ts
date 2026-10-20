import { beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";

const loadBundledPluginPublicSurfaceModuleSyncCore = vi.hoisted(() => vi.fn());
const mocks = vi.hoisted(() => ({
  configureMemoryCoreDreamingState: vi.fn(),
  createEmbeddingProvider: vi.fn().mockResolvedValue({ provider: { id: "openai" } }),
  removeGroundedShortTermCandidates: vi.fn().mockResolvedValue({ removed: 1 }),
  loadShortTermPromotionDreamingStats: vi.fn().mockResolvedValue({ shortTermCount: 0 }),
  auditDreamingArtifacts: vi.fn().mockResolvedValue({ issues: [] }),
  auditShortTermPromotionArtifacts: vi.fn().mockResolvedValue({ issues: [] }),
  repairDreamingArtifacts: vi.fn().mockResolvedValue({ changed: false }),
  repairShortTermPromotionArtifacts: vi.fn().mockResolvedValue({ changed: false }),
  previewGroundedRemMarkdown: vi.fn().mockResolvedValue({ files: [] }),
  writeBackfillDiaryEntries: vi.fn().mockResolvedValue({ writtenCount: 1 }),
  removeBackfillDiaryEntries: vi.fn().mockResolvedValue({ removedCount: 1 }),
}));
const runtimeHelpers = [
  "removeGroundedShortTermCandidates",
  "loadShortTermPromotionDreamingStats",
  "auditDreamingArtifacts",
  "auditShortTermPromotionArtifacts",
  "repairDreamingArtifacts",
  "repairShortTermPromotionArtifacts",
] as const;

vi.mock("./facade-loader.js", async () => {
  const actual = await vi.importActual<typeof import("./facade-loader.js")>("./facade-loader.js");
  return {
    ...actual,
    loadBundledPluginPublicSurfaceModuleSyncCore,
  };
});

describe("plugin-sdk memory-core bundled runtime", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockClear();
    }
    loadBundledPluginPublicSurfaceModuleSyncCore
      .mockReset()
      .mockImplementation(({ artifactBasename }) => {
        if (artifactBasename === "runtime-api.js") {
          return {
            configureMemoryCoreDreamingState: mocks.configureMemoryCoreDreamingState,
            ...Object.fromEntries(runtimeHelpers.map((name) => [name, mocks[name]])),
            createEmbeddingProvider: mocks.createEmbeddingProvider,
          };
        }
        if (artifactBasename === "api.js") {
          return {
            configureMemoryCoreDreamingState: mocks.configureMemoryCoreDreamingState,
            previewGroundedRemMarkdown: mocks.previewGroundedRemMarkdown,
            writeBackfillDiaryEntries: mocks.writeBackfillDiaryEntries,
            removeBackfillDiaryEntries: mocks.removeBackfillDiaryEntries,
          };
        }
        throw new Error(`unexpected artifact ${String(artifactBasename)}`);
      });
  });

  it("keeps the bundled memory facade cold until a helper is used", async () => {
    const module = await import("./memory-core-bundled-runtime.js");

    expect(loadBundledPluginPublicSurfaceModuleSyncCore).not.toHaveBeenCalled();
    await module.createEmbeddingProvider({} as never);
    expect(loadBundledPluginPublicSurfaceModuleSyncCore).toHaveBeenCalledWith({
      dirName: "memory-core",
      artifactBasename: "runtime-api.js",
    });
    expect(mocks.configureMemoryCoreDreamingState).toHaveBeenCalledWith(expect.any(Function));
    expect(mocks.createEmbeddingProvider).toHaveBeenCalledWith({
      acquireLocalService: expect.any(Function),
    });
  });

  it("delegates doctor and embedding helpers through the bundled public surfaces", async () => {
    const module = await import("./memory-core-bundled-runtime.js");

    for (const name of ["previewGroundedRemMarkdown", ...runtimeHelpers] as const) {
      await module[name]({} as never);
      expect(mocks[name]).toHaveBeenCalledWith({} as never);
    }
    expect(loadBundledPluginPublicSurfaceModuleSyncCore).toHaveBeenCalledWith({
      dirName: "memory-core",
      artifactBasename: "api.js",
    });
    expect(loadBundledPluginPublicSurfaceModuleSyncCore).toHaveBeenCalledWith({
      dirName: "memory-core",
      artifactBasename: "runtime-api.js",
    });
  });
});
