import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ModelTargetFenceConflictError,
  ModelTargetFenceStaleError,
  createModelTargetFenceStore,
} from "./model-target-fence-store.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const temporaryRoots: string[] = [];

function createStore() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-model-fence-"));
  temporaryRoots.push(root);
  return createModelTargetFenceStore({ path: path.join(root, "state.sqlite") });
}

const qwen35Fence = {
  provider: "kalliope",
  model: "qwen3.6:35b-a3b",
  topologyGeneration: "mama-single-gpu-v7",
  fenceEpoch: 41,
  fenceToken: "fence-token-41",
  resourceDomain: "mama-gpu-residency",
  deniedTargets: [
    { provider: "kalliope", model: "qwen3.6:27b" },
    { provider: "ornith", model: "qwen3.6:27b" },
  ],
  nowMs: 1_000,
} as const;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  temporaryRoots.length = 0;
});

describe("model target fence store", () => {
  it("persists an exact divert-new fence and generic resource-domain denials", () => {
    const store = createStore();

    const created = store.divertNew(qwen35Fence);
    const status = store.status();

    expect(created.mode).toBe("divert_new");
    expect(status.activeFences).toEqual([
      expect.objectContaining({
        provider: "kalliope",
        model: "qwen3.6:35b-a3b",
        topologyGeneration: "mama-single-gpu-v7",
        fenceEpoch: 41,
        fenceToken: "fence-token-41",
        resourceDomain: "mama-gpu-residency",
        deniedTargets: [
          { provider: "kalliope", model: "qwen3.6:27b" },
          { provider: "ornith", model: "qwen3.6:27b" },
        ],
      }),
    ]);
  });

  it("rejects stale epochs, parallel active fences, and stale release tokens", () => {
    const store = createStore();
    store.divertNew(qwen35Fence);

    expect(() =>
      store.divertNew({
        ...qwen35Fence,
        fenceEpoch: 40,
        fenceToken: "older-token",
      }),
    ).toThrow(ModelTargetFenceStaleError);
    expect(() =>
      store.divertNew({
        ...qwen35Fence,
        topologyGeneration: "mama-single-gpu-v8",
        fenceEpoch: 42,
        fenceToken: "parallel-token",
      }),
    ).toThrow(ModelTargetFenceConflictError);
    expect(() =>
      store.release({
        provider: qwen35Fence.provider,
        model: qwen35Fence.model,
        topologyGeneration: qwen35Fence.topologyGeneration,
        fenceEpoch: qwen35Fence.fenceEpoch,
        fenceToken: "stale-token",
        nowMs: 1_500,
      }),
    ).toThrow(ModelTargetFenceStaleError);
  });

  it("releases only the exact epoch/token and preserves history", () => {
    const store = createStore();
    store.divertNew(qwen35Fence);

    const released = store.release({
      provider: qwen35Fence.provider,
      model: qwen35Fence.model,
      topologyGeneration: qwen35Fence.topologyGeneration,
      fenceEpoch: qwen35Fence.fenceEpoch,
      fenceToken: qwen35Fence.fenceToken,
      nowMs: 2_000,
    });

    expect(released.state).toBe("released");
    expect(store.status()).toEqual({ activeFences: [] });
    expect(() =>
      store.divertNew({
        ...qwen35Fence,
        fenceToken: "reused-epoch-token",
        nowMs: 2_500,
      }),
    ).toThrow(ModelTargetFenceStaleError);
  });
});
