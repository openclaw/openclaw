import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetMeshRunsForTest, meshHandlers } from "./mesh.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  agent: vi.fn(),
  agentWait: vi.fn(),
  agentCommand: vi.fn(),
}));

vi.mock("./agent.js", () => ({
  agentHandlers: {
    agent: (...args: unknown[]) => mocks.agent(...args),
    "agent.wait": (...args: unknown[]) => mocks.agentWait(...args),
  },
}));

vi.mock("../../commands/agent.js", () => ({
  agentCommand: (...args: unknown[]) => mocks.agentCommand(...args),
}));

const makeContext = (): GatewayRequestContext =>
  ({
    dedupe: new Map(),
    addChatRun: vi.fn(),
    logGateway: { info: vi.fn(), error: vi.fn() },
  }) as unknown as GatewayRequestContext;

async function callMesh(method: keyof typeof meshHandlers, params: Record<string, unknown>) {
  return await new Promise<{ ok: boolean; payload?: unknown; error?: unknown }>((resolve) => {
    void meshHandlers[method]({
      req: { type: "req", id: `test-${method}`, method },
      params,
      respond: (ok, payload, error) => resolve({ ok, payload, error }),
      context: makeContext(),
      client: null,
      isWebchatConnect: () => false,
    });
  });
}

afterEach(() => {
  __resetMeshRunsForTest();
  mocks.agent.mockReset();
  mocks.agentWait.mockReset();
  mocks.agentCommand.mockReset();
});

describe("mesh handlers", () => {
  it("builds a default single-step plan", async () => {
    const res = await callMesh("mesh.plan", { goal: "Write release notes" });
    expect(res.ok).toBe(true);
    const payload = res.payload as { plan: { goal: string; steps: Array<{ id: string }> } };
    expect(payload.plan.goal).toBe("Write release notes");
    expect(payload.plan.steps).toHaveLength(1);
    expect(payload.plan.steps[0]?.id).toBe("step-1");
  });

  it("rejects cyclic plans", async () => {
    const cyclePlan = {
      planId: "mesh-plan-1",
      goal: "cycle",
      createdAt: Date.now(),
      steps: [
        { id: "a", prompt: "a", dependsOn: ["b"] },
        { id: "b", prompt: "b", dependsOn: ["a"] },
      ],
    };
    const res = await callMesh("mesh.run", { plan: cyclePlan });
    expect(res.ok).toBe(false);
  });

  it("runs steps in DAG order and supports retrying failed steps", async () => {
    const runState = new Map<string, "ok" | "error">();
    mocks.agent.mockImplementation(
      (opts: {
        params: { idempotencyKey: string };
        respond: (ok: boolean, payload?: unknown) => void;
      }) => {
        const agentRunId = `agent-${opts.params.idempotencyKey}`;
        runState.set(agentRunId, "ok");
        if (opts.params.idempotencyKey.includes(":review:1")) {
          runState.set(agentRunId, "error");
        }
        opts.respond(true, { runId: agentRunId, status: "accepted" });
      },
    );
    mocks.agentWait.mockImplementation(
      (opts: { params: { runId: string }; respond: (ok: boolean, payload?: unknown) => void }) => {
        const status = runState.get(opts.params.runId) ?? "error";
        if (status === "ok") {
          opts.respond(true, { runId: opts.params.runId, status: "ok" });
          return;
        }
        opts.respond(true, {
          runId: opts.params.runId,
          status: "error",
          error: "simulated failure",
        });
      },
    );

    const plan = {
      planId: "mesh-plan-2",
      goal: "Ship patch",
      createdAt: Date.now(),
      steps: [
        { id: "research", prompt: "Research requirements" },
        { id: "build", prompt: "Build feature", dependsOn: ["research"] },
        { id: "review", prompt: "Review result", dependsOn: ["build"] },
      ],
    };

    const runRes = await callMesh("mesh.run", { plan });
    expect(runRes.ok).toBe(true);
    const runPayload = runRes.payload as {
      runId: string;
      status: string;
      stats: { failed: number };
    };
    expect(runPayload.status).toBe("failed");
    expect(runPayload.stats.failed).toBe(1);

    // Make subsequent retries succeed
    mocks.agent.mockImplementation(
      (opts: {
        params: { idempotencyKey: string };
        respond: (ok: boolean, payload?: unknown) => void;
      }) => {
        const agentRunId = `agent-${opts.params.idempotencyKey}`;
        runState.set(agentRunId, "ok");
        opts.respond(true, { runId: agentRunId, status: "accepted" });
      },
    );

    const retryRes = await callMesh("mesh.retry", {
      runId: runPayload.runId,
      stepIds: ["review"],
    });
    expect(retryRes.ok).toBe(true);
    const retryPayload = retryRes.payload as { status: string; stats: { failed: number } };
    expect(retryPayload.status).toBe("completed");
    expect(retryPayload.stats.failed).toBe(0);

    const statusRes = await callMesh("mesh.status", { runId: runPayload.runId });
    expect(statusRes.ok).toBe(true);
    const statusPayload = statusRes.payload as { status: string };
    expect(statusPayload.status).toBe("completed");
  });

  it("auto planner creates multiple steps from llm json output", async () => {
    mocks.agentCommand.mockResolvedValue({
      payloads: [
        {
          text: JSON.stringify({
            steps: [
              { id: "analyze", prompt: "Analyze requirements" },
              { id: "build", prompt: "Build implementation", dependsOn: ["analyze"] },
            ],
          }),
        },
      ],
      meta: {},
    });

    const res = await callMesh("mesh.plan.auto", {
      goal: "Create dashboard with auth",
      maxSteps: 4,
    });
    expect(res.ok).toBe(true);
    const payload = res.payload as {
      source: string;
      plan: { steps: Array<{ id: string }> };
      order: string[];
    };
    expect(payload.source).toBe("llm");
    expect(payload.plan.steps.map((s) => s.id)).toEqual(["analyze", "build"]);
    expect(payload.order).toEqual(["analyze", "build"]);
    expect(mocks.agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionKey: "agent:main:mesh-planner",
      }),
      expect.any(Object),
      undefined,
    );
  });

  it("auto planner falls back to single-step plan when llm output is invalid", async () => {
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "not valid json" }],
      meta: {},
    });
    const res = await callMesh("mesh.plan.auto", {
      goal: "Do a thing",
    });
    expect(res.ok).toBe(true);
    const payload = res.payload as {
      source: string;
      plan: { steps: Array<{ id: string; prompt: string }> };
    };
    expect(payload.source).toBe("fallback");
    expect(payload.plan.steps).toHaveLength(1);
    expect(payload.plan.steps[0]?.prompt).toBe("Do a thing");
  });

  it("auto planner respects caller-provided planner session key", async () => {
    mocks.agentCommand.mockResolvedValue({
      payloads: [
        {
          text: JSON.stringify({
            steps: [{ id: "one", prompt: "One" }],
          }),
        },
      ],
      meta: {},
    });

    const res = await callMesh("mesh.plan.auto", {
      goal: "Do a thing",
      sessionKey: "agent:main:custom-planner",
    });
    expect(res.ok).toBe(true);
    expect(mocks.agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:custom-planner",
      }),
      expect.any(Object),
      undefined,
    );
  });
});
