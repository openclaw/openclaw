// A context-engine completion capability can be retained past the runtime call
// that minted it. The admitting run may revoke authority while the capability
// is suspended on model acquisition, so the assertion must also gate the
// post-acquisition dispatch path and reach the final provider boundary.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveContextEngineCapabilities } from "../../agents/embedded-agent-runner/context-engine-capabilities.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const hoisted = vi.hoisted(() => ({
  acquireSimpleCompletionModelForAgent:
    vi.fn<
      typeof import("../../agents/simple-completion-runtime.js").acquireSimpleCompletionModelForAgent
    >(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
  resolveSimpleCompletionSelectionForAgent: vi.fn(),
  runIsolatedCompletion: vi.fn(),
}));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: hoisted.acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel: hoisted.completeWithPreparedSimpleCompletionModel,
  resolveSimpleCompletionSelectionForAgent: hoisted.resolveSimpleCompletionSelectionForAgent,
}));

vi.mock("../../agents/isolated-completion.js", () => ({
  runIsolatedCompletion: hoisted.runIsolatedCompletion,
}));

const cfg = {
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
    },
  },
} satisfies OpenClawConfig;

function createPreparedModel(): Extract<
  Awaited<ReturnType<typeof hoisted.acquireSimpleCompletionModelForAgent>>,
  { model: unknown }
> {
  return {
    async [Symbol.asyncDispose]() {},
    selection: {
      provider: "openai",
      modelId: "gpt-5.5",
      agentDir: "/tmp/openclaw-agent",
    },
    model: {
      provider: "openai",
      id: "gpt-5.5",
      name: "gpt-5.5",
      api: "openai",
      baseUrl: "https://fixture.invalid/v1",
      input: ["text"],
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 4096,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    },
    auth: {
      apiKey: "test-api-key",
      source: "test",
      mode: "api-key",
    },
  };
}

type MockCalls = {
  mock: { calls: unknown[][] };
};

const requireRecord = createRequireRecord("object", "expected-label");

function expectFields(record: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key], key).toEqual(value);
  }
}

function expectSingleCallFirstArg(
  mock: MockCalls,
  expected: Record<string, unknown>,
  label = "mock first argument",
): Record<string, unknown> {
  expect(mock.mock.calls).toHaveLength(1);
  const [firstArg] = mock.mock.calls[0] ?? [];
  const record = requireRecord(firstArg, label);
  expectFields(record, expected);
  return record;
}

function primeCompletionMocks() {
  hoisted.acquireSimpleCompletionModelForAgent.mockResolvedValue(createPreparedModel());
  hoisted.resolveSimpleCompletionSelectionForAgent.mockImplementation(
    (params: { modelRef?: string; agentId: string }) => {
      if (!params.modelRef) {
        return {
          provider: "openai",
          modelId: "gpt-5.5",
          agentDir: `/tmp/${params.agentId}`,
        };
      }
      const slash = params.modelRef.indexOf("/");
      return {
        provider: slash > 0 ? params.modelRef.slice(0, slash) : "openai",
        modelId: slash > 0 ? params.modelRef.slice(slash + 1) : params.modelRef,
        agentDir: `/tmp/${params.agentId}`,
      };
    },
  );
  hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValue({
    content: [{ type: "text", text: "done" }],
    responseModel: "gpt-5.5-2026-08-01",
    stopReason: "stop",
    usage: {
      input: 11,
      output: 7,
      cacheRead: 5,
      cacheWrite: 2,
      total: 25,
      cost: { total: 0.0042 },
    },
  });
  hoisted.runIsolatedCompletion.mockResolvedValue({
    text: "done",
    provider: "openai",
    model: "gpt-5.5",
    owner: { kind: "cli", id: "test" },
  });
}

describe("context-engine completion authority revocation", () => {
  beforeAll(async () => {
    // The first complete() pays dynamic-import and transform costs that can
    // exceed waitFor budgets on a cold worker, so warm the module graph once.
    primeCompletionMocks();
    const warmup = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:main:session:warmup",
      purpose: "context-engine.warmup",
    });
    await warmup.llm!.complete({ messages: [{ role: "user", content: "warm" }] });
  });

  beforeEach(() => {
    hoisted.acquireSimpleCompletionModelForAgent.mockReset();
    hoisted.completeWithPreparedSimpleCompletionModel.mockReset();
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReset();
    hoisted.runIsolatedCompletion.mockReset();
    primeCompletionMocks();
  });

  it("rejects a retained completion whose run authority is revoked during model acquisition", async () => {
    // Acquisition awaits external selection state; a revocation that lands
    // while the capability is suspended must stop the completion before any
    // provider dispatch instead of only gating the entry call.
    let releaseAcquisition:
      | ((prepared: ReturnType<typeof createPreparedModel>) => void)
      | undefined;
    hoisted.acquireSimpleCompletionModelForAgent.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseAcquisition = resolve;
        }),
    );
    let revoked = false;
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:main:session:abc",
      purpose: "context-engine.after-turn",
      assertRunAuthorityActive: () => {
        if (revoked) {
          throw new Error("admitted run authority is no longer active");
        }
      },
    });

    const pending = runtimeContext.llm!.complete({
      messages: [{ role: "user", content: "summarize" }],
    });
    // Cold worker imports and policy resolution can take longer than the
    // default waitFor budget before reaching the acquisition call.
    await vi.waitFor(
      () => {
        expect(hoisted.acquireSimpleCompletionModelForAgent).toHaveBeenCalledTimes(1);
      },
      { timeout: 15_000 },
    );

    revoked = true;
    releaseAcquisition?.(createPreparedModel());
    await expect(pending).rejects.toThrow("admitted run authority is no longer active");
    expect(hoisted.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
  });

  it("carries the run-authority assertion to the prepared dispatch boundary", async () => {
    const assertRunAuthorityActive = vi.fn<() => void>();
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:main:session:abc",
      purpose: "context-engine.after-turn",
      assertRunAuthorityActive,
    });

    await runtimeContext.llm!.complete({
      messages: [{ role: "user", content: "summarize" }],
    });
    // The prepared executor re-runs the assertion at the final provider
    // boundary; the dispatched completion must carry the exact captured gate.
    const dispatched = expectSingleCallFirstArg(
      hoisted.completeWithPreparedSimpleCompletionModel,
      {},
    );
    expect(dispatched.assertCurrent).toBe(assertRunAuthorityActive);
  });

  it("completes without interference while the run authority stays active", async () => {
    const assertRunAuthorityActive = vi.fn<() => void>();
    hoisted.acquireSimpleCompletionModelForAgent.mockResolvedValue(createPreparedModel());
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:main:session:abc",
      purpose: "context-engine.after-turn",
      assertRunAuthorityActive,
    });

    await expect(
      runtimeContext.llm!.complete({
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).resolves.toMatchObject({ text: "done" });
    expect(assertRunAuthorityActive).toHaveBeenCalled();
  });

  it("carries the run-authority assertion into isolated completions", async () => {
    const assertRunAuthorityActive = vi.fn<() => void>();
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:main:session:abc",
      purpose: "context-engine.after-turn",
      assertRunAuthorityActive,
    });

    await runtimeContext.llm!.complete({
      execution: { mode: "isolated-agent-runtime" },
      messages: [{ role: "user", content: "summarize" }],
    });
    // Isolated dispatch reaches provider I/O outside the deferred scope that
    // bounds direct completions, so the forwarded contract must carry the
    // exact captured gate for its own pre-dispatch revalidation.
    const forwarded = expectSingleCallFirstArg(hoisted.runIsolatedCompletion, {});
    expect(forwarded.assertCurrent).toBe(assertRunAuthorityActive);
    expect(assertRunAuthorityActive).toHaveBeenCalled();
  });

  it("rejects an isolated completion whose run authority is revoked during preparation", async () => {
    // The isolated contract awaits its own runtime lease after admission; a
    // revocation landing inside that window must surface as an authority
    // failure instead of a wrapped provider transport error, and the
    // completion must never resolve a usable result.
    let releaseIsolated: (() => void) | undefined;
    hoisted.runIsolatedCompletion.mockImplementation(
      (params: { assertCurrent?: () => void }) =>
        new Promise((_resolve, reject) => {
          releaseIsolated = () => {
            try {
              params.assertCurrent?.();
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          };
        }),
    );
    let revoked = false;
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:main:session:abc",
      purpose: "context-engine.after-turn",
      assertRunAuthorityActive: () => {
        if (revoked) {
          throw new Error("admitted run authority is no longer active");
        }
      },
    });

    const pending = runtimeContext.llm!.complete({
      execution: { mode: "isolated-agent-runtime" },
      messages: [{ role: "user", content: "summarize" }],
    });
    await vi.waitFor(
      () => {
        expect(hoisted.runIsolatedCompletion).toHaveBeenCalledTimes(1);
      },
      { timeout: 15_000 },
    );

    revoked = true;
    releaseIsolated?.();
    await expect(pending).rejects.toThrow("admitted run authority is no longer active");
  });
});
