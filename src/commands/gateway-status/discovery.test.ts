import { describe, expect, it, vi } from "vitest";
import {
  buildSshTarget,
  inferSshTargetFromRemoteUrl,
  pickAutoSshTargetFromDiscovery,
} from "./discovery.js";

describe("inferSshTargetFromRemoteUrl", () => {
  it("extracts host from a wss:// URL and prepends USER", () => {
    vi.stubEnv("USER", "alice");
    expect(inferSshTargetFromRemoteUrl("wss://gateway.example.com:18789")).toBe(
      "alice@gateway.example.com",
    );
    vi.unstubAllEnvs();
  });

  it("returns host only when USER is empty", () => {
    vi.stubEnv("USER", "");
    expect(inferSshTargetFromRemoteUrl("wss://gateway.example.com:18789")).toBe(
      "gateway.example.com",
    );
    vi.unstubAllEnvs();
  });

  it("returns null for non-string input", () => {
    expect(inferSshTargetFromRemoteUrl(undefined)).toBeNull();
    expect(inferSshTargetFromRemoteUrl(null)).toBeNull();
  });

  it("returns null for empty or whitespace string", () => {
    expect(inferSshTargetFromRemoteUrl("")).toBeNull();
    expect(inferSshTargetFromRemoteUrl("   ")).toBeNull();
  });

  it("returns null for malformed URL", () => {
    expect(inferSshTargetFromRemoteUrl("not-a-url")).toBeNull();
  });
});

describe("buildSshTarget", () => {
  it("builds user@host for standard input", () => {
    expect(buildSshTarget({ user: "alice", host: "gw.example.com" })).toBe("alice@gw.example.com");
  });

  it("returns host only when user is empty", () => {
    expect(buildSshTarget({ host: "gw.example.com" })).toBe("gw.example.com");
  });

  it("appends non-22 port", () => {
    expect(buildSshTarget({ user: "alice", host: "gw.example.com", port: 2222 })).toBe(
      "alice@gw.example.com:2222",
    );
  });

  it("omits port when it is 22", () => {
    expect(buildSshTarget({ user: "alice", host: "gw.example.com", port: 22 })).toBe(
      "alice@gw.example.com",
    );
  });

  it("returns null when host is missing", () => {
    expect(buildSshTarget({})).toBeNull();
    expect(buildSshTarget({ user: "alice" })).toBeNull();
  });

  it("returns null when host is whitespace", () => {
    expect(buildSshTarget({ host: "  " })).toBeNull();
  });

  it("trims user and host whitespace", () => {
    expect(buildSshTarget({ user: "  alice  ", host: "  gw.example.com  " })).toBe(
      "alice@gw.example.com",
    );
  });
});

describe("pickAutoSshTargetFromDiscovery", () => {
  const makeBeacon = (host: string, port: number) =>
    ({
      instanceName: "test",
      displayName: "Test Gateway",
      domain: "local.",
      host,
      port,
      addresses: [host],
      txt: {},
    }) as Parameters<typeof pickAutoSshTargetFromDiscovery>[0]["discovery"][0];

  it("returns the first beacon whose sshTarget parses successfully", () => {
    const result = pickAutoSshTargetFromDiscovery({
      discovery: [makeBeacon("192.168.1.10", 18789)],
      parseSshTarget: (t) => (typeof t === "string" && t.length > 0 ? { host: t } : null),
      sshUser: "alice",
    });
    expect(result).toEqual(expect.any(String));
    expect(result).toContain("192.168.1.10");
  });

  it("returns null when discovery list is empty", () => {
    expect(
      pickAutoSshTargetFromDiscovery({
        discovery: [],
        parseSshTarget: () => ({}),
      }),
    ).toBeNull();
  });

  it("skips beacons whose sshTarget fails to parse", () => {
    const result = pickAutoSshTargetFromDiscovery({
      discovery: [makeBeacon("192.168.1.10", 18789), makeBeacon("192.168.1.20", 18789)],
      parseSshTarget: (t) =>
        typeof t === "string" && t.includes("192.168.1.20") ? { host: t } : null,
      sshUser: "bob",
    });
    expect(result).toContain("192.168.1.20");
  });

  it("returns null when no beacons produce a valid sshTarget", () => {
    const result = pickAutoSshTargetFromDiscovery({
      discovery: [makeBeacon("host1", 18789)],
      parseSshTarget: () => null,
    });
    expect(result).toBeNull();
  });
});
