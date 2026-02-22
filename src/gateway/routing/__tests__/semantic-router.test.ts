import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "../../../memory/embeddings.js";
import { SemanticRouter } from "../semantic-router.js";
import { TaskType } from "../types.js";
import { ROUTE_UTTERANCES } from "../utterances.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a one-hot vector at position `pos` of `dim` dimensions */
function oneHot(dim: number, pos: number): number[] {
  const v = Array.from<number>({ length: dim }).fill(0);
  v[pos] = 1;
  return v;
}

/**
 * Build a deterministic mock EmbeddingProvider.
 * Each text gets a stable one-hot vector based on hash(text) % dim.
 */
function makeMockProvider(dim = 8): EmbeddingProvider {
  const embed = (text: string): number[] => {
    // Simple hash so the same text always returns the same vector
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = (h * 31 + text.charCodeAt(i)) >>> 0;
    }
    return oneHot(dim, h % dim);
  };

  return {
    id: "mock",
    model: "mock-model",
    embedQuery: vi.fn(async (text: string) => embed(text)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(embed)),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SemanticRouter — dotProduct / cosine similarity", () => {
  it("identical normalized vectors → score = 1.0", async () => {
    const provider = makeMockProvider(4);
    const router = new SemanticRouter(provider, 0.5);

    const routes = new Map<TaskType, string[]>([[TaskType.CODE_EDIT, ["hello"]]]);
    await router.init(routes);

    // embedQuery("hello") returns the same vector as the route embedding
    const result = await router.resolve("hello", 0.5);
    expect(result).toBe(TaskType.CODE_EDIT);
  });

  it("orthogonal vectors → score = 0, returns null", async () => {
    const provider: EmbeddingProvider = {
      id: "mock",
      model: "mock",
      // Route: one-hot at index 0; Query: one-hot at index 1 → dot = 0
      embedBatch: vi.fn(async () => [[1, 0, 0, 0]]),
      embedQuery: vi.fn(async () => [0, 1, 0, 0]),
    };
    const router = new SemanticRouter(provider, 0.5);
    await router.init(new Map([[TaskType.CODE_EDIT, ["anything"]]]));

    const result = await router.resolve("query", 0.5);
    expect(result).toBeNull();
  });
});

describe("SemanticRouter — threshold behaviour", () => {
  it("returns null when best score is below threshold", async () => {
    const provider: EmbeddingProvider = {
      id: "mock",
      model: "mock",
      embedBatch: vi.fn(async () => [[1, 0, 0, 0]]),
      // Partial overlap: dot = 0.5
      embedQuery: vi.fn(async () => [0.5, 0.5, 0.5, 0.5].map((v) => v / Math.sqrt(0.75))),
    };
    const router = new SemanticRouter(provider, 0.9); // high threshold
    await router.init(new Map([[TaskType.CODE_DEBUG, ["anything"]]]));

    const result = await router.resolve("text");
    expect(result).toBeNull();
  });

  it("returns task when score meets threshold exactly", async () => {
    const vec = [1, 0, 0, 0];
    const provider: EmbeddingProvider = {
      id: "mock",
      model: "mock",
      embedBatch: vi.fn(async () => [vec]),
      embedQuery: vi.fn(async () => vec), // dot = 1.0
    };
    const router = new SemanticRouter(provider, 1.0); // exact match threshold
    await router.init(new Map([[TaskType.PLANNING, ["utterance"]]]));

    const result = await router.resolve("query");
    expect(result).toBe(TaskType.PLANNING);
  });

  it("per-call threshold overrides constructor default", async () => {
    const vec = [1, 0, 0, 0];
    const provider: EmbeddingProvider = {
      id: "mock",
      model: "mock",
      embedBatch: vi.fn(async () => [vec]),
      embedQuery: vi.fn(async () => vec),
    };
    const router = new SemanticRouter(provider, 0.9); // strict default
    await router.init(new Map([[TaskType.GIT_OPS, ["utterance"]]]));

    // Passes with lower threshold override
    const resultLow = await router.resolve("query", 0.5);
    expect(resultLow).toBe(TaskType.GIT_OPS);

    // Fails with very high threshold
    const resultHigh = await router.resolve("query", 1.1);
    expect(resultHigh).toBeNull();
  });
});

describe("SemanticRouter — init / resolve lifecycle", () => {
  it("returns null before init is called", async () => {
    const provider = makeMockProvider();
    const router = new SemanticRouter(provider, 0.5);
    // No init()
    const result = await router.resolve("test");
    expect(result).toBeNull();
  });

  it("isInitialized is false before init", () => {
    const provider = makeMockProvider();
    const router = new SemanticRouter(provider, 0.5);
    expect(router.isInitialized).toBe(false);
  });

  it("isInitialized is true after init", async () => {
    const provider = makeMockProvider();
    const router = new SemanticRouter(provider, 0.5);
    await router.init(new Map([[TaskType.CODE_EDIT, ["hello"]]]));
    expect(router.isInitialized).toBe(true);
  });

  it("routeCount reflects total utterances across all routes", async () => {
    const provider = makeMockProvider();
    const router = new SemanticRouter(provider, 0.5);
    await router.init(
      new Map([
        [TaskType.CODE_EDIT, ["a", "b", "c"]],
        [TaskType.CODE_DEBUG, ["d", "e"]],
      ]),
    );
    expect(router.routeCount).toBe(5);
  });

  it("embedBatch is called once per TaskType during init", async () => {
    const provider = makeMockProvider();
    const router = new SemanticRouter(provider, 0.5);
    await router.init(
      new Map([
        [TaskType.CODE_EDIT, ["a", "b"]],
        [TaskType.GIT_OPS, ["c", "d"]],
      ]),
    );
    expect(provider.embedBatch).toHaveBeenCalledTimes(2);
  });

  it("embedQuery is called once per resolve() call", async () => {
    const provider = makeMockProvider();
    const router = new SemanticRouter(provider, 0.5);
    await router.init(new Map([[TaskType.CODE_EDIT, ["hello"]]]));

    await router.resolve("query one");
    await router.resolve("query two");
    expect(provider.embedQuery).toHaveBeenCalledTimes(2);
  });
});

describe("SemanticRouter — multi-route disambiguation", () => {
  it("returns the TaskType with the highest dot product score", async () => {
    // Two routes, query is identical to second route
    const routeVecA = [1, 0, 0, 0]; // CODE_EDIT route
    const routeVecB = [0, 1, 0, 0]; // GIT_OPS route
    const queryVec = [0, 1, 0, 0]; // matches GIT_OPS

    const provider: EmbeddingProvider = {
      id: "mock",
      model: "mock",
      embedBatch: vi.fn(async (texts: string[]) => {
        // Assign vectors based on text content
        return texts.map((t) => (t.startsWith("code") ? routeVecA : routeVecB));
      }),
      embedQuery: vi.fn(async () => queryVec),
    };

    const router = new SemanticRouter(provider, 0.5);
    await router.init(
      new Map([
        [TaskType.CODE_EDIT, ["code utterance"]],
        [TaskType.GIT_OPS, ["git utterance"]],
      ]),
    );

    const result = await router.resolve("anything");
    expect(result).toBe(TaskType.GIT_OPS);
  });

  it("skips empty utterance arrays gracefully", async () => {
    const provider = makeMockProvider();
    const router = new SemanticRouter(provider, 0.5);

    await router.init(
      new Map([
        [TaskType.CODE_EDIT, []], // empty — should be skipped
        [TaskType.PLANNING, ["plan this"]],
      ]),
    );

    // Only PLANNING route was added
    expect(router.routeCount).toBe(1);
  });
});

describe("SemanticRouter — default threshold", () => {
  it("uses constructor default threshold of 0.68 when not specified", async () => {
    const vec = [1, 0, 0, 0];
    const provider: EmbeddingProvider = {
      id: "mock",
      model: "mock",
      embedBatch: vi.fn(async () => [vec]),
      embedQuery: vi.fn(async () => vec), // score = 1.0 >= 0.68
    };
    const router = new SemanticRouter(provider); // default threshold = 0.68
    await router.init(new Map([[TaskType.SCAFFOLD, ["utterance"]]]));

    const result = await router.resolve("query"); // no threshold arg
    expect(result).toBe(TaskType.SCAFFOLD);
  });
});

describe("SemanticRouter — confidence gap", () => {
  it("returns null when top-1 and top-2 gap is below minGap", async () => {
    // CODE_EDIT: [1, 0], GIT_OPS: [0, 1]
    // query: [0.75, 0.72] → dot(CODE_EDIT)=0.75, dot(GIT_OPS)=0.72, gap=0.03 < 0.05
    const routeVecA = [1, 0];
    const routeVecB = [0, 1];
    const queryVec = [0.75, 0.72];

    const provider: EmbeddingProvider = {
      id: "mock",
      model: "mock",
      embedBatch: vi.fn(async (texts: string[]) =>
        texts.map((t) => (t.startsWith("code") ? routeVecA : routeVecB)),
      ),
      embedQuery: vi.fn(async () => queryVec),
    };

    // threshold=0.68 (default), minGap=0.05 (default)
    const router = new SemanticRouter(provider);
    await router.init(
      new Map([
        [TaskType.CODE_EDIT, ["code utterance"]],
        [TaskType.GIT_OPS, ["git utterance"]],
      ]),
    );

    // top-1=CODE_EDIT(0.75) ≥ 0.68, but gap=0.03 < 0.05 → null
    const result = await router.resolve("query");
    expect(result).toBeNull();
  });

  it("returns top-1 TaskType when confidence gap is sufficient", async () => {
    // CODE_EDIT: [1, 0], GIT_OPS: [0, 1]
    // query: [0.9, 0.5] → dot(CODE_EDIT)=0.9, dot(GIT_OPS)=0.5, gap=0.4 >= 0.05
    const routeVecA = [1, 0];
    const routeVecB = [0, 1];
    const queryVec = [0.9, 0.5];

    const provider: EmbeddingProvider = {
      id: "mock",
      model: "mock",
      embedBatch: vi.fn(async (texts: string[]) =>
        texts.map((t) => (t.startsWith("code") ? routeVecA : routeVecB)),
      ),
      embedQuery: vi.fn(async () => queryVec),
    };

    // threshold=0.68, top-1=0.9 ≥ 0.68, gap=0.4 ≥ 0.05 → CODE_EDIT
    const router = new SemanticRouter(provider);
    await router.init(
      new Map([
        [TaskType.CODE_EDIT, ["code utterance"]],
        [TaskType.GIT_OPS, ["git utterance"]],
      ]),
    );

    const result = await router.resolve("query");
    expect(result).toBe(TaskType.CODE_EDIT);
  });

  it("single TaskType is never penalised by gap check (secondBest = -Infinity)", async () => {
    const vec = [1, 0, 0, 0];
    const provider: EmbeddingProvider = {
      id: "mock",
      model: "mock",
      embedBatch: vi.fn(async () => [vec]),
      embedQuery: vi.fn(async () => vec), // score = 1.0
    };

    const router = new SemanticRouter(provider); // minGap = 0.05
    await router.init(new Map([[TaskType.PLANNING, ["plan this"]]]));

    // 只有一个 TaskType，secondBestScore = -Infinity，gap = Infinity ≥ minGap
    const result = await router.resolve("query");
    expect(result).toBe(TaskType.PLANNING);
  });
});

describe("SemanticRouter — utterances sanity", () => {
  it("FALLBACK 不在 ROUTE_UTTERANCES 中（FALLBACK 不应参与向量匹配）", () => {
    expect(ROUTE_UTTERANCES.has(TaskType.FALLBACK)).toBe(false);
  });
});

describe("SemanticRouter — query embedding cache", () => {
  it("第二次 resolve 同一文本时 embedQuery 不被调用", async () => {
    const provider = makeMockProvider();
    const router = new SemanticRouter(provider, 0.5);
    await router.init(new Map([[TaskType.CODE_EDIT, ["hello"]]]));

    await router.resolve("same text");
    await router.resolve("same text"); // cache hit
    // embedQuery 只应被调用一次
    expect(provider.embedQuery).toHaveBeenCalledTimes(1);
  });

  it("不同文本各自调用 embedQuery", async () => {
    const provider = makeMockProvider();
    const router = new SemanticRouter(provider, 0.5);
    await router.init(new Map([[TaskType.CODE_EDIT, ["hello"]]]));

    await router.resolve("text A");
    await router.resolve("text B");
    expect(provider.embedQuery).toHaveBeenCalledTimes(2);
    expect(router.cacheSize).toBe(2);
  });

  it("cache 满后最旧条目被驱逐，cacheSize 不超过 MAX_CACHE_SIZE(100)", async () => {
    const provider = makeMockProvider();
    const router = new SemanticRouter(provider, 0.5);
    await router.init(new Map([[TaskType.CODE_EDIT, ["hello"]]]));

    // 填满 cache（100 条）
    for (let i = 0; i < 100; i++) {
      await router.resolve(`unique text ${i}`);
    }
    expect(router.cacheSize).toBe(100);

    // 插入第 101 条 → 驱逐最旧条目，size 仍为 100
    await router.resolve("overflow text");
    expect(router.cacheSize).toBe(100);

    // "unique text 0" 应已被驱逐，再次 resolve 会触发 embedQuery
    const callsBefore = (provider.embedQuery as ReturnType<typeof vi.fn>).mock.calls.length;
    await router.resolve("unique text 0");
    const callsAfter = (provider.embedQuery as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfter).toBe(callsBefore + 1);
  });

  it("init 后 cache 被清空", async () => {
    const provider = makeMockProvider();
    const router = new SemanticRouter(provider, 0.5);
    await router.init(new Map([[TaskType.CODE_EDIT, ["hello"]]]));

    // 先填入若干缓存条目
    await router.resolve("cached text 1");
    await router.resolve("cached text 2");
    expect(router.cacheSize).toBe(2);

    // 重新 init → cache 应被清空
    await router.init(new Map([[TaskType.GIT_OPS, ["push"]]]));
    expect(router.cacheSize).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("SemanticRouter — edge cases", () => {
  it("空字符串输入 → 不应 crash，返回 TaskType 或 null", async () => {
    const provider = makeMockProvider();
    const router = new SemanticRouter(provider, 0.5);
    await router.init(new Map([[TaskType.CODE_EDIT, ["hello"]]]));

    // 不应抛出异常
    await expect(router.resolve("")).resolves.not.toThrow();
    const result = await router.resolve("");
    // 结果要么是 TaskType 要么是 null（不 crash 即可）
    expect(result === null || typeof result === "string").toBe(true);
  });

  it("极长输入 → 不应 crash", async () => {
    const provider = makeMockProvider();
    const router = new SemanticRouter(provider, 0.5);
    await router.init(new Map([[TaskType.CODE_EDIT, ["hello"]]]));

    const longText = "a".repeat(100_000);
    await expect(router.resolve(longText)).resolves.not.toThrow();
  });

  it("并发 resolve → 不应 crash，两次结果一致", async () => {
    const vec = [1, 0, 0, 0];
    const provider: EmbeddingProvider = {
      id: "mock",
      model: "mock",
      embedBatch: vi.fn(async () => [vec]),
      embedQuery: vi.fn(async () => vec),
    };
    const router = new SemanticRouter(provider, 0.5);
    await router.init(new Map([[TaskType.CODE_EDIT, ["hello"]]]));

    // 两个并发 resolve 调用
    const [r1, r2] = await Promise.all([
      router.resolve("concurrent query"),
      router.resolve("concurrent query"),
    ]);

    // 不 crash，且结果相同
    expect(r1).toBe(r2);
  });

  it("第二次 init 覆盖第一次的 routes，旧 cache 被清空", async () => {
    const vec1 = [1, 0, 0, 0]; // CODE_EDIT 路由向量
    const vec2 = [0, 1, 0, 0]; // GIT_OPS 路由向量

    const provider: EmbeddingProvider = {
      id: "mock",
      model: "mock",
      embedBatch: vi
        .fn()
        .mockResolvedValueOnce([vec1]) // 第一次 init
        .mockResolvedValueOnce([vec2]), // 第二次 init
      embedQuery: vi.fn(async () => vec2), // 命中 GIT_OPS
    };

    const router = new SemanticRouter(provider, 0.5);

    // 第一次 init：CODE_EDIT 路由
    await router.init(new Map([[TaskType.CODE_EDIT, ["edit code"]]]));
    expect(router.routeCount).toBe(1);

    // 填充一些 cache
    await router.resolve("some query");
    expect(router.cacheSize).toBe(1);

    // 第二次 init：GIT_OPS 路由（覆盖 CODE_EDIT）
    await router.init(new Map([[TaskType.GIT_OPS, ["push to git"]]]));
    expect(router.routeCount).toBe(1); // 仍然只有 1 条路由
    expect(router.cacheSize).toBe(0); // cache 已清空

    // resolve 命中新路由 GIT_OPS，而不是旧的 CODE_EDIT
    const result = await router.resolve("query");
    expect(result).toBe(TaskType.GIT_OPS);
  });

  it("所有 routes 的 utterances 均为空 → routeCount=0，resolve 返回 null", async () => {
    const provider = makeMockProvider();
    const router = new SemanticRouter(provider, 0.5);

    await router.init(
      new Map([
        [TaskType.CODE_EDIT, []], // 空
        [TaskType.GIT_OPS, []], // 空
      ]),
    );

    expect(router.routeCount).toBe(0);
    expect(router.isInitialized).toBe(true); // init 已调用

    const result = await router.resolve("anything");
    expect(result).toBeNull();
  });
});
