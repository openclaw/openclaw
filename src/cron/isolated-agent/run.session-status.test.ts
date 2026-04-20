import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  resolveCronSessionMock,
  runWithModelFallbackMock,
  updateSessionStoreMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("cron isolated run session status", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("sets sessionEntry.status to 'done' after a successful run", async () => {
    const session = makeCronSession();
    resolveCronSessionMock.mockReturnValue(session);

    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [{ text: "hello" }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      },
      provider: "openai",
      model: "gpt-4",
      attempts: [],
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob(),
      }),
    );

    expect(result.status).toBe("ok");
    expect(session.sessionEntry.status).toBe("done");
  });

  it("sets sessionEntry.status to 'failed' when payloads contain a fatal error", async () => {
    const session = makeCronSession();
    resolveCronSessionMock.mockReturnValue(session);

    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [{ text: "error occurred", isError: true }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      },
      provider: "openai",
      model: "gpt-4",
      attempts: [],
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob(),
      }),
    );

    expect(result.status).toBe("error");
    expect(session.sessionEntry.status).toBe("failed");
  });

  it("sets sessionEntry.status to 'failed' when the run throws", async () => {
    const session = makeCronSession();
    resolveCronSessionMock.mockReturnValue(session);

    runWithModelFallbackMock.mockRejectedValue(new Error("model exploded"));

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob(),
      }),
    );

    expect(result.status).toBe("error");
    expect(session.sessionEntry.status).toBe("failed");
    // Verify persistSessionEntry was called (updateSessionStore is the underlying mock)
    expect(updateSessionStoreMock).toHaveBeenCalled();
  });

  it("sets sessionEntry.status to 'timeout' when aborted before telemetry", async () => {
    const session = makeCronSession();
    resolveCronSessionMock.mockReturnValue(session);

    const abortController = new AbortController();

    // Abort during the model run
    runWithModelFallbackMock.mockImplementation(async () => {
      abortController.abort();
      return {
        result: {
          payloads: [{ text: "partial" }],
          meta: { agentMeta: { usage: { input: 5, output: 5 } } },
        },
        provider: "openai",
        model: "gpt-4",
        attempts: [],
      };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob(),
        abortSignal: abortController.signal,
      }),
    );

    expect(result.status).toBe("error");
    expect(session.sessionEntry.status).toBe("timeout");
  });

  it("persists status via updateSessionStore", async () => {
    const session = makeCronSession();
    resolveCronSessionMock.mockReturnValue(session);

    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [{ text: "ok" }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      },
      provider: "openai",
      model: "gpt-4",
      attempts: [],
    });

    await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob(),
      }),
    );

    expect(updateSessionStoreMock).toHaveBeenCalled();
    // The session entry should have status set when persisted
    expect(session.sessionEntry.status).toBe("done");
  });
});
