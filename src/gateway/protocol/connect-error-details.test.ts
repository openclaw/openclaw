import { describe, expect, it } from "vitest";
import {
  buildPairingConnectCloseReason,
  buildPairingConnectErrorDetails,
  buildPairingConnectErrorMessage,
  ConnectPairingRequiredReasons,
  describePairingConnectRequirement,
  readConnectErrorDetailCode,
  readConnectErrorRecoveryAdvice,
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
});
