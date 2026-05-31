import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn(async () => ({ ok: true }));
vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: () => ({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
  }),
  callGateway: callGatewayMock,
  resolveGatewayCliScopes: (method: string) =>
    method === "health"
      ? ["operator.read"]
      : [
          "operator.admin",
          "operator.read",
          "operator.write",
          "operator.approvals",
          "operator.pairing",
          "operator.talk.secrets",
        ],
}));

vi.mock("./progress.js", () => ({
  withProgress: async (_options: unknown, action: () => Promise<unknown>) => await action(),
}));

const { callGatewayFromCliRuntime } = await import("./gateway-rpc.runtime.js");

async function withSharedGatewayToken<T>(token: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_TOKEN = token;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = previous;
    }
  }
}

describe("callGatewayFromCliRuntime", () => {
  beforeEach(() => {
    callGatewayMock.mockClear().mockResolvedValue({ ok: true });
  });

  it.each([
    ["cron status", "cron.status"],
    ["cron list", "cron.list"],
    ["cron add", "cron.add"],
    ["cron update", "cron.update"],
    ["cron remove", "cron.remove"],
    ["cron get", "cron.get"],
    ["cron runs", "cron.runs"],
    ["cron run", "cron.run"],
    ["logs", "logs.tail"],
    ["secrets reload", "secrets.reload"],
  ])("rejects malformed shared --timeout before gateway call for %s", async (_name, method) => {
    await expect(callGatewayFromCliRuntime(method, { timeout: "10ms" })).rejects.toThrow(
      'Invalid --timeout. Use a positive millisecond value, e.g. --timeout 30000. Received: "10ms".',
    );

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "1.5"])("rejects invalid shared --timeout value %j", async (timeout) => {
    await expect(callGatewayFromCliRuntime("cron.status", { timeout })).rejects.toThrow(
      `Received: "${timeout}"`,
    );

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("passes strict integer timeouts to the gateway call", async () => {
    await callGatewayFromCliRuntime("cron.status", { timeout: "15000" });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.status",
        timeoutMs: 15_000,
      }),
    );
  });

  it("uses backend auth for explicit loopback token calls", async () => {
    await withSharedGatewayToken("shared-token", async () => {
      await callGatewayFromCliRuntime("health", {
        url: "ws://127.0.0.1:18789",
        token: "shared-token",
      });
    });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "health",
        clientName: "gateway-client",
        mode: "backend",
        scopes: ["operator.read"],
        deviceIdentity: null,
      }),
    );
  });

  it("uses CLI fallback scopes for unclassified explicit loopback token calls", async () => {
    await withSharedGatewayToken("shared-token", async () => {
      await callGatewayFromCliRuntime("plugin.custom.unclassified", {
        url: "ws://127.0.0.1:18789",
        token: "shared-token",
      });
    });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "plugin.custom.unclassified",
        clientName: "gateway-client",
        mode: "backend",
        scopes: [
          "operator.admin",
          "operator.read",
          "operator.write",
          "operator.approvals",
          "operator.pairing",
          "operator.talk.secrets",
        ],
        deviceIdentity: null,
      }),
    );
  });

  it("keeps device identity available for unproven loopback token calls", async () => {
    await callGatewayFromCliRuntime("health", {
      url: "ws://127.0.0.1:18789",
      token: "operator-device-token",
    });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "health",
        clientName: "cli",
        mode: "cli",
        scopes: undefined,
        deviceIdentity: undefined,
      }),
    );
  });

  it("preserves explicit extra client identity overrides", async () => {
    await callGatewayFromCliRuntime(
      "health",
      {
        url: "ws://127.0.0.1:18789",
        token: "shared-token",
      },
      undefined,
      { clientName: "cli", mode: "cli", deviceIdentity: undefined },
    );

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "health",
        clientName: "cli",
        mode: "cli",
        deviceIdentity: undefined,
      }),
    );
  });
});
