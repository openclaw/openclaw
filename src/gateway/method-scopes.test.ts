import { describe, expect, it } from "vitest";
import {
  authorizeOperatorScopesForMethod,
  CLI_DEFAULT_OPERATOR_SCOPES,
  isGatewayMethodClassified,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "./method-scopes.js";
import { coreGatewayHandlers } from "./server-methods.js";

describe("method scope resolution", () => {
  it("classifies sessions.resolve as read and poll as write", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.resolve")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("poll")).toEqual(["operator.write"]);
  });

  it("returns empty scopes for unknown methods", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("totally.unknown.method")).toEqual([]);
  });
});

describe("operator scope authorization", () => {
  it("allows read methods with operator.read or operator.write", () => {
    expect(authorizeOperatorScopesForMethod("health", ["operator.read"])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("health", ["operator.write"])).toEqual({
      allowed: true,
    });
  });

  it("requires operator.write for write methods", () => {
    expect(authorizeOperatorScopesForMethod("send", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.write",
    });
  });

  it("requires approvals scope for approval methods", () => {
    expect(authorizeOperatorScopesForMethod("exec.approval.resolve", ["operator.write"])).toEqual({
      allowed: false,
      missingScope: "operator.approvals",
    });
  });

  it("requires admin for unknown methods", () => {
    expect(authorizeOperatorScopesForMethod("unknown.method", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
  });
});

describe("CLI default operator scopes", () => {
  it("includes read and write scopes for localhost auto-pair", () => {
    expect(CLI_DEFAULT_OPERATOR_SCOPES).toContain("operator.read");
    expect(CLI_DEFAULT_OPERATOR_SCOPES).toContain("operator.write");
    expect(CLI_DEFAULT_OPERATOR_SCOPES).toContain("operator.admin");
    expect(CLI_DEFAULT_OPERATOR_SCOPES).toContain("operator.approvals");
    expect(CLI_DEFAULT_OPERATOR_SCOPES).toContain("operator.pairing");
  });
});

describe("core gateway method classification", () => {
  it("classifies every exposed core gateway handler method", () => {
    const unclassified = Object.keys(coreGatewayHandlers).filter(
      (method) => !isGatewayMethodClassified(method),
    );
    expect(unclassified).toEqual([]);
  });
});
