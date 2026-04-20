import { describe, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../src/gateway/protocol/connect-error-details.js";
import { formatConnectError } from "./connect-error.ts";

describe("formatConnectError", () => {
  it("explains scope upgrades that require approval", () => {
    expect(
      formatConnectError({
        message: "pairing required",
        details: {
          code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
          reason: "scope-upgrade",
          approvedScopes: ["operator.read"],
          requestedScopes: ["operator.admin", "operator.read"],
        },
      }),
    ).toBe("scope upgrade pending approval");
  });

  it("explains role upgrades that require approval", () => {
    expect(
      formatConnectError({
        message: "pairing required",
        details: {
          code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
          reason: "role-upgrade",
          approvedRoles: ["operator"],
          requestedRole: "node",
        },
      }),
    ).toBe("role upgrade pending approval");
  });
});
