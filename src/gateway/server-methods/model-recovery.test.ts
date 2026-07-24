import { describe, expect, it, vi } from "vitest";
import type { ModelTargetFenceStore } from "../../state/model-target-fence-store.js";
import { createModelRecoveryHandlers } from "./model-recovery.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function invoke(
  handlers: ReturnType<typeof createModelRecoveryHandlers>,
  method: keyof ReturnType<typeof createModelRecoveryHandlers>,
  params: Record<string, unknown>,
) {
  const respond = vi.fn();
  const handler = handlers[method];
  if (!handler) {
    throw new Error(`missing handler ${method}`);
  }
  const result = handler({
    req: { type: "req", id: "recovery-1", method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {} as never,
  } as GatewayRequestHandlerOptions);
  return { respond, result };
}

function createStore(): ModelTargetFenceStore {
  return {
    status: vi.fn(() => ({ activeFences: [] })),
    divertNew: vi.fn((params) => ({
      ...params,
      mode: "divert_new" as const,
      state: "active" as const,
      resourceDomain: params.resourceDomain ?? null,
      deniedTargets: [...(params.deniedTargets ?? [])],
      createdAtMs: params.nowMs ?? 1_000,
      releasedAtMs: null,
    })),
    release: vi.fn((params) => ({
      ...params,
      mode: "divert_new" as const,
      state: "released" as const,
      resourceDomain: null,
      deniedTargets: [],
      createdAtMs: 1_000,
      releasedAtMs: params.nowMs ?? 2_000,
    })),
  };
}

const target = {
  provider: "kalliope",
  model: "qwen3.6:35b-a3b",
  topologyGeneration: "mama-single-gpu-v7",
  fenceEpoch: 41,
  fenceToken: "fence-token-41",
};

describe("model recovery gateway methods", () => {
  it("serves status through the typed store", async () => {
    const store = createStore();
    const { respond, result } = invoke(
      createModelRecoveryHandlers(store),
      "modelRecovery.status",
      {},
    );
    await result;

    expect(store.status).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      true,
      { capability: "available", activeFences: [] },
      undefined,
    );
  });

  it("persists divert-new and exact release operations", async () => {
    const store = createStore();
    const handlers = createModelRecoveryHandlers(store);
    const divert = invoke(handlers, "modelRecovery.divertNew", {
      ...target,
      resourceDomain: "mama-gpu-residency",
      deniedTargets: [{ provider: "ornith", model: "qwen3.6:27b" }],
    });
    await divert.result;
    const release = invoke(handlers, "modelRecovery.release", target);
    await release.result;

    expect(store.divertNew).toHaveBeenCalledWith(
      expect.objectContaining({ ...target, nowMs: expect.any(Number) }),
    );
    expect(store.release).toHaveBeenCalledWith(
      expect.objectContaining({ ...target, nowMs: expect.any(Number) }),
    );
    expect(divert.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ state: "active" }),
      undefined,
    );
    expect(release.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ state: "released" }),
      undefined,
    );
  });

  it("fails closed on invalid input and unavailable capability", async () => {
    const store = createStore();
    const invalid = invoke(createModelRecoveryHandlers(store), "modelRecovery.divertNew", {
      ...target,
      fenceEpoch: 0,
    });
    await invalid.result;
    expect(store.divertNew).not.toHaveBeenCalled();
    expect(invalid.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );

    vi.mocked(store.status).mockImplementation(() => {
      throw new Error("model target fence schema unavailable");
    });
    const unavailable = invoke(createModelRecoveryHandlers(store), "modelRecovery.status", {});
    await unavailable.result;
    expect(unavailable.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("schema unavailable"),
      }),
    );
  });
});
