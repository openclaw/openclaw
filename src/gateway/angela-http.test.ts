import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";

const { readJsonBodyOrErrorMock } = vi.hoisted(() => ({
  readJsonBodyOrErrorMock: vi.fn(),
}));

vi.mock("./http-common.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./http-common.js")>();
  return {
    ...actual,
    readJsonBodyOrError: readJsonBodyOrErrorMock,
  };
});

import { createAngelaTaskRequestHandler, ANGELA_MESSAGE_PATH } from "./angela-http.js";
import { createGatewayRequest } from "./hooks-test-helpers.js";

function createRequest(): IncomingMessage {
  return createGatewayRequest({
    method: "POST",
    path: ANGELA_MESSAGE_PATH,
    host: "127.0.0.1:18789",
  });
}

function createResponse(): {
  res: ServerResponse;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  getBody: () => string;
} {
  const setHeader = vi.fn();
  let body = "";
  const end = vi.fn((chunk?: unknown) => {
    if (typeof chunk === "string") {
      body = chunk;
      return;
    }
    if (chunk == null) {
      body = "";
      return;
    }
    body = JSON.stringify(chunk);
  });
  const res = {
    statusCode: 200,
    setHeader,
    end,
  } as unknown as ServerResponse;
  return {
    res,
    setHeader,
    end,
    getBody: () => body,
  };
}

describe("Angela HTTP task handler", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    readJsonBodyOrErrorMock.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("accepts Angela task envelopes and emits started/completed receipts", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const handler = createAngelaTaskRequestHandler({
      log: { warn: vi.fn() },
      runTask: ({ observer }) => {
        observer.onStarted();
        observer.onFinished({
          status: "ok",
          summary: "Investor narrative delivered",
          delivered: false,
          deliveryAttempted: false,
        });
        return "run-angela-1";
      },
    });

    readJsonBodyOrErrorMock.mockResolvedValue({
      schema: "AngelaTaskEnvelopeV1",
      task_id: "task-angela-1",
      run_id: "run-angela-upstream-1",
      callback_url: "http://tonya.internal/mission-control/api/tasks/task-angela-1/receipts",
      receipt_schema: "AngelaTaskReceiptV1",
      objective: "Prepare investor narrative",
      capability: "marketing",
      team_id: "marketing",
      alias: "story-architect",
      requester: { id: "tonya", kind: "operator" },
      acceptance_criteria: ["narrative drafted"],
      context_refs: [],
      inputs: { campaign: "series-a" },
      execution: {
        transport: "angela-http",
        runtime: "acpx",
        durable: true,
      },
    });
    const req = createRequest();
    const response = createResponse();

    const handled = await handler(req, response.res);
    await new Promise((resolve) => setImmediate(resolve));

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(202);
    expect(JSON.parse(response.getBody())).toMatchObject({
      ok: true,
      status: "accepted",
      taskId: "task-angela-1",
      runId: "run-angela-1",
      agentId: "story-architect",
      callbackRegistered: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const call0 = fetchMock.mock.calls[0];
    expect(call0?.[0]).toBe(
      "http://tonya.internal/mission-control/api/tasks/task-angela-1/receipts",
    );
    const body0 = (call0?.[1] as RequestInit | undefined)?.body;
    expect(
      JSON.parse(typeof body0 === "string" ? body0 : JSON.stringify(body0 ?? "")),
    ).toMatchObject({
      schema: "AngelaTaskReceiptV1",
      state: "started",
      owner: "angela",
      task_id: "task-angela-1",
      run_id: "run-angela-upstream-1",
    });
    const body1 = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body;
    expect(
      JSON.parse(typeof body1 === "string" ? body1 : JSON.stringify(body1 ?? "")),
    ).toMatchObject({
      schema: "AngelaTaskReceiptV1",
      state: "completed",
      owner: "angela",
      task_id: "task-angela-1",
      run_id: "run-angela-upstream-1",
      result_status: "SUCCESS",
    });
  });

  it("maps skipped runs to blocked receipts", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const handler = createAngelaTaskRequestHandler({
      log: { warn: vi.fn() },
      runTask: ({ observer }) => {
        observer.onFinished({
          status: "skipped",
          summary: "missing artifact",
        });
        return "run-angela-2";
      },
    });

    readJsonBodyOrErrorMock.mockResolvedValue({
      schema: "AngelaTaskEnvelopeV1",
      task_id: "task-angela-2",
      run_id: "run-angela-upstream-2",
      callback_url: "http://tonya.internal/mission-control/api/tasks/task-angela-2/receipts",
      objective: "Prepare campaign package",
      capability: "marketing",
      requester: { id: "tonya", kind: "operator" },
      acceptance_criteria: ["package ready"],
      execution: {
        transport: "angela-http",
        runtime: "acpx",
        durable: true,
      },
    });
    const req = createRequest();
    const response = createResponse();

    const handled = await handler(req, response.res);
    await new Promise((resolve) => setImmediate(resolve));

    expect(handled).toBe(true);
    expect(response.res.statusCode).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init0 = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body0 = init0?.body;
    expect(
      JSON.parse(typeof body0 === "string" ? body0 : JSON.stringify(body0 ?? "")),
    ).toMatchObject({
      schema: "AngelaTaskReceiptV1",
      state: "blocked",
      failure_code: "angela-task-skipped",
    });
  });

  it("rejects unauthenticated requests when the shared secret is configured", async () => {
    const handler = createAngelaTaskRequestHandler({
      log: { warn: vi.fn() },
      runTask: vi.fn(() => "run-angela-3"),
    });

    const req = createRequest();
    const response = createResponse();

    await withEnvAsync(
      {
        OPENCLAW_ANGELA_SHARED_SECRET: "top-secret-angela",
      },
      async () => {
        const handled = await handler(req, response.res);
        expect(handled).toBe(true);
      },
    );

    expect(response.res.statusCode).toBe(401);
    expect(response.getBody()).toContain("Unauthorized");
  });
});
