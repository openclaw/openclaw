// Covers scope requirements for node pairing approvals.
import { describe, expect, it } from "vitest";
import {
  nodePermissionsRequireAdminApproval,
  resolveNodePairApprovalScopes,
} from "./node-pairing-authz.js";

describe("resolveNodePairApprovalScopes", () => {
  it("requires operator.admin for system.run commands", () => {
    expect(resolveNodePairApprovalScopes(["system.run"])).toEqual([
      "operator.pairing",
      "operator.admin",
    ]);
  });

  it("requires operator.write for non-exec commands", () => {
    expect(resolveNodePairApprovalScopes(["canvas.present"])).toEqual([
      "operator.pairing",
      "operator.write",
    ]);
  });

  it("requires only operator.pairing without commands", () => {
    expect(resolveNodePairApprovalScopes(undefined)).toEqual(["operator.pairing"]);
    expect(resolveNodePairApprovalScopes([])).toEqual(["operator.pairing"]);
  });

  it("requires operator.admin for a COMMANDLESS attach-permission request", () => {
    expect(resolveNodePairApprovalScopes([], { attach: true })).toEqual([
      "operator.pairing",
      "operator.admin",
    ]);
    expect(resolveNodePairApprovalScopes(undefined, { attach: true })).toEqual([
      "operator.pairing",
      "operator.admin",
    ]);
  });

  it("adds operator.admin to a non-exec command request that also grants attach", () => {
    expect(resolveNodePairApprovalScopes(["canvas.present"], { attach: true })).toEqual([
      "operator.pairing",
      "operator.write",
      "operator.admin",
    ]);
  });

  it("does not elevate when attach is absent, false, or non-object", () => {
    expect(resolveNodePairApprovalScopes([], { attach: false })).toEqual(["operator.pairing"]);
    expect(resolveNodePairApprovalScopes([], {})).toEqual(["operator.pairing"]);
    expect(resolveNodePairApprovalScopes([], undefined)).toEqual(["operator.pairing"]);
    expect(resolveNodePairApprovalScopes([], null)).toEqual(["operator.pairing"]);
  });
});

describe("nodePermissionsRequireAdminApproval", () => {
  it("is true only when attach === true", () => {
    expect(nodePermissionsRequireAdminApproval({ attach: true })).toBe(true);
    expect(nodePermissionsRequireAdminApproval({ attach: false })).toBe(false);
    expect(nodePermissionsRequireAdminApproval({ other: true })).toBe(false);
    expect(nodePermissionsRequireAdminApproval(undefined)).toBe(false);
    expect(nodePermissionsRequireAdminApproval(null)).toBe(false);
  });
});
