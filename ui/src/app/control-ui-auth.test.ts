import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveControlUiAuthCandidates,
  resolveControlUiAuthToken,
  resolveControlUiReadAuthCandidates,
} from "./control-ui-auth.ts";

describe("Control UI credentials", () => {
  it.each([
    {
      name: "orders the device token before saved shared secrets",
      source: {
        hello: { auth: { deviceToken: "device-token" } },
        settings: { token: "shared-token" },
        password: "shared-password",
      },
      expected: ["device-token", "shared-token", "shared-password"],
    },
    {
      name: "keeps the device token for pairing-only browsers",
      source: {
        hello: { auth: { deviceToken: "device-token" } },
        settings: { token: "" },
        password: "",
      },
      expected: ["device-token"],
    },
    {
      name: "trims and deduplicates credentials in priority order",
      source: {
        hello: { auth: { deviceToken: " same-token " } },
        settings: { token: "same-token" },
        password: " password ",
      },
      expected: ["same-token", "password"],
    },
    {
      name: "uses one Bearer candidate when both fields carry the Gateway secret",
      source: {
        settings: { token: "gateway-secret" },
        password: "gateway-secret",
      },
      expected: ["gateway-secret"],
    },
    {
      name: "rejects embedded header newlines before selecting a credential",
      source: {
        hello: { auth: { deviceToken: "bad\ndevice" } },
        settings: { token: "bad\rshared" },
        password: " password ",
      },
      expected: ["password"],
    },
    { name: "accepts missing credentials", source: {}, expected: [] },
    {
      name: "ignores null and blank credentials",
      source: { hello: null, settings: { token: " " }, password: null },
      expected: [],
    },
  ])("$name", ({ source, expected }) => {
    expect(resolveControlUiAuthCandidates(source)).toEqual(expected);
    expect(resolveControlUiAuthToken(source)).toBe(expected[0] ?? null);
  });
});

describe("Gateway read credential selection", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    ["tailscale", "wss://gateway.example/ws", []],
    ["tailscale", "wss://other.example/ws", ["device", "saved"]],
    ["token", "wss://gateway.example/ws", ["device", "saved"]],
    ["device-token", "wss://gateway.example/ws", ["device", "saved"]],
    ["trusted-proxy", "wss://gateway.example/ws", ["device", "saved"]],
    [undefined, "wss://gateway.example/ws", ["device", "saved"]],
  ])("preserves the intended identity for %s through %s", (method, gatewayUrl, expected) => {
    vi.stubGlobal("location", { origin: "https://gateway.example" });
    expect(
      resolveControlUiReadAuthCandidates(
        {
          hello: { auth: { method, deviceToken: "device" } },
          settings: { token: "saved" },
        },
        gatewayUrl,
      ),
    ).toEqual(expected);
  });
});
