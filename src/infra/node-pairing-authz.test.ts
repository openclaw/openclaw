import { describe, expect, it } from "vitest";
import { resolveNodePairApprovalScopes } from "./node-pairing-authz.js";

describe("resolveNodePairApprovalScopes", () => {
  // All node approvals require only operator.pairing scope to enable
  // automation workflows that cannot obtain operator.admin.
  // See: https://github.com/openclaw/openclaw/issues/84144

  it("requires only operator.pairing for system.run commands", () => {
    expect(resolveNodePairApprovalScopes(["system.run"])).toEqual(["operator.pairing"]);
  });

  it("requires only operator.pairing for non-exec commands", () => {
    expect(resolveNodePairApprovalScopes(["canvas.present"])).toEqual(["operator.pairing"]);
  });

  it("requires only operator.pairing without commands", () => {
    expect(resolveNodePairApprovalScopes(undefined)).toEqual(["operator.pairing"]);
    expect(resolveNodePairApprovalScopes([])).toEqual(["operator.pairing"]);
  });
});
