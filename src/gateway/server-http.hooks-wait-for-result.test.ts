/**
 * Tests the waitForResult / announceToMain response contract for POST /hooks/agent:
 * completed vs accepted status mapping, agent error surfacing, idempotency-cache
 * bypass for waiting callers, and cache rollback when dispatch rejects.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { HookAgentDispatchPayload } from "./hooks.js";
import {
  createHookRequest,
  createHooksHandler,
  createResponse,
} from "./server-http.test-harness.js";

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

type DispatchResult = {
  runId: string;
  sessionKey: string;
  outputText?: string;
  agentError?: string;
};

/** Dispatch mock that echoes the pre-allocated runId like the production dispatcher. */
function createDispatchMock(
  respond: (payload: HookAgentDispatchPayload) => Partial<DispatchResult> = () => ({}),
) {
  return vi.fn(async (payload: HookAgentDispatchPayload): Promise<DispatchResult> => {
    return {
      runId: payload.runId ?? "run-fallback",
      sessionKey: payload.sessionKey,
      ...respond(payload),
    };
  });
}

async function postAgentHook(
  handler: ReturnType<typeof createHooksHandler>,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  readJsonBodyMock.mockResolvedValueOnce({ ok: true, value: payload });
  const req = createHookRequest({ url: "/hooks/agent" });
  const { res, getBody } = createResponse();
  const handled = await handler(req, res);
  expect(handled).toBe(true);
  return { status: res.statusCode, body: JSON.parse(getBody()) as Record<string, unknown> };
}

describe("POST /hooks/agent waitForResult contract", () => {
  beforeEach(() => {
    readJsonBodyMock.mockClear();
  });

  test("waitForResult returns completed status with the agent output", async () => {
    const dispatchAgentHook = createDispatchMock(() => ({ outputText: "agent says hi" }));
    const handler = createHooksHandler({ dispatchAgentHook });

    const { status, body } = await postAgentHook(handler, {
      message: "Do it",
      name: "Wait",
      waitForResult: true,
      announceToMain: false,
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: "completed", result: "agent says hi" });
    expect(typeof body.runId).toBe("string");
    expect(typeof body.sessionKey).toBe("string");
    const dispatched = dispatchAgentHook.mock.calls[0]?.[0];
    expect(dispatched?.waitForResult).toBe(true);
    expect(dispatched?.announceToMain).toBe(false);
    expect(dispatched?.runId).toBe(body.runId);
  });

  test("async requests keep the accepted contract without a result field", async () => {
    const dispatchAgentHook = createDispatchMock();
    const handler = createHooksHandler({ dispatchAgentHook });

    const { status, body } = await postAgentHook(handler, {
      message: "Do it",
      name: "Async",
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: "accepted" });
    expect(body).not.toHaveProperty("result");
    const dispatched = dispatchAgentHook.mock.calls[0]?.[0];
    expect(dispatched?.waitForResult).toBe(false);
    expect(dispatched?.announceToMain).toBe(true);
  });

  test("waitForResult maps agentError to a structured 500 response", async () => {
    const dispatchAgentHook = createDispatchMock(() => ({ agentError: "model exploded" }));
    const handler = createHooksHandler({ dispatchAgentHook });

    const { status, body } = await postAgentHook(handler, {
      message: "Do it",
      name: "Fail",
      waitForResult: true,
    });

    expect(status).toBe(500);
    expect(body).toMatchObject({ ok: false, status: "error", error: "model exploded" });
    expect(typeof body.runId).toBe("string");
    expect(body).not.toHaveProperty("result");
  });

  test("dispatch rejection returns a structured 500 and rolls back the idempotency cache", async () => {
    const dispatchAgentHook = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockImplementation(async (payload: HookAgentDispatchPayload) => ({
        runId: payload.runId,
        sessionKey: payload.sessionKey,
      }));
    const handler = createHooksHandler({ dispatchAgentHook });

    const first = await postAgentHook(handler, {
      message: "Do it",
      name: "Retry",
      idempotencyKey: "idem-rollback",
    });
    expect(first.status).toBe(500);
    expect(first.body).toMatchObject({ ok: false, status: "error" });
    expect(String(first.body.error)).toContain("boom");

    // The failed dispatch must not leave a cache entry behind: the retry has
    // to reach the dispatcher again instead of replaying a phantom run.
    const second = await postAgentHook(handler, {
      message: "Do it",
      name: "Retry",
      idempotencyKey: "idem-rollback",
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, status: "accepted" });
    expect(dispatchAgentHook).toHaveBeenCalledTimes(2);
  });

  test("waitForResult retries bypass the idempotency cache and re-run the agent", async () => {
    const dispatchAgentHook = createDispatchMock(() => ({ outputText: "fresh" }));
    const handler = createHooksHandler({ dispatchAgentHook });

    const payload = {
      message: "Do it",
      name: "Wait",
      waitForResult: true,
      idempotencyKey: "idem-wait",
    };
    const first = await postAgentHook(handler, payload);
    const second = await postAgentHook(handler, payload);

    expect(first.body).toMatchObject({ ok: true, status: "completed", result: "fresh" });
    expect(second.body).toMatchObject({ ok: true, status: "completed", result: "fresh" });
    expect(first.body.runId).not.toBe(second.body.runId);
    expect(dispatchAgentHook).toHaveBeenCalledTimes(2);
  });

  test("async idempotent retries replay the accepted response from cache", async () => {
    const dispatchAgentHook = createDispatchMock();
    const handler = createHooksHandler({ dispatchAgentHook });

    const payload = { message: "Do it", name: "Async", idempotencyKey: "idem-async" };
    const first = await postAgentHook(handler, payload);
    const second = await postAgentHook(handler, payload);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      ok: true,
      status: "accepted",
      runId: first.body.runId,
      sessionKey: first.body.sessionKey,
    });
    expect(typeof first.body.sessionKey).toBe("string");
    expect(dispatchAgentHook).toHaveBeenCalledTimes(1);
  });
});
