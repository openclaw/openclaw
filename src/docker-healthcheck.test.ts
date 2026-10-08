import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "./config/config.js";
import { probeDockerGatewayHealth } from "./docker-healthcheck.js";
import { readActiveGatewayLockPort } from "./infra/gateway-lock.js";

vi.mock("./config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config/config.js")>()),
  getRuntimeConfig: vi.fn(),
}));

vi.mock("./infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./infra/gateway-lock.js")>()),
  readActiveGatewayLockPort: vi.fn(),
}));

describe("Docker healthcheck", () => {
  const fetch = vi.fn<typeof globalThis.fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", undefined);
    vi.mocked(readActiveGatewayLockPort).mockResolvedValue(undefined);
    vi.mocked(getRuntimeConfig).mockReturnValue({ gateway: { port: 19002 } });
    fetch.mockResolvedValue(new Response());
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("probes the active Gateway lock port used by --port", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "19001");
    vi.mocked(readActiveGatewayLockPort).mockResolvedValue(19000);

    await expect(probeDockerGatewayHealth()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:19000/healthz");
    expect(getRuntimeConfig).not.toHaveBeenCalled();
  });

  it.each([
    { name: "environment", port: "19001", expected: 19001 },
    { name: "config", port: undefined, expected: 19002 },
  ])("probes the canonical $name port when no active lock exists", async ({ port, expected }) => {
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", port);

    await expect(probeDockerGatewayHealth()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith(`http://127.0.0.1:${expected}/healthz`);
    expect(getRuntimeConfig).toHaveBeenCalledWith({
      pin: false,
      skipPluginValidation: true,
      skipShellEnvFallback: true,
    });
  });

  it("probes the configured port when the active lock cannot be read", async () => {
    vi.mocked(readActiveGatewayLockPort).mockRejectedValue(new Error("lock unavailable"));

    await expect(probeDockerGatewayHealth()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:19002/healthz");
  });

  it("reports an unsuccessful or unreachable liveness endpoint as unhealthy", async () => {
    vi.mocked(readActiveGatewayLockPort).mockResolvedValue(19000);
    fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(probeDockerGatewayHealth()).resolves.toBe(false);

    fetch.mockRejectedValueOnce(new Error("connection refused"));
    await expect(probeDockerGatewayHealth()).resolves.toBe(false);
  });
});
