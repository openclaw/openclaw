import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyGatewaySecret } from "../../ui/src/lib/gateway-secret-shape.ts";
import { issueDevicePairSetupBootstrapToken } from "../infra/device-bootstrap.js";
import {
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
} from "../shared/device-bootstrap-profile.js";
import {
  encodePairingSetupCode,
  resolvePairingGatewayUrl,
  resolvePairingSetupFromConfig,
} from "./setup-code.js";

// mock-isolation: Keep bootstrap credential issuance outside this URL and payload fixture.
vi.mock("../infra/device-bootstrap.js", () => ({
  issueDevicePairSetupBootstrapToken: vi.fn(async () => ({
    token: "bootstrap-123",
    expiresAtMs: 123,
    setupId: "setup-123",
  })),
}));

const options = { env: {}, networkInterfaces: () => ({}) };

describe("pairing public origin", () => {
  type OriginCase = {
    config: Parameters<typeof resolvePairingGatewayUrl>[0];
    networkInterfaces?: Parameters<typeof resolvePairingGatewayUrl>[1]["networkInterfaces"];
    expected: Awaited<ReturnType<typeof resolvePairingGatewayUrl>>;
  };
  it.each<OriginCase>([
    {
      config: {
        gateway: { bind: "loopback", publicOrigin: "https://gateway.example.test/openclaw-gw" },
      },
      expected: {
        url: "wss://gateway.example.test/openclaw-gw",
        source: "gateway.publicOrigin",
      },
    },
    {
      config: {
        gateway: { bind: "loopback", publicOrigin: "https://gateway.example.test:notaport" },
      },
      expected: { error: "Configured gateway.publicOrigin is invalid." },
    },
    {
      config: {
        gateway: { bind: "lan", port: 19001, publicOrigin: "https://gateway.example.test" },
      },
      networkInterfaces: () => ({
        en0: [
          {
            address: "192.168.1.20",
            family: "IPv4",
            internal: false,
            netmask: "255.255.255.0",
            mac: "00:00:00:00:00:00",
            cidr: "192.168.1.20/24",
          },
        ],
      }),
      expected: { url: "ws://192.168.1.20:19001", source: "gateway.bind=lan" },
    },
  ])(
    "resolves public-origin fallback: $expected",
    async ({ config, networkInterfaces, expected }) => {
      await expect(
        resolvePairingGatewayUrl(config, {
          ...options,
          networkInterfaces: networkInterfaces ?? options.networkInterfaces,
        }),
      ).resolves.toEqual(expected);
    },
  );

  it("preserves Tailscale Funnel ahead of publicOrigin for device pairing", async () => {
    const config = {
      gateway: {
        bind: "loopback",
        publicOrigin: "https://gateway.example.test",
        remote: { url: "wss://remote.example.test" },
        tailscale: { mode: "funnel" },
      },
    } satisfies Parameters<typeof resolvePairingGatewayUrl>[0];
    const runCommandWithTimeout = vi.fn(async () => ({
      code: 0,
      stdout: '{"Self":{"DNSName":"gateway.tailnet.ts.net"}}',
    }));
    const resolveOptions = { ...options, runCommandWithTimeout };
    await expect(resolvePairingGatewayUrl(config, resolveOptions)).resolves.toEqual({
      url: "wss://gateway.tailnet.ts.net",
      source: "gateway.tailscale.mode=funnel",
    });
    await expect(
      resolvePairingGatewayUrl(config, {
        ...resolveOptions,
        preferRemoteUrl: true,
        publicUrl: "https://pairing.example.test",
      }),
    ).resolves.toEqual({
      url: "wss://pairing.example.test",
      source: "plugins.entries.device-pair.config.publicUrl",
    });
    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
  });
});

describe("trusted-proxy pairing setup", () => {
  beforeEach(() => vi.mocked(issueDevicePairSetupBootstrapToken).mockClear());

  it.each([
    {
      name: "issues full setup codes without a shared secret over TLS",
      url: "wss://gateway.example.test",
      profile: FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
      access: "full",
      accessDowngraded: false,
    },
    {
      name: "keeps plaintext LAN handoff limited",
      url: "ws://192.168.1.20:18789",
      profile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
      access: "limited",
      accessDowngraded: true,
    },
  ])("$name", async ({ url, profile, access, accessDowngraded }) => {
    const result = await resolvePairingSetupFromConfig(
      {
        gateway: {
          bind: "custom",
          customBindHost: "127.0.0.1",
          auth: { mode: "trusted-proxy" },
        },
      },
      { env: {}, publicUrl: url },
    );
    expect(result).toMatchObject({
      ok: true,
      authLabel: "trusted-proxy",
      payload: { url, bootstrapToken: "bootstrap-123", expiresAtMs: 123 },
      setupId: "setup-123",
      expiresAtMs: 123,
      urlSource: "plugins.entries.device-pair.config.publicUrl",
      access,
      accessDowngraded,
    });
    expect(issueDevicePairSetupBootstrapToken).toHaveBeenCalledExactlyOnceWith({
      baseDir: undefined,
      profile,
    });
    if (result.ok) {
      expect(result.payload).not.toHaveProperty("setupId");
    }
  });
});

it("recognizes an encoded setup link in the Control UI even after expiry", () => {
  const setupCode = encodePairingSetupCode({
    url: "wss://gateway.example/日本語",
    bootstrapToken: "synthetic-bootstrap-token",
    expiresAtMs: 1,
  });
  expect(classifyGatewaySecret(`  OC-PAIR://${setupCode}\n`)).toBe("setup-code");
});
