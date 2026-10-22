import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import { GatewayLocalBackendSharedAuthUnavailableError } from "../../gateway/call.js";
import { GatewayTransportError } from "../../gateway/transport-error.js";

const mocks = vi.hoisted(() => ({ callGateway: vi.fn(), isImplicitLocalGatewayTarget: vi.fn() }));

vi.mock("../../gateway/call.js", async () => {
  const requestErrors = await import("../../../packages/gateway-client/src/request-error.js");
  return {
    callGateway: mocks.callGateway,
    GatewayLocalBackendSharedAuthUnavailableError: class extends Error {},
    isGatewayClientRequestError: (error: unknown) =>
      error instanceof requestErrors.GatewayClientRequestError,
    isImplicitLocalGatewayTarget: mocks.isImplicitLocalGatewayTarget,
  };
});

const { refreshRunningGatewayAuthState } = await import("./auth-refresh.js");
const warn = vi.fn();
async function expectRefresh(
  outcome: Awaited<ReturnType<typeof refreshRunningGatewayAuthState>>,
  warning?: string,
  operation: "login" | "update" = "login",
) {
  const result = await refreshRunningGatewayAuthState("main", operation, { error: warn });
  expect({ result, warnings: warn.mock.calls }).toEqual({
    result: outcome,
    warnings: warning ? [[warning]] : [],
  });
}

describe("refreshRunningGatewayAuthState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callGateway.mockReset();
    mocks.isImplicitLocalGatewayTarget.mockResolvedValue(true);
  });

  it("acknowledges a published update", async () => {
    mocks.callGateway.mockResolvedValueOnce({ refreshed: true });
    await expectRefresh("refreshed", undefined, "update");
    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "models.authRefresh",
        params: { operation: "update", agentId: "main" },
        requireLocalBackendSharedAuth: true,
      }),
    );
  });

  it("keeps restart guidance when legacy status refresh fails", async () => {
    const error = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "unknown method: models.authRefresh",
    });
    mocks.callGateway.mockImplementation(
      async (options: { method: string; onHelloOk?: () => void }) => {
        options.onHelloOk?.();
        if (options.method === "models.authRefresh") {
          throw error;
        }
        throw new Error("legacy refresh failed");
      },
    );
    await expectRefresh(
      "gateway-rejected",
      "Warning: Model auth changes were saved, but the running Gateway could not refresh them. Run `openclaw gateway restart` to apply the saved changes.",
    );

    expect(mocks.callGateway).toHaveBeenCalledTimes(2);
    expect(mocks.callGateway).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "models.authStatus",
        params: { refresh: true, agentId: "main" },
        timeoutMs: 3000,
        requireLocalBackendSharedAuth: true,
      }),
    );
  });

  it("stays silent when no gateway is listening", async () => {
    mocks.callGateway.mockRejectedValueOnce(
      new GatewayTransportError({
        kind: "closed",
        message: "gateway unreachable",
        reason: "connect ECONNREFUSED 127.0.0.1:18789",
        connectionDetails: {
          url: "ws://127.0.0.1:18789",
          urlSource: "local loopback",
          message: "Local target",
        },
      }),
    );
    await expectRefresh("gateway-unreachable");

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ requireLocalBackendSharedAuth: true }),
    );
  });

  it("directs remote clients to run auth changes on the gateway host", async () => {
    mocks.isImplicitLocalGatewayTarget.mockResolvedValueOnce(false);
    mocks.callGateway.mockRejectedValueOnce(
      new GatewayLocalBackendSharedAuthUnavailableError(
        "local backend shared auth is limited to the configured local gateway",
      ),
    );
    await expectRefresh(
      "gateway-rejected",
      "Warning: Model auth changes were saved on this host, but the configured Gateway does not share this auth state. Run the auth command on the Gateway host (the far end of any SSH tunnel).",
    );
  });

  it("does not guess a restart host when target classification fails", async () => {
    mocks.isImplicitLocalGatewayTarget.mockRejectedValueOnce(new Error("invalid config"));
    await expectRefresh(
      "gateway-unreachable",
      "Warning: Model auth changes were saved, but the configured Gateway could not be identified or refreshed. Apply the auth change on the Gateway host, or restart it there.",
    );
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });
});
