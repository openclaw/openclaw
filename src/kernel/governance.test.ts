import { describe, it, expect } from "vitest";
import { createHashChainLedger } from "./hash-chain.js";
import {
  createGovernanceGate,
  allowedToolsConstraint,
  authorityLevelConstraint,
  type GovernanceContext,
} from "./governance.js";

describe("GovernanceGate", () => {
  function makeGate() {
    const ledger = createHashChainLedger();
    const gate = createGovernanceGate(ledger);
    return { gate, ledger };
  }

  it("allows when no constraints are registered", () => {
    const { gate } = makeGate();
    const ctx: GovernanceContext = {
      domain: "skill",
      action: "execute:test",
      actor: "user-1",
      meta: {},
    };
    const decision = gate.evaluate(ctx);
    expect(decision.verdict).toBe("allow");
  });

  it("denies when a constraint rejects", () => {
    const { gate } = makeGate();
    gate.addConstraint({
      id: "always-deny",
      evaluate: () => "blocked by test constraint",
    });
    const decision = gate.evaluate({
      domain: "skill",
      action: "execute:test",
      actor: "user-1",
      meta: {},
    });
    expect(decision.verdict).toBe("deny");
    expect(decision.reason).toContain("blocked by test constraint");
  });

  it("logs every decision to the hash chain", () => {
    const { gate, ledger } = makeGate();
    gate.evaluate({ domain: "skill", action: "a", actor: "u", meta: {} });
    gate.evaluate({ domain: "tool", action: "b", actor: "u", meta: {} });
    // 2 decisions logged (constraint registration doesn't count here since none added)
    expect(ledger.length).toBe(2);
  });

  it("fail-closed: errors during evaluation result in deny", () => {
    const { gate } = makeGate();
    gate.addConstraint({
      id: "throws",
      evaluate: () => { throw new Error("kaboom"); },
    });
    const decision = gate.evaluate({
      domain: "skill",
      action: "test",
      actor: "u",
      meta: {},
    });
    expect(decision.verdict).toBe("deny");
    expect(decision.reason).toContain("kaboom");
  });

  it("can remove constraints", () => {
    const { gate } = makeGate();
    gate.addConstraint({ id: "deny-all", evaluate: () => "no" });
    expect(gate.evaluate({ domain: "skill", action: "x", actor: "u", meta: {} }).verdict).toBe("deny");
    gate.removeConstraint("deny-all");
    expect(gate.evaluate({ domain: "skill", action: "x", actor: "u", meta: {} }).verdict).toBe("allow");
  });
});

describe("allowedToolsConstraint", () => {
  it("allows tool in the allowed list", () => {
    const constraint = allowedToolsConstraint();
    const result = constraint.evaluate({
      domain: "skill",
      action: "execute:test",
      actor: "u",
      meta: { allowedTools: ["message", "read"], tool: "message" },
    });
    expect(result).toBeNull();
  });

  it("denies tool not in the allowed list", () => {
    const constraint = allowedToolsConstraint();
    const result = constraint.evaluate({
      domain: "skill",
      action: "execute:test",
      actor: "u",
      meta: { allowedTools: ["message"], tool: "exec" },
    });
    expect(result).toContain("exec");
    expect(result).toContain("not in allowed-tools");
  });

  it("abstains for non-skill domains", () => {
    const constraint = allowedToolsConstraint();
    const result = constraint.evaluate({
      domain: "memory",
      action: "write",
      actor: "u",
      meta: { tool: "exec" },
    });
    expect(result).toBeNull();
  });
});

describe("authorityLevelConstraint", () => {
  it("allows when level meets minimum", () => {
    const constraint = authorityLevelConstraint(2);
    const result = constraint.evaluate({
      domain: "skill",
      action: "x",
      actor: "u",
      meta: { authorityLevel: 3 },
    });
    expect(result).toBeNull();
  });

  it("denies when level is below minimum", () => {
    const constraint = authorityLevelConstraint(5);
    const result = constraint.evaluate({
      domain: "skill",
      action: "x",
      actor: "u",
      meta: { authorityLevel: 2 },
    });
    expect(result).toContain("below minimum");
  });
});
