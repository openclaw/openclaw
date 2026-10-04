import { describe, expect, it, vi } from "vitest";
import { resolvePairingGatewayUrl } from "./setup-code.js";

const options = { env: {}, networkInterfaces: () => ({}) };

describe("pairing public origin", () => {
  type OriginCase = {
    config: Parameters<typeof resolvePairingGatewayUrl>[0];
    networkInterfaces?: Parameters<typeof resolvePairingGatewayUrl>[1]["networkInterfaces"];
    expected: Awaited<ReturnType<typeof resolvePairingGatewayUrl>>;
  };
  it.each<OriginCase>([
    ...[
      ["https://gateway.example.test", "wss://gateway.example.test"],
      ["http://127.0.0.1:19821", "ws://127.0.0.1:19821"],
      ["https://gateway.example.test/openclaw-gw", "wss://gateway.example.test/openclaw-gw"],
    ].map(([publicOrigin, url]) => ({
      config: { gateway: { bind: "loopback" as const, publicOrigin } },
      expected: { url, source: "gateway.publicOrigin" },
    })),
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

  it.each(["serve", "funnel"] as const)(
    "preserves Tailscale %s ahead of publicOrigin for device pairing",
    async (mode) => {
      const config = {
        gateway: {
          bind: "loopback",
          publicOrigin: "https://gateway.example.test",
          remote: { url: "wss://remote.example.test" },
          tailscale: { mode },
        },
      } satisfies Parameters<typeof resolvePairingGatewayUrl>[0];
      const runCommandWithTimeout = vi.fn(async () => ({
        code: 0,
        stdout: '{"Self":{"DNSName":"gateway.tailnet.ts.net"}}',
      }));
      const resolveOptions = { ...options, runCommandWithTimeout };
      await expect(resolvePairingGatewayUrl(config, resolveOptions)).resolves.toEqual({
        url: "wss://gateway.tailnet.ts.net",
        source: `gateway.tailscale.mode=${mode}`,
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
    },
  );

  it.each([
    {
      preferRemoteUrl: undefined,
      url: "wss://remote.example.test",
      source: "gateway.remote.url",
    },
    {
      preferRemoteUrl: true,
      url: "wss://remote.example.test",
      source: "gateway.remote.url",
    },
  ])(
    "selects $source when preferRemoteUrl=$preferRemoteUrl",
    async ({ preferRemoteUrl, url, source }) => {
      await expect(
        resolvePairingGatewayUrl(
          {
            gateway: {
              publicOrigin: "https://gateway.example.test",
              remote: { url: "wss://remote.example.test" },
            },
          },
          { ...options, preferRemoteUrl },
        ),
      ).resolves.toEqual({ url, source });
    },
  );
});
