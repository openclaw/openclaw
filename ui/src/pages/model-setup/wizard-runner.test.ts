import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, GatewayBrowserClient } from "../../api/gateway.ts";
import type { WizardNextResult } from "../../api/types.ts";
import * as uuid from "../../lib/uuid.ts";
import { ModelSetupWizardRunner } from "./wizard-runner.ts";

type RunnerOptions = ConstructorParameters<typeof ModelSetupWizardRunner>[0];

function createRunner(options: Pick<RunnerOptions, "getClient"> & Partial<RunnerOptions>) {
  return new ModelSetupWizardRunner({
    getAgentId: () => null,
    onChange: () => undefined,
    requestFailedMessage: () => "failed",
    cancelledMessage: () => "cancelled",
    sessionExpiredMessage: () => "expired",
    gatewayNotRespondingMessage: () => "not responding",
    ...options,
  });
}

describe("ModelSetupWizardRunner", () => {
  it("cleans a late MCP admission on the captured client without replaying or selecting an agent", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const generateUUID = vi.spyOn(uuid, "generateUUID").mockReturnValue(sessionId);
    const admission = createDeferred<WizardNextResult>();
    const original = new GatewayBrowserClient({ url: "ws://gateway-a.example.test" });
    const replacement = new GatewayBrowserClient({ url: "ws://gateway-b.example.test" });
    const originalRequest = vi
      .spyOn(original, "request")
      .mockReturnValueOnce(admission.promise)
      .mockResolvedValue({ status: "cancelled" });
    const replacementRequest = vi.spyOn(replacement, "request");
    let client = original;
    const getAgentId = vi.fn(() => "selected-agent");
    const onStart = vi.fn();
    const runner = createRunner({ getClient: () => client, getAgentId, onStart });
    try {
      const start = runner.startMcpLogin("docs");
      expect(originalRequest).toHaveBeenCalledWith(
        "mcp.authLogin",
        { sessionId, serverName: "docs" },
        { timeoutMs: null },
      );
      expect(getAgentId).not.toHaveBeenCalled();
      expect(onStart).toHaveBeenCalledWith("mcp.authLogin", undefined);

      client = replacement;
      await runner.cancel();
      const cancellation = originalRequest.mock.calls[1];
      expect(cancellation).toEqual([
        "wizard.cancel",
        { sessionId, closeInput: true },
        { timeoutMs: 30_000 },
      ]);
      admission.resolve({ done: false, status: "running" });
      await expect(start).resolves.toBeNull();
      expect(originalRequest).toHaveBeenCalledTimes(3);
      expect(originalRequest.mock.calls[2]).toEqual(cancellation);
      expect(replacementRequest).not.toHaveBeenCalled();
      expect(runner.state).toEqual({ phase: "idle" });
    } finally {
      admission.resolve({ done: true, status: "cancelled" });
      await runner.cancel();
      originalRequest.mockRestore();
      replacementRequest.mockRestore();
      generateUUID.mockRestore();
    }
  });

  it("shares a failed in-flight cancellation with teardown", async () => {
    const pending = createDeferred<unknown>();
    const request = vi.fn(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { done: false, status: "running" };
      }
      if (method === "wizard.cancel") {
        return await pending.promise;
      }
      return { done: false, status: "running", step: { id: "key", type: "text" } };
    });
    const terminal = vi.fn();
    const runner = createRunner({
      getClient: () => ({ request }) as unknown as GatewayBrowserClient,
      getAgentId: () => "main",
      onStart: () => terminal,
    });
    await runner.start("provider-auth");
    const explicit = runner.requestCancellation();
    const teardown = runner.cancel();
    const callsBeforeAcknowledgment = request.mock.calls.filter(
      ([method]) => method === "wizard.cancel",
    );
    pending.reject(new Error("Cancellation transport disconnected"));
    await expect(Promise.all([explicit, teardown])).resolves.toEqual([undefined, undefined]);
    expect(callsBeforeAcknowledgment).toHaveLength(1);
    expect(runner.state).toEqual({ phase: "idle" });
    expect(terminal).not.toHaveBeenCalled();
  });

  it("cancels independently after transport rebind and retries settled cancellation attempts", async () => {
    const oldCancellation = createDeferred<unknown>();
    const originalRequest = vi.fn(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { done: false, status: "running" };
      }
      if (method === "wizard.cancel") {
        return await oldCancellation.promise;
      }
      return { done: false, status: "running", step: { id: "key", type: "text" } };
    });
    let cancellations = 0;
    const replacementRequest = vi.fn(async (method: string) => {
      if (method === "wizard.next") {
        return { done: false, status: "running", step: { id: "key", type: "text" } };
      }
      if (method === "wizard.cancel") {
        cancellations += 1;
        if (cancellations === 1) {
          return { status: "running" };
        }
        if (cancellations === 2) {
          throw new Error("Cancellation transport disconnected");
        }
        return { status: "cancelled" };
      }
      throw new Error(`Unexpected wizard request: ${method}`);
    });
    let client = { request: originalRequest } as unknown as GatewayBrowserClient;
    const terminal = vi.fn();
    const runner = createRunner({
      getClient: () => client,
      getAgentId: () => "main",
      onStart: () => terminal,
    });
    await runner.start("provider-auth");
    const pending = runner.requestCancellation();
    runner.suspend();
    client = { request: replacementRequest } as unknown as GatewayBrowserClient;
    await runner.resume();
    await expect(runner.requestCancellation()).resolves.toBe("running");
    await expect(runner.requestCancellation()).rejects.toThrow(
      "Cancellation transport disconnected",
    );
    expect(runner.state).toMatchObject({ phase: "step", authChoice: "provider-auth" });
    await expect(runner.requestCancellation()).resolves.toBe("cancelled");
    expect(cancellations).toBe(3);
    expect(terminal).toHaveBeenCalledExactlyOnceWith({ done: true, status: "cancelled" });
    oldCancellation.resolve({ status: "cancelled" });
    await expect(pending).resolves.toBeUndefined();
    expect(terminal).toHaveBeenCalledOnce();
    expect(runner.state).toEqual({ phase: "idle" });
    expect(
      originalRequest.mock.calls.filter(([method]) => method === "wizard.cancel"),
    ).toHaveLength(1);
    expect(replacementRequest.mock.calls.map(([method]) => method)).toEqual([
      "wizard.next",
      "wizard.cancel",
      "wizard.cancel",
      "wizard.cancel",
    ]);
  });

  it("retires detached admission authority before a client can represent another owner", async () => {
    const lateReply = createDeferred<WizardNextResult>();
    const request = vi.fn(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return await lateReply.promise;
      }
      if (method === "wizard.next") {
        return { done: false, status: "running", step: { id: "key", type: "text" } };
      }
      if (method === "wizard.cancel") {
        return await lateReply.promise;
      }
      throw new Error(`Unexpected wizard request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const onTerminal = vi.fn();
    const runner = createRunner({
      getClient: () => client,
      getAgentId: () => "main",
      onStart: () => onTerminal,
    });
    const pending = runner.start("original-provider");
    runner.close({ retireOwner: true });
    const requestsAtRetirement = request.mock.calls.length;
    lateReply.resolve({ done: false, status: "running" });
    await pending;
    expect(request).toHaveBeenCalledTimes(requestsAtRetirement);
    expect(onTerminal).not.toHaveBeenCalled();
    expect(runner.state).toEqual({ phase: "idle" });
  });

  it("reconciles an interrupted answer without replaying it or cancelling the resumed wizard", async () => {
    const interrupted = createDeferred<unknown>();
    let nextCalls = 0;
    const originalRequest = vi.fn(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { done: false, status: "running" };
      }
      nextCalls += 1;
      if (nextCalls === 1) {
        return { done: false, status: "running", step: { id: "key", type: "text" } };
      }
      return interrupted.promise;
    });
    const replacementRequest = vi.fn(
      async (_method: string, _params?: unknown, _options?: unknown) => ({
        done: false,
        status: "running",
        step: { id: "model-review", type: "note" },
      }),
    );
    let client = { request: originalRequest } as unknown as GatewayBrowserClient;
    const terminal = vi.fn();
    const runner = createRunner({
      getClient: () => client,
      getAgentId: () => "research",
      onStart: () => terminal,
    });
    await runner.start("meta-api-key");
    const answer = runner.answer("synthetic-key");
    runner.suspend();
    client = { request: replacementRequest } as unknown as GatewayBrowserClient;
    await runner.resume();
    expect(replacementRequest).toHaveBeenCalledExactlyOnceWith(
      "wizard.next",
      { sessionId: expect.any(String) },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    interrupted.resolve({ done: true, status: "cancelled" });
    await answer;
    expect(terminal).not.toHaveBeenCalled();
    expect(runner.state).toMatchObject({
      phase: "step",
      authChoice: "meta-api-key",
      step: { id: "model-review" },
    });
    expect(
      originalRequest.mock.calls.filter(([method]) => method === "wizard.cancel"),
    ).toHaveLength(0);
  });

  it("uses a terminal reply received while disconnected without repeating a Gateway request", async () => {
    const terminalReply = createDeferred<unknown>();
    let nextCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { done: false, status: "running" };
      }
      if (++nextCalls === 1) {
        return { done: false, status: "running", step: { id: "key", type: "text" } };
      }
      return terminalReply.promise;
    });
    const afterReconnect = vi.fn();
    let client = { request } as unknown as GatewayBrowserClient;
    const onTerminal = vi.fn();
    const runner = createRunner({
      getClient: () => client,
      getAgentId: () => "research",
      onStart: () => onTerminal,
    });
    await runner.start("meta-api-key");
    const answer = runner.answer("synthetic-key");
    runner.suspend();
    terminalReply.resolve({
      done: true,
      status: "done",
      modelActivation: { modelRef: "meta/fixture-model" },
    });
    await answer;
    expect(onTerminal).not.toHaveBeenCalled();
    client = { request: afterReconnect } as unknown as GatewayBrowserClient;
    expect(await runner.resume()).toMatchObject({
      modelActivation: { modelRef: "meta/fixture-model" },
    });
    expect(afterReconnect).not.toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it("starts, advances an unbounded note step, and guards duplicate answers", async () => {
    let resolveDone: ((value: unknown) => void) | null = null;
    const request = vi.fn((method: string, _params?: unknown, _options?: unknown) => {
      if (method === "openclaw.setup.auth.start") {
        return Promise.resolve({ sessionId: "session-1", done: false, status: "running" });
      }
      if (method === "wizard.next" && !resolveDone) {
        resolveDone = () => undefined;
        return Promise.resolve({
          done: false,
          status: "running",
          step: { id: "note-1", type: "note", message: "Continue in browser" },
        });
      }
      if (method === "wizard.next") {
        return new Promise((resolve) => {
          resolveDone = resolve;
        });
      }
      return Promise.resolve({});
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const runner = createRunner({
      getClient: () => client,
      getAgentId: () => "research",
    });

    await runner.start("openai-oauth");
    expect(request).toHaveBeenNthCalledWith(
      1,
      "openclaw.setup.auth.start",
      { sessionId: expect.any(String), agentId: "research", authChoice: "openai-oauth" },
      { timeoutMs: null },
    );
    expect(runner.state).toMatchObject({ phase: "step" });
    const answer = runner.answer(undefined, false);
    void runner.answer(undefined, false);
    expect(request).toHaveBeenCalledTimes(3);
    const nextCalls = request.mock.calls.filter(([method]) => method === "wizard.next");
    expect(nextCalls[1]?.[1]).toEqual({
      sessionId: expect.any(String),
      answer: { stepId: "note-1" },
    });
    expect(nextCalls[1]?.[2]).toEqual(
      expect.objectContaining({ timeoutMs: null, signal: expect.any(AbortSignal) }),
    );
    resolveDone!({ done: true, status: "done" });
    await expect(answer).resolves.toEqual({ startMethod: "openclaw.setup.auth.start" });
    expect(runner.state).toEqual({ phase: "done" });
  });

  it("releases a late admission after close so setup can restart", async () => {
    const method = "openclaw.setup.auth.start";
    let runningSession: string | null = null;
    let firstSessionId = "";
    let resolveFirstStart: () => void = () => {
      throw new Error("the first setup request did not start");
    };
    let startCount = 0;
    const request = vi.fn(
      async (
        requestMethod: string,
        params?: { sessionId?: string },
        options?: { signal?: AbortSignal },
      ) => {
        if (requestMethod === method) {
          const sessionId = params?.sessionId;
          if (!sessionId) {
            throw new Error("missing setup session");
          }
          if (startCount++ === 0) {
            firstSessionId = sessionId;
            return await new Promise((resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => reject(new Error("Gateway retired the aborted start request")),
                { once: true },
              );
              resolveFirstStart = () => {
                runningSession = sessionId;
                resolve({ sessionId, done: false, status: "running" });
              };
            });
          }
          if (runningSession) {
            throw new Error("wizard already running");
          }
          return { sessionId, done: true, status: "done" };
        }
        if (requestMethod === "wizard.cancel") {
          if (runningSession !== params?.sessionId) {
            throw new Error("wizard not found");
          }
          runningSession = null;
          return { status: "cancelled" };
        }
        throw new Error(`unexpected request ${requestMethod}`);
      },
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const terminalResult = vi.fn();
    const runner = createRunner({
      getClient: () => client,
      onStart: () => terminalResult,
    });

    const firstStart = runner.start("original", method);
    runner.close();
    resolveFirstStart();
    await firstStart;

    expect(runningSession).toBeNull();
    expect(terminalResult).toHaveBeenCalledWith({ done: true, status: "cancelled" });
    expect(request).toHaveBeenCalledWith(
      "wizard.cancel",
      { sessionId: firstSessionId },
      { timeoutMs: 30_000 },
    );
    await expect(runner.start("replacement", method)).resolves.toEqual({ startMethod: method });
    expect(runner.state).toEqual({ phase: "done" });
  });

  it.each([
    ["openclaw.setup.auth.start", "running"],
    ["openclaw.setup.auth.start", "busy"],
  ] as const)(
    "retains late %s responses after the local deadline (status: %s)",
    async (method, status) => {
      const terminal = status !== "running";
      vi.useFakeTimers();
      try {
        let runningSession: string | null = null;
        let firstSessionId = "";
        let resolveFirstStart: () => void = () => {
          throw new Error("the first setup request did not start");
        };
        let startCount = 0;
        const request = vi.fn(
          async (
            requestMethod: string,
            params?: { sessionId?: string },
            options?: { signal?: AbortSignal; timeoutMs?: number | null },
          ) => {
            if (requestMethod === method) {
              const sessionId = params?.sessionId;
              if (!sessionId) {
                throw new Error("missing setup session");
              }
              if (startCount++ === 0) {
                firstSessionId = sessionId;
                return await new Promise((resolve, reject) => {
                  options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                    once: true,
                  });
                  if (typeof options?.timeoutMs === "number") {
                    setTimeout(
                      () => reject(new Error("Gateway retired the timed-out request")),
                      options.timeoutMs,
                    );
                  }
                  resolveFirstStart = () => {
                    if (status === "busy") {
                      reject(
                        new GatewayRequestError({
                          code: "UNAVAILABLE",
                          message: "Setup busy",
                          details: { code: "SETUP_ADMISSION_BUSY" },
                        }),
                      );
                      return;
                    }
                    if (!terminal) {
                      runningSession = sessionId;
                    }
                    resolve({ sessionId, done: terminal, status });
                  };
                });
              }
              if (runningSession) {
                throw new Error("wizard already running");
              }
              return { sessionId, done: true, status: "done" };
            }
            if (requestMethod === "wizard.cancel") {
              if (runningSession !== params?.sessionId) {
                throw new Error("wizard not found");
              }
              runningSession = null;
              return { status: "cancelled" };
            }
            throw new Error(`unexpected request ${requestMethod}`);
          },
        );
        const client = { request } as unknown as GatewayBrowserClient;
        const terminalResult = vi.fn();
        const runner = createRunner({
          getClient: () => client,
          onStart: () => terminalResult,
        });

        const timedOutStart = runner.start("original", method);
        await vi.advanceTimersByTimeAsync(30_000);
        await timedOutStart;
        expect(runner.state).toEqual({ phase: "error", message: "not responding" });

        resolveFirstStart();
        await vi.runAllTimersAsync();
        expect(runningSession).toBeNull();
        expect(terminalResult).toHaveBeenCalledOnce();
        const cancelCalls = request.mock.calls.filter(
          ([requestMethod]) => requestMethod === "wizard.cancel",
        );
        const lateCancelCalls = cancelCalls.filter(
          ([, params]) => params?.sessionId === firstSessionId,
        );
        expect(lateCancelCalls).toHaveLength(terminal ? 1 : 2);

        await runner.cancel();
        await expect(runner.start("replacement", method)).resolves.toEqual({ startMethod: method });
        expect(runner.state).toEqual({ phase: "done" });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("clears an expired session and abort without cancelling or replaying the answer", async () => {
    let nextCount = 0;
    let answerSignal: AbortSignal | undefined;
    const request = vi.fn(
      (method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
        if (method === "openclaw.setup.auth.start") {
          return Promise.resolve({ sessionId: "session-expired", done: false, status: "running" });
        }
        if (method === "wizard.next" && nextCount++ === 0) {
          return Promise.resolve({
            done: false,
            status: "running",
            step: { id: "api-key", type: "text", message: "API key", sensitive: true },
          });
        }
        if (method === "wizard.next") {
          answerSignal = options?.signal;
          return Promise.reject(
            new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: "wizard not found",
              details: { code: "WIZARD_NOT_FOUND" },
            }),
          );
        }
        return Promise.resolve({ ok: true });
      },
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const runner = createRunner({
      getClient: () => client,
      sessionExpiredMessage: () => "Setup expired. Close and restart setup.",
    });

    await runner.start("api-key");
    await runner.answer("secret-key");

    expect(runner.state).toEqual({
      phase: "error",
      message: "Setup expired. Close and restart setup.",
    });
    expect(answerSignal?.aborted).toBe(true);
    await runner.cancel();
    expect(
      request.mock.calls.filter(([method]) => method === "openclaw.setup.auth.start"),
    ).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "wizard.next")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "wizard.cancel")).toEqual([]);
  });
});
