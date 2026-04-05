import { describe, it, expect } from "vitest";
import { createHashChainLedger } from "../kernel/hash-chain.js";
import { createGovernanceGate } from "../kernel/governance.js";
import { createSkillRegistry } from "./skill-registry.js";
import type { SkillCausalContract } from "./skill-contract.js";

function setup() {
  const ledger = createHashChainLedger();
  const gate = createGovernanceGate(ledger);
  const registry = createSkillRegistry(gate, ledger);
  return { ledger, gate, registry };
}

function makeContract(id: string, overrides?: Partial<SkillCausalContract>): SkillCausalContract {
  return {
    skillId: id,
    description: `Test skill ${id}`,
    allowedTools: ["message"],
    requiredConfig: [],
    requiredEnv: [],
    minAuthorityLevel: 0,
    mutatesState: false,
    ...overrides,
  };
}

describe("SkillRegistry", () => {
  it("registers a skill and makes it available", () => {
    const { registry } = setup();
    const contract = makeContract("discord");
    const decision = registry.register(contract, "admin");
    expect(decision.verdict).toBe("allow");
    expect(registry.isAvailable("discord")).toBe(true);
  });

  it("lists registered skills", () => {
    const { registry } = setup();
    registry.register(makeContract("a"), "admin");
    registry.register(makeContract("b"), "admin");
    expect(registry.list()).toHaveLength(2);
  });

  it("unregisters a skill", () => {
    const { registry } = setup();
    registry.register(makeContract("x"), "admin");
    expect(registry.unregister("x", "admin")).toBe(true);
    expect(registry.isAvailable("x")).toBe(false);
  });

  it("disables and enables a skill", () => {
    const { registry } = setup();
    registry.register(makeContract("s"), "admin");
    expect(registry.isAvailable("s")).toBe(true);

    registry.disable("s", "admin");
    expect(registry.isAvailable("s")).toBe(false);

    registry.enable("s", "admin");
    expect(registry.isAvailable("s")).toBe(true);
  });

  it("listEnabled only returns enabled skills", () => {
    const { registry } = setup();
    registry.register(makeContract("a"), "admin");
    registry.register(makeContract("b"), "admin");
    registry.disable("b", "admin");
    expect(registry.listEnabled()).toHaveLength(1);
    expect(registry.listEnabled()[0]!.contract.skillId).toBe("a");
  });

  it("respects governance gate denial", () => {
    const { gate, registry } = setup();
    gate.addConstraint({
      id: "deny-all",
      evaluate: () => "no registrations allowed",
    });
    const decision = registry.register(makeContract("blocked"), "user");
    expect(decision.verdict).toBe("deny");
    expect(registry.isAvailable("blocked")).toBe(false);
  });

  it("logs all registry operations to the hash chain", () => {
    const { ledger, registry } = setup();
    registry.register(makeContract("s"), "admin");
    registry.disable("s", "admin");
    registry.enable("s", "admin");
    registry.unregister("s", "admin");
    // governance decision + register + disable + enable + unregister = 5 entries
    // (governance gate also logs its allow decision)
    expect(ledger.length).toBeGreaterThanOrEqual(4);
    expect(ledger.verify()).toBe(-1); // chain integrity intact
  });
});
