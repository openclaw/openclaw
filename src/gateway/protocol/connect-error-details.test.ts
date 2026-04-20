import { describe, expect, it } from "vitest";
import {
  buildPairingConnectCloseReason,
  buildPairingConnectErrorDetails,
  buildPairingConnectErrorMessage,
  ConnectPairingRequiredReasons,
  describePairingConnectRequirement,
  formatConnectErrorMessage,
  formatConnectPairingRequiredMessage,
  normalizePairingConnectRequestId,
  readConnectErrorDetailCode,
  readConnectErrorRecoveryAdvice,
  readConnectPairingRequiredDetails,
  readConnectPairingRequiredMessage,
  readPairingConnectErrorDetails,
} from "./connect-error-details.js";

describe("readConnectErrorDetailCode", () => {
  it("reads structured detail codes", () => {
    expect(readConnectErrorDetailCode({ code: "AUTH_TOKEN_MISMATCH" })).toBe("AUTH_TOKEN_MISMATCH");
  });

  it("returns null for invalid detail payloads", () => {
    expect(readConnectErrorDetailCode(null)).toBeNull();
    expect(readConnectErrorDetailCode("AUTH_TOKEN_MISMATCH")).toBeNull();
  });
});

describe("readConnectErrorRecoveryAdvice", () => {
  it("reads retry advice fields when present", () => {
    expect(
      readConnectErrorRecoveryAdvice({
        canRetryWithDeviceToken: true,
        recommendedNextStep: "retry_with_device_token",
      }),
    ).toEqual({
      canRetryWithDeviceToken: true,
      recommendedNextStep: "retry_with_device_token",
    });
  });

  it("returns empty advice for invalid payloads", () => {
    expect(readConnectErrorRecoveryAdvice(null)).toEqual({});
    expect(readConnectErrorRecoveryAdvice("x")).toEqual({});
    expect(readConnectErrorRecoveryAdvice({ canRetryWithDeviceToken: "yes" })).toEqual({});
    expect(
      readConnectErrorRecoveryAdvice({
        canRetryWithDeviceToken: true,
        recommendedNextStep: "retry_with_magic",
      }),
    ).toEqual({ canRetryWithDeviceToken: true, recommendedNextStep: undefined });
  });
});

describe("pairing connect details", () => {
  it("builds reason-specific pairing messages", () => {
    expect(buildPairingConnectErrorMessage(ConnectPairingRequiredReasons.SCOPE_UPGRADE)).toBe(
      "pairing required: device is asking for more scopes than currently approved",
    );
    expect(describePairingConnectRequirement(ConnectPairingRequiredReasons.NOT_PAIRED)).toBe(
      "device is not approved yet",
    );
  });

  it("builds structured pairing details with remediation", () => {
    expect(
      buildPairingConnectErrorDetails({
        reason: ConnectPairingRequiredReasons.NOT_PAIRED,
        requestId: "req-123",
      }),
    ).toEqual({
      code: "PAIRING_REQUIRED",
      reason: "not-paired",
      requestId: "req-123",
      remediationHint: "Approve this device from the pending pairing requests.",
    });
  });

  it("reads pairing details and backfills missing remediation hints", () => {
    expect(
      readPairingConnectErrorDetails({
        code: "PAIRING_REQUIRED",
        reason: "scope-upgrade",
        requestId: "req-456",
      }),
    ).toEqual({
      code: "PAIRING_REQUIRED",
      reason: "scope-upgrade",
      requestId: "req-456",
      remediationHint: "Review the requested scopes, then approve the pending upgrade.",
    });
  });

  it("includes request ids in close reasons when available", () => {
    expect(
      buildPairingConnectCloseReason({
        reason: ConnectPairingRequiredReasons.ROLE_UPGRADE,
        requestId: "req-789",
      }),
    ).toBe(
      "pairing required: device is asking for a higher role than currently approved (requestId: req-789)",
    );
  });

  it("drops request ids that do not match the allowlist", () => {
    expect(normalizePairingConnectRequestId("req-123")).toBe("req-123");
    expect(normalizePairingConnectRequestId("req-123;rm -rf /")).toBeUndefined();
    expect(
      readPairingConnectErrorDetails({
        code: "PAIRING_REQUIRED",
        reason: "scope-upgrade",
        requestId: "req-123;rm -rf /",
      }),
    ).toEqual({
      code: "PAIRING_REQUIRED",
      reason: "scope-upgrade",
      remediationHint: "Review the requested scopes, then approve the pending upgrade.",
    });
  });

  it("reads pairing details as compact connect details", () => {
    expect(
      readConnectPairingRequiredDetails({
        code: "PAIRING_REQUIRED",
        requestId: "req-123",
        reason: "scope-upgrade",
        remediationHint: "Review the requested scopes, then approve the pending upgrade.",
      }),
    ).toEqual({
      requestId: "req-123",
      reason: "scope-upgrade",
    });
  });

  it("formats upgrade rejections with the request id", () => {
    expect(
      formatConnectPairingRequiredMessage({
        code: "PAIRING_REQUIRED",
        requestId: "req-123",
        reason: "scope-upgrade",
      }),
    ).toBe(
      "gateway pairing required: device is asking for more scopes than currently approved (requestId: req-123)",
    );
  });

  it("formats pairing upgrades with approved and requested details", () => {
    expect(
      formatConnectPairingRequiredMessage({
        code: "PAIRING_REQUIRED",
        reason: "scope-upgrade",
        requestId: "req-123",
        approvedScopes: ["operator.read"],
        requestedScopes: ["operator.admin", "operator.read"],
      }),
    ).toBe(
      "device scope upgrade requires approval (approved: operator.read; requested: operator.admin, operator.read) (requestId: req-123)",
    );
    expect(
      formatConnectPairingRequiredMessage({
        code: "PAIRING_REQUIRED",
        reason: "role-upgrade",
        requestId: "req-456",
        approvedRoles: ["operator"],
        requestedRole: "node",
      }),
    ).toBe(
      "device role upgrade requires approval (approved: operator; requested: node) (requestId: req-456)",
    );
    expect(
      formatConnectPairingRequiredMessage({
        code: "PAIRING_REQUIRED",
        reason: "metadata-upgrade",
        requestId: "req-789",
      }),
    ).toBe("device metadata change pending approval (requestId: req-789)");
  });

  it("parses surfaced pairing-required messages", () => {
    expect(
      readConnectPairingRequiredMessage("scope upgrade pending approval (requestId: req-123)"),
    ).toEqual({
      requestId: "req-123",
      reason: "scope-upgrade",
    });
    expect(
      readConnectPairingRequiredMessage(
        "device scope upgrade requires approval (approved: operator.read; requested: operator.admin, operator.read) (requestId: req-456)",
      ),
    ).toEqual({
      requestId: "req-456",
      reason: "scope-upgrade",
    });
    expect(
      readConnectPairingRequiredMessage(
        "gateway pairing required: device is asking for a higher role than currently approved",
      ),
    ).toEqual({
      reason: "role-upgrade",
    });
    expect(
      readConnectPairingRequiredMessage(
        "scope upgrade pending approval (requestId: req-123;rm -rf /)",
      ),
    ).toEqual({
      reason: "scope-upgrade",
    });
  });

  it("prefers pairing detail formatting over the generic message", () => {
    expect(
      formatConnectErrorMessage({
        message: "pairing required",
        details: {
          code: "PAIRING_REQUIRED",
          requestId: "req-123",
          reason: "scope-upgrade",
        },
      }),
    ).toBe(
      "gateway pairing required: device is asking for more scopes than currently approved (requestId: req-123)",
    );
  });
});
