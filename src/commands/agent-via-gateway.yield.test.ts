import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { agentCliCommand } from "./agent-via-gateway.js";
import { createGatewayNormalCloseError } from "./agent-via-gateway.test-support.js";

const callGateway = vi.hoisted(() => vi.fn());
const config = vi.hoisted(() => ({
  agents: { defaults: { timeoutSeconds: 600 } },
  session: { mainKey: "main" },
}));

// mock-isolation: the CLI must dispatch with this fixture config, not the operator's.
vi.mock("../config/gateway-dispatch-config.js", () => ({
  readGatewayDispatchConfig: () => config,
  readGatewayDispatchConfigWithShellEnvFallback: async () => config,
}));
// mock-isolation: Gateway dispatch fixtures control runtime config without loading operator state.
vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => config,
  captureRuntimeConfigAsyncReader: () => async () => config,
  loadConfig: () => config,
}));
// mock-isolation: the fixture plays the Gateway's agent connection.
vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callGateway,
}));

const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
const jsonRuntime = { ...runtime, writeJson: vi.fn(), writeStdout: vi.fn() };
const runTo = () => agentCliCommand({ message: "hi", sessionKey: "agent:main:main" }, runtime);
let originalExitCode: NodeJS.Process["exitCode"];

beforeEach(() => {
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_GATEWAY_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.exitCode = originalExitCode;
});

const yieldedTurn = {
  runId: "turn-1",
  status: "ok",
  result: {
    payloads: [],
    meta: { yielded: true, yieldAcknowledgment: "Checking with a helper." },
    acceptedSessionSpawns: [
      {
        runId: "child-1",
        childSessionKey: "agent:main:subagent:c1",
        expectsCompletionMessage: true,
      },
    ],
  },
};

function lifecycle(runId: string, sessionKey: string, phase: string) {
  return { event: "agent", payload: { runId, sessionKey, stream: "lifecycle", data: { phase } } };
}

function chatFinal(runId: string, sessionKey: string, text: string, extra = {}) {
  return {
    event: "chat",
    payload: {
      runId,
      sessionKey,
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text }] },
      ...extra,
    },
  };
}

/** The agent connection streams `events`, answers the yielded turn, then streams `later`. */
function mockYieldedGatewayTurn(events: unknown[], later: unknown[] = []) {
  callGateway.mockImplementationOnce(async (value: unknown) => {
    const request = value as {
      onAccepted?: (payload: unknown) => void;
      onEvent?: (event: unknown) => void;
      onResponse?: (request: unknown, signal: AbortSignal, result: unknown) => Promise<void>;
    };
    request.onAccepted?.({ status: "accepted", runId: "turn-1", sessionKey: "agent:main:main" });
    for (const event of events) {
      request.onEvent?.(event);
    }
    const waiting = request.onResponse?.(vi.fn(), new AbortController().signal, yieldedTurn);
    if (later.length) {
      // The wait is armed once the turn's own reply has printed.
      await vi.waitFor(() => expect(runtime.log).toHaveBeenCalledWith("Checking with a helper."));
      // One zero-length timer turn: a zero deadline (the --timeout 0 bug) would fire first.
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    for (const event of later) {
      request.onEvent?.(event);
    }
    await waiting;
    return yieldedTurn;
  });
}

it("prints a yielded turn's acknowledgment, then the reply its subagents settle", async () => {
  const main = "agent:main:main";
  mockYieldedGatewayTurn([
    // An earlier run in the session and the child's own reply are not the follow-up.
    lifecycle("other-run", main, "start"),
    chatFinal("other-run", main, "unrelated"),
    chatFinal("child-1", "agent:main:subagent:c1", "323"),
    lifecycle("child-1", "agent:main:subagent:c1", "end"),
    lifecycle("settle-1", main, "start"),
    chatFinal("settle-1", main, "Waiting on more.", { yielded: true, stopReason: "end_turn" }),
    lifecycle("settle-2", main, "start"),
    chatFinal("settle-2", main, "The helper says 17 × 19 = 323."),
  ]);

  await runTo();

  expect(vi.mocked(runtime.log).mock.calls).toEqual([
    ["Checking with a helper."],
    ["The helper says 17 × 19 = 323."],
  ]);
  expect(runtime.error).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(0);
});

it("waits without a deadline when --timeout 0 disables the turn's timeout", async () => {
  const main = "agent:main:main";
  mockYieldedGatewayTurn(
    [lifecycle("child-1", "agent:main:subagent:c1", "end")],
    [lifecycle("settle-1", main, "start"), chatFinal("settle-1", main, "Done: 323.")],
  );

  await agentCliCommand({ message: "hi", sessionKey: main, timeout: "0" }, runtime);

  expect(runtime.log).toHaveBeenLastCalledWith("Done: 323.");
  expect(runtime.error).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(0);
});

it("says where a yielded turn's result goes when the connection drops during the wait", async () => {
  const connection = new AbortController();
  callGateway.mockImplementationOnce(async (value: unknown) => {
    const request = value as {
      onAccepted?: (payload: unknown) => void;
      onResponse?: (request: unknown, signal: AbortSignal, result: unknown) => Promise<void>;
    };
    request.onAccepted?.({ status: "accepted", runId: "turn-1", sessionKey: "agent:main:main" });
    const waiting = request.onResponse?.(vi.fn(), connection.signal, yieldedTurn);
    connection.abort();
    await waiting;
    throw createGatewayNormalCloseError();
  });

  await runTo();

  expect(runtime.log).toHaveBeenCalledWith("Checking with a helper.");
  expect(runtime.error).toHaveBeenCalledWith(
    "Stopped waiting for the subagents. Their result will still be added to session agent:main:main.",
  );
  expect(process.exitCode).toBe(1);
});

it("keeps --json output and timing unchanged for a yielded turn", async () => {
  mockYieldedGatewayTurn([]);

  await agentCliCommand({ message: "hi", sessionKey: "agent:main:main", json: true }, jsonRuntime);

  expect(jsonRuntime.writeJson).toHaveBeenCalledWith(yieldedTurn, 2);
  expect(jsonRuntime.error).not.toHaveBeenCalled();
});
