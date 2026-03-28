import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";

const waitState = vi.hoisted(() => ({
  requestedStructuredOutput: false,
  waitForAgentJob: vi.fn(),
  waitForTerminalGatewayDedupe: vi.fn(),
  readTerminalSnapshotFromGatewayDedupe: vi.fn(),
}));

vi.mock("../../infra/agent-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/agent-events.js")>();
  return {
    ...actual,
    getAgentRunContext: vi.fn(() => ({
      requestedStructuredOutput: waitState.requestedStructuredOutput,
    })),
  };
});

vi.mock("./agent-job.js", () => ({
  waitForAgentJob: waitState.waitForAgentJob,
}));

vi.mock("./agent-wait-dedupe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-wait-dedupe.js")>();
  return {
    ...actual,
    readTerminalSnapshotFromGatewayDedupe: waitState.readTerminalSnapshotFromGatewayDedupe,
    waitForTerminalGatewayDedupe: waitState.waitForTerminalGatewayDedupe,
  };
});

import { agentHandlers } from "./agent.js";

function makeContext(): GatewayRequestContext {
  return {
    dedupe: new Map(),
    chatAbortControllers: new Map(),
  } as unknown as GatewayRequestContext;
}

describe("agent.wait structured metadata gating", () => {
  beforeEach(() => {
    waitState.requestedStructuredOutput = false;
    waitState.readTerminalSnapshotFromGatewayDedupe.mockReset();
    waitState.waitForAgentJob.mockReset();
    waitState.waitForTerminalGatewayDedupe.mockReset();
    waitState.readTerminalSnapshotFromGatewayDedupe.mockReturnValue(null);
  });

  it("returns plain lifecycle completions without waiting for dedupe metadata", async () => {
    waitState.waitForAgentJob.mockResolvedValue({
      status: "ok",
      startedAt: 1,
      endedAt: 2,
    });
    waitState.waitForTerminalGatewayDedupe.mockImplementation(() => new Promise<null>(() => {}));

    const respond = vi.fn();
    await agentHandlers["agent.wait"]({
      params: { runId: "run-plain", timeoutMs: 1_000 },
      respond: respond as never,
      context: makeContext(),
      req: { type: "req", id: "req-plain", method: "agent.wait" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId: "run-plain",
        status: "ok",
        stopReason: undefined,
        pendingToolCalls: undefined,
      }),
    );
  });

  it("re-reads structured output intent before applying lifecycle grace wait", async () => {
    let resolveLifecycle:
      | ((value: { status: "ok"; startedAt: number; endedAt: number }) => void)
      | undefined;
    let resolveDedupe:
      | ((value: {
          status: "ok";
          startedAt: number;
          endedAt: number;
          stopReason: "tool_calls";
          pendingToolCalls: Array<{ id: string; name: string; arguments: string }>;
        }) => void)
      | undefined;

    waitState.waitForAgentJob.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLifecycle = resolve;
        }),
    );
    waitState.waitForTerminalGatewayDedupe.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDedupe = resolve;
        }),
    );

    const respond = vi.fn();
    const waitPromise = agentHandlers["agent.wait"]({
      params: { runId: "run-reread", timeoutMs: 1_000 },
      respond: respond as never,
      context: makeContext(),
      req: { type: "req", id: "req-reread", method: "agent.wait" },
      client: null,
      isWebchatConnect: () => false,
    });

    await Promise.resolve();
    waitState.requestedStructuredOutput = true;
    resolveLifecycle?.({
      status: "ok",
      startedAt: 10,
      endedAt: 11,
    });
    await Promise.resolve();
    resolveDedupe?.({
      status: "ok",
      startedAt: 10,
      endedAt: 11,
      stopReason: "tool_calls",
      pendingToolCalls: [
        {
          id: "call-reread",
          name: "emit_structured_result",
          arguments: '{"ok":true}',
        },
      ],
    });

    await waitPromise;

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId: "run-reread",
        status: "ok",
        stopReason: "tool_calls",
        pendingToolCalls: [
          {
            id: "call-reread",
            name: "emit_structured_result",
            arguments: '{"ok":true}',
          },
        ],
      }),
    );
  });
});
