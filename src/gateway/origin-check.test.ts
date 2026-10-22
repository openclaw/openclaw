import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  checkBrowserOrigin,
  normalizeChromeExtensionOrigin,
  resolveAcceptedBrowserOrigin,
} from "./origin-check.js";

const denied = { ok: false, reason: "origin not allowed" } as const;
const invalid = { ok: false, reason: "origin missing or invalid" } as const;
const privateOrigin = { ok: true, matchedBy: "private-same-origin" } as const;
const allowlisted = { ok: true, matchedBy: "allowlist" } as const;
function browserRequest(origin: string, host = "127.0.0.1:18789") {
  return {
    headers: { host, origin },
    socket: { remoteAddress: "203.0.113.10" },
  } as IncomingMessage;
}

describe("checkBrowserOrigin", () => {
  it.each([
    [
      "http://127.0.0.1:18789",
      { ok: true, matchedBy: "host-header-fallback" },
      { requestHost: "127.0.0.1:18789", allowHostHeaderOriginFallback: true },
    ],
    ["https://gateway.example.com:18789", denied],
    ["http://192.168.0.202:18789", privateOrigin, { requestHost: "192.168.0.202:18789" }],
    [
      "http://peters-mac-studio-1.example.ts.net:18789",
      privateOrigin,
      { requestHost: "peters-mac-studio-1.example.ts.net:18789" },
    ],
    [
      "http://127.0.0.1:18789",
      privateOrigin,
      { requestHost: "127.0.0.1:18789", isLocalClient: true },
    ],
    ["http://127.0.0.1:18789", denied, { requestHost: "127.0.0.1:18789", isLocalClient: false }],
    ["http://[64:ff9b:1::8.8.8.8]:18789", denied, { requestHost: "[64:ff9b:1::8.8.8.8]:18789" }],
    [
      "http://localhost:5173",
      { ok: true, matchedBy: "local-loopback" },
      { requestHost: "127.0.0.1:18789", isLocalClient: true },
    ],
    ["http://localhost:5173", denied, { requestHost: "127.0.0.1:18789", isLocalClient: false }],
    [
      "https://CONTROL.example.com",
      allowlisted,
      { allowedOrigins: [" https://control.example.com "] },
    ],
    [
      "https://any-origin.example.com",
      allowlisted,
      {
        requestHost: "gateway.tailnet.ts.net:18789",
        allowedOrigins: ["https://control.example.com", " * "],
      },
    ],
    ["", invalid],
    ["null", invalid],
    ["not a url", invalid],
    ["https://attacker.example.com", denied],
  ] satisfies [
    string,
    ReturnType<typeof checkBrowserOrigin>,
    Partial<Parameters<typeof checkBrowserOrigin>[0]>?,
  ][])("checks origin %s", (origin, expected, overrides) => {
    expect(
      checkBrowserOrigin({ requestHost: "gateway.example.com:18789", origin, ...overrides }),
    ).toEqual(expected);
  });

  it.each(["chrome-extension://abcdefghijklmnop", "tauri://localhost"])(
    "accepts an exactly allowlisted hosted app origin: %s",
    (origin) => {
      expect(checkBrowserOrigin({ origin, allowedOrigins: [origin] })).toEqual(allowlisted);
    },
  );

  it.each([
    "tauri://localhost/path",
    "tauri://localhost/admin/..",
    "tauri://localhost/%2e",
    "https://control.example.com\\admin",
    "tauri://localhost?mode=admin",
    "tauri://localhost#admin",
    "tauri://user@localhost",
    "file:///tmp/openclaw.html",
    "data:text/plain,hello",
  ])("rejects a non-origin URL value: %s", (origin) => {
    expect(checkBrowserOrigin({ origin, allowedOrigins: [origin] })).toEqual(invalid);
  });

  it("recognizes only canonical Chrome extension origins", () => {
    const extension = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    expect(normalizeChromeExtensionOrigin(extension)).toBe(extension);
    expect(normalizeChromeExtensionOrigin("chrome-extension://abc")).toBeUndefined();
    expect(
      normalizeChromeExtensionOrigin("https://abcdefghijklmnopabcdefghijklmnop"),
    ).toBeUndefined();
  });
});

describe("resolveAcceptedBrowserOrigin", () => {
  const gateway = "https://gateway.example.com";
  const other = "https://other.example.com";
  it.each([
    { allowedOrigins: undefined, origin: gateway, accepted: true },
    { allowedOrigins: undefined, origin: other, accepted: false },
    { allowedOrigins: [], origin: gateway, accepted: false },
    { allowedOrigins: [other], origin: gateway, accepted: false },
    { allowedOrigins: [other], origin: other, accepted: true },
  ])("uses the effective configured origin policy: %j", ({ allowedOrigins, origin, accepted }) => {
    expect(
      resolveAcceptedBrowserOrigin({
        req: browserRequest(origin),
        cfg: {
          gateway: {
            publicOrigin: "https://GATEWAY.example.com:443/",
            controlUi: { allowedOrigins },
          },
        },
      }),
    ).toBe(accepted ? origin : undefined);
  });

  it("applies the configured Host-header fallback through the canonical request resolver", () => {
    const origin = "https://gateway.example.com:18789";
    const req = browserRequest(origin, "gateway.example.com:18789");

    expect(
      resolveAcceptedBrowserOrigin({
        req,
        cfg: {
          gateway: {
            controlUi: { dangerouslyAllowHostHeaderOriginFallback: true },
          },
        },
      }),
    ).toBe(origin);
    expect(resolveAcceptedBrowserOrigin({ req, cfg: {} })).toBeUndefined();
  });
});
