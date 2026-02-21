import { beforeEach, describe, expect, it, vi } from "vitest";
import { callGatewayTool, resolveGatewayOptions } from "./gateway.js";

const callGatewayMock = vi.fn();
const loadConfigMock = vi.fn().mockReturnValue({});
vi.mock("../../config/config.js", () => ({
  loadConfig: (...args: unknown[]) => loadConfigMock(...args),
  resolveGatewayPort: () => 18789,
}));
vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

describe("gateway tool defaults", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    loadConfigMock.mockReturnValue({});
  });

  it("resolves to loopback URL for local mode (avoids CWE-319 block on LAN IPs)", () => {
    const opts = resolveGatewayOptions();
    expect(opts.url).toBe("ws://127.0.0.1:18789");
  });

  it("accepts allowlisted gatewayUrl overrides (SSRF hardening)", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    await callGatewayTool(
      "health",
      { gatewayUrl: "ws://127.0.0.1:18789", gatewayToken: "t", timeoutMs: 5000 },
      {},
    );
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        token: "t",
        timeoutMs: 5000,
        scopes: ["operator.read"],
      }),
    );
  });

  it("uses least-privilege write scope for write methods", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    await callGatewayTool("wake", {}, { mode: "now", text: "hi" });
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "wake",
        scopes: ["operator.write"],
      }),
    );
  });

  it("uses admin scope only for admin methods", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    await callGatewayTool("cron.add", {}, { id: "job-1" });
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.add",
        scopes: ["operator.admin"],
      }),
    );
  });

  it("default-denies unknown methods by sending no scopes", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    await callGatewayTool("nonexistent.method", {}, {});
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "nonexistent.method",
        scopes: [],
      }),
    );
  });

  it("leaves url undefined in remote mode so callGateway resolves remote URL", () => {
    loadConfigMock.mockReturnValueOnce({ gateway: { mode: "remote" } });
    const opts = resolveGatewayOptions();
    expect(opts.url).toBeUndefined();
  });

  it("rejects non-allowlisted overrides (SSRF hardening)", async () => {
    await expect(
      callGatewayTool("health", { gatewayUrl: "ws://127.0.0.1:8080", gatewayToken: "t" }, {}),
    ).rejects.toThrow(/gatewayUrl override rejected/i);
    await expect(
      callGatewayTool("health", { gatewayUrl: "ws://169.254.169.254", gatewayToken: "t" }, {}),
    ).rejects.toThrow(/gatewayUrl override rejected/i);
  });
});
