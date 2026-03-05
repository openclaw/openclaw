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

describe("port-defaults", () => {
  it("exports expected default port constants", () => {
    expect(DEFAULT_BRIDGE_PORT).toBe(18790);
    expect(DEFAULT_BROWSER_CONTROL_PORT).toBe(18791);
    expect(DEFAULT_CANVAS_HOST_PORT).toBe(18793);
    expect(DEFAULT_BROWSER_CDP_PORT_RANGE_START).toBe(18800);
    expect(DEFAULT_BROWSER_CDP_PORT_RANGE_END).toBe(18899);
  });

  describe("deriveDefaultBridgePort", () => {
    it("returns gatewayPort + 1 when valid", () => {
      expect(deriveDefaultBridgePort(18789)).toBe(18790);
      expect(deriveDefaultBridgePort(9000)).toBe(9001);
    });

    it("returns DEFAULT_BRIDGE_PORT when derived port (gatewayPort+1) is invalid", () => {
      expect(deriveDefaultBridgePort(-1)).toBe(DEFAULT_BRIDGE_PORT);
      expect(deriveDefaultBridgePort(65535)).toBe(DEFAULT_BRIDGE_PORT);
      expect(deriveDefaultBridgePort(65536)).toBe(DEFAULT_BRIDGE_PORT);
      expect(deriveDefaultBridgePort(Number.NaN)).toBe(DEFAULT_BRIDGE_PORT);
    });
  });

  describe("deriveDefaultBrowserControlPort", () => {
    it("returns gatewayPort + 2 when valid", () => {
      expect(deriveDefaultBrowserControlPort(18789)).toBe(18791);
      expect(deriveDefaultBrowserControlPort(9000)).toBe(9002);
    });

    it("returns DEFAULT_BROWSER_CONTROL_PORT when derived port (gatewayPort+2) is invalid", () => {
      expect(deriveDefaultBrowserControlPort(-2)).toBe(DEFAULT_BROWSER_CONTROL_PORT);
      expect(deriveDefaultBrowserControlPort(65534)).toBe(DEFAULT_BROWSER_CONTROL_PORT);
      expect(deriveDefaultBrowserControlPort(65536)).toBe(DEFAULT_BROWSER_CONTROL_PORT);
    });
  });

  describe("deriveDefaultCanvasHostPort", () => {
    it("returns gatewayPort + 4 when valid", () => {
      expect(deriveDefaultCanvasHostPort(18789)).toBe(18793);
      expect(deriveDefaultCanvasHostPort(9000)).toBe(9004);
    });

    it("returns DEFAULT_CANVAS_HOST_PORT when derived port (gatewayPort+4) is invalid", () => {
      expect(deriveDefaultCanvasHostPort(-4)).toBe(DEFAULT_CANVAS_HOST_PORT);
      expect(deriveDefaultCanvasHostPort(65532)).toBe(DEFAULT_CANVAS_HOST_PORT);
    });
  });

  describe("deriveDefaultBrowserCdpPortRange", () => {
    it("returns range starting at browserControlPort + 9 with expected length", () => {
      const range = deriveDefaultBrowserCdpPortRange(18791);
      expect(range.start).toBe(18800);
      expect(range.end).toBe(18899);
      expect(range.end - range.start).toBe(
        DEFAULT_BROWSER_CDP_PORT_RANGE_END - DEFAULT_BROWSER_CDP_PORT_RANGE_START,
      );
    });

    it("returns valid range for small browserControlPort", () => {
      const range = deriveDefaultBrowserCdpPortRange(100);
      expect(range.start).toBe(109);
      expect(range.end).toBeGreaterThanOrEqual(range.start);
      expect(range.start).toBeGreaterThan(0);
      expect(range.end).toBeLessThanOrEqual(65535);
    });

    it("clamps when derived start would exceed max", () => {
      const range = deriveDefaultBrowserCdpPortRange(70000);
      expect(range.start).toBe(DEFAULT_BROWSER_CDP_PORT_RANGE_START);
      expect(range.end).toBe(DEFAULT_BROWSER_CDP_PORT_RANGE_END);
    });
  });
});
