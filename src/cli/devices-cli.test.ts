import { Command } from "commander";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const callGateway = vi.fn();
const buildGatewayConnectionDetails = vi.fn(() => ({
  url: "ws://127.0.0.1:18789",
  urlSource: "local loopback",
  message: "",
}));
const resolveGatewayCredentialsWithSecretInputs = vi.fn();
const listDevicePairing = vi.fn();
const approveDevicePairing = vi.fn();
const summarizeDeviceTokens = vi.fn();
const verifyDeviceToken = vi.fn();
const loadConfig = vi.fn(() => ({ gateway: {} }));
const loadOrCreateDeviceIdentity = vi.fn(() => ({ deviceId: "device-1" }));
const loadCurrentDeviceAuthStore = vi.fn();
const withProgress = vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => await fn());
const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  writeStdout: vi.fn((value: string) => {
    runtime.log(value.endsWith("\n") ? value.slice(0, -1) : value);
  }),
  writeJson: vi.fn((value: unknown, space = 2) => {
    runtime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
  }),
  exit: vi.fn(),
};

vi.mock("../gateway/call.js", () => ({
  callGateway,
  buildGatewayConnectionDetails,
  resolveGatewayCredentialsWithSecretInputs,
}));

vi.mock("./progress.js", () => ({
  withProgress,
}));

vi.mock("../infra/device-pairing.js", () => ({
  listDevicePairing,
  approveDevicePairing,
  summarizeDeviceTokens,
  verifyDeviceToken,
}));

vi.mock("../infra/device-auth-store.js", () => ({
  loadCurrentDeviceAuthStore,
}));

vi.mock("../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../infra/device-identity.js", () => ({
  loadOrCreateDeviceIdentity,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

let registerDevicesCli: typeof import("./devices-cli.js").registerDevicesCli;

beforeAll(async () => {
  ({ registerDevicesCli } = await import("./devices-cli.js"));
});

async function runDevicesApprove(argv: string[]) {
  await runDevicesCommand(["approve", ...argv]);
}

async function runDevicesCommand(argv: string[]) {
  const program = new Command();
  registerDevicesCli(program);
  await program.parseAsync(["devices", ...argv], { from: "user" });
}

describe("devices cli approve", () => {
  it("approves an explicit request id without listing", async () => {
    callGateway.mockResolvedValueOnce({ device: { deviceId: "device-1" } });

    await runDevicesApprove(["req-123"]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "device.pair.approve",
        params: { requestId: "req-123" },
      }),
    );
  });

  it.each([
    {
      name: "id is omitted",
      args: [] as string[],
      pending: [
        { requestId: "req-1", ts: 1000 },
        { requestId: "req-2", ts: 2000 },
      ],
      expectedRequestId: "req-2",
    },
    {
      name: "--latest is passed",
      args: ["req-old", "--latest"] as string[],
      pending: [
        { requestId: "req-2", ts: 2000 },
        { requestId: "req-3", ts: 3000 },
      ],
      expectedRequestId: "req-3",
    },
  ])("uses latest pending request when $name", async ({ args, pending, expectedRequestId }) => {
    callGateway
      .mockResolvedValueOnce({
        pending,
      })
      .mockResolvedValueOnce({ device: { deviceId: "device-2" } });

    await runDevicesApprove(args);

    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: "device.pair.list" }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "device.pair.approve",
        params: { requestId: expectedRequestId },
      }),
    );
  });

  it("prints an error and exits when no pending requests are available", async () => {
    callGateway.mockResolvedValueOnce({ pending: [] });

    await runDevicesApprove([]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "device.pair.list" }),
    );
    expect(runtime.error).toHaveBeenCalledWith("No pending device pairing requests to approve");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "device.pair.approve" }),
    );
  });
});

describe("devices cli remove", () => {
  it("removes a paired device by id", async () => {
    callGateway.mockResolvedValueOnce({ deviceId: "device-1" });

    await runDevicesCommand(["remove", "device-1"]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "device.pair.remove",
        params: { deviceId: "device-1" },
      }),
    );
  });
});

describe("devices cli clear", () => {
  it("requires --yes before clearing", async () => {
    await runDevicesCommand(["clear"]);

    expect(callGateway).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith("Refusing to clear pairing table without --yes");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("clears paired devices and optionally pending requests", async () => {
    callGateway
      .mockResolvedValueOnce({
        paired: [{ deviceId: "device-1" }, { deviceId: "device-2" }],
        pending: [{ requestId: "req-1" }],
      })
      .mockResolvedValueOnce({ deviceId: "device-1" })
      .mockResolvedValueOnce({ deviceId: "device-2" })
      .mockResolvedValueOnce({ requestId: "req-1", deviceId: "device-1" });

    await runDevicesCommand(["clear", "--yes", "--pending"]);

    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: "device.pair.list" }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ method: "device.pair.remove", params: { deviceId: "device-1" } }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ method: "device.pair.remove", params: { deviceId: "device-2" } }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ method: "device.pair.reject", params: { requestId: "req-1" } }),
    );
  });
});

describe("devices cli tokens", () => {
  it.each([
    {
      label: "rotates a token for a device role",
      argv: [
        "rotate",
        "--device",
        "device-1",
        "--role",
        "main",
        "--scope",
        "messages:send",
        "--scope",
        "messages:read",
      ],
      expectedCall: {
        method: "device.token.rotate",
        params: {
          deviceId: "device-1",
          role: "main",
          scopes: ["messages:send", "messages:read"],
        },
      },
    },
    {
      label: "revokes a token for a device role",
      argv: ["revoke", "--device", "device-1", "--role", "main"],
      expectedCall: {
        method: "device.token.revoke",
        params: {
          deviceId: "device-1",
          role: "main",
        },
      },
    },
  ])("$label", async ({ argv, expectedCall }) => {
    callGateway.mockResolvedValueOnce({ ok: true });
    await runDevicesCommand(argv);
    expect(callGateway).toHaveBeenCalledWith(expect.objectContaining(expectedCall));
  });

  it("rejects blank device or role values", async () => {
    await runDevicesCommand(["rotate", "--device", " ", "--role", "main"]);

    expect(callGateway).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith("--device and --role required");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});

describe("devices cli local fallback", () => {
  const fallbackNotice = "Direct scope access failed; using local fallback.";

  it("falls back to local pairing list when gateway returns pairing required on loopback", async () => {
    callGateway.mockRejectedValueOnce(new Error("gateway closed (1008): pairing required"));
    listDevicePairing.mockResolvedValueOnce({
      pending: [{ requestId: "req-1", deviceId: "device-1", publicKey: "pk", ts: 1 }],
      paired: [],
    });
    summarizeDeviceTokens.mockReturnValue(undefined);

    await runDevicesCommand(["list"]);

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "device.pair.list" }),
    );
    expect(listDevicePairing).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining(fallbackNotice));
  });

  it("does not use local pairing list fallback when loopback gateway closes without a reason", async () => {
    callGateway.mockRejectedValueOnce(
      new Error("gateway closed (1000 normal closure): no close reason"),
    );
    await expect(runDevicesCommand(["list"])).rejects.toThrow("normal closure");

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "device.pair.list" }),
    );
    expect(listDevicePairing).not.toHaveBeenCalled();
  });

  it("falls back to local approve when gateway returns pairing required on loopback", async () => {
    callGateway
      .mockRejectedValueOnce(new Error("gateway closed (1008): pairing required"))
      .mockRejectedValueOnce(new Error("gateway closed (1008): pairing required"));
    listDevicePairing.mockResolvedValueOnce({
      pending: [{ requestId: "req-latest", deviceId: "device-1", publicKey: "pk", ts: 2 }],
      paired: [],
    });
    approveDevicePairing.mockResolvedValueOnce({
      requestId: "req-latest",
      device: {
        deviceId: "device-1",
        publicKey: "pk",
        approvedAtMs: 1,
        createdAtMs: 1,
      },
    });
    summarizeDeviceTokens.mockReturnValue(undefined);

    await runDevicesApprove(["--latest"]);

    expect(approveDevicePairing).toHaveBeenCalledWith("req-latest");
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining(fallbackNotice));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Approved"));
  });

  it("falls back to local approve when loopback gateway closes without a reason and a matching operator token exists", async () => {
    callGateway
      .mockRejectedValueOnce(new Error("gateway closed (1000 normal closure): no close reason"))
      .mockRejectedValueOnce(new Error("gateway closed (1000 normal closure): no close reason"));
    listDevicePairing.mockResolvedValueOnce({
      pending: [{ requestId: "req-latest", deviceId: "device-1", publicKey: "pk", ts: 2 }],
      paired: [],
    });
    loadCurrentDeviceAuthStore.mockReturnValue({
      version: 1,
      deviceId: "device-1",
      tokens: {
        operator: {
          token: "secret",
          role: "operator",
          scopes: ["operator.pairing"],
          updatedAtMs: 1,
        },
      },
    });
    verifyDeviceToken.mockResolvedValueOnce({ ok: true });
    approveDevicePairing.mockResolvedValueOnce({
      requestId: "req-latest",
      device: {
        deviceId: "device-1",
        publicKey: "pk",
        approvedAtMs: 1,
        createdAtMs: 1,
      },
    });
    summarizeDeviceTokens.mockReturnValue(undefined);

    await runDevicesApprove(["--latest"]);

    expect(approveDevicePairing).toHaveBeenCalledWith("req-latest", {
      callerScopes: ["operator.pairing"],
    });
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining(fallbackNotice));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Approved"));
  });

  it("falls back to local approve when the in-flight request sees raw gateway closed (1000): no close reason", async () => {
    callGateway
      .mockRejectedValueOnce(new Error("gateway closed (1000): no close reason"))
      .mockRejectedValueOnce(new Error("gateway closed (1000): no close reason"));
    listDevicePairing.mockResolvedValueOnce({
      pending: [{ requestId: "req-latest", deviceId: "device-1", publicKey: "pk", ts: 2 }],
      paired: [],
    });
    loadCurrentDeviceAuthStore.mockReturnValue({
      version: 1,
      deviceId: "device-1",
      tokens: {
        operator: {
          token: "secret",
          role: "operator",
          scopes: ["operator.pairing"],
          updatedAtMs: 1,
        },
      },
    });
    verifyDeviceToken.mockResolvedValueOnce({ ok: true });
    approveDevicePairing.mockResolvedValueOnce({
      requestId: "req-latest",
      device: {
        deviceId: "device-1",
        publicKey: "pk",
        approvedAtMs: 1,
        createdAtMs: 1,
      },
    });
    summarizeDeviceTokens.mockReturnValue(undefined);

    await runDevicesApprove(["--latest"]);

    expect(approveDevicePairing).toHaveBeenCalledWith("req-latest", {
      callerScopes: ["operator.pairing"],
    });
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining(fallbackNotice));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Approved"));
  });

  it("uses local approve fallback with caller scopes for a matching local operator token", async () => {
    callGateway
      .mockRejectedValueOnce(new Error("gateway closed (1000 normal closure): no close reason"))
      .mockRejectedValueOnce(new Error("gateway closed (1000 normal closure): no close reason"));
    listDevicePairing.mockResolvedValueOnce({
      pending: [{ requestId: "req-latest", deviceId: "device-1", publicKey: "pk", ts: 2 }],
      paired: [],
    });
    loadCurrentDeviceAuthStore.mockReturnValue({
      version: 1,
      deviceId: "device-1",
      tokens: {
        operator: {
          token: "secret",
          role: "operator",
          scopes: ["operator.pairing"],
          updatedAtMs: 1,
        },
      },
    });
    verifyDeviceToken.mockResolvedValueOnce({ ok: true });
    approveDevicePairing.mockResolvedValueOnce({
      status: "approved",
      requestId: "req-latest",
      device: {
        deviceId: "device-1",
        publicKey: "pk",
        approvedAtMs: 1,
        createdAtMs: 1,
      },
    });

    await runDevicesApprove(["--latest"]);

    expect(approveDevicePairing).toHaveBeenCalledWith("req-latest", {
      callerScopes: ["operator.pairing"],
    });
  });

  it("does not use local approve fallback for normal closures when the operator token lacks pairing scope", async () => {
    callGateway.mockRejectedValueOnce(
      new Error("gateway closed (1000 normal closure): no close reason"),
    );
    loadCurrentDeviceAuthStore.mockReturnValue({
      version: 1,
      deviceId: "device-1",
      tokens: {
        operator: {
          token: "secret",
          role: "operator",
          scopes: ["operator.read"],
          updatedAtMs: 1,
        },
      },
    });

    await expect(runDevicesApprove(["--latest"])).rejects.toThrow("normal closure");

    expect(verifyDeviceToken).not.toHaveBeenCalled();
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("does not use local approve fallback for normal closures when explicit shared auth exists", async () => {
    callGateway.mockRejectedValueOnce(
      new Error("gateway closed (1000 normal closure): no close reason"),
    );

    await expect(runDevicesApprove(["--latest", "--token", "shared-secret"])).rejects.toThrow(
      "normal closure",
    );

    expect(listDevicePairing).not.toHaveBeenCalled();
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("does not use local approve fallback for normal closures when config shared auth resolves", async () => {
    callGateway.mockRejectedValueOnce(
      new Error("gateway closed (1000 normal closure): no close reason"),
    );
    resolveGatewayCredentialsWithSecretInputs.mockResolvedValueOnce({ password: "shared-secret" });

    await expect(runDevicesApprove(["--latest"])).rejects.toThrow("normal closure");

    expect(listDevicePairing).not.toHaveBeenCalled();
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("does not use local approve fallback for normal closures when config shared token resolves", async () => {
    callGateway.mockRejectedValueOnce(
      new Error("gateway closed (1000 normal closure): no close reason"),
    );
    resolveGatewayCredentialsWithSecretInputs.mockResolvedValueOnce({ token: "shared-secret" });
    loadCurrentDeviceAuthStore.mockReturnValue({
      version: 1,
      deviceId: "device-1",
      tokens: {
        operator: {
          token: "secret",
          role: "operator",
          scopes: ["operator.pairing"],
          updatedAtMs: 1,
        },
      },
    });

    await expect(runDevicesApprove(["--latest"])).rejects.toThrow("normal closure");

    expect(listDevicePairing).not.toHaveBeenCalled();
    expect(verifyDeviceToken).not.toHaveBeenCalled();
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("does not use local approve fallback when only a non-operator token exists", async () => {
    callGateway.mockRejectedValueOnce(
      new Error("gateway closed (1000 normal closure): no close reason"),
    );
    loadCurrentDeviceAuthStore.mockReturnValueOnce({
      version: 1,
      deviceId: "device-1",
      tokens: {
        node: {
          token: "secret",
          role: "node",
          scopes: ["operator.read"],
          updatedAtMs: 1,
        },
      },
    });

    await expect(runDevicesApprove(["--latest"])).rejects.toThrow("normal closure");

    expect(listDevicePairing).not.toHaveBeenCalled();
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("does not use local approve fallback when the stored operator token belongs to another device", async () => {
    callGateway.mockRejectedValueOnce(
      new Error("gateway closed (1000 normal closure): no close reason"),
    );
    loadCurrentDeviceAuthStore.mockReturnValue({
      version: 1,
      deviceId: "stale-device",
      tokens: {
        operator: {
          token: "secret",
          role: "operator",
          scopes: ["operator.read"],
          updatedAtMs: 1,
        },
      },
    });

    await expect(runDevicesApprove(["--latest"])).rejects.toThrow("normal closure");

    expect(listDevicePairing).not.toHaveBeenCalled();
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("does not use local approve fallback when the matching operator token no longer verifies", async () => {
    callGateway.mockRejectedValueOnce(
      new Error("gateway closed (1000 normal closure): no close reason"),
    );
    loadCurrentDeviceAuthStore.mockReturnValue({
      version: 1,
      deviceId: "device-1",
      tokens: {
        operator: {
          token: "secret",
          role: "operator",
          scopes: ["operator.pairing"],
          updatedAtMs: 1,
        },
      },
    });
    verifyDeviceToken.mockResolvedValueOnce({ ok: false, reason: "token-revoked" });

    await expect(runDevicesApprove(["--latest"])).rejects.toThrow("normal closure");

    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("surfaces missing scopes when local approve fallback rejects the request", async () => {
    callGateway
      .mockRejectedValueOnce(new Error("gateway closed (1000 normal closure): no close reason"))
      .mockRejectedValueOnce(new Error("gateway closed (1000 normal closure): no close reason"));
    listDevicePairing.mockResolvedValueOnce({
      pending: [
        {
          requestId: "req-latest",
          deviceId: "device-1",
          publicKey: "pk",
          scopes: ["operator.admin"],
          ts: 2,
        },
      ],
      paired: [],
    });
    loadCurrentDeviceAuthStore.mockReturnValue({
      version: 1,
      deviceId: "device-1",
      tokens: {
        operator: {
          token: "secret",
          role: "operator",
          scopes: ["operator.pairing"],
          updatedAtMs: 1,
        },
      },
    });
    verifyDeviceToken.mockResolvedValueOnce({ ok: true });
    approveDevicePairing.mockResolvedValueOnce({
      status: "forbidden",
      missingScope: "operator.admin",
    });

    await expect(runDevicesApprove(["--latest"])).rejects.toThrow("missing scope: operator.admin");

    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Approved"));
  });

  it("preserves the original normal-closure error when the local retry sees no pending request", async () => {
    callGateway
      .mockRejectedValueOnce(new Error("gateway closed (1000 normal closure): no close reason"))
      .mockRejectedValueOnce(new Error("gateway closed (1000 normal closure): no close reason"));
    listDevicePairing.mockResolvedValueOnce({
      pending: [{ requestId: "req-latest", deviceId: "device-1", publicKey: "pk", ts: 2 }],
      paired: [],
    });
    loadCurrentDeviceAuthStore.mockReturnValue({
      version: 1,
      deviceId: "device-1",
      tokens: {
        operator: {
          token: "secret",
          role: "operator",
          scopes: ["operator.pairing"],
          updatedAtMs: 1,
        },
      },
    });
    verifyDeviceToken.mockResolvedValueOnce({ ok: true });
    approveDevicePairing.mockResolvedValueOnce(null);

    await expect(runDevicesApprove(["--latest"])).rejects.toThrow("normal closure");

    expect(runtime.error).not.toHaveBeenCalledWith("unknown requestId");
  });

  it("preserves unknown requestId for explicit approve retries after normal closure", async () => {
    callGateway
      .mockRejectedValueOnce(new Error("gateway closed (1000 normal closure): no close reason"))
      .mockRejectedValueOnce(new Error("gateway closed (1000 normal closure): no close reason"));
    loadCurrentDeviceAuthStore.mockReturnValue({
      version: 1,
      deviceId: "device-1",
      tokens: {
        operator: {
          token: "secret",
          role: "operator",
          scopes: ["operator.pairing"],
          updatedAtMs: 1,
        },
      },
    });
    verifyDeviceToken.mockResolvedValueOnce({ ok: true });
    approveDevicePairing.mockResolvedValueOnce(null);

    await runDevicesApprove(["req-missing"]);

    expect(approveDevicePairing).toHaveBeenCalledWith("req-missing", {
      callerScopes: ["operator.pairing"],
    });
    expect(runtime.error).toHaveBeenCalledWith("unknown requestId");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("does not use local clear fallback when list returns pairing required", async () => {
    callGateway.mockRejectedValueOnce(new Error("gateway closed (1008): pairing required"));

    await expect(runDevicesCommand(["clear", "--yes", "--pending"])).rejects.toThrow(
      "pairing required",
    );

    expect(listDevicePairing).not.toHaveBeenCalled();
  });

  it("does not use local fallback when an explicit --url is provided", async () => {
    callGateway.mockRejectedValueOnce(new Error("gateway closed (1008): pairing required"));

    await expect(
      runDevicesCommand(["list", "--json", "--url", "ws://127.0.0.1:18789"]),
    ).rejects.toThrow("pairing required");
    expect(listDevicePairing).not.toHaveBeenCalled();
  });
});

describe("devices cli list", () => {
  it("renders pending scopes when present", async () => {
    callGateway.mockResolvedValueOnce({
      pending: [
        {
          requestId: "req-1",
          deviceId: "device-1",
          displayName: "Device One",
          role: "operator",
          scopes: ["operator.admin", "operator.read"],
          ts: 1,
        },
      ],
      paired: [],
    });

    await runDevicesCommand(["list"]);

    const output = runtime.log.mock.calls.map((entry) => String(entry[0] ?? "")).join("\n");
    expect(output).toContain("Scopes");
    expect(output).toContain("operator.admin, operator.read");
  });
});

afterEach(() => {
  callGateway.mockReset();
  buildGatewayConnectionDetails.mockReset();
  buildGatewayConnectionDetails.mockReturnValue({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
    message: "",
  });
  listDevicePairing.mockReset();
  listDevicePairing.mockResolvedValue({ pending: [], paired: [] });
  approveDevicePairing.mockReset();
  approveDevicePairing.mockResolvedValue(undefined);
  summarizeDeviceTokens.mockReset();
  summarizeDeviceTokens.mockReturnValue(undefined);
  verifyDeviceToken.mockReset();
  verifyDeviceToken.mockResolvedValue({ ok: true });
  resolveGatewayCredentialsWithSecretInputs.mockReset();
  resolveGatewayCredentialsWithSecretInputs.mockResolvedValue({});
  loadConfig.mockReset();
  loadConfig.mockReturnValue({ gateway: {} });
  loadOrCreateDeviceIdentity.mockReset();
  loadOrCreateDeviceIdentity.mockReturnValue({ deviceId: "device-1" });
  loadCurrentDeviceAuthStore.mockReset();
  loadCurrentDeviceAuthStore.mockReturnValue(null);
  withProgress.mockReset();
  withProgress.mockImplementation(async (_opts: unknown, fn: () => Promise<unknown>) => await fn());
  runtime.log.mockClear();
  runtime.error.mockClear();
  runtime.exit.mockClear();
});
