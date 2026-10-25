import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as containerEnvironment from "../infra/container-environment.js";
import * as interfaces from "../infra/network-interfaces.js";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";
import {
  defaultGatewayBindMode,
  isLocalishHost,
  isLoopbackGatewayUrl,
  isPrivateOrLoopbackAddress,
  isPrivateOrLoopbackHost,
  isSecureWebSocketUrl,
  isTrustedProxyAddress,
  resolveLocalInterfaceAddressMatch,
  resolveClientIp,
  resolveGatewayBindHost,
  resolveGatewayListenHosts,
  resolveHostName,
} from "./net.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it.each([
  ["localhost:18789", "localhost"],
  ["[::1]:18789", "::1"],
  ["::1", "::1"],
] as const)("resolveHostName normalizes %s", (input, expected) => {
  expect(resolveHostName(input), input).toBe(expected);
});

describe("isLocalishHost", () => {
  it("accepts loopback and tailscale serve/funnel host headers", () => {
    const accepted = [
      "localhost",
      "localhost.:18789",
      "127.0.0.1:18789",
      "[::1]:18789",
      "[::ffff:127.0.0.1]:18789",
      "gateway.tailnet.ts.net",
    ];
    for (const host of accepted) {
      expect(isLocalishHost(host), host).toBe(true);
    }
  });

  it("rejects non-local hosts", () => {
    const rejected = ["example.com", "192.168.1.10", "203.0.113.5:18789"];
    for (const host of rejected) {
      expect(isLocalishHost(host), host).toBe(false);
    }
  });
});

it.each([
  ["ws://LOCALHOST:18789", true],
  ["ws://localhost.:18789", false],
  ["ws://127.42.0.1:18789", true],
  ["ws://[::1]:18789", true],
  ["not-a-url", false],
] as const)("isLoopbackGatewayUrl classifies %s as %s", (url, expected) => {
  expect(isLoopbackGatewayUrl(url)).toBe(expected);
});

it.each([
  ["different IP", "192.168.1.2", ["192.168.1.1"], false],
  ["missing IP", undefined, ["192.168.1.1"], false],
  ["missing proxies", "192.168.1.1", undefined, false],
  ["empty proxies", "192.168.1.1", [], false],
  ["blank and padded valid proxies", "10.0.0.5", [" ", " 10.0.0.5 ", ""], true],
  ["all-blank proxies", "10.0.0.5", [" ", "\t"], false],
])("isTrustedProxyAddress: %s", (_name, ip, trustedProxies, expected) => {
  expect(isTrustedProxyAddress(ip, trustedProxies)).toBe(expected);
});

describe("resolveLocalInterfaceAddressMatch", () => {
  const snapshot = makeNetworkInterfacesSnapshot({
    lo: [
      { address: "127.0.0.1", family: "IPv4", internal: true },
      { address: "::1", family: "IPv6", internal: true },
    ],
    eth0: [{ address: "10.42.0.59", family: "IPv4" }],
    tailscale0: [{ address: "fd7a:115c:a1e0::1234", family: "IPv6" }],
  });

  it.each([
    ["10.42.0.59", true],
    ["::ffff:10.42.0.59", true],
    ["fd7a:115c:a1e0::1234", true],
    ["127.0.0.1", true],
    ["10.42.0.60", false],
    [undefined, false],
  ] as const)("classifies %s as %s", (input, expected) => {
    using _ = vi.spyOn(interfaces, "safeNetworkInterfaces").mockReturnValue(snapshot);
    expect(resolveLocalInterfaceAddressMatch(input)).toBe(expected);
  });

  it("reports an indeterminate match when interface discovery is unavailable", () => {
    using _ = vi.spyOn(interfaces, "safeNetworkInterfaces").mockReturnValue(undefined);
    expect(resolveLocalInterfaceAddressMatch("10.42.0.59")).toBeUndefined();
  });
});

describe("resolveClientIp", () => {
  const proxy = (
    forwardedFor?: string,
    overrides: Partial<Parameters<typeof resolveClientIp>[0]> = {},
  ) => ({
    remoteAddr: "127.0.0.1",
    trustedProxies: ["127.0.0.1"],
    forwardedFor,
    ...overrides,
  });
  it.each([
    ["untrusted remote", proxy("10.0.0.2", { remoteAddr: "203.0.113.10" }), "203.0.113.10"],
    ["right-most untrusted hop", proxy("198.51.100.99, 10.0.0.9, 127.0.0.1"), "10.0.0.9"],
    [
      "spoofed loopback",
      proxy("127.0.0.1", { remoteAddr: "10.0.0.50", trustedProxies: ["10.0.0.0/8"] }),
      undefined,
    ],
    [
      "all loopback hops trusted",
      proxy("127.0.0.1, ::1", { trustedProxies: ["127.0.0.1", "::1"] }),
      undefined,
    ],
    [
      "all non-loopback hops trusted",
      proxy("10.0.0.2, 10.0.0.1", { remoteAddr: "10.0.0.50", trustedProxies: ["10.0.0.0/8"] }),
      undefined,
    ],
    ["missing headers", proxy(), undefined],
    ["invalid forwarded entries", proxy("garbage, 10.0.0.999"), undefined],
    ["real IP disabled", proxy(undefined, { realIp: "[2001:db8::5]" }), undefined],
    [
      "real IP enabled",
      proxy(undefined, { realIp: "[2001:db8::5]", allowRealIpFallback: true }),
      "2001:db8::5",
    ],
    [
      "invalid real IP",
      proxy(undefined, { realIp: "not-an-ip", allowRealIpFallback: true }),
      undefined,
    ],
  ])("resolves client IP: %s", (_name, input, expected) => {
    expect(resolveClientIp(input)).toBe(expected);
  });
});

describe("resolveGatewayListenHosts", () => {
  function mockBind(available: boolean) {
    const server = new net.Server();
    const listen = vi.spyOn(server, "listen").mockImplementation(() => {
      queueMicrotask(() =>
        server.emit(available ? "listening" : "error", new Error("bind failed")),
      );
      return server;
    });
    vi.spyOn(net, "createServer").mockReturnValue(server);
    return listen;
  }

  it.each([
    ["linux", false, "0.0.0.0", ["0.0.0.0"], undefined],
    ["linux", false, "::1", ["::1"], undefined],
    ["linux", false, "100.64.0.1", ["100.64.0.1", "127.0.0.1"], undefined],
    ["linux", false, "127.0.0.1", ["127.0.0.1"], "::1"],
    ["win32", true, "127.0.0.1", ["127.0.0.1"], undefined],
    ["darwin", true, "127.0.0.1", ["127.0.0.1", "::1"], "::1"],
  ] as const)("%s IPv6=%s bind=%s", async (platform, available, host, expected, probeHost) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const listen = mockBind(available);
    const hosts = await resolveGatewayListenHosts(host);
    expect(hosts).toEqual(expected);
    expect(listen).toHaveBeenCalledTimes(probeHost ? 1 : 0);
    if (probeHost) {
      expect(listen).toHaveBeenCalledWith(0, probeHost);
    }
  });
});

describe("gateway bind probe lifecycle", () => {
  let server: net.Server;
  let listenSpy: MockInstance<net.Server["listen"]>;
  let closeSpy: MockInstance<net.Server["close"]>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    server = new net.Server();
    listenSpy = vi.spyOn(server, "listen").mockReturnValue(server);
    closeSpy = vi.spyOn(server, "close");
    vi.spyOn(net, "createServer").mockReturnValue(server);
  });

  afterEach(() => {
    server.close();
    vi.useRealTimers();
  });

  it("bounds a never-emitting probe and closes a listener arriving after timeout", async () => {
    const results: string[][] = [];
    const pending = resolveGatewayListenHosts("127.0.0.1").then((hosts) => results.push(hosts));
    await vi.advanceTimersByTimeAsync(2999);
    expect(results).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(results).toEqual([["127.0.0.1"]]);
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    // Model a late native bind with a real ephemeral socket, not just a mock event.
    listenSpy.mockRestore();
    const closed = new Promise<void>((resolve) => {
      server.once("close", resolve);
    });
    server.listen(0, "127.0.0.1");
    await closed;
    await pending;
    expect(server.listening).toBe(false);
    expect(results).toEqual([["127.0.0.1"]]);
    expect(closeSpy).toHaveBeenCalledTimes(2);
    server.emit("error", new Error("late bind error"));
    expect(results).toEqual([["127.0.0.1"]]);
  });

  it.each(["error", "listening"] as const)(
    "settles once on %s and cancels the deadline",
    async (event) => {
      const result = resolveGatewayListenHosts("127.0.0.1");
      server.emit(event, new Error("bind failed"));
      const expected = event === "listening" ? ["127.0.0.1", "::1"] : ["127.0.0.1"];
      expect(await result).toEqual(expected);
      expect(closeSpy).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(6000);
      expect(closeSpy).toHaveBeenCalledOnce();
      // The other terminal event must not change the already published decision.
      server.emit(event === "error" ? "listening" : "error", new Error("late event"));
      expect(await result).toEqual(expected);
    },
  );

  it("treats a synchronous listen failure as an unavailable probe", async () => {
    listenSpy.mockImplementation(() => {
      throw new Error("listen failed synchronously");
    });
    await expect(resolveGatewayListenHosts("127.0.0.1")).resolves.toEqual(["127.0.0.1"]);
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("does not treat RFC8215 local-use NAT64 as a private Gateway address", () => {
  expect(isPrivateOrLoopbackAddress("64:ff9b:1::8.8.8.8")).toBe(false);
});

it("isPrivateOrLoopbackHost rejects empty input", () => {
  expect(isPrivateOrLoopbackHost("")).toBe(false);
});

describe("resolveGatewayBindHost", () => {
  it("closes a successful real loopback probe for a custom bind", async () => {
    const probe = new net.Server();
    vi.spyOn(net, "createServer").mockReturnValue(probe);
    expect(await resolveGatewayBindHost("custom", "127.0.0.1")).toBe("127.0.0.1");
    expect(probe.listening).toBe(false);
    expect(probe.address()).toBeNull();
  });

  it("returns 127.0.0.1 for auto mode on non-container host", async () => {
    vi.spyOn(containerEnvironment, "isContainerEnvironment").mockReturnValue(false);
    expect(await resolveGatewayBindHost("auto")).toBe("127.0.0.1");
  });

  it("returns 0.0.0.0 for auto mode inside a container", async () => {
    vi.spyOn(containerEnvironment, "isContainerEnvironment").mockReturnValue(true);
    expect(await resolveGatewayBindHost("auto")).toBe("0.0.0.0");
  });

  it("defaults to loopback when bind is undefined (non-container)", async () => {
    vi.spyOn(containerEnvironment, "isContainerEnvironment").mockReturnValue(false);
    const createServerSpy = vi.spyOn(net, "createServer");
    expect(await resolveGatewayBindHost(undefined)).toBe("127.0.0.1");
    expect(createServerSpy).not.toHaveBeenCalled();
  });
});

it.each([
  [false, undefined, "loopback"],
  [true, undefined, "auto"],
  [true, "serve", "loopback"],
  [true, "off", "auto"],
] as const)(
  "defaultGatewayBindMode container=%s tailscale=%s gives %s",
  (container, tailscale, expected) => {
    vi.spyOn(containerEnvironment, "isContainerEnvironment").mockReturnValue(container);
    expect(defaultGatewayBindMode(tailscale)).toBe(expected);
  },
);

describe("isSecureWebSocketUrl", () => {
  it.each([
    // wss:// always accepted
    ["wss://remote.example.com:18789", true],
    // ws:// loopback accepted
    ["ws://127.0.0.1:18789", true],
    ["ws://localhost:18789", true],
    ["ws://[::1]:18789", true],
    // ws:// trusted LAN/Tailnet endpoints accepted
    ["ws://10.0.0.5:18789", true],
    ["ws://172.16.0.1:18789", true],
    ["ws://192.168.1.100:18789", true],
    ["ws://169.254.10.20:18789", true],
    ["ws://100.64.0.1:18789", true],
    ["ws://[fd12:3456:789a::1]:18789", true],
    ["ws://[fe80::1]:18789", true],
    ["ws://gateway.local:18789", true],
    ["ws://machine.tail123.ts.net:18789", true],
    ["ws://[::]:18789", false],
    ["ws://[ff02::1]:18789", false],
    // ws:// public addresses rejected
    ["ws://remote.example.com:18789", false],
    ["ws://1.1.1.1:18789", false],
    // invalid URLs
    ["not-a-url", false],
    ["http://127.0.0.1:18789", true],
    ["https://remote.example.com:18789", true],
    ["http://remote.example.com:18789", false],
  ] as const)("defaults secure websocket behavior for %s", (input, expected) => {
    expect(isSecureWebSocketUrl(input), input).toBe(expected);
  });

  it("allows arbitrary private-dns ws:// hostnames only when opt-in is enabled", () => {
    const input = "ws://gateway.private.example:18789";
    expect(isSecureWebSocketUrl(input)).toBe(false);
    expect(isSecureWebSocketUrl(input, { allowPrivateWs: true })).toBe(true);
  });

  it("still rejects ws:// public IP literals when opt-in is enabled", () => {
    const publicIpWsUrls = ["ws://1.1.1.1:18789", "ws://8.8.8.8:18789", "ws://203.0.113.10:18789"];

    for (const input of publicIpWsUrls) {
      expect(isSecureWebSocketUrl(input, { allowPrivateWs: true }), input).toBe(false);
    }
  });

  it("still rejects non-unicast IPv6 ws:// even when opt-in is enabled", () => {
    const disallowedWhenOptedIn = [
      "ws://[::]:18789",
      "ws://[0:0::0]:18789",
      "ws://[ff02::1]:18789",
    ];

    for (const input of disallowedWhenOptedIn) {
      expect(isSecureWebSocketUrl(input, { allowPrivateWs: true }), input).toBe(false);
    }
  });
});
