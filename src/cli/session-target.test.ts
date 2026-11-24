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

  it("shapes identity-proxy and malformed-URL connection errors", async () => {
    callGatewayMock.mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "gateway rejected websocket upgrade (HTTP 302)",
        details: { reason: "websocket-upgrade-rejected", httpStatus: 302 },
      }),
    );
    const error = await resolveSessionTarget({ raw: "gw.example/main/a1166b81" }).catch(String);
    expect(error).toContain("gateway.remote.edgeAuth");
    expect(error).not.toContain("tailnet");
    expect(error).not.toContain("SSH tunnel");

    callGatewayMock.mockRejectedValueOnce(new Error("SECURITY ERROR: plaintext ws://"));
    await expect(
      resolveSessionTarget({ raw: "agent:ops:main", gateway: { url: "ws://[bad" } }),
    ).rejects.toThrow("SECURITY ERROR: plaintext ws://");
  });
});
