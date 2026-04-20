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
          requestId: "req-123",
          approvedScopes: ["operator.read"],
          requestedScopes: ["operator.admin", "operator.read"],
        },
      }),
    ).toBe(
      "device scope upgrade requires approval (approved: operator.read; requested: operator.admin, operator.read) (requestId: req-123)",
    );
  });

  it("explains role upgrades that require approval", () => {
    expect(
      formatConnectError({
        message: "pairing required",
        details: {
          code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
          reason: "role-upgrade",
          requestId: "req-456",
          approvedRoles: ["operator"],
          requestedRole: "node",
        },
      }),
    ).toBe(
      "device role upgrade requires approval (approved: operator; requested: node) (requestId: req-456)",
    );
  });
});
