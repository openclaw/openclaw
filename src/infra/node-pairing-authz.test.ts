// Covers scope requirements for node pairing approvals.
import { describe, expect, it } from "vitest";
import {
  NODE_BROWSER_PROXY_COMMANDS,
  NODE_EXEC_APPROVALS_COMMANDS,
  NODE_SYSTEM_RUN_COMMANDS,
} from "./node-commands.js";
import { resolveNodePairApprovalScopes } from "./node-pairing-authz.js";

describe("resolveNodePairApprovalScopes", () => {
  it.each([NODE_SYSTEM_RUN_COMMANDS[1], NODE_BROWSER_PROXY_COMMANDS[0]])(
    "requires operator.admin for %s commands",
    (command) => {
      expect(resolveNodePairApprovalScopes([command])).toEqual([
        "operator.pairing",
        "operator.admin",
      ]);
    },
  );

  it("keeps dedicated exec-approval commands admin-gated at pairing", () => {
    for (const command of NODE_EXEC_APPROVALS_COMMANDS) {
      expect(resolveNodePairApprovalScopes([command])).toEqual([
        "operator.pairing",
        "operator.admin",
      ]);
    }
  });

  it("treats computer.act pairing approval as non-exec surface approval", () => {
    expect(resolveNodePairApprovalScopes(["computer.act"])).toEqual([
      "operator.pairing",
      "operator.write",
    ]);
  });

  it("requires only operator.pairing without commands", () => {
    expect(resolveNodePairApprovalScopes(undefined)).toEqual(["operator.pairing"]);
    expect(resolveNodePairApprovalScopes([])).toEqual(["operator.pairing"]);
  });
});
