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

describe("resolveGatewayCredentialsForUrlEdit", () => {
  it("preserves credentials for same normalized gateway endpoint edits", () => {
    expect(editCredentials(endpoint, ` ${endpoint}/ `)).toEqual({
      token: "abc123",
      password: "secret",
    });
  });

  it("loads a scoped token and clears the password when the gateway endpoint changes", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    sessionStorage.setItem(`openclaw.control.token.v1:${otherEndpoint}`, "other-token");

    expect(editCredentials(endpoint, `${otherEndpoint}/`)).toEqual({
      token: "other-token",
      password: "",
    });
  });

  it("preserves the token but clears the password when only the query scope changes", () => {
    expect(editCredentials(`${endpoint}?tenant=first`, `${endpoint}?tenant=second`)).toEqual({
      token: "abc123",
      password: "",
    });
  });

  it("does not restore legacy durable tokens when the gateway endpoint changes", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({
        gatewayUrl: otherEndpoint,
        token: "gateway-token",
      }),
    );

    expect(editCredentials(endpoint, otherEndpoint)).toEqual({ token: "", password: "" });
  });
});

describe("resolvePairingHint", () => {
  it.each([
    ["case-insensitive close reason", "Pairing Required", undefined],
    ["structured pairing code", "disconnected (4008): connect failed", Codes.PAIRING_REQUIRED],
  ])("detects pairing required from %s", (_name, lastError, lastErrorCode) => {
    expect(resolvePairingHint(lastError, lastErrorCode)).toEqual({
      kind: "pairing-required",
      requestId: null,
    });
  });

  it.each([
    ["missing errors", null],
    ["unrelated errors", "disconnected (1006): no reason"],
  ])("ignores %s", (_name, lastError) => {
    expect(resolvePairingHint(lastError)).toBeNull();
  });

  it("detects scope-upgrade pending approval and keeps the request id", () => {
    expect(
      resolvePairingHint(
        "scope upgrade pending approval (requestId: req-123)",
        Codes.PAIRING_REQUIRED,
      ),
    ).toEqual({
      kind: "scope-upgrade-pending",
      requestId: "req-123",
    });
  });
});

describe("resolveAuthHintKind", () => {
  it.each([
    [Codes.AUTH_TOKEN_MISSING, false, "required"],
    [Codes.AUTH_DEVICE_TOKEN_MISMATCH, false, "required"],
    [Codes.AUTH_TOKEN_MISMATCH, true, "failed"],
    [Codes.AUTH_BOOTSTRAP_TOKEN_INVALID, false, "failed"],
    [Codes.AUTH_DEVICE_TOKEN_MISMATCH, true, "failed"],
  ] as const)(
    "classifies %s with a supplied token=%s as %s",
    (lastErrorCode, hasToken, expected) => {
      expect(authHint({ lastErrorCode, hasToken })).toBe(expected);
    },
  );

  it.each([
    ["empty credentials", false, false, "unauthorized"],
    ["both credentials", true, true, "connect failed"],
  ])("uses the identity-header code with %s", (_name, hasToken, hasPassword, lastError) => {
    expect(
      authHint({
        lastError,
        lastErrorCode: Codes.AUTH_IDENTITY_HEADER_REQUIRED,
        hasToken,
        hasPassword,
      }),
    ).toBe("trusted-proxy");
  });

  it.each([
    ["connected clients", true, "unauthorized"],
    ["missing errors", false, null],
  ])("ignores the identity-header code for %s", (_name, connected, lastError) => {
    expect(
      authHint({
        connected,
        lastError,
        lastErrorCode: Codes.AUTH_IDENTITY_HEADER_REQUIRED,
      }),
    ).toBeNull();
  });

  it.each([Codes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED, "UNKNOWN_CONNECT_ERROR"])(
    "does not infer auth from unauthorized when the structured code is %s",
    (lastErrorCode) => {
      expect(
        authHint({
          lastError: "unauthorized",
          lastErrorCode,
          hasToken: true,
        }),
      ).toBeNull();
    },
  );

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
        lastError: "unauthorized",
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

  it("falls back to unauthorized string matching without structured codes", () => {
    expect(
      authHint({
        lastError: "disconnected (4008): unauthorized",
        lastErrorCode: null,
        hasToken: true,
      }),
    ).toBe("failed");
  });
});

describe("shouldShowInsecureContextHint", () => {
  it("returns true for browser WebSocket security errors", () => {
    expect(
      shouldShowInsecureContextHint(
        "Browser refused the Gateway WebSocket for security reasons.",
        "BROWSER_WEBSOCKET_SECURITY_ERROR",
      ),
    ).toBe(true);
  });

  it("does not treat generic WebSocket constructor errors as insecure context", () => {
    expect(
      shouldShowInsecureContextHint(
        "Could not create the Gateway WebSocket: constructor failed",
        "BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR",
      ),
    ).toBe(false);
  });
});
