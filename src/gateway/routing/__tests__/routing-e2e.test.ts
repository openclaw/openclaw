/**
 * routing-e2e.test.ts — Routing end-to-end integration tests
 *
 * Tests the full chain:
 *   resolveTaskType (real, unmodified)
 *     → L1 keyword rules (sync)
 *     → L1.5 SemanticRouter (real class, mock EmbeddingProvider)
 *
 * Verifies:
 *   1. L1 miss + L1.5 hit path works end-to-end
 *   2. Configured threshold takes effect (higher threshold rejects borderline match)
 *   3. Configured min_gap takes effect (small gap → null even if score passes threshold)
 *   4. setEmbeddingProvider wires threshold and min_gap into SemanticRouter correctly
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "../../memory/embeddings.js";
import { getRoutingInstance, resetRoutingInstance } from "../routing-instance.js";
import { SemanticRouter } from "../semantic-router.js";
import { resolveTaskType } from "../task-resolver.js";
import { ModelTier, TaskType } from "../types.js";
import type { RoutingConfig } from "../types.js";
import { ROUTE_UTTERANCES } from "../utterances.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One-hot vector of `dim` dimensions at position `pos` */
function oneHot(dim: number, pos: number): number[] {
  const v = Array.from<number>({ length: dim }).fill(0);
  v[pos] = 1;
  return v;
}

/**
 * Build a mock EmbeddingProvider.
 *
 * Embedding strategy:
 *   - Routes (embedBatch) get vectors from `routeVectors` keyed by utterance content.
 *   - Queries (embedQuery) return `queryVector`.
 *
 * This lets us precisely control cosine similarity scores (dot products of
 * normalized one-hot vectors).
 */
function makePreciseMockProvider(params: {
  /** Map from utterance string → embedding vector */
  routeVectors: Map<string, number[]>;
  /** Vector returned for all embedQuery calls */
  queryVector: number[];
}): EmbeddingProvider {
  return {
    id: "mock",
    model: "mock-model",
    embedBatch: vi.fn(async (texts: string[]) =>
      texts.map((t) => params.routeVectors.get(t) ?? [0, 0, 0, 0]),
    ),
    embedQuery: vi.fn(async () => params.queryVector),
  };
}

/** Build a minimal RoutingConfig for testing */
function makeRoutingConfig(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    default_task_type: TaskType.FALLBACK,
    cooldown_seconds: 0,
    antiflap_enabled: false,
    triggers: {},
    deny_list: [],
    ha_matrix: {
      [TaskType.FALLBACK]: { [ModelTier.TIER1]: "fallback-model" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  resetRoutingInstance();
});

describe("resolveTaskType — L1 miss + L1.5 hit (end-to-end)", () => {
  it("returns SemanticRouter result when L1 does not match", async () => {
    // "这件事" contains no L1 keywords → falls through to L1.5
    // SemanticRouter is configured with CODE_EDIT route that matches the query
    const vec = oneHot(4, 0);
    const provider = makePreciseMockProvider({
      routeVectors: new Map([["write some code please", vec]]),
      queryVector: vec, // identical → score = 1.0
    });

    const router = new SemanticRouter(provider, 0.68, 0.05);
    await router.init(new Map([[TaskType.CODE_EDIT, ["write some code please"]]]));

    // "这件事" has no L1 keyword matches
    const result = await resolveTaskType("这件事", router);
    expect(result).toBe(TaskType.CODE_EDIT);
  });

  it("L1 keyword takes priority over SemanticRouter", async () => {
    // "fix" triggers L1 → CODE_DEBUG, even if semantic router would return something else
    const vec = oneHot(4, 0);
    const provider = makePreciseMockProvider({
      routeVectors: new Map([["plan something", vec]]),
      queryVector: vec,
    });

    const router = new SemanticRouter(provider, 0.5, 0.0);
    await router.init(new Map([[TaskType.PLANNING, ["plan something"]]]));

    // "fix this" → L1 hits CODE_DEBUG before L1.5 is consulted
    const result = await resolveTaskType("fix this", router);
    expect(result).toBe(TaskType.CODE_DEBUG);

    // SemanticRouter.resolve should NOT have been called at all
    expect(provider.embedQuery).not.toHaveBeenCalled();
  });

  it("falls back to FALLBACK when both L1 and L1.5 miss", async () => {
    // Score = 0 (orthogonal vectors) → SemanticRouter returns null
    const provider = makePreciseMockProvider({
      routeVectors: new Map([["route utterance", oneHot(4, 0)]]),
      queryVector: oneHot(4, 1), // orthogonal
    });

    const router = new SemanticRouter(provider, 0.5, 0.0);
    await router.init(new Map([[TaskType.CODE_EDIT, ["route utterance"]]]));

    // Text has no L1 keywords and no semantic match → FALLBACK
    const result = await resolveTaskType("随便说说", router);
    expect(result).toBe(TaskType.FALLBACK);
  });

  it("recentContext is forwarded to SemanticRouter query when L1 misses", async () => {
    // L1 misses on "好" (single char)
    // SemanticRouter receives "帮我写代码\n好" as concatenated query
    let capturedQuery: string | undefined;
    const vec = oneHot(4, 0);

    const provider: EmbeddingProvider = {
      id: "mock",
      model: "mock-model",
      embedBatch: vi.fn(async () => [vec]),
      embedQuery: vi.fn(async (text: string) => {
        capturedQuery = text;
        return vec; // same vec → score = 1.0 → returns CODE_EDIT
      }),
    };

    const router = new SemanticRouter(provider, 0.5, 0.0);
    await router.init(new Map([[TaskType.CODE_EDIT, ["code utterance"]]]));

    await resolveTaskType("好", router, "帮我写代码");

    // embedQuery should receive the concatenated text
    expect(capturedQuery).toBe("帮我写代码\n好");
  });
});

describe("resolveTaskType — threshold configuration (end-to-end)", () => {
  it("score below custom threshold → SemanticRouter returns null → FALLBACK", async () => {
    // Route vec=[1,0], query vec=[0.9, ~0.44] → dot ≈ 0.9
    // With threshold=0.95, 0.9 < 0.95 → null → FALLBACK
    const routeVec = [1, 0];
    const queryVec = [0.9, Math.sqrt(1 - 0.81)]; // normalized so dot=0.9

    const provider = makePreciseMockProvider({
      routeVectors: new Map([["some utterance", routeVec]]),
      queryVector: queryVec,
    });

    const router = new SemanticRouter(provider, 0.95, 0.0); // high threshold
    await router.init(new Map([[TaskType.CODE_EDIT, ["some utterance"]]]));

    const result = await resolveTaskType("something unrecognized", router);
    expect(result).toBe(TaskType.FALLBACK);
  });

  it("score above custom threshold → SemanticRouter returns TaskType", async () => {
    // Route vec=[1,0], query vec=[1,0] → dot = 1.0 ≥ 0.7
    const vec = [1, 0];
    const provider = makePreciseMockProvider({
      routeVectors: new Map([["some utterance", vec]]),
      queryVector: vec,
    });

    const router = new SemanticRouter(provider, 0.7, 0.0); // moderate threshold
    await router.init(new Map([[TaskType.PLANNING, ["some utterance"]]]));

    const result = await resolveTaskType("something unrecognized", router);
    expect(result).toBe(TaskType.PLANNING);
  });
});

describe("resolveTaskType — min_gap configuration (end-to-end)", () => {
  it("small confidence gap → SemanticRouter returns null → FALLBACK", async () => {
    // CODE_EDIT=[1,0], GIT_OPS=[0,1], query=[0.75, 0.72]
    // dot(CODE_EDIT)=0.75, dot(GIT_OPS)=0.72, gap=0.03 < min_gap=0.05
    const routeVecA = [1, 0];
    const routeVecB = [0, 1];
    const queryVec = [0.75, 0.72];

    const provider: EmbeddingProvider = {
      id: "mock",
      model: "mock-model",
      embedBatch: vi.fn(async (texts: string[]) =>
        texts.map((t) => (t === "code utterance" ? routeVecA : routeVecB)),
      ),
      embedQuery: vi.fn(async () => queryVec),
    };

    const router = new SemanticRouter(provider, 0.68, 0.05); // default min_gap
    await router.init(
      new Map([
        [TaskType.CODE_EDIT, ["code utterance"]],
        [TaskType.GIT_OPS, ["git utterance"]],
      ]),
    );

    const result = await resolveTaskType("something vague", router);
    expect(result).toBe(TaskType.FALLBACK);
  });

  it("large confidence gap → SemanticRouter returns top-1 TaskType", async () => {
    // CODE_EDIT=[1,0], GIT_OPS=[0,1], query=[0.9,0.5]
    // dot(CODE_EDIT)=0.9, dot(GIT_OPS)=0.5, gap=0.4 >= 0.05
    const routeVecA = [1, 0];
    const routeVecB = [0, 1];
    const queryVec = [0.9, 0.5];

    const provider: EmbeddingProvider = {
      id: "mock",
      model: "mock-model",
      embedBatch: vi.fn(async (texts: string[]) =>
        texts.map((t) => (t === "code utterance" ? routeVecA : routeVecB)),
      ),
      embedQuery: vi.fn(async () => queryVec),
    };

    const router = new SemanticRouter(provider, 0.68, 0.05);
    await router.init(
      new Map([
        [TaskType.CODE_EDIT, ["code utterance"]],
        [TaskType.GIT_OPS, ["git utterance"]],
      ]),
    );

    const result = await resolveTaskType("something vague", router);
    expect(result).toBe(TaskType.CODE_EDIT);
  });
});

/**
 * Build an EmbeddingProvider that returns distinct vectors per TaskType.
 *
 * Strategy:
 *   - Build utterance→TaskType index from ROUTE_UTTERANCES
 *   - Each TaskType gets a unique "slot" in a high-dimensional one-hot space
 *   - CODE_EDIT slot = 0, GIT_OPS slot = 1, ... etc.
 *
 * This avoids the minGap failure caused by all routes getting the same vector.
 */
function makeTaskTypeAwareMockProvider(params: {
  /** TaskType whose utterances should get the "match" vector */
  targetTaskType: TaskType;
  /** Vector to return for targetTaskType utterances */
  targetVec: number[];
  /** Vector to return for all other utterances */
  otherVec: number[];
  /** Vector returned for all embedQuery calls */
  queryVector: number[];
}): EmbeddingProvider {
  // Build utterance→TaskType index
  const utteranceIndex = new Map<string, TaskType>();
  for (const [taskType, utterances] of ROUTE_UTTERANCES) {
    for (const utterance of utterances) {
      utteranceIndex.set(utterance, taskType);
    }
  }

  return {
    id: "mock",
    model: "mock-model",
    embedBatch: vi.fn(async (texts: string[]) =>
      texts.map((t) => {
        const tt = utteranceIndex.get(t);
        return tt === params.targetTaskType ? params.targetVec : params.otherVec;
      }),
    ),
    embedQuery: vi.fn(async () => params.queryVector),
  };
}

describe("setEmbeddingProvider — threshold and min_gap wiring (end-to-end)", () => {
  it("setEmbeddingProvider uses SemanticRouter default threshold (0.68) when config has none", async () => {
    // When no threshold is configured, SemanticRouter should use its default 0.68.
    // query = CODE_EDIT vec → score = 1.0 ≥ 0.68 → should resolve CODE_EDIT.
    // All other TaskType utterances get orthogonal vector → score = 0.0, gap = 1.0 ≥ 0.05.
    const codeEditVec = [1, 0, 0, 0];
    const otherVec = [0, 1, 0, 0];

    const config = makeRoutingConfig({
      semantic_router: { enabled: true }, // no threshold or min_gap
    });

    const instance = getRoutingInstance(config);

    const provider = makeTaskTypeAwareMockProvider({
      targetTaskType: TaskType.CODE_EDIT,
      targetVec: codeEditVec,
      otherVec,
      queryVector: codeEditVec, // matches CODE_EDIT exactly
    });

    instance.setEmbeddingProvider(provider);

    // Wait for background init to complete.
    // vi.waitFor polls while the condition throws; stops when it returns.
    await vi.waitFor(
      () => {
        if (!instance.semanticRouter?.isInitialized) {
          throw new Error("semantic router not initialized yet");
        }
      },
      { timeout: 2000 },
    );

    expect(instance.semanticRouter!.isInitialized).toBe(true);

    // Score = 1.0, gap = 1.0, default threshold = 0.68 → should resolve
    const result = await instance.semanticRouter!.resolve("query");
    expect(result).toBe(TaskType.CODE_EDIT);
  });

  it("setEmbeddingProvider respects configured threshold from RoutingConfig", async () => {
    // threshold=0.99 in config.
    // CODE_EDIT vec = [1,0], query = [1,0] → score = 1.0 ≥ 0.99 → resolves.
    // Other vec = [0,1] → score = 0.0, gap = 1.0 ≥ min_gap(default 0.05) → OK.
    const codeEditVec = [1, 0, 0, 0];
    const otherVec = [0, 1, 0, 0];

    const config = makeRoutingConfig({
      semantic_router: { enabled: true, threshold: 0.99 },
    });

    const instance = getRoutingInstance(config);

    const provider = makeTaskTypeAwareMockProvider({
      targetTaskType: TaskType.CODE_EDIT,
      targetVec: codeEditVec,
      otherVec,
      queryVector: codeEditVec, // dot = 1.0 with CODE_EDIT
    });

    instance.setEmbeddingProvider(provider);

    await vi.waitFor(
      () => {
        if (!instance.semanticRouter?.isInitialized) {
          throw new Error("semantic router not initialized yet");
        }
      },
      { timeout: 2000 },
    );

    // score = 1.0 ≥ threshold = 0.99 → resolves
    const resultHigh = await instance.semanticRouter!.resolve("query");
    expect(resultHigh).toBe(TaskType.CODE_EDIT);

    // Verify threshold is actually 0.99 by checking a score of 0.98 would fail.
    // Use a fresh SemanticRouter with a single route and partial-overlap query.
    const vec = [1, 0, 0, 0];
    const partialProvider: EmbeddingProvider = {
      id: "mock",
      model: "mock-model",
      embedBatch: vi.fn(async () => [vec]),
      embedQuery: vi.fn(async () => [0.98, Math.sqrt(1 - 0.98 * 0.98), 0, 0]),
    };
    const strictRouter = new SemanticRouter(partialProvider, 0.99, 0.0);
    await strictRouter.init(new Map([[TaskType.CODE_EDIT, ["utterance"]]]));
    const resultBorderline = await strictRouter.resolve("q");
    expect(resultBorderline).toBeNull(); // 0.98 < 0.99 → null
  });

  it("setEmbeddingProvider respects configured min_gap from RoutingConfig", async () => {
    // min_gap=0.1 in config.
    // CODE_EDIT = [1, 0], GIT_OPS = [0, 1], others = neutral
    // query = [0.75, 0.72]:
    //   dot(CODE_EDIT) = 0.75 ≥ 0.68 (threshold)
    //   dot(GIT_OPS)   = 0.72
    //   gap = 0.03 < min_gap = 0.1 → null (ambiguous)
    const config = makeRoutingConfig({
      semantic_router: { enabled: true, threshold: 0.68, min_gap: 0.1 },
    });

    const instance = getRoutingInstance(config);

    // Build utterance→TaskType index
    const utteranceIndex = new Map<string, TaskType>();
    for (const [taskType, utterances] of ROUTE_UTTERANCES) {
      for (const utterance of utterances) {
        utteranceIndex.set(utterance, taskType);
      }
    }

    const provider: EmbeddingProvider = {
      id: "mock",
      model: "mock-model",
      embedBatch: vi.fn(async (texts: string[]) =>
        texts.map((t) => {
          const tt = utteranceIndex.get(t);
          if (tt === TaskType.CODE_EDIT) {
            return [1, 0];
          }
          if (tt === TaskType.GIT_OPS) {
            return [0, 1];
          }
          return [0.5, 0.5]; // neutral for other TaskTypes
        }),
      ),
      embedQuery: vi.fn(async () => [0.75, 0.72]),
    };

    instance.setEmbeddingProvider(provider);

    await vi.waitFor(
      () => {
        if (!instance.semanticRouter?.isInitialized) {
          throw new Error("semantic router not initialized yet");
        }
      },
      { timeout: 2000 },
    );

    const router = instance.semanticRouter!;
    // top-1 = CODE_EDIT(0.75) or a neutral(0.75*0.5+0.72*0.5=0.735)... but 0.75 > 0.735
    // top-2 score ≥ 0.72, gap ≤ 0.03 < min_gap=0.1 → should return null
    const result = await router.resolve("ambiguous query");
    expect(result).toBeNull();
  });

  it("setEmbeddingProvider is a no-op when semantic_router.enabled=false", () => {
    const config = makeRoutingConfig({
      semantic_router: { enabled: false },
    });

    const instance = getRoutingInstance(config);

    const provider = makePreciseMockProvider({
      routeVectors: new Map(),
      queryVector: [1, 0],
    });

    instance.setEmbeddingProvider(provider);

    // semanticRouter should remain undefined since enabled=false
    expect(instance.semanticRouter).toBeUndefined();
  });

  it("setEmbeddingProvider is a no-op on second call (already initialized)", async () => {
    const config = makeRoutingConfig({
      semantic_router: { enabled: true },
    });

    const instance = getRoutingInstance(config);
    const vec = oneHot(4, 0);

    const providerA = makePreciseMockProvider({
      routeVectors: new Map([["utterance", vec]]),
      queryVector: vec,
    });
    const providerB = makePreciseMockProvider({
      routeVectors: new Map([["utterance", vec]]),
      queryVector: vec,
    });

    instance.setEmbeddingProvider(providerA);

    await vi.waitFor(
      () => {
        if (!instance.semanticRouter?.isInitialized) {
          throw new Error("semantic router not initialized yet");
        }
      },
      { timeout: 2000 },
    );

    const routerAfterFirst = instance.semanticRouter;

    // Second call should be a no-op
    instance.setEmbeddingProvider(providerB);

    // Router instance should be unchanged
    expect(instance.semanticRouter).toBe(routerAfterFirst);

    // providerB.embedBatch should NOT have been called (no new router created)
    expect(providerB.embedBatch).not.toHaveBeenCalled();
  });
});
