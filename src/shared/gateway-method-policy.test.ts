import { describe, expect, it } from "vitest";
import {
  normalizePluginGatewayMethodScope,
  resolveReservedGatewayMethodScope,
} from "./gateway-method-policy.js";

describe("resolveReservedGatewayMethodScope", () => {
  it("returns operator.admin for exec.approvals methods", () => {
    expect(resolveReservedGatewayMethodScope("exec.approvals.list")).toBe("operator.admin");
    expect(resolveReservedGatewayMethodScope("exec.approvals.update")).toBe("operator.admin");
  });

  it("returns operator.admin for config methods", () => {
    expect(resolveReservedGatewayMethodScope("config.get")).toBe("operator.admin");
    expect(resolveReservedGatewayMethodScope("config.set")).toBe("operator.admin");
  });

  it("returns operator.admin for wizard methods", () => {
    expect(resolveReservedGatewayMethodScope("wizard.setup")).toBe("operator.admin");
  });

  it("returns operator.admin for update methods", () => {
    expect(resolveReservedGatewayMethodScope("update.run")).toBe("operator.admin");
  });

  it("returns undefined for non-reserved methods", () => {
    expect(resolveReservedGatewayMethodScope("tasks.list")).toBeUndefined();
    expect(resolveReservedGatewayMethodScope("chat.send")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(resolveReservedGatewayMethodScope("")).toBeUndefined();
  });
});

describe("normalizePluginGatewayMethodScope", () => {
  it("passes through non-reserved methods unchanged", () => {
    const result = normalizePluginGatewayMethodScope("tasks.list", "some.scope");
    expect(result.scope).toBe("some.scope");
    expect(result.coercedToReservedAdmin).toBe(false);
  });

  it("keeps reserved scope when plugin already uses it", () => {
    const result = normalizePluginGatewayMethodScope("config.get", "operator.admin");
    expect(result.scope).toBe("operator.admin");
    expect(result.coercedToReservedAdmin).toBe(false);
  });

  it("coerces plugin scope to reserved admin for reserved methods", () => {
    const result = normalizePluginGatewayMethodScope("exec.approvals.list", "some.scope");
    expect(result.scope).toBe("operator.admin");
    expect(result.coercedToReservedAdmin).toBe(true);
  });

  it("passes through undefined scope", () => {
    const result = normalizePluginGatewayMethodScope("config.get", undefined);
    expect(result.scope).toBeUndefined();
    expect(result.coercedToReservedAdmin).toBe(false);
  });
});
