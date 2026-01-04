import { describe, expect, it } from "vitest";
import {
  resolveBrowserConfig,
  resolveProfile,
  shouldStartLocalBrowserServer,
} from "./config.js";

describe("browser config", () => {
  it("defaults to enabled with loopback control url and lobster-orange color", () => {
    const resolved = resolveBrowserConfig(undefined);
    expect(resolved.enabled).toBe(true);
    expect(resolved.controlPort).toBe(18791);
    expect(resolved.controlHost).toBe("127.0.0.1");
    expect(resolved.color).toBe("#FF4500");
    expect(shouldStartLocalBrowserServer(resolved)).toBe(true);
    const profile = resolveProfile(resolved, resolved.defaultProfile);
    expect(profile?.cdpPort).toBe(18800);
    expect(profile?.cdpUrl).toBe("http://127.0.0.1:18800");
    expect(profile?.cdpIsLoopback).toBe(true);
  });

  it("normalizes hex colors", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://localhost:18791",
      color: "ff4500",
    });
    expect(resolved.color).toBe("#FF4500");
  });

  it("falls back to default color for invalid hex", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://localhost:18791",
      color: "#GGGGGG",
    });
    expect(resolved.color).toBe("#FF4500");
  });

  it("treats non-loopback control urls as remote", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://example.com:18791",
    });
    expect(shouldStartLocalBrowserServer(resolved)).toBe(false);
  });

  it("derives CDP host/protocol from control url when cdpUrl is unset", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://127.0.0.1:19000",
    });
    expect(resolved.controlPort).toBe(19000);
    expect(resolved.cdpHost).toBe("127.0.0.1");
    expect(resolved.cdpProtocol).toBe("http");
  });

  it("supports explicit CDP URLs for the default profile", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://127.0.0.1:18791",
      cdpUrl: "http://example.com:9222",
    });
    const profile = resolveProfile(resolved, resolved.defaultProfile);
    expect(profile?.cdpPort).toBe(9222);
    expect(profile?.cdpUrl).toBe("http://example.com:9222");
    expect(profile?.cdpIsLoopback).toBe(false);
  });

  it("uses profile cdpUrl when provided", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://127.0.0.1:18791",
      profiles: {
        remote: { cdpUrl: "http://10.0.0.42:9222", color: "#0066CC" },
      },
    });

    const remote = resolveProfile(resolved, "remote");
    expect(remote?.cdpUrl).toBe("http://10.0.0.42:9222");
    expect(remote?.cdpHost).toBe("10.0.0.42");
    expect(remote?.cdpIsLoopback).toBe(false);
  });

  it("uses base protocol for profiles with only cdpPort", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://127.0.0.1:18791",
      cdpUrl: "https://example.com:9443",
      profiles: {
        work: { cdpPort: 18801, color: "#0066CC" },
      },
    });

    const work = resolveProfile(resolved, "work");
    expect(work?.cdpUrl).toBe("https://example.com:18801");
  });

  it("rejects unsupported protocols", () => {
    expect(() =>
      resolveBrowserConfig({ controlUrl: "ws://127.0.0.1:18791" }),
    ).toThrow(/must be http/i);
  });
});
