import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const { readJsonBodyWithLimitMock } = vi.hoisted(() => ({
  readJsonBodyWithLimitMock: vi.fn(),
}));

vi.mock("../../infra/http-body.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/http-body.js")>();
  return {
    ...actual,
    readJsonBodyWithLimit: readJsonBodyWithLimitMock,
  };
});

const { __testing } = await import("./provider.js");

function createRequest(headers: Record<string, string | undefined> = {}): IncomingMessage {
  return {
    method: "POST",
    url: "/slack/events",
    headers,
  } as IncomingMessage;
}

function createResponse() {
  const setHeader = vi.fn();
  const end = vi.fn();
  const res = {
    statusCode: 200,
    setHeader,
    end,
  } as unknown as ServerResponse;
  return { res, setHeader, end };
}

describe("Slack unsigned url_verification handling", () => {
  afterEach(() => {
    readJsonBodyWithLimitMock.mockReset();
  });

  it("responds to unsigned Slack url_verification challenges before Bolt signature checks", async () => {
    readJsonBodyWithLimitMock.mockResolvedValue({
      ok: true,
      value: {
        type: "url_verification",
        challenge: "abc123",
      },
    });
    const req = createRequest();
    const { res, setHeader, end } = createResponse();

    const handled = await __testing.maybeHandleUnsignedSlackUrlVerification(req, res);

    expect(handled).toBe(true);
    expect(readJsonBodyWithLimitMock).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        maxBytes: 1024 * 1024,
        timeoutMs: 30_000,
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(setHeader).toHaveBeenCalledWith("content-type", "application/json; charset=utf-8");
    expect(end).toHaveBeenCalledWith(JSON.stringify({ challenge: "abc123" }));
  });

  it("leaves signed Slack requests for Bolt to verify and handle", async () => {
    const req = createRequest({
      "x-slack-signature": "v0=test",
    });
    const { res, end } = createResponse();

    const handled = await __testing.maybeHandleUnsignedSlackUrlVerification(req, res);

    expect(handled).toBe(false);
    expect(readJsonBodyWithLimitMock).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });

  it("rejects other unsigned Slack webhook payloads", async () => {
    readJsonBodyWithLimitMock.mockResolvedValue({
      ok: true,
      value: {
        type: "event_callback",
      },
    });
    const req = createRequest();
    const { res, setHeader, end } = createResponse();

    const handled = await __testing.maybeHandleUnsignedSlackUrlVerification(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(setHeader).toHaveBeenCalledWith("content-type", "text/plain; charset=utf-8");
    expect(end).toHaveBeenCalledWith("invalid slack signature");
  });
});
