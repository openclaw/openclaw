// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes as Codes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { resolveGatewayCredentialsForUrlEdit } from "../app/settings.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  resolveAuthHintKind,
  resolvePairingHint,
  shouldShowInsecureContextHint,
} from "./connection-hints.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const credentials = { token: "abc123", password: "secret" };
const endpoint = "wss://gateway.example/openclaw";
const otherEndpoint = "wss://other-gateway.example/openclaw";
const editCredentials = (from: string, to: string) =>
  resolveGatewayCredentialsForUrlEdit(from, to, credentials);
const authHint = (overrides: Partial<Parameters<typeof resolveAuthHintKind>[0]>) =>
  resolveAuthHintKind({
    connected: false,
    lastError: "disconnected (4008): connect failed",
    hasToken: false,
    hasPassword: false,
    ...overrides,
  });
const unauthorized = "unauthorized";
const pairingRequired = { kind: "pairing-required", requestId: null };
const identityHeaderRequired = Codes.AUTH_IDENTITY_HEADER_REQUIRED;

describe("resolveGatewayCredentialsForUrlEdit", () => {
  it.each([
    [endpoint, ` ${endpoint}/ `, { token: "abc123", password: "secret" }],
    [`${endpoint}?tenant=first`, `${endpoint}?tenant=second`, { token: "abc123", password: "" }],
  ] as const)("preserves only credentials scoped to %s -> %s", (from, to, expected) => {
    expect(editCredentials(from, to)).toEqual(expected);
  });

  it("loads a scoped token and clears the password when the gateway endpoint changes", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    sessionStorage.setItem(`openclaw.control.token.v1:${otherEndpoint}`, "other-token");

    expect(editCredentials(endpoint, `${otherEndpoint}/`)).toEqual({
      token: "other-token",
      password: "",
    });
  });

  it("does not restore legacy durable tokens when the gateway endpoint changes", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({ gatewayUrl: otherEndpoint, token: "gateway-token" }),
    );

    expect(editCredentials(endpoint, otherEndpoint)).toEqual({ token: "", password: "" });
  });
});

it.each([
  ["Pairing Required", undefined, pairingRequired],
  ["disconnected (4008): connect failed", Codes.PAIRING_REQUIRED, pairingRequired],
  [null, undefined, null],
  ["disconnected (1006): no reason", undefined, null],
  [
    "scope upgrade pending approval (requestId: req-123)",
    Codes.PAIRING_REQUIRED,
    { kind: "scope-upgrade-pending", requestId: "req-123" },
  ],
] as const)("resolves pairing hint for %s (%s)", (lastError, lastErrorCode, expected) => {
  expect(resolvePairingHint(lastError, lastErrorCode)).toEqual(expected);
});

describe("resolveAuthHintKind", () => {
  it.each([
    [Codes.AUTH_TOKEN_MISSING, {}, "required"],
    [Codes.AUTH_DEVICE_TOKEN_MISMATCH, {}, "required"],
    [Codes.AUTH_TOKEN_MISMATCH, { hasToken: true }, "failed"],
    [Codes.AUTH_BOOTSTRAP_TOKEN_INVALID, {}, "failed"],
    [Codes.AUTH_DEVICE_TOKEN_MISMATCH, { hasToken: true }, "failed"],
    [identityHeaderRequired, { lastError: unauthorized }, "trusted-proxy"],
    [
      identityHeaderRequired,
      { lastError: "connect failed", hasToken: true, hasPassword: true },
      "trusted-proxy",
    ],
    [identityHeaderRequired, { connected: true, lastError: unauthorized }, null],
    [identityHeaderRequired, { lastError: null }, null],
    [Codes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED, { lastError: unauthorized, hasToken: true }, null],
    ["UNKNOWN_CONNECT_ERROR", { lastError: unauthorized, hasToken: true }, null],
    [null, { lastError: "disconnected (4008): unauthorized", hasToken: true }, "failed"],
  ] as const)("classifies %s with %j as %s", (lastErrorCode, overrides, expected) => {
    expect(authHint({ lastErrorCode, ...overrides })).toBe(expected);
  });

  it.each([
    "trusted_proxy_no_request",
    "trusted_proxy_untrusted_source",
    "trusted_proxy_loopback_source",
    "trusted_proxy_local_interface_check_failed",
    "trusted_proxy_local_interface_source",
    "trusted_proxy_user_missing",
    "trusted_proxy_user_not_allowed",
    "trusted_proxy_config_missing",
    "trusted_proxy_no_proxies_configured",
    "proxy_attribution_required",
  ])("classifies the structured proxy denial %s without token advice", (lastErrorAuthReason) => {
    expect(
      authHint({
        lastError: unauthorized,
        lastErrorCode: Codes.AUTH_UNAUTHORIZED,
        lastErrorAuthReason,
        hasToken: true,
        hasPassword: true,
      }),
    ).toBe("trusted-proxy");
  });

  it.each([undefined, "trusted_proxy_unknown"])(
    "does not infer proxy authentication from an unrecognized reason %s",
    (lastErrorAuthReason) => {
      expect(
        authHint({
          lastError: "unauthorized: trusted_proxy_user_missing",
          lastErrorCode: Codes.AUTH_UNAUTHORIZED,
          lastErrorAuthReason,
        }),
      ).toBe("failed");
    },
  );
});

it.each([
  ["BROWSER_WEBSOCKET_SECURITY_ERROR", true],
  ["BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR", false],
] as const)("shows an insecure-context hint for %s: %s", (code, expected) => {
  expect(shouldShowInsecureContextHint("connect failed", code)).toBe(expected);
});
