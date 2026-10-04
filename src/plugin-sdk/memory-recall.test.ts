import { describe, expect, it, vi } from "vitest";
const loadBundledPluginPublicSurfaceModuleSyncCore = vi.hoisted(() => vi.fn());
const configureMemoryCoreDreamingStateImpl = vi.hoisted(() => vi.fn());
vi.mock("./facade-loader.js", () => ({ loadBundledPluginPublicSurfaceModuleSyncCore }));
vi.mock("../plugin-state/plugin-state-store.js", () => ({ createPluginStateKeyedStore: vi.fn() }));

describe("interactive recall run accounting", () => {
  const hit = {
    source: "memory" as const,
    path: "memory/2026-01-02.md",
    startLine: 1,
    endLine: 1,
    snippet: "A grounded source excerpt.",
    score: 0.9,
  };
  let counter = 0;
  const params = () => ({
    config: {},
    workspaceDir: "/synthetic/workspace",
    query: "actual query",
    sessionKey: "agent:fixture:main",
    runId: `recall-run-${counter++}`,
    results: [hit],
    assertActive: vi.fn(),
  });

  it("deduplicates manual aliases, auto recall, and repeated batch hits within one run", async () => {
    const recorded: unknown[] = [];
    loadBundledPluginPublicSurfaceModuleSyncCore.mockReturnValue({
      configureMemoryCoreDreamingState: configureMemoryCoreDreamingStateImpl,
      recordMemoryRecall: async (
        input: ReturnType<typeof params>,
        claim: (hit: typeof hit) => boolean,
      ) => {
        recorded.push(...input.results.filter(claim));
      },
    });
    const { recordMemoryRecall } = await import("./memory-recall.js");
    const input = params();
    await Promise.all([
      recordMemoryRecall({ ...input, results: [hit, hit] }),
      recordMemoryRecall({
        ...input,
        query: "alias query",
        results: [{ ...hit, endLine: 5, snippet: hit.snippet + "\nMore source lines." }],
      }),
    ]);
    expect(recorded).toEqual([hit]);
    await recordMemoryRecall({ ...input, runId: "another-recall-turn" });
    expect(recorded).toEqual([hit, hit]);
  });

  it("retains reservations after ambiguous post-commit failure without inflating a retry", async () => {
    let fail = true;
    const selected: number[] = [];
    loadBundledPluginPublicSurfaceModuleSyncCore.mockReturnValue({
      configureMemoryCoreDreamingState: configureMemoryCoreDreamingStateImpl,
      recordMemoryRecall: async (
        input: ReturnType<typeof params>,
        claim: (hit: typeof hit) => boolean,
      ) => {
        selected.push(input.results.filter(claim).length);
        if (fail) {
          fail = false;
          throw new Error("synthetic post-commit failure");
        }
      },
    });
    const { recordMemoryRecall } = await import("./memory-recall.js");
    const input = params();
    await expect(recordMemoryRecall(input)).rejects.toThrow("synthetic post-commit failure");
    await recordMemoryRecall(input);
    expect(selected).toEqual([1, 0]);
    await recordMemoryRecall({ ...input, runId: "retry-next-run" });
    expect(selected).toEqual([1, 0, 1]);
  });

  it("rejects a completed host run even if a caller retains its assertion", async () => {
    const selected: unknown[] = [];
    loadBundledPluginPublicSurfaceModuleSyncCore.mockReturnValue({
      configureMemoryCoreDreamingState: configureMemoryCoreDreamingStateImpl,
      recordMemoryRecall: async (
        input: ReturnType<typeof params>,
        claim: (hit: typeof hit) => boolean,
      ) => {
        selected.push(...input.results.filter(claim));
      },
    });
    const { dispatchPluginAgentEventSubscriptions } =
      await import("../plugins/host-hook-runtime.js");
    const { recordMemoryRecall } = await import("./memory-recall.js");
    const input = params();
    dispatchPluginAgentEventSubscriptions({
      registry: undefined,
      event: { runId: input.runId, seq: 1, ts: 1, stream: "lifecycle", data: { phase: "end" } },
      isLive: () => true,
    });
    await expect(recordMemoryRecall(input)).rejects.toThrow("Memory recall run is closed");
    expect(selected).toEqual([]);
  });

  it("does not load the recorder for missing identities or expired invocation", async () => {
    loadBundledPluginPublicSurfaceModuleSyncCore.mockClear();
    const { recordMemoryRecall } = await import("./memory-recall.js");
    await recordMemoryRecall({ ...params(), runId: "" });
    await recordMemoryRecall({ ...params(), sessionKey: "" });
    await expect(
      recordMemoryRecall({
        ...params(),
        assertActive: () => {
          throw new Error("closed");
        },
      }),
    ).rejects.toThrow("closed");
    expect(loadBundledPluginPublicSurfaceModuleSyncCore).not.toHaveBeenCalled();
  });
});
