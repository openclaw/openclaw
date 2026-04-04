import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRIDGE_PORT,
  DEFAULT_BROWSER_CONTROL_PORT,
  DEFAULT_CANVAS_HOST_PORT,
  DEFAULT_BROWSER_CDP_PORT_RANGE_START,
  DEFAULT_BROWSER_CDP_PORT_RANGE_END,
  deriveDefaultBridgePort,
  deriveDefaultBrowserControlPort,
  deriveDefaultCanvasHostPort,
  deriveDefaultBrowserCdpPortRange,
} from "./port-defaults.js";

describe("port defaults", () => {
  it("has correct default values", () => {
    expect(DEFAULT_BRIDGE_PORT).toBe(18790);
    expect(DEFAULT_BROWSER_CONTROL_PORT).toBe(18791);
    expect(DEFAULT_CANVAS_HOST_PORT).toBe(18793);
    expect(DEFAULT_BROWSER_CDP_PORT_RANGE_START).toBe(18800);
    expect(DEFAULT_BROWSER_CDP_PORT_RANGE_END).toBe(18899);
  });
});

describe("deriveDefaultBridgePort", () => {
  it("adds 1 to gateway port", () => {
    expect(deriveDefaultBridgePort(18789)).toBe(18790);
    expect(deriveDefaultBridgePort(8080)).toBe(8081);
  });

  it("falls back to DEFAULT_BRIDGE_PORT for invalid gateway port", () => {
    expect(deriveDefaultBridgePort(0)).toBe(DEFAULT_BRIDGE_PORT);
    expect(deriveDefaultBridgePort(-1)).toBe(DEFAULT_BRIDGE_PORT);
    expect(deriveDefaultBridgePort(70000)).toBe(DEFAULT_BRIDGE_PORT);
  });
});

describe("deriveDefaultBrowserControlPort", () => {
  it("adds 2 to gateway port", () => {
    expect(deriveDefaultBrowserControlPort(18789)).toBe(18791);
    expect(deriveDefaultBrowserControlPort(8080)).toBe(8082);
  });

  it("falls back for invalid gateway port", () => {
    expect(deriveDefaultBrowserControlPort(0)).toBe(DEFAULT_BROWSER_CONTROL_PORT);
    expect(deriveDefaultBrowserControlPort(NaN)).toBe(DEFAULT_BROWSER_CONTROL_PORT);
  });
});

describe("deriveDefaultCanvasHostPort", () => {
  it("adds 4 to gateway port", () => {
    expect(deriveDefaultCanvasHostPort(18789)).toBe(18793);
    expect(deriveDefaultCanvasHostPort(8080)).toBe(8084);
  });

  it("falls back for invalid gateway port", () => {
    expect(deriveDefaultCanvasHostPort(-100)).toBe(DEFAULT_CANVAS_HOST_PORT);
  });
});

describe("deriveDefaultBrowserCdpPortRange", () => {
  it("derives correct range from browser control port", () => {
    const range = deriveDefaultBrowserCdpPortRange(18791);
    expect(range.start).toBe(18800);
    expect(range.end).toBe(18899);
  });

  it("shifts range with browser control port", () => {
    const range = deriveDefaultBrowserCdpPortRange(18781);
    expect(range.start).toBe(18800 - 10);
    expect(range.end).toBe(18899 - 10);
  });

  it("handles overflow by clamping end to start", () => {
    const range = deriveDefaultBrowserCdpPortRange(65530);
    expect(range.end).toBeLessThanOrEqual(range.start);
  });
});
