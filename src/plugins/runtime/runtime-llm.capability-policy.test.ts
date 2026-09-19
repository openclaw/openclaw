// Context-engine runtime capabilities own the only policy seam for engine
// callers: ambient plugin scope must not rescue an unbound completion, so the
// supplied owner id is what makes plugin completion allowlists apply.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveContextEngineCapabilities } from "../../agents/embedded-agent-runner/context-engine-capabilities.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const hoisted = vi.hoisted(() => ({
  acquireSimpleCompletionModelForAgent:
    vi.fn<
      typeof import("../../agents/simple-completion-runtime.js").acquireSimpleCompletionModelForAgent
    >(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
  resolveSimpleCompletionSelectionForAgent: vi.fn(),
}));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: hoisted.acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel: hoisted.completeWithPreparedSimpleCompletionModel,
  resolveSimpleCompletionSelectionForAgent: hoisted.resolveSimpleCompletionSelectionForAgent,
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

describe("context-engine capability completion policy", () => {
  beforeEach(() => {
    hoisted.acquireSimpleCompletionModelForAgent.mockReset();
    hoisted.completeWithPreparedSimpleCompletionModel.mockReset();
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReset();
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
  });

  it("denies default-model completions outside the owning plugin completion allowlist", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: {
        ...cfg,
        plugins: {
          entries: {
            "lossless-claw": {
              llm: {
                allowedCompletionModels: ["openai/gpt-5.4-mini"],
              },
            },
          },
        },
      },
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.after-turn",
    });

    await expect(
      runtimeContext.llm!.complete({
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow('model "openai/gpt-5.5" is not allowlisted for completions');
    expect(hoisted.acquireSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("allows default-model completions inside the owning plugin completion allowlist", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: {
        ...cfg,
        plugins: {
          entries: {
            "lossless-claw": {
              llm: {
                allowedCompletionModels: ["openai/gpt-5.5"],
              },
            },
          },
        },
      },
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.after-turn",
    });

    await runtimeContext.llm!.complete({
      messages: [{ role: "user", content: "summarize" }],
    });
    expectSingleCallFirstArg(hoisted.acquireSimpleCompletionModelForAgent, {
      agentId: "main",
    });
  });

  it("skips the plugin completion policy when the caller has no owning plugin id", async () => {
    // Context-engine callers bind plugin completion policy only through the
    // supplied owner id; without it a policy-excluded default model would run.
    const runtimeContext = resolveContextEngineCapabilities({
      config: {
        ...cfg,
        plugins: {
          entries: {
            "lossless-claw": {
              llm: {
                allowedCompletionModels: ["openai/gpt-5.4-mini"],
              },
            },
          },
        },
      },
      sessionKey: "agent:main:session:abc",
      purpose: "context-engine.after-turn",
    });

    await runtimeContext.llm!.complete({
      messages: [{ role: "user", content: "summarize" }],
    });
    expectSingleCallFirstArg(hoisted.acquireSimpleCompletionModelForAgent, {
      agentId: "main",
    });
  });

  it("rejects a retained completion before acquisition once run authority is revoked", async () => {
    // Engines can retain the minted capability past the runtime call that
    // supplied it; the run-authority gate keeps that retained handle from
    // completing after close, replacement, or abort.
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:main:session:abc",
      purpose: "context-engine.after-turn",
      assertRunAuthorityActive: () => {
        throw new Error("admitted run authority is no longer active");
      },
    });

    await expect(
      runtimeContext.llm!.complete({
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow("admitted run authority is no longer active");
    expect(hoisted.acquireSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });
});
