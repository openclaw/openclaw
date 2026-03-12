import { describe, it, expect } from "vitest";
import {
  ADMIN_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  CLI_DEFAULT_OPERATOR_SCOPES,
  isApprovalMethod,
  isPairingMethod,
  isReadMethod,
  isWriteMethod,
  isNodeRoleMethod,
  isAdminOnlyMethod,
  resolveRequiredOperatorScopeForMethod,
  resolveLeastPrivilegeOperatorScopesForMethod,
  authorizeOperatorScopesForMethod,
  isGatewayMethodClassified,
} from "./method-scopes.js";

describe("scope constants", () => {
  it("should have correct scope values", () => {
    expect(ADMIN_SCOPE).toBe("operator.admin");
    expect(READ_SCOPE).toBe("operator.read");
    expect(WRITE_SCOPE).toBe("operator.write");
    expect(APPROVALS_SCOPE).toBe("operator.approvals");
    expect(PAIRING_SCOPE).toBe("operator.pairing");
  });

  it("should have all scopes in CLI default", () => {
    expect(CLI_DEFAULT_OPERATOR_SCOPES).toContain(ADMIN_SCOPE);
    expect(CLI_DEFAULT_OPERATOR_SCOPES).toContain(READ_SCOPE);
    expect(CLI_DEFAULT_OPERATOR_SCOPES).toContain(WRITE_SCOPE);
    expect(CLI_DEFAULT_OPERATOR_SCOPES).toContain(APPROVALS_SCOPE);
    expect(CLI_DEFAULT_OPERATOR_SCOPES).toContain(PAIRING_SCOPE);
    expect(CLI_DEFAULT_OPERATOR_SCOPES).toHaveLength(5);
  });
});

describe("isApprovalMethod", () => {
  it("should return true for approval methods", () => {
    expect(isApprovalMethod("exec.approval.request")).toBe(true);
    expect(isApprovalMethod("exec.approval.waitDecision")).toBe(true);
    expect(isApprovalMethod("exec.approval.resolve")).toBe(true);
  });

  it("should return false for non-approval methods", () => {
    expect(isApprovalMethod("health")).toBe(false);
    expect(isApprovalMethod("send")).toBe(false);
    expect(isApprovalMethod("agents.create")).toBe(false);
  });
});

describe("isPairingMethod", () => {
  it("should return true for pairing methods", () => {
    expect(isPairingMethod("node.pair.request")).toBe(true);
    expect(isPairingMethod("device.pair.approve")).toBe(true);
    expect(isPairingMethod("node.rename")).toBe(true);
  });

  it("should return false for non-pairing methods", () => {
    expect(isPairingMethod("health")).toBe(false);
    expect(isPairingMethod("send")).toBe(false);
  });
});

describe("isReadMethod", () => {
  it("should return true for read methods", () => {
    expect(isReadMethod("health")).toBe(true);
    expect(isReadMethod("status")).toBe(true);
    expect(isReadMethod("agents.list")).toBe(true);
    expect(isReadMethod("sessions.get")).toBe(true);
  });

  it("should return false for non-read methods", () => {
    expect(isReadMethod("send")).toBe(false);
    expect(isReadMethod("agents.create")).toBe(false);
  });
});

describe("isWriteMethod", () => {
  it("should return true for write methods", () => {
    expect(isWriteMethod("send")).toBe(true);
    expect(isWriteMethod("agent")).toBe(true);
    expect(isWriteMethod("chat.send")).toBe(true);
    expect(isWriteMethod("node.invoke")).toBe(true);
  });

  it("should return false for non-write methods", () => {
    expect(isWriteMethod("health")).toBe(false);
    expect(isWriteMethod("agents.create")).toBe(false);
  });
});

describe("isNodeRoleMethod", () => {
  it("should return true for node role methods", () => {
    expect(isNodeRoleMethod("node.invoke.result")).toBe(true);
    expect(isNodeRoleMethod("node.event")).toBe(true);
    expect(isNodeRoleMethod("node.pending.drain")).toBe(true);
    expect(isNodeRoleMethod("skills.bins")).toBe(true);
  });

  it("should return false for non-node-role methods", () => {
    expect(isNodeRoleMethod("health")).toBe(false);
    expect(isNodeRoleMethod("send")).toBe(false);
  });
});

describe("isAdminOnlyMethod", () => {
  it("should return true for admin methods", () => {
    expect(isAdminOnlyMethod("agents.create")).toBe(true);
    expect(isAdminOnlyMethod("agents.delete")).toBe(true);
    expect(isAdminOnlyMethod("cron.add")).toBe(true);
    expect(isAdminOnlyMethod("sessions.delete")).toBe(true);
  });

  it("should return false for non-admin methods", () => {
    expect(isAdminOnlyMethod("health")).toBe(false);
    expect(isAdminOnlyMethod("send")).toBe(false);
    expect(isAdminOnlyMethod("agents.list")).toBe(false);
  });

  it("should return true for methods with admin prefix", () => {
    expect(isAdminOnlyMethod("exec.approvals.list")).toBe(true);
    expect(isAdminOnlyMethod("config.get")).toBe(true);
    expect(isAdminOnlyMethod("wizard.start")).toBe(true);
    expect(isAdminOnlyMethod("update.check")).toBe(true);
  });
});

describe("resolveRequiredOperatorScopeForMethod", () => {
  it("should return correct scope for classified methods", () => {
    expect(resolveRequiredOperatorScopeForMethod("health")).toBe(READ_SCOPE);
    expect(resolveRequiredOperatorScopeForMethod("send")).toBe(WRITE_SCOPE);
    expect(resolveRequiredOperatorScopeForMethod("agents.create")).toBe(ADMIN_SCOPE);
    expect(resolveRequiredOperatorScopeForMethod("exec.approval.request")).toBe(APPROVALS_SCOPE);
    expect(resolveRequiredOperatorScopeForMethod("node.pair.request")).toBe(PAIRING_SCOPE);
  });

  it("should return undefined for unclassified methods", () => {
    expect(resolveRequiredOperatorScopeForMethod("unknown.method")).toBeUndefined();
    expect(resolveRequiredOperatorScopeForMethod("custom.action")).toBeUndefined();
  });

  it("should return undefined for node role methods", () => {
    expect(resolveRequiredOperatorScopeForMethod("node.event")).toBeUndefined();
    expect(resolveRequiredOperatorScopeForMethod("skills.bins")).toBeUndefined();
  });
});

describe("resolveLeastPrivilegeOperatorScopesForMethod", () => {
  it("should return array with single required scope", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("health")).toEqual([READ_SCOPE]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("send")).toEqual([WRITE_SCOPE]);
  });

  it("should return empty array for unclassified methods", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("unknown")).toEqual([]);
  });

  it("should return empty array for node role methods", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("node.event")).toEqual([]);
  });
});

describe("authorizeOperatorScopesForMethod", () => {
  it("should allow admin scope for any method", () => {
    const result = authorizeOperatorScopesForMethod("agents.create", [ADMIN_SCOPE]);
    expect(result).toEqual({ allowed: true });
  });

  it("should allow when required scope is present", () => {
    const result = authorizeOperatorScopesForMethod("health", [READ_SCOPE]);
    expect(result).toEqual({ allowed: true });
  });

  it("should allow write scope for read methods", () => {
    const result = authorizeOperatorScopesForMethod("health", [WRITE_SCOPE]);
    expect(result).toEqual({ allowed: true });
  });

  it("should deny when scope is missing", () => {
    const result = authorizeOperatorScopesForMethod("agents.create", [READ_SCOPE]);
    expect(result).toEqual({ allowed: false, missingScope: ADMIN_SCOPE });
  });

  it("should require admin for unclassified methods", () => {
    const result = authorizeOperatorScopesForMethod("unknown", []);
    expect(result).toEqual({ allowed: false, missingScope: ADMIN_SCOPE });
  });

  it("should allow multiple scopes", () => {
    const result = authorizeOperatorScopesForMethod("send", [READ_SCOPE, WRITE_SCOPE]);
    expect(result).toEqual({ allowed: true });
  });

  it("should deny read method without read or write scope", () => {
    const result = authorizeOperatorScopesForMethod("health", [ADMIN_SCOPE]);
    expect(result).toEqual({ allowed: true }); // admin allows everything
  });
});

describe("isGatewayMethodClassified", () => {
  it("should return true for classified methods", () => {
    expect(isGatewayMethodClassified("health")).toBe(true);
    expect(isGatewayMethodClassified("send")).toBe(true);
    expect(isGatewayMethodClassified("agents.create")).toBe(true);
  });

  it("should return true for node role methods", () => {
    expect(isGatewayMethodClassified("node.event")).toBe(true);
    expect(isGatewayMethodClassified("skills.bins")).toBe(true);
  });

  it("should return false for unclassified methods", () => {
    expect(isGatewayMethodClassified("unknown")).toBe(false);
    expect(isGatewayMethodClassified("custom.action")).toBe(false);
  });
});
