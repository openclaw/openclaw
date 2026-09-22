import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import { GatewayLocalBackendSharedAuthUnavailableError } from "../../gateway/call.js";
import { GatewayTransportError } from "../../gateway/transport-error.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  isImplicitLocalGatewayTarget: vi.fn(),
}));

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

describe("refreshRunningGatewayAuthState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callGateway.mockReset();
    mocks.isImplicitLocalGatewayTarget.mockResolvedValue(true);
  });

  it.each(["login", "logout", "update"] as const)(
    "acknowledges a published %s",
    async (operation) => {
      mocks.callGateway.mockResolvedValueOnce({ refreshed: true });
      const warn = vi.fn();
      await expect(
        refreshRunningGatewayAuthState("main", operation, { error: warn }),
      ).resolves.toBe("refreshed");
      expect(mocks.callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "models.authRefresh",
          params: { operation, agentId: "main" },
          requireLocalBackendSharedAuth: true,
        }),
      );
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "legacy status refresh succeeds",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "unknown method: models.authRefresh",
      }),
      fallback: "success",
    },
    {
      name: "legacy status refresh fails",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "unknown method: models.authRefresh",
      }),
      fallback: "failure",
    },
    {
      name: "the Gateway reports a different error code",
      error: new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "unknown method: models.authRefresh",
      }),
      fallback: "none",
    },
    {
      name: "the Gateway rejects admin scope",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "missing scope: operator.admin",
      }),
      fallback: "none",
    },
    {
      name: "another method is unknown",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "unknown method: models.authStatus",
      }),
      fallback: "none",
    },
    {
      name: "a local error has the same message",
      error: new Error("unknown method: models.authRefresh"),
      fallback: "none",
    },
  ])("keeps restart guidance when $name", async ({ error, fallback }) => {
    mocks.callGateway.mockImplementation(
      async (options: { method: string; onHelloOk?: () => void }) => {
        options.onHelloOk?.();
        if (options.method === "models.authRefresh") {
          throw error;
        }
        if (fallback === "failure") {
          throw new Error("legacy refresh failed");
        }
        return { providers: [] };
      },
    );
    const warn = vi.fn();

    await expect(refreshRunningGatewayAuthState("main", "login", { error: warn })).resolves.toBe(
      "gateway-rejected",
    );

    expect(mocks.callGateway).toHaveBeenCalledTimes(fallback === "none" ? 1 : 2);
    if (fallback !== "none") {
      expect(mocks.callGateway).toHaveBeenLastCalledWith(
        expect.objectContaining({
          method: "models.authStatus",
          params: { refresh: true, agentId: "main" },
          timeoutMs: 3000,
          requireLocalBackendSharedAuth: true,
        }),
      );
    }
    expect(warn).toHaveBeenCalledWith(
      "Warning: Model auth changes were saved, but the running Gateway could not refresh them. Run `openclaw gateway restart` to apply the saved changes.",
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
    const warn = vi.fn();

    await expect(refreshRunningGatewayAuthState("main", "login", { error: warn })).resolves.toBe(
      "gateway-unreachable",
    );

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ requireLocalBackendSharedAuth: true }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when a running gateway rejects the auth refresh", async () => {
    mocks.callGateway.mockImplementationOnce(async (options: { onHelloOk?: () => void }) => {
      options.onHelloOk?.();
      throw new Error("refresh rejected");
    });
    const warn = vi.fn();

    await expect(refreshRunningGatewayAuthState("main", "login", { error: warn })).resolves.toBe(
      "gateway-rejected",
    );

    expect(warn).toHaveBeenCalledWith(
      "Warning: Model auth changes were saved, but the running Gateway could not refresh them. Run `openclaw gateway restart` to apply the saved changes.",
    );
  });

  it("warns when the gateway cannot publish refreshed auth state", async () => {
    mocks.callGateway.mockImplementationOnce(async (options: { onHelloOk?: () => void }) => {
      options.onHelloOk?.();
      return { refreshed: false };
    });
    const warn = vi.fn();

    await expect(refreshRunningGatewayAuthState("main", "login", { error: warn })).resolves.toBe(
      "gateway-rejected",
    );

    expect(warn).toHaveBeenCalledWith(
      "Warning: Model auth changes were saved, but the running Gateway could not refresh them. Run `openclaw gateway restart` to apply the saved changes.",
    );
  });

  it("directs remote clients to run auth changes on the gateway host", async () => {
    mocks.isImplicitLocalGatewayTarget.mockResolvedValueOnce(false);
    mocks.callGateway.mockRejectedValueOnce(
      new GatewayLocalBackendSharedAuthUnavailableError(
        "local backend shared auth is limited to the configured local gateway",
      ),
    );
    const warn = vi.fn();

    await expect(refreshRunningGatewayAuthState("main", "login", { error: warn })).resolves.toBe(
      "gateway-rejected",
    );

    expect(warn).toHaveBeenCalledWith(
      "Warning: Model auth changes were saved on this host, but the configured Gateway does not share this auth state. Run the auth command on the Gateway host (the far end of any SSH tunnel).",
    );
  });

  it("does not guess a restart host when target classification fails", async () => {
    mocks.isImplicitLocalGatewayTarget.mockRejectedValueOnce(new Error("invalid config"));
    const warn = vi.fn();

    await expect(refreshRunningGatewayAuthState("main", "login", { error: warn })).resolves.toBe(
      "gateway-unreachable",
    );

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "Warning: Model auth changes were saved, but the configured Gateway could not be identified or refreshed. Apply the auth change on the Gateway host, or restart it there.",
    );
  });
});
