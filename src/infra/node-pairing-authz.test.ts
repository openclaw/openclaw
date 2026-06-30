// Covers scope requirements for node pairing approvals.
import { describe, expect, it } from "vitest";
import { resolveNodePairApprovalScopes } from "./node-pairing-authz.js";

describe("resolveNodePairApprovalScopes", () => {
  it("requires operator.admin for system.run commands", () => {
    expect(resolveNodePairApprovalScopes(["system.run"])).toEqual([
      "operator.pairing",
      "operator.admin",
    ]);
  });

  it("requires operator.admin for exec-approvals commands", () => {
    expect(resolveNodePairApprovalScopes(["system.execApprovals.get"])).toEqual([
      "operator.pairing",
      "operator.admin",
    ]);
    expect(resolveNodePairApprovalScopes(["system.execApprovals.set"])).toEqual([
      "operator.pairing",
      "operator.admin",
    ]);
  });

  it("requires operator.write for non-admin commands", () => {
    expect(resolveNodePairApprovalScopes(["canvas.present"])).toEqual([
      "operator.pairing",
      "operator.write",
    ]);
  });

  it("requires only operator.pairing without commands", () => {
    expect(resolveNodePairApprovalScopes(undefined)).toEqual(["operator.pairing"]);
    expect(resolveNodePairApprovalScopes([])).toEqual(["operator.pairing"]);
  });
});
