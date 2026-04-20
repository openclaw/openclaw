import { describe, expect, it } from "vitest";
import { formatConnectError } from "./connect-error.ts";

describe("formatConnectError", () => {
  it("formats pairing scope upgrades with the richer contract", () => {
    expect(
      formatConnectError({
        message: "pairing required: device is asking for more scopes than currently approved",
        details: {
          code: "PAIRING_REQUIRED",
          reason: "scope-upgrade",
          requestId: "req-123",
        },
      }),
    ).toBe("scope upgrade pending approval (requestId: req-123)");
  });

  it("formats unapproved devices with the richer contract", () => {
    expect(
      formatConnectError({
        message: "pairing required: device is not approved yet",
        details: {
          code: "PAIRING_REQUIRED",
          reason: "not-paired",
        },
      }),
    ).toBe("device pairing required");
  });
});
