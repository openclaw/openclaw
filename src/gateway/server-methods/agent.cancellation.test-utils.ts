// Imported by agent.test.ts to share its established Gateway mock graph.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
} from "../../agents/run-termination.js";
import { dispatchAgentRunFromGateway } from "../agent-turn/agent-run-dispatch.js";
import { createAgentTurnIo } from "../agent-turn/io.js";
import { describe0AfterEach0, getAgentTestMocks, makeContext } from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

describe("gateway run-owned cancellation", () => {
  afterEach(describe0AfterEach0);

  it.each([
    {
      name: "direct cancellation without Gateway abort",
      gatewayReason: undefined,
      error: createAgentRunDirectAbortError(),
      ok: true,
      status: "timeout",
      stopReason: "rpc",
    },
    {
      name: "plain provider abort without Gateway abort",
      gatewayReason: undefined,
      error: Object.assign(new Error("provider aborted"), { name: "AbortError" }),
      ok: false,
      status: "error",
      stopReason: undefined,
    },
    {
      name: "Gateway timeout takes precedence",
      gatewayReason: Object.assign(new Error("deadline reached"), { name: "TimeoutError" }),
      error: createAgentRunDirectAbortError(),
      ok: true,
      status: "timeout",
      stopReason: "timeout",
    },
    {
      name: "Gateway restart takes precedence",
      gatewayReason: createAgentRunRestartAbortError(),
      error: createAgentRunDirectAbortError(),
      ok: true,
      status: "timeout",
      stopReason: "restart",
    },
  ])("$name", async ({ gatewayReason, error, ok, status, stopReason }) => {
    const abortController = new AbortController();
    if (gatewayReason) {
      abortController.abort(gatewayReason);
    }
    mocks.agentCommand.mockRejectedValueOnce(error);
    const context = makeContext();
    const respond = vi.fn();
    const cleanupAbortController = vi.fn();
    const runId = "run-owned-cancellation";
    await dispatchAgentRunFromGateway({
      admittedRunEntry: undefined,
      ingressOpts: {
        message: "finish private continuation",
        sessionKey: "agent:main:main",
        allowModelOverride: false,
      },
      runId,
      dedupeKeys: ["agent:" + runId],
      abortController,
      cleanupAbortController,
      io: createAgentTurnIo(respond),
      context,
    });
    const payload = {
      runId,
      status,
      summary: ok ? "aborted" : error.message,
      ...(stopReason ? { stopReason } : {}),
    };
    expect(respond).toHaveBeenCalledWith(
      ok,
      expect.objectContaining(payload),
      ok ? undefined : expect.any(Object),
      expect.any(Object),
    );
    expect(context.dedupe.get("agent:" + runId)).toMatchObject({ ok, payload });
    expect(cleanupAbortController).toHaveBeenCalledOnce();
    expect(abortController.signal.aborted).toBe(gatewayReason !== undefined);
  });
});
