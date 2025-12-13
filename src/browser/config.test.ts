import { describe, expect, it } from "vitest";
import {
  resolveBrowserConfig,
  shouldStartLocalBrowserServer,
} from "./config.js";

describe("browser config", () => {
  it("defaults to enabled with loopback control url and lobster-orange color", () => {
    const resolved = resolveBrowserConfig(undefined);
    expect(resolved.enabled).toBe(true);
    expect(resolved.controlPort).toBe(18790);
    expect(resolved.cdpPort).toBe(18791);
    expect(resolved.controlHost).toBe("127.0.0.1");
    expect(resolved.color).toBe("#FF4500");
    expect(shouldStartLocalBrowserServer(resolved)).toBe(true);
  });

  it("normalizes hex colors", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://localhost:18790",
      color: "ff4500",
    });
    expect(resolved.color).toBe("#FF4500");
  });

  it("falls back to default color for invalid hex", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://localhost:18790",
      color: "#GGGGGG",
    });
    expect(resolved.color).toBe("#FF4500");
  });

  it("treats non-loopback control urls as remote", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://example.com:18790",
    });
    expect(shouldStartLocalBrowserServer(resolved)).toBe(false);
  });

  it("rejects unsupported protocols", () => {
    expect(() =>
      resolveBrowserConfig({ controlUrl: "ws://127.0.0.1:18790" }),
    ).toThrow(/must be http/i);
  });
});
