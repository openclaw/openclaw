import { describe, expect, it } from "vitest";
import {
  CONTROL_UI_DEVICE_IDENTITY_INSECURE_CONTEXT_MESSAGE,
  readConnectErrorDetailCode,
  readConnectErrorRecoveryAdvice,
} from "./connect-error-details.js";

describe("CONTROL_UI_DEVICE_IDENTITY_INSECURE_CONTEXT_MESSAGE", () => {
  it("keeps a stable prefix for handshake and UI copy", () => {
    expect(CONTROL_UI_DEVICE_IDENTITY_INSECURE_CONTEXT_MESSAGE).toMatch(
      /^control ui requires device identity:/,
    );
    expect(CONTROL_UI_DEVICE_IDENTITY_INSECURE_CONTEXT_MESSAGE).toContain("allowInsecureAuth");
  });
});

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
