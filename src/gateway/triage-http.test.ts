import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

vi.mock("./http-endpoint-helpers.js", () => ({
  handleGatewayPostJsonEndpoint: vi.fn(),
}));

vi.mock("./http-common.js", () => ({
  sendInvalidRequest: vi.fn(),
  sendJson: vi.fn(),
}));

const { handleGatewayPostJsonEndpoint } = await import("./http-endpoint-helpers.js");
const { sendInvalidRequest, sendJson } = await import("./http-common.js");
const { handleTriageHttpRequest } = await import("./triage-http.js");

const auth = {
  mode: "token",
  token: "t",
  password: undefined,
  allowTailscale: false,
} as const;

function makeReq(headers?: Record<string, string>): IncomingMessage {
  return {
    method: "POST",
    url: "/api/triage",
    headers: {
      host: "localhost",
      ...headers,
    },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

function makeRes(): ServerResponse {
  return {} as unknown as ServerResponse;
}

describe("handleTriageHttpRequest", () => {
  it("returns false when endpoint path does not match", async () => {
    vi.mocked(handleGatewayPostJsonEndpoint).mockResolvedValueOnce(false);
    const handled = await handleTriageHttpRequest(makeReq(), makeRes(), { auth });
    expect(handled).toBe(false);
  });

  it("rejects missing message", async () => {
    vi.mocked(handleGatewayPostJsonEndpoint).mockResolvedValueOnce({ body: {} });
    const handled = await handleTriageHttpRequest(makeReq(), makeRes(), { auth });
    expect(handled).toBe(true);
    expect(vi.mocked(sendInvalidRequest)).toHaveBeenCalledTimes(1);
  });

  it("returns stepup response when financial request is unverified", async () => {
    vi.mocked(handleGatewayPostJsonEndpoint).mockResolvedValueOnce({
      body: {
        message: "What is my payoff amount?",
        isFinancial: true,
      },
    });

    const handled = await handleTriageHttpRequest(makeReq(), makeRes(), { auth });

    expect(handled).toBe(true);
    expect(vi.mocked(sendJson)).toHaveBeenCalled();
    const call = vi.mocked(sendJson).mock.calls.at(-1);
    expect(call?.[1]).toBe(401);
    expect(call?.[2]).toMatchObject({ decision: "stepup" });
  });

  it("falls back from api_only to low_llm when API adapter is unavailable", async () => {
    vi.mocked(handleGatewayPostJsonEndpoint).mockResolvedValueOnce({
      body: {
        message: "What is my current balance?",
        hasRequiredEntities: true,
        intentSlug: "current_balance",
        executionHint: "api-first",
      },
    });

    const handled = await handleTriageHttpRequest(
      makeReq({ "x-openclaw-verified": "true" }),
      makeRes(),
      { auth },
    );

    expect(handled).toBe(true);
    const call = vi.mocked(sendJson).mock.calls.at(-1);
    expect(call?.[1]).toBe(200);
    expect(call?.[2]).toMatchObject({ lane: "low_llm", status: "ok" });
  });

  it("uses identity lookup scoped unit id when request body omits entities", async () => {
    vi.mocked(handleGatewayPostJsonEndpoint).mockResolvedValueOnce({
      body: {
        message: "What is my current balance?",
        intentSlug: "current_balance",
        executionHint: "api-first",
        hasRequiredEntities: false,
        channel: "sms",
        channelIdentity: "+13055556000",
      },
    });

    const executeApiIntent = vi.fn().mockResolvedValue({
      ok: true,
      data: { currentBalance: 42 },
      sourceLatencyMs: 12,
    });

    const identityLookup = vi.fn().mockResolvedValue([
      {
        subjectId: "owner-1",
        role: "owner",
        allowedPropertyIds: ["AZ-1"],
        allowedUnitIds: ["402"],
        allowedWorkOrderIds: [],
        identityConfidence: "high",
      },
    ]);

    const handled = await handleTriageHttpRequest(
      makeReq({ "x-openclaw-verified": "true" }),
      makeRes(),
      {
        auth,
        identityLookup,
        laneDeps: {
          executeApiIntent,
        },
      },
    );

    expect(handled).toBe(true);
    expect(executeApiIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        unitId: "402",
      }),
    );
    const call = vi.mocked(sendJson).mock.calls.at(-1);
    expect(call?.[1]).toBe(200);
    expect(call?.[2]).toMatchObject({ lane: "api_only", status: "ok" });
  });
});