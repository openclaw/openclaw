import { describe, expect, test } from "vitest";
import {
  getPermissionsForRole,
  parseCmmcRole,
  roleAtLeast,
  type CmmcRole,
  type Permission,
} from "./rbac.js";

describe("parseCmmcRole", () => {
  test("parses valid roles", () => {
    expect(parseCmmcRole("admin")).toBe("admin");
    expect(parseCmmcRole("operator")).toBe("operator");
    expect(parseCmmcRole("observer")).toBe("observer");
    expect(parseCmmcRole("guest")).toBe("guest");
  });

  test("defaults unknown values to guest (fail-safe)", () => {
    expect(parseCmmcRole("superuser")).toBe("guest");
    expect(parseCmmcRole(undefined)).toBe("guest");
    expect(parseCmmcRole(null)).toBe("guest");
    expect(parseCmmcRole(42)).toBe("guest");
    expect(parseCmmcRole("")).toBe("guest");
  });
});

describe("getPermissionsForRole", () => {
  test("guest has gateway:status and channel:read only", () => {
    const perms = getPermissionsForRole("guest");
    expect(perms.has("gateway:status")).toBe(true);
    expect(perms.has("channel:read")).toBe(true);
    expect(perms.has("account:create")).toBe(false);
    expect(perms.has("config:write")).toBe(false);
  });

  test("observer includes guest permissions and read-only extras", () => {
    const perms = getPermissionsForRole("observer");
    expect(perms.has("gateway:status")).toBe(true);
    expect(perms.has("account:list")).toBe(true);
    expect(perms.has("audit:read")).toBe(true);
    expect(perms.has("config:read")).toBe(true);
    // Not allowed for observer
    expect(perms.has("account:create")).toBe(false);
    expect(perms.has("config:write")).toBe(false);
    expect(perms.has("gateway:restart")).toBe(false);
  });

  test("operator includes observer permissions and write extras", () => {
    const perms = getPermissionsForRole("operator");
    expect(perms.has("session:revoke")).toBe(true);
    expect(perms.has("config:write")).toBe(true);
    expect(perms.has("audit:export")).toBe(true);
    // Not allowed for operator
    expect(perms.has("account:create")).toBe(false);
    expect(perms.has("gateway:restart")).toBe(false);
  });

  test("admin has all permissions", () => {
    const perms = getPermissionsForRole("admin");
    const adminOnly: Permission[] = [
      "account:create",
      "account:disable",
      "account:enable",
      "account:delete",
      "gateway:restart",
    ];
    for (const p of adminOnly) {
      expect(perms.has(p)).toBe(true);
    }
  });

  test("permission sets are consistent — higher roles are strict supersets", () => {
    const roles: CmmcRole[] = ["guest", "observer", "operator", "admin"];
    for (let i = 0; i < roles.length - 1; i++) {
      const lower = getPermissionsForRole(roles[i]);
      const higher = getPermissionsForRole(roles[i + 1]);
      for (const p of lower) {
        expect(higher.has(p)).toBe(true);
      }
    }
  });
});

describe("roleAtLeast", () => {
  test("same role meets itself", () => {
    expect(roleAtLeast("admin", "admin")).toBe(true);
    expect(roleAtLeast("guest", "guest")).toBe(true);
  });

  test("higher role meets lower minimum", () => {
    expect(roleAtLeast("admin", "observer")).toBe(true);
    expect(roleAtLeast("operator", "guest")).toBe(true);
  });

  test("lower role does not meet higher minimum", () => {
    expect(roleAtLeast("guest", "admin")).toBe(false);
    expect(roleAtLeast("observer", "operator")).toBe(false);
  });
});
