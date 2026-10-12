// Hook request lifetime: pending bounded admission dies with the client,
// accepted work and background fan-out do not.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { resolveHookMappings } from "./hooks-mapping.js";
import { createHooksConfig } from "./hooks-test-helpers.js";
import type { HookAgentDispatchPayload } from "./hooks.js";
import type { HookAgentDispatchResult } from "./hooks.types.js";
import {
  createHookRequest,
  createHooksHandler,
  createResponse,
} from "./server-http.test-harness.js";
import { createHooksRequestHandler } from "./server/hooks-request-handler.js";

const { readJsonBodyMock } = vi.hoisted(() => ({
  readJsonBodyMock: vi.fn(),
}));

vi.mock("./hooks.js", async () => {
  const actual = await vi.importActual<typeof import("./hooks.js")>("./hooks.js");
  return {
    ...actual,
    readJsonBody: readJsonBodyMock,
  };
});

type DispatchContext = { abortSignal?: AbortSignal };

function accepted(runId: string): HookAgentDispatchResult {
  return {
    ok: true,
    runId,
    completion: Promise.resolve({ status: "ok", replyDisposition: "empty" }),
  };
}

function disconnectedResult(): HookAgentDispatchResult {
  return {
    ok: false,
    statusCode: 503,
    error: "hook request disconnected before agent run started",
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("hook request admission lifetime", () => {
  beforeEach(() => {
    readJsonBodyMock.mockReset();
    readJsonBodyMock.mockResolvedValue({ ok: true, value: { message: "Dispatch" } });
  });

  test("rejects a disconnected unauthenticated hook before dispatch", async () => {
    const dispatchAgentHook = vi.fn();
    const handler = createHooksHandler({ dispatchAgentHook });
    const req = createHookRequest({
      url: "/hooks/agent",
      authorization: "Bearer wrong-token",
    });
    req.destroy();
    const { res } = createResponse();

    await expect(handler(req, res)).resolves.toBe(true);

    expect(res.statusCode).toBe(401);
    expect(dispatchAgentHook).not.toHaveBeenCalled();
  });

  test("cancels pending direct admission when the client disconnects", async () => {
    let dispatchSignal: AbortSignal | undefined;
    const dispatchAgentHook = vi.fn(
      async (_value: HookAgentDispatchPayload, context?: DispatchContext) => {
        dispatchSignal = context?.abortSignal;
        const aborted = await new Promise<boolean>((resolve) => {
          if (!context?.abortSignal) {
            resolve(false);
            return;
          }
          if (context.abortSignal.aborted) {
            resolve(true);
            return;
          }
          context.abortSignal.addEventListener("abort", () => resolve(true), { once: true });
        });
        return aborted ? disconnectedResult() : accepted("run-direct");
      },
    );
    const handler = createHooksHandler({ dispatchAgentHook });
    const req = createHookRequest({ url: "/hooks/agent" });
    const { res, end } = createResponse();

    const handled = handler(req, res);
    await vi.waitFor(() => expect(dispatchAgentHook).toHaveBeenCalledTimes(1));
    req.destroy();

    await expect(handled).resolves.toBe(true);
    expect(dispatchSignal?.aborted).toBe(true);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({
        ok: false,
        error: "hook request disconnected before agent run started",
      }),
    );
  });

  test("retries one disconnected idempotent request without a second execution", async () => {
    let releaseAdmission!: (admitted: boolean) => void;
    const admission = new Promise<boolean>((resolve) => {
      releaseAdmission = resolve;
    });
    let executions = 0;
    const dispatchAgentHook = vi.fn(
      async (_value: HookAgentDispatchPayload, context?: DispatchContext) => {
        const admitted = await Promise.race([
          admission,
          new Promise<boolean>((resolve) => {
            if (!context?.abortSignal) {
              return;
            }
            if (context.abortSignal.aborted) {
              resolve(false);
              return;
            }
            context.abortSignal.addEventListener("abort", () => resolve(false), { once: true });
          }),
        ]);
        if (!admitted) {
          return disconnectedResult();
        }
        executions += 1;
        return accepted("run-retry");
      },
    );
    const handler = createHooksHandler({ dispatchAgentHook });
    const headers = { "idempotency-key": "gmail-message-1" };
    const firstReq = createHookRequest({ url: "/hooks/agent", headers });
    const { res: firstRes } = createResponse();

    const firstHandled = handler(firstReq, firstRes);
    await vi.waitFor(() => expect(dispatchAgentHook).toHaveBeenCalledTimes(1));
    firstReq.destroy();
    await expect(firstHandled).resolves.toBe(true);
    expect(executions).toBe(0);

    releaseAdmission(true);
    const retryReq = createHookRequest({ url: "/hooks/agent", headers });
    const { res: retryRes, end: retryEnd } = createResponse();
    await expect(handler(retryReq, retryRes)).resolves.toBe(true);

    expect(dispatchAgentHook).toHaveBeenCalledTimes(2);
    expect(executions).toBe(1);
    expect(retryEnd).toHaveBeenCalledWith(JSON.stringify({ ok: true, runId: "run-retry" }));
  });

  test("keeps a shared pending admission alive while another caller stays connected", async () => {
    const release = createDeferred<void>();
    let runs = 0;
    const dispatchAgentHook = vi.fn(
      async (_value: HookAgentDispatchPayload, context?: DispatchContext) => {
        const disconnected = new Promise<boolean>((resolve) => {
          if (!context?.abortSignal) {
            return;
          }
          context.abortSignal.addEventListener("abort", () => resolve(true), { once: true });
        });
        const aborted = await Promise.race([release.promise.then(() => false), disconnected]);
        if (aborted) {
          return disconnectedResult();
        }
        runs += 1;
        return accepted("run-shared");
      },
    );
    const handler = createHooksHandler({ dispatchAgentHook });
    const headers = { "idempotency-key": "shared-hook" };
    const firstReq = createHookRequest({ url: "/hooks/agent", headers });
    const secondReq = createHookRequest({ url: "/hooks/agent", headers });
    const firstRes = createResponse();
    const secondRes = createResponse();

    const firstHandled = handler(firstReq, firstRes.res);
    await vi.waitFor(() => expect(dispatchAgentHook).toHaveBeenCalledTimes(1));
    const secondHandled = handler(secondReq, secondRes.res);
    await vi.waitFor(() => expect(dispatchAgentHook).toHaveBeenCalledTimes(1));
    firstReq.destroy();
    await delay(20);
    expect(runs).toBe(0);
    release.resolve();

    await expect(Promise.all([firstHandled, secondHandled])).resolves.toEqual([true, true]);
    expect(dispatchAgentHook).toHaveBeenCalledTimes(1);
    expect(runs).toBe(1);
    expect(secondRes.end).toHaveBeenCalledWith(JSON.stringify({ ok: true, runId: "run-shared" }));
  });

  test("does not cancel background gmail fan-out when the client disconnects", async () => {
    const release = createDeferred<void>();
    let signal: AbortSignal | undefined;
    const dispatchAgentHook = vi.fn(
      async (_value: HookAgentDispatchPayload, context?: DispatchContext) => {
        signal = context?.abortSignal;
        await release.promise;
        return accepted("run-gmail");
      },
    );
    const canonical = createHooksConfig();
    const hooksConfig = {
      ...canonical,
      mappings: resolveHookMappings({
        presets: ["gmail"],
        allowRequestSessionKey: true,
        allowedSessionKeyPrefixes: ["hook:gmail:"],
      }),
      sessionPolicy: {
        ...canonical.sessionPolicy,
        allowRequestSessionKey: true,
        allowedSessionKeyPrefixes: ["hook:gmail:"],
      },
    };
    const handler = createHooksRequestHandler({
      scheduler: createTestGatewayScheduler("fake-timers"),
      getHooksConfig: () => hooksConfig,
      bindHost: "127.0.0.1",
      port: 18789,
      logHooks: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
      dispatchWakeHook: () => ({ eventOutcome: "queued" }),
      dispatchAgentHook,
      fanoutResponseDeadlineMs: 50,
    });
    readJsonBodyMock.mockResolvedValueOnce({
      ok: true,
      value: {
        source: "gmail",
        messages: [
          {
            id: "m1",
            from: "m1@example.com",
            subject: "Subject",
            snippet: "s",
            body: "b",
          },
        ],
      },
    });
    const req = createHookRequest({ url: "/hooks/gmail" });
    const { res } = createResponse();

    const handled = handler(req, res);
    await vi.waitFor(() => expect(dispatchAgentHook).toHaveBeenCalledTimes(1));
    req.destroy();
    await delay(20);
    expect(signal?.aborted).not.toBe(true);
    release.resolve();

    await expect(handled).resolves.toBe(true);
    expect(dispatchAgentHook).toHaveBeenCalledTimes(1);
  });
});
