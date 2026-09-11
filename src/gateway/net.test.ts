// Gateway net tests cover bind-host selection, loopback/private host detection,
// trusted proxy IP resolution, container defaults, and interface matching.
import net from "node:net";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetContainerEnvironmentCacheForTest } from "../infra/container-environment.js";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  defaultGatewayBindMode,
  isContainerEnvironment,
  isLocalishHost,
  isLoopbackGatewayUrl,
  isLoopbackHost,
  isPrivateOrLoopbackAddress,
  isPrivateOrLoopbackHost,
  isSecureWebSocketUrl,
  isTrustedProxyAddress,
  pickPrimaryLanIPv4,
  resolveLocalInterfaceAddressMatch,
  resolveClientIp,
  resolveGatewayBindHost,
  resolveGatewayListenHosts,
  resolveGatewayRequiredListenHosts,
  resolveHostName,
} from "./net.js";

const flyMachineEnvKeys = ["FLY_MACHINE_ID", "FLY_APP_NAME"] as const;

function clearFlyMachineEnvForTest(): () => void {
  const envSnapshot = captureEnv([...flyMachineEnvKeys]);
  for (const key of flyMachineEnvKeys) {
    deleteTestEnvValue(key);
  }

  return () => envSnapshot.restore();
}

function useClearedFlyMachineEnv() {
  let restoreFlyMachineEnv: (() => void) | undefined;

  beforeEach(() => {
    restoreFlyMachineEnv = clearFlyMachineEnvForTest();
  });

  afterEach(() => {
    restoreFlyMachineEnv?.();
    restoreFlyMachineEnv = undefined;
  });
}

describe("resolveHostName", () => {
  it.each([
    ["localhost:18789", "localhost"],
    ["127.0.0.1:18789", "127.0.0.1"],
    ["[::1]:18789", "::1"],
    ["::1", "::1"],
  ] as const)("normalizes host form for %s", (input, expected) => {
    expect(resolveHostName(input), input).toBe(expected);
  });
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

describe("isLoopbackHost", () => {
  it("accepts localhost absolute-form hostnames", () => {
    expect(isLoopbackHost("localhost.")).toBe(true);
    expect(isLoopbackHost("LOCALHOST...")).toBe(true);
  });
});

describe("isLoopbackGatewayUrl", () => {
  it.each([
    ["ws://LOCALHOST:18789", true],
    ["ws://localhost.:18789", false],
    ["ws://127.42.0.1:18789", true],
    ["ws://[::1]:18789", true],
    ["ws://[0:0:0:0:0:0:0:1]:18789", true],
    ["ws://[::ffff:127.0.0.1]:18789", true],
    ["ws://192.168.1.2:18789", false],
    ["not-a-url", false],
    ["/relative", false],
    ["http://localhost:18789", true],
    ["https://localhost:18789", true],
  ] as const)("classifies %s as %s", (url, expected) => {
    expect(isLoopbackGatewayUrl(url)).toBe(expected);
  });
});

describe("isTrustedProxyAddress", () => {
  it.each([
    ["matches exact IP entries", "192.168.1.1", ["192.168.1.1"], true],
    ["rejects non-matching exact IP entries", "192.168.1.2", ["192.168.1.1"], false],
    [
      "matches one of multiple exact entries",
      "10.0.0.5",
      ["192.168.1.1", "10.0.0.5", "172.16.0.1"],
      true,
    ],
    ["ignores surrounding whitespace in exact IP entries", "10.0.0.5", [" 10.0.0.5 "], true],
    ["matches /24 CIDR entries", "10.42.0.59", ["10.42.0.0/24"], true],
    ["rejects IPs outside /24 CIDR entries", "10.42.1.1", ["10.42.0.0/24"], false],
    ["matches /16 CIDR entries", "172.19.255.255", ["172.19.0.0/16"], true],
    ["rejects IPs outside /16 CIDR entries", "172.20.0.1", ["172.19.0.0/16"], false],
    ["treats /32 as a single-IP CIDR", "10.42.0.0", ["10.42.0.0/32"], true],
    ["rejects non-matching /32 CIDR entries", "10.42.0.1", ["10.42.0.0/32"], false],
    [
      "handles mixed exact IP and CIDR entries",
      "172.19.5.100",
      ["192.168.1.1", "10.42.0.0/24", "172.19.0.0/16"],
      true,
    ],
    [
      "rejects IPs missing from mixed exact IP and CIDR entries",
      "10.43.0.1",
      ["192.168.1.1", "10.42.0.0/24", "172.19.0.0/16"],
      false,
    ],
    ["supports IPv6 CIDR notation", "2001:db8::1234", ["2001:db8::/32"], true],
    [
      "rejects IPv6 addresses outside the configured CIDR",
      "2001:db9::1234",
      ["2001:db8::/32"],
      false,
    ],
    ["preserves exact matching behavior for plain IP entries", "10.42.0.59", ["10.42.0.1"], false],
    ["normalizes IPv4-mapped IPv6 addresses", "::ffff:192.168.1.1", ["192.168.1.1"], true],
    ["returns false when IP is undefined", undefined, ["192.168.1.1"], false],
    ["returns false when trusted proxies are undefined", "192.168.1.1", undefined, false],
    ["returns false when trusted proxies are empty", "192.168.1.1", [], false],
    [
      "rejects invalid CIDR prefixes and addresses",
      "10.42.0.59",
      ["10.42.0.0/33", "10.42.0.0/-1", "invalid/24", "2001:db8::/129"],
      false,
    ],
    ["ignores surrounding whitespace in CIDR entries", "10.42.0.59", [" 10.42.0.0/24 "], true],
    ["ignores blank trusted proxy entries", "10.0.0.5", [" ", "10.0.0.5", ""], true],
    ["treats all-blank trusted proxy entries as no match", "10.0.0.5", [" ", "\t"], false],
  ])("%s", (_name, ip, trustedProxies, expected) => {
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
    [
      "returns remote IP when remote is not trusted proxy",
      "203.0.113.10",
      "10.0.0.2",
      ["127.0.0.1"],
      "203.0.113.10",
      undefined,
      undefined,
    ],
    [
      "uses right-most untrusted X-Forwarded-For hop",
      "127.0.0.1",
      "198.51.100.99, 10.0.0.9, 127.0.0.1",
      ["127.0.0.1"],
      "10.0.0.9",
      undefined,
      undefined,
    ],
    [
      "ignores spoofed loopback X-Forwarded-For hops from trusted proxies",
      "10.0.0.50",
      "127.0.0.1",
      ["10.0.0.0/8"],
      undefined,
      undefined,
      undefined,
    ],
    [
      "fails closed when all X-Forwarded-For hops are trusted proxies",
      "127.0.0.1",
      "127.0.0.1, ::1",
      ["127.0.0.1", "::1"],
      undefined,
      undefined,
      undefined,
    ],
    [
      "fails closed when all non-loopback X-Forwarded-For hops are trusted proxies",
      "10.0.0.50",
      "10.0.0.2, 10.0.0.1",
      ["10.0.0.0/8"],
      undefined,
      undefined,
      undefined,
    ],
    [
      "fails closed when trusted proxy omits forwarding headers",
      "127.0.0.1",
      undefined,
      ["127.0.0.1"],
      undefined,
      undefined,
      undefined,
    ],
    [
      "ignores invalid X-Forwarded-For entries",
      "127.0.0.1",
      "garbage, 10.0.0.999",
      ["127.0.0.1"],
      undefined,
      undefined,
      undefined,
    ],
    [
      "does not trust X-Real-IP by default",
      "127.0.0.1",
      undefined,
      ["127.0.0.1"],
      undefined,
      "[2001:db8::5]",
      undefined,
    ],
    [
      "uses X-Real-IP only when explicitly enabled",
      "127.0.0.1",
      undefined,
      ["127.0.0.1"],
      "2001:db8::5",
      "[2001:db8::5]",
      true,
    ],
    [
      "ignores invalid X-Real-IP even when fallback enabled",
      "127.0.0.1",
      undefined,
      ["127.0.0.1"],
      undefined,
      "not-an-ip",
      true,
    ],
  ])(
    "%s",
    (_name, remoteAddr, forwardedFor, trustedProxies, expected, realIp, allowRealIpFallback) => {
      const ip = resolveClientIp({
        remoteAddr,
        forwardedFor,
        realIp,
        trustedProxies,
        allowRealIpFallback,
      });
      expect(ip).toBe(expected);
    },
  );
});

describe("resolveGatewayListenHosts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [
      "non-loopback host passthrough",
      "0.0.0.0",
      async (): Promise<boolean> => {
        throw new Error("should not be called");
      },
      ["0.0.0.0"],
    ],
    [
      "IPv6 host passthrough",
      "::1",
      async (): Promise<boolean> => {
        throw new Error("should not be called");
      },
      ["::1"],
    ],
    [
      "specific non-loopback host with loopback alias available",
      "100.64.0.1",
      async (): Promise<boolean> => {
        throw new Error("should not be called");
      },
      ["100.64.0.1", "127.0.0.1"],
    ],
    [
      "loopback with IPv6 available",
      "127.0.0.1",
      async (): Promise<boolean> => true,
      ["127.0.0.1", "::1"],
    ],
    [
      "loopback with IPv6 unavailable",
      "127.0.0.1",
      async (): Promise<boolean> => false,
      ["127.0.0.1"],
    ],
  ] as const)("resolves listen hosts: %s", async (_name, host, canBindToHost, expected) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const hosts = await resolveGatewayListenHosts(host, {
      canBindToHost,
    });
    expect(hosts).toEqual(expected);
  });

  it("skips ::1 on Windows even when IPv6 is bindable", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const canBindToHost = vi.fn().mockResolvedValue(true);
    const hosts = await resolveGatewayListenHosts("127.0.0.1", { canBindToHost });
    expect(hosts).toEqual(["127.0.0.1"]);
    expect(canBindToHost).not.toHaveBeenCalled();
  });

  it("still adds the IPv4 loopback alias for a specific host on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const canBindToHost = vi.fn().mockResolvedValue(true);
    const hosts = await resolveGatewayListenHosts("100.64.0.1", { canBindToHost });
    expect(hosts).toEqual(["100.64.0.1", "127.0.0.1"]);
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

describe("resolveGatewayRequiredListenHosts", () => {
  it.each([
    ["127.0.0.1", ["127.0.0.1"]],
    ["0.0.0.0", ["0.0.0.0"]],
    ["::1", ["::1"]],
    ["100.64.0.1", ["100.64.0.1", "127.0.0.1"]],
  ])("returns required startup hosts for %s", (host, expected) => {
    expect(resolveGatewayRequiredListenHosts(host)).toEqual(expected);
  });
});

describe("pickPrimaryLanIPv4", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [
      "prefers en0",
      makeNetworkInterfacesSnapshot({
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        en0: [{ address: "192.168.1.42", family: "IPv4" }],
      }),
      "192.168.1.42",
    ],
    [
      "falls back to eth0",
      makeNetworkInterfacesSnapshot({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [{ address: "10.0.0.5", family: "IPv4" }],
      }),
      "10.0.0.5",
    ],
    [
      "falls back to any non-internal interface",
      makeNetworkInterfacesSnapshot({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        wlan0: [{ address: "172.16.0.99", family: "IPv4" }],
      }),
      "172.16.0.99",
    ],
    [
      "no non-internal interface",
      makeNetworkInterfacesSnapshot({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      }),
      undefined,
    ],
  ] as const)(
    "prefers en0, then eth0, then any non-internal IPv4: %s",
    (_name, interfaces, expected) => {
      vi.spyOn(os, "networkInterfaces").mockReturnValue(interfaces);
      expect(pickPrimaryLanIPv4()).toBe(expected);
    },
  );

  it("throws when interface discovery throws", () => {
    vi.spyOn(os, "networkInterfaces").mockImplementation(() => {
      throw new Error("uv_interface_addresses failed");
    });
    expect(() => pickPrimaryLanIPv4()).toThrow("uv_interface_addresses failed");
  });
});

describe("isPrivateOrLoopbackAddress", () => {
  it("accepts loopback, private, link-local, and cgnat ranges", () => {
    const accepted = [
      "127.0.0.1",
      "::1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.0.1",
      "169.254.10.20",
      "100.64.0.1",
      "100.127.255.254",
      "::ffff:100.100.100.100",
      "fc00::1",
      "fd12:3456:789a::1",
      "fe80::1",
      "fe9a::1",
      "febb::1",
    ];
    for (const ip of accepted) {
      expect(isPrivateOrLoopbackAddress(ip)).toBe(true);
    }
  });

  it("rejects public IP addresses", () => {
    const rejected = [
      "1.1.1.1",
      "8.8.8.8",
      "172.32.0.1",
      "203.0.113.10",
      "2001:4860:4860::8888",
      "64:ff9b:1::8.8.8.8",
    ];
    for (const ip of rejected) {
      expect(isPrivateOrLoopbackAddress(ip)).toBe(false);
    }
  });
});

describe("isPrivateOrLoopbackHost", () => {
  it("accepts localhost", () => {
    expect(isPrivateOrLoopbackHost("localhost")).toBe(true);
    expect(isPrivateOrLoopbackHost("localhost.")).toBe(true);
  });

  it("accepts loopback addresses", () => {
    expect(isPrivateOrLoopbackHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("[::1]")).toBe(true);
  });

  it("accepts RFC 1918 private addresses", () => {
    expect(isPrivateOrLoopbackHost("10.0.0.5")).toBe(true);
    expect(isPrivateOrLoopbackHost("10.42.1.100")).toBe(true);
    expect(isPrivateOrLoopbackHost("172.16.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("172.31.255.254")).toBe(true);
    expect(isPrivateOrLoopbackHost("192.168.1.100")).toBe(true);
  });

  it("accepts CGNAT and link-local addresses", () => {
    expect(isPrivateOrLoopbackHost("100.64.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("169.254.10.20")).toBe(true);
  });

  it("accepts IPv6 private addresses", () => {
    expect(isPrivateOrLoopbackHost("[fc00::1]")).toBe(true);
    expect(isPrivateOrLoopbackHost("[fd12:3456:789a::1]")).toBe(true);
    expect(isPrivateOrLoopbackHost("[fe80::1]")).toBe(true);
  });

  it("rejects unspecified IPv6 address (::)", () => {
    expect(isPrivateOrLoopbackHost("[::]")).toBe(false);
    expect(isPrivateOrLoopbackHost("::")).toBe(false);
    expect(isPrivateOrLoopbackHost("0:0::0")).toBe(false);
    expect(isPrivateOrLoopbackHost("[0:0::0]")).toBe(false);
    expect(isPrivateOrLoopbackHost("[0000:0000:0000:0000:0000:0000:0000:0000]")).toBe(false);
  });

  it("rejects multicast IPv6 addresses (ff00::/8)", () => {
    expect(isPrivateOrLoopbackHost("[ff02::1]")).toBe(false);
    expect(isPrivateOrLoopbackHost("[ff05::2]")).toBe(false);
    expect(isPrivateOrLoopbackHost("[ff0e::1]")).toBe(false);
  });

  it("rejects public host addresses", () => {
    expect(isPrivateOrLoopbackHost("1.1.1.1")).toBe(false);
    expect(isPrivateOrLoopbackHost("8.8.8.8")).toBe(false);
    expect(isPrivateOrLoopbackHost("203.0.113.10")).toBe(false);
    expect(isPrivateOrLoopbackHost("[64:ff9b:1::8.8.8.8]")).toBe(false);
  });

  it("rejects empty/falsy input", () => {
    expect(isPrivateOrLoopbackHost("")).toBe(false);
  });
});

describe("isContainerEnvironment", () => {
  useClearedFlyMachineEnv();

  afterEach(() => {
    resetContainerEnvironmentCacheForTest();
    vi.restoreAllMocks();
  });

  it("returns false on a typical non-container host", () => {
    // Mock fs.accessSync to throw (no /.dockerenv) and fs.readFileSync to
    // return a cgroup file without container markers.
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("12:memory:/user.slice/user-1000.slice\n");
    expect(isContainerEnvironment()).toBe(false);
  });

  it("returns true when /.dockerenv exists", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    expect(isContainerEnvironment()).toBe(true);
  });

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
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("10:cpuset:/\n9:perf_event:/\n8:memory:/\n0::/\n");

    setTestEnvValue("FLY_MACHINE_ID", "3d8d5459a03038");
    setTestEnvValue("FLY_APP_NAME", "openclaw-test");
    expect(isContainerEnvironment()).toBe(true);
  });

  it("returns true when /proc/1/cgroup contains docker marker", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("12:memory:/docker/abc123def456\n");
    expect(isContainerEnvironment()).toBe(true);
  });

  it("returns true when /proc/1/cgroup contains kubepods marker", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("11:cpuset:/kubepods/besteffort/pod-abc\n");
    expect(isContainerEnvironment()).toBe(true);
  });

  it("returns true when /proc/1/cgroup contains containerd with container ID", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      "0::/system.slice/containerd/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\n",
    );
    expect(isContainerEnvironment()).toBe(true);
  });

  it("returns false when /proc/1/cgroup contains containerd.service (host machine)", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("0::/system.slice/containerd.service\n");
    expect(isContainerEnvironment()).toBe(false);
  });

  it("returns true for cgroup v2 kubepods.slice path", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      "0::/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod123.slice/cri-containerd-abc123.scope\n",
    );
    expect(isContainerEnvironment()).toBe(true);
  });

  it("returns true for cgroup v2 cri-containerd scope path", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      "0::/system.slice/cri-containerd-a1b2c3d4e5f6.scope\n",
    );
    expect(isContainerEnvironment()).toBe(true);
  });

  it("caches the result across calls", () => {
    const fs = require("node:fs");
    const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    expect(isContainerEnvironment()).toBe(true);
    expect(isContainerEnvironment()).toBe(true);
    // accessSync should only be called once due to caching
    expect(accessSpy).toHaveBeenCalledTimes(1);
  });
});

describe("resolveGatewayBindHost", () => {
  useClearedFlyMachineEnv();

  afterEach(() => {
    resetContainerEnvironmentCacheForTest();
    vi.restoreAllMocks();
  });

  it("returns 127.0.0.1 for loopback mode", async () => {
    const createServerSpy = vi.spyOn(net, "createServer");
    expect(await resolveGatewayBindHost("loopback")).toBe("127.0.0.1");
    expect(createServerSpy).not.toHaveBeenCalled();
  });

  it("returns 0.0.0.0 for lan mode", async () => {
    expect(await resolveGatewayBindHost("lan")).toBe("0.0.0.0");
  });

  it("returns 127.0.0.1 for auto mode on non-container host", async () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("12:memory:/user.slice\n");
    expect(await resolveGatewayBindHost("auto")).toBe("127.0.0.1");
  });

  it("returns 0.0.0.0 for auto mode inside a container", async () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    expect(await resolveGatewayBindHost("auto")).toBe("0.0.0.0");
  });

  it("defaults to loopback when bind is undefined (non-container)", async () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("12:memory:/user.slice\n");
    expect(await resolveGatewayBindHost(undefined)).toBe("127.0.0.1");
  });
});

describe("defaultGatewayBindMode", () => {
  useClearedFlyMachineEnv();

  afterEach(() => {
    resetContainerEnvironmentCacheForTest();
    vi.restoreAllMocks();
  });

  it("returns loopback on non-container host", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("12:memory:/user.slice\n");
    expect(defaultGatewayBindMode()).toBe("loopback");
  });

  it("returns auto inside a container", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    expect(defaultGatewayBindMode()).toBe("auto");
  });

  it("returns loopback inside a container when tailscale serve is active", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    expect(defaultGatewayBindMode("serve")).toBe("loopback");
  });

  it("returns loopback inside a container when tailscale funnel is active", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    expect(defaultGatewayBindMode("funnel")).toBe("loopback");
  });

  it("returns auto inside a container when tailscale is off", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    expect(defaultGatewayBindMode("off")).toBe("auto");
  });
});

describe("isSecureWebSocketUrl", () => {
  it.each([
    // wss:// always accepted
    ["wss://127.0.0.1:18789", true],
    ["wss://localhost:18789", true],
    ["wss://remote.example.com:18789", true],
    ["wss://192.168.1.100:18789", true],
    // ws:// loopback accepted
    ["ws://127.0.0.1:18789", true],
    ["ws://localhost:18789", true],
    ["ws://[::1]:18789", true],
    ["ws://127.0.0.42:18789", true],
    // ws:// trusted LAN/Tailnet endpoints accepted
    ["ws://10.0.0.5:18789", true],
    ["ws://10.42.1.100:18789", true],
    ["ws://172.16.0.1:18789", true],
    ["ws://172.31.255.254:18789", true],
    ["ws://192.168.1.100:18789", true],
    ["ws://169.254.10.20:18789", true],
    ["ws://100.64.0.1:18789", true],
    ["ws://[fc00::1]:18789", true],
    ["ws://[fd12:3456:789a::1]:18789", true],
    ["ws://[fe80::1]:18789", true],
    ["ws://gateway.local:18789", true],
    ["ws://machine.tail123.ts.net:18789", true],
    ["ws://[::]:18789", false],
    ["ws://[ff02::1]:18789", false],
    // ws:// public addresses rejected
    ["ws://remote.example.com:18789", false],
    ["ws://1.1.1.1:18789", false],
    ["ws://8.8.8.8:18789", false],
    ["ws://203.0.113.10:18789", false],
    // invalid URLs
    ["not-a-url", false],
    ["", false],
    ["http://127.0.0.1:18789", true],
    ["https://127.0.0.1:18789", true],
    ["https://remote.example.com:18789", true],
    ["http://remote.example.com:18789", false],
  ] as const)("defaults secure websocket behavior for %s", (input, expected) => {
    expect(isSecureWebSocketUrl(input), input).toBe(expected);
  });

  it("allows arbitrary private-dns ws:// hostnames only when opt-in is enabled", () => {
    const allowedWhenOptedIn = ["ws://gateway.private.example:18789"];

    for (const input of allowedWhenOptedIn) {
      expect(isSecureWebSocketUrl(input), input).toBe(false);
      expect(isSecureWebSocketUrl(input, { allowPrivateWs: true }), input).toBe(true);
    }
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
