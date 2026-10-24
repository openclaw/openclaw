import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyGatewaySecret } from "../../ui/src/lib/gateway-secret-shape.ts";
import { issueDevicePairSetupBootstrapToken } from "../infra/device-bootstrap.js";
import {
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
} from "../shared/device-bootstrap-profile.js";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";
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
const localPassword = "synthetic-local-password";

type OriginCase = [
  NonNullable<Parameters<typeof resolvePairingGatewayUrl>[0]["gateway"]>,
  Awaited<ReturnType<typeof resolvePairingGatewayUrl>>,
  Parameters<typeof resolvePairingGatewayUrl>[1]["networkInterfaces"]?,
];
it.each<OriginCase>([
  [
    { bind: "loopback", publicOrigin: "https://gateway.example.test/openclaw-gw" },
    { url: "wss://gateway.example.test/openclaw-gw", source: "gateway.publicOrigin" },
  ],
  [
    { bind: "loopback", publicOrigin: "https://gateway.example.test:notaport" },
    { error: "Configured gateway.publicOrigin is invalid." },
  ],
  [
    { bind: "lan", port: 19001, publicOrigin: "https://gateway.example.test" },
    { url: "ws://192.168.1.20:19001", source: "gateway.bind=lan" },
    () =>
      makeNetworkInterfacesSnapshot({
        en0: [{ address: "192.168.1.20", family: "IPv4", netmask: "255.255.255.0" }],
      }),
  ],
])(
  "resolves public-origin fallback for %j",
  async (gateway, expected, networkInterfaces = options.networkInterfaces) => {
    await expect(
      resolvePairingGatewayUrl({ gateway }, { ...options, networkInterfaces }),
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

describe("trusted-proxy pairing setup", () => {
  beforeEach(() => vi.mocked(issueDevicePairSetupBootstrapToken).mockClear());

  it.each<[string, NodeJS.ProcessEnv, string | undefined, boolean]>([
    ["TLS without shared secret", {}, undefined, false],
    ["ambient password", { OPENCLAW_GATEWAY_PASSWORD: localPassword }, undefined, false],
    ["configured password", {}, localPassword, false],
    ["limited plaintext LAN", {}, undefined, true],
  ])("preserves trusted-proxy setup: %s", async (_name, env, password, limited) => {
    const url = limited ? "ws://192.168.1.20:18789" : "wss://gateway.example.test";
    const result = await resolvePairingSetupFromConfig(
      {
        gateway: {
          bind: "custom",
          customBindHost: "127.0.0.1",
          auth: { mode: "trusted-proxy", ...(password ? { password } : {}) },
        },
      },
      { env, publicUrl: url },
    );
    expect(result).toMatchObject({
      ok: true,
      authLabel: "trusted-proxy",
      setupId: "setup-123",
      expiresAtMs: 123,
      urlSource: "plugins.entries.device-pair.config.publicUrl",
      access: limited ? "limited" : "full",
      accessDowngraded: limited,
    });
    expect(issueDevicePairSetupBootstrapToken).toHaveBeenCalledExactlyOnceWith({
      profile: limited
        ? PAIRING_SETUP_BOOTSTRAP_PROFILE
        : FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    if (result.ok) {
      expect(result.payload).toEqual({ url, bootstrapToken: "bootstrap-123", expiresAtMs: 123 });
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
