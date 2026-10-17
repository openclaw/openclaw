import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigIO } from "./config/config.js";
import { probeDockerGatewayHealth } from "./docker-healthcheck.js";
import { readActiveGatewayLockPort } from "./infra/gateway-lock.js";

vi.mock("./config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config/config.js")>();
  return {
    ...actual,
    createConfigIO: vi.fn((...args: Parameters<typeof actual.createConfigIO>) => ({
      ...actual.createConfigIO(...args),
      loadConfigAsync: async () => ({ gateway: { port: 19002 } }),
    })),
  };
});

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
    expect(createConfigIO).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "environment",
      port: "19001",
      expected: 19001,
      configLoaded: false,
    },
    { name: "config", port: undefined, expected: 19002, configLoaded: true },
  ])(
    "probes the canonical $name port when no active lock exists",
    async ({ port, expected, configLoaded }) => {
      vi.stubEnv("OPENCLAW_GATEWAY_PORT", port);

      await expect(probeDockerGatewayHealth()).resolves.toBe(true);
      expect(fetch).toHaveBeenCalledWith(`http://127.0.0.1:${expected}/healthz`);
      if (configLoaded) {
        expect(createConfigIO).toHaveBeenCalledWith({
          pluginValidation: "skip",
          shellEnvFallback: "defer",
        });
      } else {
        expect(createConfigIO).not.toHaveBeenCalled();
      }
    },
  );

  it("still probes the env port when config resolution throws", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "19001");
    const defaultImpl = vi.mocked(createConfigIO).getMockImplementation()!;
    vi.mocked(createConfigIO).mockImplementationOnce((...args) => ({
      ...defaultImpl(...args),
      loadConfigAsync: async () => {
        throw new Error("invalid config");
      },
    }));

    try {
      await expect(probeDockerGatewayHealth()).resolves.toBe(true);
      expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:19001/healthz");
      expect(createConfigIO).not.toHaveBeenCalled();
    } finally {
      // The env short-circuit never consumes the once implementation; restore it so
      // later tests still load config through the default mock.
      vi.mocked(createConfigIO).mockReset();
      vi.mocked(createConfigIO).mockImplementation(defaultImpl);
    }
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
