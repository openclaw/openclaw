import { describe, expect, test } from "vitest";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../../protocol/client-info.js";
import type { ConnectParams } from "../../protocol/index.js";
import {
  evaluateMissingDeviceIdentity,
  isTrustedProxyControlUiOperatorAuth,
  resolveControlUiAuthPolicy,
  resolveInternalBackendClientAttestation,
  shouldSkipBackendSelfPairing,
  shouldSkipControlUiPairing,
} from "./connect-policy.js";

describe("ws connect policy", () => {
  test("resolves control-ui auth policy", () => {
    const bypass = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
      deviceRaw: {
        id: "dev-1",
        publicKey: "pk",
        signature: "sig",
        signedAt: Date.now(),
        nonce: "nonce-1",
      },
    });
    expect(bypass.allowBypass).toBe(true);
    expect(bypass.device).toBeNull();

    const regular = resolveControlUiAuthPolicy({
      isControlUi: false,
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
      deviceRaw: {
        id: "dev-2",
        publicKey: "pk",
        signature: "sig",
        signedAt: Date.now(),
        nonce: "nonce-2",
      },
    });
    expect(regular.allowBypass).toBe(false);
    expect(regular.device?.id).toBe("dev-2");
  });

  test("evaluates missing-device decisions", () => {
    const policy = resolveControlUiAuthPolicy({
      isControlUi: false,
      controlUiConfig: undefined,
      deviceRaw: null,
    });

    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: true,
        role: "node",
        isControlUi: false,
        controlUiAuthPolicy: policy,
        trustedProxyAuthOk: false,
        sharedAuthOk: true,
        authOk: true,
        hasSharedAuth: true,
        isLocalClient: false,
      }).kind,
    ).toBe("allow");

    const controlUiStrict = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: { allowInsecureAuth: true, dangerouslyDisableDeviceAuth: false },
      deviceRaw: null,
    });
    // Remote Control UI with allowInsecureAuth -> still rejected.
    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: true,
        controlUiAuthPolicy: controlUiStrict,
        trustedProxyAuthOk: false,
        sharedAuthOk: true,
        authOk: true,
        hasSharedAuth: true,
        isLocalClient: false,
      }).kind,
    ).toBe("reject-control-ui-insecure-auth");

    // Local Control UI with allowInsecureAuth -> allowed.
    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: true,
        controlUiAuthPolicy: controlUiStrict,
        trustedProxyAuthOk: false,
        sharedAuthOk: true,
        authOk: true,
        hasSharedAuth: true,
        isLocalClient: true,
      }).kind,
    ).toBe("allow");

    // Control UI without allowInsecureAuth, even on localhost -> rejected.
    const controlUiNoInsecure = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: { dangerouslyDisableDeviceAuth: false },
      deviceRaw: null,
    });
    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: true,
        controlUiAuthPolicy: controlUiNoInsecure,
        trustedProxyAuthOk: false,
        sharedAuthOk: true,
        authOk: true,
        hasSharedAuth: true,
        isLocalClient: true,
      }).kind,
    ).toBe("reject-control-ui-insecure-auth");

    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: false,
        controlUiAuthPolicy: policy,
        trustedProxyAuthOk: false,
        sharedAuthOk: true,
        authOk: true,
        hasSharedAuth: true,
        isLocalClient: false,
      }).kind,
    ).toBe("allow");

    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: false,
        controlUiAuthPolicy: policy,
        trustedProxyAuthOk: false,
        sharedAuthOk: false,
        authOk: false,
        hasSharedAuth: true,
        isLocalClient: false,
      }).kind,
    ).toBe("reject-unauthorized");

    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "node",
        isControlUi: false,
        controlUiAuthPolicy: policy,
        trustedProxyAuthOk: false,
        sharedAuthOk: true,
        authOk: true,
        hasSharedAuth: true,
        isLocalClient: false,
      }).kind,
    ).toBe("reject-device-required");

    // Trusted-proxy authenticated Control UI should bypass device-identity gating.
    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: true,
        controlUiAuthPolicy: controlUiNoInsecure,
        trustedProxyAuthOk: true,
        sharedAuthOk: false,
        authOk: true,
        hasSharedAuth: false,
        isLocalClient: false,
      }).kind,
    ).toBe("allow");

    const bypass = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
      deviceRaw: null,
    });
    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: true,
        controlUiAuthPolicy: bypass,
        trustedProxyAuthOk: false,
        sharedAuthOk: false,
        authOk: false,
        hasSharedAuth: false,
        isLocalClient: false,
      }).kind,
    ).toBe("allow");

    // Regression: dangerouslyDisableDeviceAuth bypass must NOT extend to node-role
    // sessions — the break-glass flag is scoped to operator Control UI only.
    // A device-less node-role connection must still be rejected even when the flag
    // is set, to prevent the flag from being abused to admit unauthorized node
    // registrations.
    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "node",
        isControlUi: true,
        controlUiAuthPolicy: bypass,
        trustedProxyAuthOk: false,
        sharedAuthOk: false,
        authOk: false,
        hasSharedAuth: false,
        isLocalClient: false,
      }).kind,
    ).toBe("reject-device-required");
  });

  test("dangerouslyDisableDeviceAuth skips pairing for operator control-ui only", () => {
    const bypass = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
      deviceRaw: null,
    });
    const strict = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: undefined,
      deviceRaw: null,
    });
    expect(shouldSkipControlUiPairing(bypass, "operator", false)).toBe(true);
    expect(shouldSkipControlUiPairing(bypass, "node", false)).toBe(false);
    expect(shouldSkipControlUiPairing(strict, "operator", false)).toBe(false);
    expect(shouldSkipControlUiPairing(strict, "operator", true)).toBe(true);
  });

  test("trusted-proxy control-ui bypass only applies to operator + trusted-proxy auth", () => {
    const cases: Array<{
      role: "operator" | "node";
      authMode: string;
      authOk: boolean;
      authMethod: string | undefined;
      expected: boolean;
    }> = [
      {
        role: "operator",
        authMode: "trusted-proxy",
        authOk: true,
        authMethod: "trusted-proxy",
        expected: true,
      },
      {
        role: "node",
        authMode: "trusted-proxy",
        authOk: true,
        authMethod: "trusted-proxy",
        expected: false,
      },
      {
        role: "operator",
        authMode: "token",
        authOk: true,
        authMethod: "token",
        expected: false,
      },
      {
        role: "operator",
        authMode: "trusted-proxy",
        authOk: false,
        authMethod: "trusted-proxy",
        expected: false,
      },
    ];

    for (const tc of cases) {
      expect(
        isTrustedProxyControlUiOperatorAuth({
          isControlUi: true,
          role: tc.role,
          authMode: tc.authMode,
          authOk: tc.authOk,
          authMethod: tc.authMethod,
        }),
      ).toBe(tc.expected);
    }
  });

  test("backend self-pairing skip requires trusted local backend handshake conditions", () => {
    const makeConnectParams = (
      clientId: ConnectParams["client"]["id"],
      mode: ConnectParams["client"]["mode"],
    ): ConnectParams => ({
      client: {
        id: clientId,
        mode,
        version: "1.0.0",
        platform: "node",
      },
      minProtocol: 1,
      maxProtocol: 1,
    });

    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: true,
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authOk: true,
        authMethod: "token",
      }),
    ).toBe(true);

    // Remote shared-secret backend clients must still complete pairing; the
    // client-reported gateway-client/backend label is not enough to skip it.
    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: false,
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authOk: true,
        authMethod: "token",
      }),
    ).toBe(false);

    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: true,
        hasBrowserOriginHeader: true,
        sharedAuthOk: true,
        authOk: true,
        authMethod: "token",
      }),
    ).toBe(false);

    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: true,
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authOk: false,
        authMethod: "token",
      }),
    ).toBe(false);

    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: true,
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authOk: true,
        authMethod: "trusted-proxy",
      }),
    ).toBe(false);

    // Backend client authenticated via verified Tailscale identity is trusted via authOk,
    // not sharedAuthOk (sharedAuthOk stays false for tailscale per auth-context.ts).
    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: true,
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authOk: true,
        authMethod: "tailscale",
      }),
    ).toBe(true);

    // Remote Tailscale-authenticated backend clients still need pairing. A
    // spoofed gateway-client/backend label must not create implicit trust.
    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: false,
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authOk: true,
        authMethod: "tailscale",
      }),
    ).toBe(false);

    // Tailscale with authOk=false is rejected.
    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: true,
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authOk: false,
        authMethod: "tailscale",
      }),
    ).toBe(false);

    // Browser-origin Tailscale backend connection is still rejected.
    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: false,
        hasBrowserOriginHeader: true,
        sharedAuthOk: false,
        authOk: true,
        authMethod: "tailscale",
      }),
    ).toBe(false);

    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams("webchat", GATEWAY_CLIENT_MODES.BACKEND),
        isLocalClient: true,
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authOk: true,
        authMethod: "token",
      }),
    ).toBe(false);

    // auth.mode="none": local backend client with no browser origin is trusted even without a
    // shared secret, because there is no secret to verify.
    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: true,
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authOk: false,
        authMethod: "none",
      }),
    ).toBe(true);

    // auth.mode="none" with remote client is still rejected (isLocalClient=false).
    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: false,
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authOk: false,
        authMethod: "none",
      }),
    ).toBe(false);

    // Backend client authenticating via device-token is trusted via authOk, not sharedAuthOk
    // (sharedAuthOk stays false for device-token in the WS flow per auth-context.ts).
    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: true,
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authOk: true,
        authMethod: "device-token",
      }),
    ).toBe(true);

    // device-token with authOk=false is rejected.
    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: true,
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authOk: false,
        authMethod: "device-token",
      }),
    ).toBe(false);

    // bootstrap-token is onboarding-only auth: first-time backend connects must still
    // go through pairing so the session can mint/persist a device token.
    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: true,
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authOk: true,
        authMethod: "bootstrap-token",
      }),
    ).toBe(false);

    // Remote device-token backend clients also keep the pairing check. Device
    // token auth proves the credential, not the self-declared backend label.
    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: false,
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authOk: true,
        authMethod: "device-token",
      }),
    ).toBe(false);

    // Remote bootstrap-token backend clients are also still onboarding and must pair.
    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: false,
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authOk: true,
        authMethod: "bootstrap-token",
      }),
    ).toBe(false);

    // Duplicate regression guard: remote shared-secret backend clients must not
    // bypass pairing just by claiming the backend client identity.
    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: false,
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authOk: true,
        authMethod: "token",
      }),
    ).toBe(false);

    // Remote backend client with browser origin header is still rejected.
    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: false,
        hasBrowserOriginHeader: true,
        sharedAuthOk: true,
        authOk: true,
        authMethod: "token",
      }),
    ).toBe(false);

    // Browser-origin device-token / bootstrap-token backend connections are also rejected.
    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: false,
        hasBrowserOriginHeader: true,
        sharedAuthOk: false,
        authOk: true,
        authMethod: "device-token",
      }),
    ).toBe(false);
    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: false,
        hasBrowserOriginHeader: true,
        sharedAuthOk: false,
        authOk: true,
        authMethod: "bootstrap-token",
      }),
    ).toBe(false);

    // auth.mode="none" with browser origin header is still rejected (hasBrowserOriginHeader=true).
    expect(
      shouldSkipBackendSelfPairing({
        connectParams: makeConnectParams(
          GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          GATEWAY_CLIENT_MODES.BACKEND,
        ),
        isLocalClient: true,
        hasBrowserOriginHeader: true,
        sharedAuthOk: false,
        authOk: false,
        authMethod: "none",
      }),
    ).toBe(false);
  });

  test("promotes bootstrap-paired backend clients to internal attestation", () => {
    const backendConnect: ConnectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        version: "1.0.0",
        platform: "node",
      },
      minProtocol: 1,
      maxProtocol: 1,
    };

    expect(
      resolveInternalBackendClientAttestation({
        connectParams: backendConnect,
        hasBrowserOriginHeader: false,
        initialIsInternalBackendClient: false,
        authMethod: "bootstrap-token",
        deviceTokenIssued: true,
      }),
    ).toBe(true);

    expect(
      resolveInternalBackendClientAttestation({
        connectParams: backendConnect,
        hasBrowserOriginHeader: true,
        initialIsInternalBackendClient: false,
        authMethod: "bootstrap-token",
        deviceTokenIssued: true,
      }),
    ).toBe(false);

    expect(
      resolveInternalBackendClientAttestation({
        connectParams: {
          client: {
            id: "desktop",
            mode: GATEWAY_CLIENT_MODES.TEST,
            version: "1.0.0",
            platform: "node",
          },
          minProtocol: 1,
          maxProtocol: 1,
        },
        hasBrowserOriginHeader: false,
        initialIsInternalBackendClient: false,
        authMethod: "bootstrap-token",
        deviceTokenIssued: true,
      }),
    ).toBe(false);
  });
});
