import { describe, expect, it } from "vitest";
import {
  type HostedPluginSurfaceUrlParams,
  resolveHostedPluginSurfaceUrl,
} from "./hosted-plugin-surface-url.js";

describe("resolveHostedPluginSurfaceUrl", () => {
  it.each<[HostedPluginSurfaceUrlParams, string]>([
    [
      {
        requestHost: "10.0.0.2:18900",
        forwardedHost: "gateway.example.com",
        forwardedProto: "https",
      },
      "https://gateway.example.com:443",
    ],
    [
      {
        requestHost: "10.0.0.2:18900",
        forwardedHost: "gateway.example.com:9443",
        forwardedProto: "https",
      },
      "https://gateway.example.com:9443",
    ],
    [
      {
        requestHost: "gateway.example.com:18900",
        scheme: "https",
      },
      "https://gateway.example.com:18900",
    ],
    [{ requestHost: "[2001:db8::1]:18900" }, "http://[2001:db8::1]:18900"],
    [
      {
        requestHost: "192.0.2.1:18900",
        forwardedHost: "[2001:db8::1]:9443",
        forwardedProto: "https",
      },
      "https://[2001:db8::1]:9443",
    ],
    [{ requestHost: "[2001:db8::1]" }, "http://[2001:db8::1]:80"],
    [{ requestHost: "[2001:db8::1]", scheme: "https" }, "https://[2001:db8::1]:443"],
    [
      {
        requestHost: "192.0.2.1:18900",
        forwardedHost: ["[2001:db8::1], ignored.example.com"],
        forwardedProto: ["https"],
      },
      "https://[2001:db8::1]:443",
    ],
    [{ localAddress: "::1" }, "http://[::1]:18900"],
    [
      {
        hostOverride: "2001:db8::2",
        forwardedHost: "[2001:db8::1]:9443",
        forwardedProto: "https",
      },
      "https://[2001:db8::2]:18900",
    ],
    [{ hostOverride: "[2001:db8::2]", scheme: "https" }, "https://[2001:db8::2]:18900"],
    [{ hostOverride: "Gateway.Example.COM." }, "http://Gateway.Example.COM.:18900"],
  ])("%j resolves to %s", (params, expected) => {
    const resolved = resolveHostedPluginSurfaceUrl({ port: 18900, ...params });
    expect(resolved).toBe(expected);
    expect(new URL(resolved ?? "").origin).toBe(new URL(expected).origin);
  });
});
