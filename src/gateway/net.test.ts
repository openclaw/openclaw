import net from "node:net";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { resetContainerEnvironmentCacheForTest } from "../infra/container-environment.js";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  defaultGatewayBindMode,
  isContainerEnvironment,
  isLocalishHost,
  isLoopbackGatewayUrl,
  isPrivateOrLoopbackAddress,
  isPrivateOrLoopbackHost,
  isSecureWebSocketUrl,
  isTrustedProxyAddress,
  pickPrimaryLanIPv4,
  resolveLocalInterfaceAddressMatch,
  resolveClientIp,
  resolveGatewayBindHost,
  resolveGatewayListenHosts,
  resolveHostName,
} from "./net.js";

const flyMachineEnvKeys = ["FLY_MACHINE_ID", "FLY_APP_NAME"] as const;

function useClearedFlyMachineEnv() {
  let envSnapshot: ReturnType<typeof captureEnv>;
  beforeEach(() => {
    envSnapshot = captureEnv([...flyMachineEnvKeys]);
    for (const key of flyMachineEnvKeys) {
      deleteTestEnvValue(key);
    }
  });
  afterEach(() => {
    envSnapshot.restore();
    resetContainerEnvironmentCacheForTest();
    vi.restoreAllMocks();
  });
}

it.each([
  ["localhost:18789", "localhost"],
  ["[::1]:18789", "::1"],
  ["::1", "::1"],
] as const)("resolveHostName normalizes %s", (input, expected) => {
  expect(resolveHostName(input), input).toBe(expected);
});

describe("isLocalishHost", () => {
  it("accepts loopback and tailscale serve/funnel host headers", () => {
    for (const host of [
      "localhost",
      "localhost.:18789",
      "127.0.0.1:18789",
      "[::1]:18789",
      "[::ffff:127.0.0.1]:18789",
      "gateway.tailnet.ts.net",
    ]) {
      expect(isLocalishHost(host), host).toBe(true);
    }
  });

  it("rejects non-local hosts", () => {
    for (const host of ["example.com", "192.168.1.10", "203.0.113.5:18789"]) {
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

describe("isTrustedProxyAddress", () => {
  it.each([
    ["192.168.1.1", ["192.168.1.1"], true],
    ["192.168.1.2", ["192.168.1.1"], false],
    ["10.0.0.5", ["192.168.1.1", "10.0.0.5", "172.16.0.1"], true],
    ["10.0.0.5", [" 10.0.0.5 "], true],
    ["10.42.0.59", ["10.42.0.0/24"], true],
    ["10.42.1.1", ["10.42.0.0/24"], false],
    ["2001:db8::1234", ["2001:db8::/32"], true],
    ["2001:db9::1234", ["2001:db8::/32"], false],
    ["::ffff:192.168.1.1", ["192.168.1.1"], true],
    [undefined, ["192.168.1.1"], false],
    ["192.168.1.1", undefined, false],
    ["192.168.1.1", [], false],
    ["10.42.0.59", ["10.42.0.0/33", "10.42.0.0/-1", "invalid/24", "2001:db8::/129"], false],
    ["10.0.0.5", [" ", "10.0.0.5", ""], true],
    ["10.0.0.5", [" ", "\t"], false],
  ])("trusts %s via %j: %s", (ip, trustedProxies, expected) => {
    expect(isTrustedProxyAddress(ip, trustedProxies)).toBe(expected);
  });
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
    expect(resolveLocalInterfaceAddressMatch(input, snapshot)).toBe(expected);
  });

  it("reports an indeterminate match when interface discovery is unavailable", () => {
    expect(resolveLocalInterfaceAddressMatch("10.42.0.59", undefined)).toBeUndefined();
  });
});

describe("resolveClientIp", () => {
  it.each([
    ["untrusted remote", { remoteAddr: "203.0.113.10", forwardedFor: "10.0.0.2" }, "203.0.113.10"],
    [
      "right-most untrusted hop",
      { forwardedFor: "198.51.100.99, 10.0.0.9, 127.0.0.1" },
      "10.0.0.9",
    ],
    [
      "spoofed loopback hop",
      { remoteAddr: "10.0.0.50", forwardedFor: "127.0.0.1", trustedProxies: ["10.0.0.0/8"] },
      undefined,
    ],
    [
      "all loopback hops trusted",
      { forwardedFor: "127.0.0.1, ::1", trustedProxies: ["127.0.0.1", "::1"] },
      undefined,
    ],
    [
      "all non-loopback hops trusted",
      {
        remoteAddr: "10.0.0.50",
        forwardedFor: "10.0.0.2, 10.0.0.1",
        trustedProxies: ["10.0.0.0/8"],
      },
      undefined,
    ],
    ["missing forwarding headers", {}, undefined],
    ["invalid forwarded entries", { forwardedFor: "garbage, 10.0.0.999" }, undefined],
    ["X-Real-IP disabled by default", { realIp: "[2001:db8::5]" }, undefined],
    [
      "X-Real-IP explicitly enabled",
      { realIp: "[2001:db8::5]", allowRealIpFallback: true },
      "2001:db8::5",
    ],
    [
      "invalid X-Real-IP with fallback enabled",
      { realIp: "not-an-ip", allowRealIpFallback: true },
      undefined,
    ],
  ])("%s", (_name, overrides, expected) => {
    expect(
      resolveClientIp({ remoteAddr: "127.0.0.1", trustedProxies: ["127.0.0.1"], ...overrides }),
    ).toBe(expected);
  });
});

describe("resolveGatewayListenHosts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const unexpectedProbe = async (): Promise<boolean> => {
    throw new Error("should not be called");
  };

  it.each([
    ["0.0.0.0", unexpectedProbe, ["0.0.0.0"]],
    ["::1", unexpectedProbe, ["::1"]],
    ["100.64.0.1", unexpectedProbe, ["100.64.0.1", "127.0.0.1"]],
    ["127.0.0.1", async () => false, ["127.0.0.1"]],
  ] as const)("resolves listen hosts: %s", async (host, canBindToHost, expected) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(await resolveGatewayListenHosts(host, { canBindToHost })).toEqual(expected);
  });

  it("skips ::1 on Windows even when IPv6 is bindable", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const canBindToHost = vi.fn().mockResolvedValue(true);
    const hosts = await resolveGatewayListenHosts("127.0.0.1", { canBindToHost });
    expect(hosts).toEqual(["127.0.0.1"]);
    expect(canBindToHost).not.toHaveBeenCalled();
  });

  it("still includes ::1 on non-Windows when IPv6 is bindable", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const canBindToHost = vi.fn().mockResolvedValue(true);
    const hosts = await resolveGatewayListenHosts("127.0.0.1", { canBindToHost });
    expect(hosts).toEqual(["127.0.0.1", "::1"]);
    expect(canBindToHost).toHaveBeenCalledWith("::1");
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
    vi.restoreAllMocks();
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

describe("pickPrimaryLanIPv4", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("selects the preferred LAN interface", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue(
      makeNetworkInterfacesSnapshot({
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        en0: [{ address: "192.168.1.42", family: "IPv4" }],
      }),
    );
    expect(pickPrimaryLanIPv4()).toBe("192.168.1.42");
  });
});

it("isPrivateOrLoopbackAddress rejects public IP addresses", () => {
  for (const ip of [
    "1.1.1.1",
    "8.8.8.8",
    "172.32.0.1",
    "203.0.113.10",
    "2001:4860:4860::8888",
    "64:ff9b:1::8.8.8.8",
  ]) {
    expect(isPrivateOrLoopbackAddress(ip)).toBe(false);
  }
});

it("isPrivateOrLoopbackHost rejects empty input", () => {
  expect(isPrivateOrLoopbackHost("")).toBe(false);
});

function mockCgroup(contents: string) {
  const fs = require("node:fs");
  vi.spyOn(fs, "accessSync").mockImplementation(() => {
    throw new Error("ENOENT");
  });
  vi.spyOn(fs, "readFileSync").mockReturnValue(contents);
}

describe("isContainerEnvironment", () => {
  useClearedFlyMachineEnv();

  it("returns true when /run/.containerenv exists", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation((filePath: unknown) => {
      if (filePath === "/run/.containerenv") {
        return undefined;
      }
      throw new Error("ENOENT");
    });
    expect(isContainerEnvironment()).toBe(true);
  });

  it("returns true on Fly Machines without Docker sentinel files", () => {
    mockCgroup("10:cpuset:/\n9:perf_event:/\n8:memory:/\n0::/\n");

    setTestEnvValue("FLY_MACHINE_ID", "3d8d5459a03038");
    setTestEnvValue("FLY_APP_NAME", "openclaw-test");
    expect(isContainerEnvironment()).toBe(true);
  });
});

describe("resolveGatewayBindHost", () => {
  useClearedFlyMachineEnv();

  it("closes a successful real loopback probe for a custom bind", async () => {
    const probe = new net.Server();
    vi.spyOn(net, "createServer").mockReturnValue(probe);
    expect(await resolveGatewayBindHost("custom", "127.0.0.1")).toBe("127.0.0.1");
    expect(probe.listening).toBe(false);
    expect(probe.address()).toBeNull();
  });

  it("returns 127.0.0.1 for auto mode on non-container host", async () => {
    mockCgroup("12:memory:/user.slice\n");
    expect(await resolveGatewayBindHost("auto")).toBe("127.0.0.1");
  });

  it("returns 0.0.0.0 for auto mode inside a container", async () => {
    mockCgroup("12:memory:/docker/abc123def456\n");
    expect(await resolveGatewayBindHost("auto")).toBe("0.0.0.0");
  });

  it("defaults to loopback when bind is undefined (non-container)", async () => {
    mockCgroup("12:memory:/user.slice\n");
    const createServerSpy = vi.spyOn(net, "createServer");
    expect(await resolveGatewayBindHost(undefined)).toBe("127.0.0.1");
    expect(createServerSpy).not.toHaveBeenCalled();
  });
});

describe("defaultGatewayBindMode", () => {
  useClearedFlyMachineEnv();

  it("returns loopback on non-container host", () => {
    mockCgroup("12:memory:/user.slice\n");
    expect(defaultGatewayBindMode()).toBe("loopback");
  });

  it.each([
    [undefined, "auto"],
    ["serve", "loopback"],
    ["off", "auto"],
  ] as const)("with tailscale %s, defaults to %s inside a container", (tailscaleMode, expected) => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    expect(defaultGatewayBindMode(tailscaleMode)).toBe(expected);
  });
});

describe("isSecureWebSocketUrl", () => {
  it.each([
    ["wss://remote.example.com:18789", true],
    ["ws://127.0.0.1:18789", true],
    ["ws://localhost:18789", true],
    ["ws://[::1]:18789", true],
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
    ["ws://remote.example.com:18789", false],
    ["ws://1.1.1.1:18789", false],
    ["not-a-url", false],
    ["http://127.0.0.1:18789", true],
    ["https://remote.example.com:18789", true],
    ["http://remote.example.com:18789", false],
  ] as const)("defaults secure websocket behavior for %s", (input, expected) => {
    expect(isSecureWebSocketUrl(input), input).toBe(expected);
  });

  it("allows arbitrary private-dns ws:// hostnames only when opt-in is enabled", () => {
    const input = "ws://gateway.private.example:18789";
    expect(isSecureWebSocketUrl(input), input).toBe(false);
    expect(isSecureWebSocketUrl(input, { allowPrivateWs: true }), input).toBe(true);
  });

  it("still rejects ws:// public IP literals when opt-in is enabled", () => {
    for (const input of ["ws://1.1.1.1:18789", "ws://8.8.8.8:18789", "ws://203.0.113.10:18789"]) {
      expect(isSecureWebSocketUrl(input, { allowPrivateWs: true }), input).toBe(false);
    }
  });

  it("still rejects non-unicast IPv6 ws:// even when opt-in is enabled", () => {
    for (const input of ["ws://[::]:18789", "ws://[0:0::0]:18789", "ws://[ff02::1]:18789"]) {
      expect(isSecureWebSocketUrl(input, { allowPrivateWs: true }), input).toBe(false);
    }
  });
});
