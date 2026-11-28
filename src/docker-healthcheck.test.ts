import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readActiveGatewayLockPort } from "./infra/gateway-lock.js";

vi.mock("./infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./infra/gateway-lock.js")>()),
  readActiveGatewayLockPort: vi.fn(),
}));

describe("Docker healthcheck", () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const loadConfigAsync = vi.fn(async () => ({ gateway: { port: 19002 } }));
  const createConfigIO = vi.fn(() => ({ loadConfigAsync }));
  const configModuleLoaded = vi.fn();
  let probeDockerGatewayHealth: typeof import("./docker-healthcheck.js").probeDockerGatewayHealth;

  beforeEach(async () => {
    // Docker launches a fresh probe each time. Observe module loading from a cold entry.
    vi.resetModules();
    vi.doMock("./config/config.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./config/config.js")>();
      configModuleLoaded();
      return { ...actual, createConfigIO };
    });
    ({ probeDockerGatewayHealth } = await import("./docker-healthcheck.js"));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", undefined);
    vi.mocked(readActiveGatewayLockPort).mockResolvedValue(undefined);
    fetch.mockResolvedValue(new Response());
  });

  afterEach(() => {
    vi.doUnmock("./config/config.js");
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("probes the active Gateway lock port used by --port", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "19001");
    vi.mocked(readActiveGatewayLockPort).mockResolvedValue(19000);

    await expect(probeDockerGatewayHealth()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:19000/healthz");
    expect(configModuleLoaded).not.toHaveBeenCalled();
  });

  it.each([
    { name: "environment", port: "19001", expected: 19001 },
    { name: "config", port: undefined, expected: 19002 },
  ])("probes the canonical $name port when no active lock exists", async ({ port, expected }) => {
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", port);

    await expect(probeDockerGatewayHealth()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith(`http://127.0.0.1:${expected}/healthz`);
    if (port === undefined) {
      expect(configModuleLoaded).toHaveBeenCalledOnce();
      expect(createConfigIO).toHaveBeenCalledWith({
        pluginValidation: "skip",
        shellEnvFallback: "defer",
      });
    } else {
      expect(configModuleLoaded).not.toHaveBeenCalled();
    }
  });

  it("still probes the env port when config resolution throws", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "19001");
    await loadConfigAsync.withImplementation(
      async () => {
        throw new Error("invalid config");
      },
      async () => {
        await expect(probeDockerGatewayHealth()).resolves.toBe(true);
        expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:19001/healthz");
      },
    );
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
