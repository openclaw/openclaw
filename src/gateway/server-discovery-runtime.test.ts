import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startGatewayBonjourAdvertiser: vi.fn(),
  pickPrimaryLanIPv4: vi.fn(),
  resolveTailnetDnsHint: vi.fn(),
  formatBonjourInstanceName: vi.fn(),
  resolveBonjourCliPath: vi.fn(),
}));

vi.mock("../infra/bonjour.js", () => ({
  startGatewayBonjourAdvertiser: mocks.startGatewayBonjourAdvertiser,
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: vi.fn(),
  pickPrimaryTailnetIPv6: vi.fn(),
}));

vi.mock("../infra/widearea-dns.js", () => ({
  resolveWideAreaDiscoveryDomain: vi.fn(),
  writeWideAreaGatewayZone: vi.fn(),
}));

vi.mock("./net.js", () => ({
  pickPrimaryLanIPv4: mocks.pickPrimaryLanIPv4,
}));

vi.mock("./server-discovery.js", () => ({
  formatBonjourInstanceName: mocks.formatBonjourInstanceName,
  resolveBonjourCliPath: mocks.resolveBonjourCliPath,
  resolveTailnetDnsHint: mocks.resolveTailnetDnsHint,
}));

const { startGatewayDiscovery } = await import("./server-discovery-runtime.js");

describe("startGatewayDiscovery", () => {
  const prevEnv = { ...process.env };

  function baseParams(overrides?: Partial<Parameters<typeof startGatewayDiscovery>[0]>) {
    return {
      machineDisplayName: "test-machine",
      port: 18789,
      wideAreaDiscoveryEnabled: false,
      tailscaleMode: "off" as const,
      mdnsMode: "minimal" as const,
      logDiscovery: { info: vi.fn(), warn: vi.fn() },
      ...overrides,
    };
  }

  beforeEach(() => {
    // Allow bonjour to be "enabled" in tests.
    delete process.env.VITEST;
    delete process.env.OPENCLAW_DISABLE_BONJOUR;
    process.env.NODE_ENV = "development";

    mocks.formatBonjourInstanceName.mockReturnValue("test-machine (OpenClaw)");
    mocks.resolveBonjourCliPath.mockReturnValue("/usr/local/bin/openclaw");
    mocks.resolveTailnetDnsHint.mockResolvedValue(undefined);
    mocks.startGatewayBonjourAdvertiser.mockResolvedValue({ stop: vi.fn() });
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(prevEnv)) {
      process.env[key] = value;
    }
    vi.restoreAllMocks();
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
  });

  it("passes primary LAN IP as networkInterface to bonjour advertiser", async () => {
    mocks.pickPrimaryLanIPv4.mockReturnValue("192.168.1.130");
    mocks.startGatewayBonjourAdvertiser.mockResolvedValue({ stop: vi.fn() });

    await startGatewayDiscovery(baseParams());

    expect(mocks.startGatewayBonjourAdvertiser).toHaveBeenCalledTimes(1);
    const opts = mocks.startGatewayBonjourAdvertiser.mock.calls[0]?.[0];
    expect(opts.networkInterface).toBe("192.168.1.130");
  });

  it("passes undefined networkInterface when no LAN IP is available", async () => {
    mocks.pickPrimaryLanIPv4.mockReturnValue(undefined);
    mocks.startGatewayBonjourAdvertiser.mockResolvedValue({ stop: vi.fn() });

    await startGatewayDiscovery(baseParams());

    expect(mocks.startGatewayBonjourAdvertiser).toHaveBeenCalledTimes(1);
    const opts = mocks.startGatewayBonjourAdvertiser.mock.calls[0]?.[0];
    expect(opts.networkInterface).toBeUndefined();
  });
});
