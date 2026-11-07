// Handshake auth helper tests cover browser-origin security, pairing locality, and auth error details.
import { describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams } from "../../../../packages/gateway-protocol/src/schema.js";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import {
  resolveHandshakeBrowserSecurityContext,
  resolvePairingLocality,
  resolveUnauthorizedHandshakeContext,
  shouldAllowSilentLocalPairing,
  shouldPreserveLocalCliSharedAuthScopes,
  shouldSkipLocalBackendSelfPairing,
} from "./handshake-auth-helpers.js";

type PairingLocalityParams = Parameters<typeof resolvePairingLocality>[0];
type PairingLocalityOverrides = {
  connectParams?: ConnectParams;
  isLocalClient?: boolean;
  requestHost?: string;
  requestOrigin?: string;
  remoteAddress?: string;
  hasProxyHeaders?: boolean;
  hasBrowserOriginHeader?: boolean;
  sharedAuthOk?: boolean;
  authMethod?: PairingLocalityParams["authMethod"];
};
type SilentLocalPairingParams = Parameters<typeof shouldAllowSilentLocalPairing>[0];
type BackendSelfPairingParams = Parameters<typeof shouldSkipLocalBackendSelfPairing>[0];
type LocalCliSharedAuthScopeParams = Parameters<typeof shouldPreserveLocalCliSharedAuthScopes>[0];

const CONTROL_UI_WEBCHAT_CONNECT_PARAMS = {
  client: {
    id: GATEWAY_CLIENT_IDS.CONTROL_UI,
    mode: GATEWAY_CLIENT_MODES.WEBCHAT,
  },
} as ConnectParams;

function createRateLimiter(): AuthRateLimiter {
  return {
    check: () => ({ allowed: true, remaining: 1, retryAfterMs: 0 }),
    reset: () => {},
    recordFailure: () => {},
    recordFailureAndDelay: async () => {},
    size: () => 0,
    prune: () => {},
    dispose: () => {},
  };
}

const GATEWAY_BACKEND_CONNECT_PARAMS = {
  client: {
    id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
  },
} as ConnectParams;

const NODE_HOST_CONNECT_PARAMS = {
  client: {
    id: GATEWAY_CLIENT_IDS.NODE_HOST,
    mode: GATEWAY_CLIENT_MODES.NODE,
  },
} as ConnectParams;

const CLI_CONNECT_PARAMS = {
  client: {
    id: GATEWAY_CLIENT_IDS.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  },
} as ConnectParams;

function resolveDockerPublishedBrowserLocality(overrides: PairingLocalityOverrides = {}) {
  return resolvePairingLocality({
    connectParams: overrides.connectParams ?? CONTROL_UI_WEBCHAT_CONNECT_PARAMS,
    isLocalClient: overrides.isLocalClient ?? false,
    requestHost: overrides.requestHost ?? "127.0.0.1:18789",
    requestOrigin: overrides.requestOrigin ?? "http://127.0.0.1:18789",
    remoteAddress: overrides.remoteAddress ?? "172.17.0.1",
    hasProxyHeaders: overrides.hasProxyHeaders ?? false,
    hasBrowserOriginHeader: overrides.hasBrowserOriginHeader ?? true,
    sharedAuthOk: overrides.sharedAuthOk ?? true,
    authMethod: overrides.authMethod ?? "token",
  });
}

function resolveLoopbackLocality(
  connectParams: ConnectParams,
  overrides: PairingLocalityOverrides = {},
  requestHost = "127.0.0.1:18789",
) {
  return resolvePairingLocality({
    connectParams: overrides.connectParams ?? connectParams,
    isLocalClient: overrides.isLocalClient ?? false,
    requestHost: overrides.requestHost ?? requestHost,
    requestOrigin: overrides.requestOrigin,
    remoteAddress: overrides.remoteAddress ?? "127.0.0.1",
    hasProxyHeaders: overrides.hasProxyHeaders ?? false,
    hasBrowserOriginHeader: overrides.hasBrowserOriginHeader ?? false,
    sharedAuthOk: overrides.sharedAuthOk ?? true,
    authMethod: overrides.authMethod ?? "token",
  });
}

function resolveNodeLoopbackLocality(overrides: PairingLocalityOverrides = {}) {
  return resolveLoopbackLocality(NODE_HOST_CONNECT_PARAMS, overrides);
}

function resolveCliLoopbackLocality(overrides: PairingLocalityOverrides = {}) {
  return resolveLoopbackLocality(CLI_CONNECT_PARAMS, overrides, "172.17.0.2:18789");
}

function allowSilentLocalPairing(overrides: Partial<SilentLocalPairingParams>) {
  return shouldAllowSilentLocalPairing({
    locality: "direct_local",
    hasBrowserOriginHeader: false,
    isControlUi: false,
    isWebchat: false,
    authMethod: "token",
    reason: "not-paired",
    ...overrides,
  });
}

function skipBackendSelfPairing(overrides: Partial<BackendSelfPairingParams> = {}) {
  return shouldSkipLocalBackendSelfPairing({
    connectParams: GATEWAY_BACKEND_CONNECT_PARAMS,
    locality: "direct_local",
    hasBrowserOriginHeader: false,
    sharedAuthOk: true,
    authMethod: "token",
    ...overrides,
  });
}

function preserveLocalCliSharedAuthScopes(overrides: Partial<LocalCliSharedAuthScopeParams> = {}) {
  return shouldPreserveLocalCliSharedAuthScopes({
    connectParams: CLI_CONNECT_PARAMS,
    locality: "direct_local",
    hasBrowserOriginHeader: false,
    sharedAuthOk: true,
    authMethod: "token",
    ...overrides,
  });
}

describe("handshake auth helpers", () => {
  it("isolates browser-origin loopback clients in the browser limiter", () => {
    const rateLimiter = createRateLimiter();
    const browserRateLimiter = createRateLimiter();
    const resolved = resolveHandshakeBrowserSecurityContext({
      requestOrigin: "https://app.example",
      clientIp: "127.0.0.1",
      rateLimiter,
      browserRateLimiter,
    });

    expect(resolved).toMatchObject({
      hasBrowserOriginHeader: true,
      enforceOriginCheckForAnyClient: true,
      rateLimitClientIp: "browser-origin:https://app.example",
      authRateLimiter: browserRateLimiter,
    });
  });

  it("uses the synthetic browser key when the origin is invalid", () => {
    const resolved = resolveHandshakeBrowserSecurityContext({
      requestOrigin: "not a url",
      clientIp: "127.0.0.1",
    });
    expect(resolved.rateLimitClientIp).toBe("198.18.0.1");
  });

  it("recommends device-token retry only for shared-token mismatch with device identity", () => {
    const resolved = resolveUnauthorizedHandshakeContext({
      connectAuth: { token: "shared" },
      failedAuth: { ok: false, reason: "token_mismatch" },
      hasDeviceIdentity: true,
    });

    expect(resolved).toEqual({
      authProvided: "token",
      canRetryWithDeviceToken: true,
      recommendedNextStep: "retry_with_device_token",
    });
  });

  it("treats explicit device-token mismatch as credential update guidance", () => {
    const resolved = resolveUnauthorizedHandshakeContext({
      connectAuth: { deviceToken: "device-token" },
      failedAuth: { ok: false, reason: "device_token_mismatch" },
      hasDeviceIdentity: true,
    });

    expect(resolved).toEqual({
      authProvided: "device-token",
      canRetryWithDeviceToken: false,
      recommendedNextStep: "update_auth_credentials",
    });
  });

  it("treats device-token scope mismatch as configuration review guidance", () => {
    const resolved = resolveUnauthorizedHandshakeContext({
      connectAuth: { deviceToken: "device-token" },
      failedAuth: { ok: false, reason: "scope_mismatch" },
      hasDeviceIdentity: true,
    });

    expect(resolved).toEqual({
      authProvided: "device-token",
      canRetryWithDeviceToken: false,
      recommendedNextStep: "review_auth_configuration",
    });
  });

  it("allows silent local pairing for not-paired, scope-upgrade and role-upgrade", () => {
    for (const [input, expected] of [
      [{ reason: "not-paired" }, true],
      [{ reason: "role-upgrade" }, true],
      [{ reason: "scope-upgrade" }, true],
      [{ reason: "metadata-upgrade" }, false],
    ] as const) {
      expect(allowSilentLocalPairing(input)).toBe(expected);
    }
  });

  it.each(["not-paired", "role-upgrade", "scope-upgrade"] as const)(
    "requires explicit local approval for %s when autoApproveLocal is false",
    (reason) => {
      for (const locality of [
        "direct_local",
        "cli_container_local",
        "browser_container_local",
        "shared_secret_loopback_local",
      ] as const) {
        expect(
          allowSilentLocalPairing({
            autoApproveLocal: false,
            locality,
            hasBrowserOriginHeader: locality === "browser_container_local",
            isControlUi: locality === "browser_container_local",
            isWebchat: locality === "browser_container_local",
            reason,
          }),
        ).toBe(false);
      }
    },
  );

  it("allows Control UI or WebChat browser-origin pairing but keeps other browser-origin clients explicit", () => {
    expect(
      allowSilentLocalPairing({
        locality: "browser_container_local",
        hasBrowserOriginHeader: true,
        isControlUi: true,
        isWebchat: true,
        reason: "not-paired",
      }),
    ).toBe(true);
    expect(
      allowSilentLocalPairing({
        locality: "shared_secret_loopback_local",
        hasBrowserOriginHeader: true,
        isWebchat: true,
        reason: "scope-upgrade",
      }),
    ).toBe(true);
    expect(
      allowSilentLocalPairing({
        locality: "shared_secret_loopback_local",
        hasBrowserOriginHeader: true,
        reason: "scope-upgrade",
      }),
    ).toBe(false);
  });

  it("limits silent scope-upgrade to local-grade auth methods", () => {
    for (const authMethod of ["none", "token", "password"] as const) {
      expect(allowSilentLocalPairing({ authMethod, reason: "scope-upgrade" })).toBe(true);
    }
    // Identity-proxy and bearer-token connects never proved local-grade
    // credentials, so their pairing rows stay a durable scope cap.
    for (const authMethod of [
      "tailscale",
      "trusted-proxy",
      "device-token",
      "bootstrap-token",
    ] as const) {
      expect(allowSilentLocalPairing({ authMethod, reason: "scope-upgrade" })).toBe(false);
      expect(allowSilentLocalPairing({ authMethod, reason: "not-paired" })).toBe(true);
      expect(allowSilentLocalPairing({ authMethod, reason: "role-upgrade" })).toBe(true);
    }
    expect(allowSilentLocalPairing({ authMethod: undefined, reason: "scope-upgrade" })).toBe(false);
  });

  it("rejects silent role-upgrade for remote clients", () => {
    expect(
      allowSilentLocalPairing({
        locality: "remote",
        reason: "role-upgrade",
      }),
    ).toBe(false);
  });

  it("classifies direct local requests ahead of any Docker CLI fallback", () => {
    expect(
      resolvePairingLocality({
        connectParams: CLI_CONNECT_PARAMS,
        isLocalClient: true,
        requestHost: "gateway.example",
        remoteAddress: "203.0.113.20",
        hasProxyHeaders: true,
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authMethod: "token",
      }),
    ).toBe("direct_local");
  });

  it("classifies Docker-published loopback Control UI as browser-container-local", () => {
    expect(resolveDockerPublishedBrowserLocality()).toBe("browser_container_local");
    expect(
      resolveDockerPublishedBrowserLocality({
        requestHost: "localhost:18789",
        requestOrigin: "http://localhost:18789",
        authMethod: "password",
      }),
    ).toBe("browser_container_local");
  });

  it("keeps Docker-published non-loopback Control UI origins remote", () => {
    for (const [input, expected] of [
      [{ requestHost: "192.168.1.10:18789", requestOrigin: "http://192.168.1.10:18789" }, "remote"],
      [{ requestOrigin: "https://app.example" }, "remote"],
      [{ hasProxyHeaders: true }, "remote"],
      [{ sharedAuthOk: false }, "remote"],
    ] as const) {
      expect(resolveDockerPublishedBrowserLocality(input)).toBe(expected);
    }
  });

  it("keeps non-Control-UI clients remote for browser-container-local conditions", () => {
    expect(
      resolveDockerPublishedBrowserLocality({
        connectParams: GATEWAY_BACKEND_CONNECT_PARAMS,
      }),
    ).toBe("remote");
  });

  it("classifies CLI loopback/private-host connects as cli_container_local only with shared auth", () => {
    for (const [input, expected] of [
      [{}, "cli_container_local"],
      [{ hasProxyHeaders: true }, "remote"],
      [{ requestHost: "gateway.example" }, "remote"],
      [{ authMethod: "device-token" }, "remote"],
    ] as const) {
      expect(resolveCliLoopbackLocality(input)).toBe(expected);
    }
  });

  it("skips backend self-pairing only for direct-local backend clients", () => {
    for (const [input, expected] of [
      [{}, true],
      [{ locality: "shared_secret_loopback_local" }, true],
      [{ locality: "remote" }, false],
      [{ locality: "remote", authMethod: "password" }, false],
      [{ sharedAuthOk: false, authMethod: "device-token" }, true],
      [{ locality: "remote", sharedAuthOk: false, authMethod: "device-token" }, false],
      [{ locality: "cli_container_local" }, false],
    ] as const) {
      expect(skipBackendSelfPairing(input)).toBe(expected);
    }
  });

  it("does not skip backend self-pairing for CLI clients", () => {
    expect(
      skipBackendSelfPairing({
        connectParams: CLI_CONNECT_PARAMS,
      }),
    ).toBe(false);
  });

  it("preserves local CLI shared-auth scopes only for token/password loopback auth", () => {
    for (const [input, expected] of [
      [{}, true],
      [{ locality: "cli_container_local", authMethod: "password" }, true],
      [{ locality: "remote" }, false],
      [{ authMethod: "device-token" }, false],
      [{ hasBrowserOriginHeader: true }, false],
      [{ connectParams: GATEWAY_BACKEND_CONNECT_PARAMS }, false],
    ] as const) {
      expect(preserveLocalCliSharedAuthScopes(input)).toBe(expected);
    }
  });

  it("rejects pairing bypass when browser origin header is present", () => {
    expect(
      skipBackendSelfPairing({
        hasBrowserOriginHeader: true,
      }),
    ).toBe(false);
  });

  it("skips backend self-pairing when auth mode is none (scoped, sharedAuthOk-independent)", () => {
    for (const [input, expected] of [
      // auth:none on local backend skips regardless of sharedAuthOk
      [{ authMethod: "none" }, true],
      [{ locality: "shared_secret_loopback_local", authMethod: "none" }, true],
      // sharedAuthOk=false is fine for auth:none on local backend
      [{ sharedAuthOk: false, authMethod: "none" }, true],
      // Remote connections with auth:none should NOT skip
      [{ locality: "remote", authMethod: "none" }, false],
      // Browser origin with auth:none should NOT skip
      [{ hasBrowserOriginHeader: true, sharedAuthOk: false, authMethod: "none" }, false],
    ] as const) {
      expect(skipBackendSelfPairing(input)).toBe(expected);
    }
  });

  it("classifies non-CLI loopback + shared-secret clients as shared_secret_loopback_local", () => {
    expect(resolveNodeLoopbackLocality()).toBe("shared_secret_loopback_local");
  });

  it("keeps non-CLI loopback clients remote without shared-secret auth", () => {
    for (const [input, expected] of [
      [{ sharedAuthOk: false, authMethod: "token" }, "remote"],
      [{ sharedAuthOk: true, authMethod: "device-token" }, "remote"],
      [{ remoteAddress: "192.168.1.10", sharedAuthOk: true, authMethod: "token" }, "remote"],
      [{ hasProxyHeaders: true, sharedAuthOk: true, authMethod: "token" }, "remote"],
      [{ hasBrowserOriginHeader: true, sharedAuthOk: true, authMethod: "token" }, "remote"],
    ] as const) {
      expect(resolveNodeLoopbackLocality(input)).toBe(expected);
    }
  });

  it("allows silent scope-upgrade, role-upgrade, and metadata-upgrade for shared_secret_loopback_local", () => {
    for (const [input, expected] of [
      [{ locality: "shared_secret_loopback_local", reason: "scope-upgrade" }, true],
      [{ locality: "shared_secret_loopback_local", reason: "role-upgrade" }, true],
      // metadata-upgrade now auto-approves for shared_secret_loopback_local
      // (extended allowlist — see shouldAllowSilentLocalPairing).
      [{ locality: "shared_secret_loopback_local", reason: "metadata-upgrade" }, true],
    ] as const) {
      expect(allowSilentLocalPairing(input)).toBe(expected);
    }
  });

  describe("shouldAllowSilentLocalPairing — metadata-upgrade reason", () => {
    it("allows silent metadata-upgrade for direct local native app clients without browser origin", () => {
      expect(
        allowSilentLocalPairing({
          isNativeAppUi: true,
          reason: "metadata-upgrade",
        }),
      ).toBe(true);
    });

    it("allows silent metadata-upgrade for cli_container_local CLI clients", () => {
      expect(
        allowSilentLocalPairing({
          locality: "cli_container_local",
          reason: "metadata-upgrade",
        }),
      ).toBe(true);
    });

    it("still requires approval for direct local Browser or Control UI metadata-upgrade", () => {
      expect(
        allowSilentLocalPairing({
          hasBrowserOriginHeader: true,
          isControlUi: true,
          reason: "metadata-upgrade",
        }),
      ).toBe(false);
      expect(
        allowSilentLocalPairing({
          hasBrowserOriginHeader: true,
          isWebchat: true,
          reason: "metadata-upgrade",
        }),
      ).toBe(false);
    });
  });
});
