import { describe, expect, it } from "vitest";
import {
  isLoopbackGatewayUrl,
  shouldOmitGatewayClientDeviceIdentity,
} from "./loopback-shared-auth-identity.js";

describe("isLoopbackGatewayUrl", () => {
  it("recognizes localhost and IPv4 loopback hosts", () => {
    expect(isLoopbackGatewayUrl("ws://localhost:18789")).toBe(true);
    expect(isLoopbackGatewayUrl("ws://127.0.0.1:18789")).toBe(true);
    expect(isLoopbackGatewayUrl("http://127.0.0.1/path")).toBe(true);
  });

  it("recognizes IPv6 loopback in bracketed form", () => {
    expect(isLoopbackGatewayUrl("ws://[::1]:18789")).toBe(true);
    expect(isLoopbackGatewayUrl("ws://[0:0:0:0:0:0:0:1]:18789")).toBe(true);
  });

  it("rejects remote hostnames and IPs", () => {
    expect(isLoopbackGatewayUrl("wss://gateway.example/ws")).toBe(false);
    expect(isLoopbackGatewayUrl("ws://10.0.0.5:18789")).toBe(false);
    expect(isLoopbackGatewayUrl("ws://198.51.100.7:18789")).toBe(false);
  });

  it("returns false for unparseable URLs instead of throwing", () => {
    expect(isLoopbackGatewayUrl("not a url")).toBe(false);
    expect(isLoopbackGatewayUrl("")).toBe(false);
  });
});

describe("shouldOmitGatewayClientDeviceIdentity", () => {
  it("omits identity for loopback URL with a preauth token", () => {
    expect(
      shouldOmitGatewayClientDeviceIdentity({
        url: "ws://127.0.0.1:18789",
        token: "secret",
      }),
    ).toBe(true);
  });

  it("omits identity for loopback URL with a preauth password", () => {
    expect(
      shouldOmitGatewayClientDeviceIdentity({
        url: "ws://localhost:18789",
        password: "secret", // pragma: allowlist secret
      }),
    ).toBe(true);
  });

  it("keeps identity for remote URLs even with shared auth", () => {
    expect(
      shouldOmitGatewayClientDeviceIdentity({
        url: "wss://gateway.example/ws",
        token: "secret",
      }),
    ).toBe(false);
    expect(
      shouldOmitGatewayClientDeviceIdentity({
        url: "wss://gateway.example/ws",
        password: "secret", // pragma: allowlist secret
      }),
    ).toBe(false);
  });

  it("keeps identity for loopback URLs without shared auth", () => {
    expect(
      shouldOmitGatewayClientDeviceIdentity({
        url: "ws://127.0.0.1:18789",
      }),
    ).toBe(false);
    expect(
      shouldOmitGatewayClientDeviceIdentity({
        url: "ws://localhost:18789",
        token: undefined,
        password: undefined,
      }),
    ).toBe(false);
  });
});
