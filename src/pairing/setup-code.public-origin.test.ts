import { beforeEach, expect, it, vi } from "vitest";
import { classifyGatewaySecret } from "../../ui/src/lib/gateway-secret-shape.ts";
import { issueDevicePairSetupBootstrapToken } from "../infra/device-bootstrap.js";
import {
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE as FULL_ACCESS,
  PAIRING_SETUP_BOOTSTRAP_PROFILE as LIMITED_ACCESS,
} from "../shared/device-bootstrap-profile.js";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";
import {
  encodePairingSetupCode,
  resolvePairingGatewayUrl as resolveUrl,
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

const publicOrigin = "https://gw.test";
const funnel = { tailscale: { mode: "funnel" }, remote: { url: "wss://remote.test" } } as const;
const tailnet = { code: 0, stdout: '{"Self":{"DNSName":"gw.ts.net"}}' };
const funnelOptions = { runCommandWithTimeout: async () => tailnet };
const lan = makeNetworkInterfacesSnapshot({
  en0: [{ address: "192.168.1.20", family: "IPv4", netmask: "255.255.255.0" }],
});
beforeEach(() => vi.mocked(issueDevicePairSetupBootstrapToken).mockClear());

type OriginCase = [
  NonNullable<Parameters<typeof resolveUrl>[0]["gateway"]>,
  string,
  string?,
  Partial<Parameters<typeof resolveUrl>[1]>?,
];
it.each<OriginCase>([
  [{ publicOrigin: `${publicOrigin}/gw` }, "wss://gw.test/gw", "gateway.publicOrigin"],
  [{ publicOrigin: `${publicOrigin}:notaport` }, "Configured gateway.publicOrigin is invalid."],
  [
    { bind: "lan", port: 19001 },
    "ws://192.168.1.20:19001",
    "gateway.bind=lan",
    { networkInterfaces: () => lan },
  ],
  [funnel, "wss://gw.ts.net", "gateway.tailscale.mode=funnel", funnelOptions],
  [
    funnel,
    "wss://pair.test",
    "plugins.entries.device-pair.config.publicUrl",
    { ...funnelOptions, preferRemoteUrl: true, publicUrl: "https://pair.test" },
  ],
])("resolves public-origin precedence for %j", async (gateway, expected, source, overrides) => {
  await expect(
    resolveUrl(
      { gateway: { bind: "loopback", publicOrigin, ...gateway } },
      { env: {}, networkInterfaces: () => ({}), ...overrides },
    ),
  ).resolves.toEqual(source ? { url: expected, source } : { error: expected });
});

it.each<[string, NodeJS.ProcessEnv, string | undefined, boolean]>([
  ["TLS without shared secret", {}, undefined, false],
  ["ambient password", { OPENCLAW_GATEWAY_PASSWORD: "password" }, undefined, false],
  ["configured password", {}, "password", false],
  ["limited plaintext LAN", {}, undefined, true],
])("preserves trusted-proxy setup: %s", async (_name, env, password, limited) => {
  const url = limited ? "ws://192.168.1.20:18789" : "wss://gw.test";
  const result = await resolvePairingSetupFromConfig(
    { gateway: { auth: { mode: "trusted-proxy", ...(password ? { password } : {}) } } },
    { env, publicUrl: url },
  );
  expect(result).toEqual({
    ok: true,
    authLabel: "trusted-proxy",
    setupId: "setup-123",
    expiresAtMs: 123,
    urlSource: "plugins.entries.device-pair.config.publicUrl",
    access: limited ? "limited" : "full",
    accessDowngraded: limited,
    payload: { url, bootstrapToken: "bootstrap-123", expiresAtMs: 123 },
  });
  expect(issueDevicePairSetupBootstrapToken).toHaveBeenCalledExactlyOnceWith({
    profile: limited ? LIMITED_ACCESS : FULL_ACCESS,
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
