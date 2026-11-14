import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../gateway/client.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return { ...actual, callGateway: callGatewayMock };
});

const { resolveSessionTarget } = await import("./session-target.js");

describe("session target connection errors", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("surfaces identity-proxy remediation without tailnet or SSH tunnel advice", async () => {
    callGatewayMock.mockRejectedValue(
      new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "gateway rejected websocket upgrade (HTTP 302)",
        details: { reason: "websocket-upgrade-rejected", httpStatus: 302 },
      }),
    );

    let error: unknown;
    try {
      await resolveSessionTarget({ raw: "gateway.example/main/a1166b81" });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("gateway.remote.edgeAuth");
    expect(String(error)).not.toContain("tailnet");
    expect(String(error)).not.toContain("SSH tunnel");
  });

  it("shapes a malformed explicit gateway URL without crashing or masking the security error", async () => {
    callGatewayMock.mockRejectedValue(
      new Error(
        'SECURITY ERROR: Gateway URL "not a valid url" uses plaintext ws:// to a non-loopback address.',
      ),
    );

    let error: unknown;
    try {
      await resolveSessionTarget({ raw: "agent:ops:main", gateway: { url: "not a valid url" } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(String(error)).toContain("SECURITY ERROR");
  });
});
