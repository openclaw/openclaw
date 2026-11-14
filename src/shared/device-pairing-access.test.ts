import { describe, expect, it } from "vitest";
import { resolvePendingDeviceApprovalState } from "./device-pairing-access.js";

const operator = { role: "operator", scopes: ["operator.read"] };
const access = (roles: string[]) => ({ roles, scopes: ["operator.read"] });

describe("resolvePendingDeviceApprovalState", () => {
  it("treats legacy singular approved role fields as approved access", () => {
    expect(resolvePendingDeviceApprovalState(operator, operator)).toEqual({
      kind: "re-approval",
      requested: access(["operator"]),
      approved: access(["operator"]),
    });
  });

  it("treats revoked approved-role tokens as a role upgrade", () => {
    expect(
      resolvePendingDeviceApprovalState(operator, {
        ...operator,
        tokens: { operator: { role: "operator", revokedAtMs: Date.now() } },
      }),
    ).toEqual({
      kind: "role-upgrade",
      requested: access(["operator"]),
      approved: access([]),
    });
  });

  it("drops non-string role entries from malformed pairing records instead of crashing", () => {
    // Legacy/malformed on-disk pairing records can carry non-string roles/role (blind-cast JSON);
    // before the shared-normalizer guard these crashed normalizeRoleList on .trim().
    type PendingArg = Parameters<typeof resolvePendingDeviceApprovalState>[0];
    type PairedArg = NonNullable<Parameters<typeof resolvePendingDeviceApprovalState>[1]>;
    expect(
      resolvePendingDeviceApprovalState(
        {
          roles: [123, "operator", null, "  admin  "],
          role: 5,
          scopes: ["operator.read"],
        } as unknown as PendingArg,
        {
          roles: [null, "operator"],
          role: 9,
          scopes: ["operator.read"],
        } as unknown as PairedArg,
      ),
    ).toEqual({
      kind: "role-upgrade",
      requested: access(["admin", "operator"]),
      approved: access(["operator"]),
    });
  });

  it("drops a non-string token role without crashing", () => {
    type PairedArg = NonNullable<Parameters<typeof resolvePendingDeviceApprovalState>[1]>;
    expect(
      resolvePendingDeviceApprovalState(operator, {
        roles: ["operator"],
        scopes: ["operator.read"],
        tokens: { t1: { role: 7, revokedAtMs: null } },
      } as unknown as PairedArg),
    ).toEqual({
      kind: "role-upgrade",
      requested: access(["operator"]),
      approved: access([]),
    });
  });
});
