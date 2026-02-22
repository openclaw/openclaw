import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createA2AMessage,
  discoverContracts,
  findContract,
  listAgentContracts,
  listDeprecatedContracts,
  parseA2AMessage,
  validateContractInput,
  validateContractOutput,
} from "./a2a-contracts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCfg(agentOverrides: Record<string, unknown>[] = []): OpenClawConfig {
  return {
    agents: {
      list: agentOverrides,
    },
  } as unknown as OpenClawConfig;
}

const researchContract = {
  description: "Submit a research query",
  input: {
    type: "object",
    properties: {
      query: { type: "string" },
      depth: { type: "string", enum: ["shallow", "deep"] },
    },
    required: ["query"],
  },
  output: {
    type: "object",
    properties: {
      findings: { type: "string" },
      sources: { type: "array", items: { type: "string" } },
    },
  },
};

const reviewContract = {
  description: "Request a code review",
  input: {
    type: "object",
    properties: {
      code: { type: "string" },
      language: { type: "string" },
    },
    required: ["code"],
  },
};

// ---------------------------------------------------------------------------
// Contract discovery
// ---------------------------------------------------------------------------

describe("discoverContracts", () => {
  it("returns empty array when no agents configured", () => {
    const contracts = discoverContracts({} as OpenClawConfig);
    expect(contracts).toEqual([]);
  });

  it("returns empty array when no a2a config on agents", () => {
    const cfg = makeCfg([{ id: "bot1" }, { id: "bot2" }]);
    expect(discoverContracts(cfg)).toEqual([]);
  });

  it("discovers contracts from multiple agents", () => {
    const cfg = makeCfg([
      { id: "research-bot", a2a: { contracts: { "research.request": researchContract } } },
      { id: "review-bot", a2a: { contracts: { "code.review": reviewContract } } },
    ]);
    const contracts = discoverContracts(cfg);
    expect(contracts).toHaveLength(2);
    expect(contracts[0]).toMatchObject({
      agentId: "research-bot",
      contractName: "research.request",
    });
    expect(contracts[1]).toMatchObject({
      agentId: "review-bot",
      contractName: "code.review",
    });
  });

  it("skips agents without id", () => {
    const cfg = makeCfg([{ a2a: { contracts: { "orphan.contract": researchContract } } }]);
    expect(discoverContracts(cfg)).toEqual([]);
  });
});

describe("findContract", () => {
  it("finds a specific contract by agent and name", () => {
    const cfg = makeCfg([
      { id: "research-bot", a2a: { contracts: { "research.request": researchContract } } },
    ]);
    const found = findContract(cfg, "research-bot", "research.request");
    expect(found).toBeDefined();
    expect(found?.contract.description).toBe("Submit a research query");
  });

  it("returns undefined for non-existent contract", () => {
    const cfg = makeCfg([
      { id: "research-bot", a2a: { contracts: { "research.request": researchContract } } },
    ]);
    expect(findContract(cfg, "research-bot", "nonexistent")).toBeUndefined();
    expect(findContract(cfg, "nonexistent-bot", "research.request")).toBeUndefined();
  });
});

describe("listAgentContracts", () => {
  it("lists all contracts for a specific agent", () => {
    const cfg = makeCfg([
      {
        id: "multi-bot",
        a2a: {
          contracts: {
            "research.request": researchContract,
            "code.review": reviewContract,
          },
        },
      },
      { id: "other-bot", a2a: { contracts: { "other.task": reviewContract } } },
    ]);
    const contracts = listAgentContracts(cfg, "multi-bot");
    expect(contracts).toHaveLength(2);
    expect(contracts.map((c) => c.contractName)).toEqual(["research.request", "code.review"]);
  });
});

// ---------------------------------------------------------------------------
// Contract validation
// ---------------------------------------------------------------------------

describe("validateContractInput", () => {
  it("accepts valid input", () => {
    const result = validateContractInput(researchContract, {
      query: "test query",
      depth: "deep",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects input with missing required fields", () => {
    const result = validateContractInput(researchContract, { depth: "deep" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("input.query: required field missing");
  });

  it("rejects input with wrong type", () => {
    const result = validateContractInput(researchContract, {
      query: 42,
      depth: "deep",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('expected type "string"');
  });

  it("rejects invalid enum values", () => {
    const result = validateContractInput(researchContract, {
      query: "foo",
      depth: "medium",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("must be one of");
  });

  it("accepts anything when no input schema defined", () => {
    const result = validateContractInput({ description: "no schema" }, "anything");
    expect(result.valid).toBe(true);
  });

  it("rejects non-object when object expected", () => {
    const result = validateContractInput(researchContract, "not an object");
    expect(result.valid).toBe(false);
  });
});

describe("validateContractOutput", () => {
  it("validates array items in output", () => {
    const result = validateContractOutput(researchContract, {
      findings: "found it",
      sources: ["https://example.com", 42],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("output.sources[1]");
  });

  it("accepts valid output", () => {
    const result = validateContractOutput(researchContract, {
      findings: "found it",
      sources: ["https://example.com"],
    });
    expect(result.valid).toBe(true);
  });

  it("accepts anything when no output schema defined", () => {
    const result = validateContractOutput(reviewContract, "anything");
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structured message format
// ---------------------------------------------------------------------------

describe("createA2AMessage", () => {
  it("creates a structured message", () => {
    const msg = createA2AMessage("research.request", { query: "test" });
    expect(msg._a2a).toBe(true);
    expect(msg.contract).toBe("research.request");
    expect(msg.payload).toEqual({ query: "test" });
    expect(msg.correlationId).toBeUndefined();
  });

  it("includes correlationId when provided", () => {
    const msg = createA2AMessage("research.request", { query: "test" }, "corr-123");
    expect(msg.correlationId).toBe("corr-123");
  });
});

describe("parseA2AMessage", () => {
  it("parses a valid structured message", () => {
    const raw = JSON.stringify({
      _a2a: true,
      contract: "research.request",
      payload: { query: "test" },
    });
    const parsed = parseA2AMessage(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.contract).toBe("research.request");
  });

  it("returns null for plain text messages", () => {
    expect(parseA2AMessage("just a regular message")).toBeNull();
  });

  it("returns null for JSON without _a2a marker", () => {
    expect(parseA2AMessage(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  it("returns null for JSON with _a2a=false", () => {
    expect(parseA2AMessage(JSON.stringify({ _a2a: false, contract: "x" }))).toBeNull();
  });

  it("returns null for JSON without contract field", () => {
    expect(parseA2AMessage(JSON.stringify({ _a2a: true }))).toBeNull();
  });

  it("returns null for JSON without payload field", () => {
    expect(parseA2AMessage(JSON.stringify({ _a2a: true, contract: "foo" }))).toBeNull();
  });

  it("accepts message with explicit null payload", () => {
    const result = parseA2AMessage(JSON.stringify({ _a2a: true, contract: "foo", payload: null }));
    expect(result).not.toBeNull();
    expect(result!.contract).toBe("foo");
    expect(result!.payload).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Type validation edge cases
// ---------------------------------------------------------------------------

describe("schema type checks", () => {
  it("validates integer type", () => {
    const contract = {
      input: {
        type: "object",
        properties: {
          count: { type: "integer" },
        },
      },
    };
    expect(validateContractInput(contract, { count: 5 }).valid).toBe(true);
    expect(validateContractInput(contract, { count: 5.5 }).valid).toBe(false);
  });

  it("validates boolean type", () => {
    const contract = {
      input: {
        type: "object",
        properties: {
          flag: { type: "boolean" },
        },
      },
    };
    expect(validateContractInput(contract, { flag: true }).valid).toBe(true);
    expect(validateContractInput(contract, { flag: "true" }).valid).toBe(false);
  });

  it("validates null type", () => {
    const contract = {
      input: { type: "null" },
    };
    expect(validateContractInput(contract, null).valid).toBe(true);
    expect(validateContractInput(contract, undefined).valid).toBe(false);
  });

  it("validates array type", () => {
    const contract = {
      input: { type: "array", items: { type: "number" } },
    };
    expect(validateContractInput(contract, [1, 2, 3]).valid).toBe(true);
    expect(validateContractInput(contract, [1, "two"]).valid).toBe(false);
    expect(validateContractInput(contract, "not array").valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Extended schema constraints
// ---------------------------------------------------------------------------

describe("extended schema constraints", () => {
  it("enforces minLength on strings", () => {
    const contract = { input: { type: "string", minLength: 3 } };
    expect(validateContractInput(contract, "ab").valid).toBe(false);
    expect(validateContractInput(contract, "abc").valid).toBe(true);
  });

  it("enforces maxLength on strings", () => {
    const contract = { input: { type: "string", maxLength: 5 } };
    expect(validateContractInput(contract, "hello").valid).toBe(true);
    expect(validateContractInput(contract, "toolong").valid).toBe(false);
  });

  it("enforces pattern on strings", () => {
    const contract = { input: { type: "string", pattern: "^[A-Z]+$" } };
    expect(validateContractInput(contract, "HELLO").valid).toBe(true);
    expect(validateContractInput(contract, "hello").valid).toBe(false);
  });

  it("ignores invalid regex in pattern gracefully", () => {
    const contract = { input: { type: "string", pattern: "[invalid" } };
    // Should not throw — just skip the pattern check
    expect(validateContractInput(contract, "anything").valid).toBe(true);
  });

  it("enforces minimum on numbers", () => {
    const contract = { input: { type: "number", minimum: 0 } };
    expect(validateContractInput(contract, 5).valid).toBe(true);
    expect(validateContractInput(contract, 0).valid).toBe(true);
    expect(validateContractInput(contract, -1).valid).toBe(false);
  });

  it("enforces maximum on numbers", () => {
    const contract = { input: { type: "number", maximum: 100 } };
    expect(validateContractInput(contract, 50).valid).toBe(true);
    expect(validateContractInput(contract, 100).valid).toBe(true);
    expect(validateContractInput(contract, 101).valid).toBe(false);
  });

  it("enforces additionalProperties: false", () => {
    const contract = {
      input: {
        type: "object",
        properties: { name: { type: "string" } },
        additionalProperties: false,
      },
    };
    expect(validateContractInput(contract, { name: "ok" }).valid).toBe(true);
    const result = validateContractInput(contract, { name: "ok", extra: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("unknown property");
  });

  it("allows extra props when additionalProperties not set", () => {
    const contract = {
      input: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    };
    expect(validateContractInput(contract, { name: "ok", extra: 1 }).valid).toBe(true);
  });

  it("enforces minItems on arrays", () => {
    const contract = { input: { type: "array", items: { type: "number" }, minItems: 2 } };
    expect(validateContractInput(contract, [1]).valid).toBe(false);
    expect(validateContractInput(contract, [1, 2]).valid).toBe(true);
  });

  it("enforces maxItems on arrays", () => {
    const contract = { input: { type: "array", items: { type: "number" }, maxItems: 3 } };
    expect(validateContractInput(contract, [1, 2, 3]).valid).toBe(true);
    expect(validateContractInput(contract, [1, 2, 3, 4]).valid).toBe(false);
  });

  it("combines multiple string constraints", () => {
    const contract = { input: { type: "string", minLength: 2, maxLength: 5, pattern: "^[a-z]+$" } };
    expect(validateContractInput(contract, "ab").valid).toBe(true);
    expect(validateContractInput(contract, "a").valid).toBe(false); // too short
    expect(validateContractInput(contract, "abcdef").valid).toBe(false); // too long
    expect(validateContractInput(contract, "AB").valid).toBe(false); // pattern fail
  });
});

// ---------------------------------------------------------------------------
// Contract versioning & deprecation
// ---------------------------------------------------------------------------

describe("contract versioning", () => {
  it("version field is preserved on contract", () => {
    const cfg = makeCfg([
      {
        id: "agent-a",
        a2a: {
          contracts: {
            research: { ...researchContract, version: "2.1.0" },
          },
        },
      },
    ]);

    const found = findContract(cfg, "agent-a", "research");
    expect(found?.contract.version).toBe("2.1.0");
  });

  it("version defaults to undefined when not set", () => {
    const cfg = makeCfg([
      {
        id: "agent-a",
        a2a: { contracts: { research: researchContract } },
      },
    ]);

    const found = findContract(cfg, "agent-a", "research");
    expect(found?.contract.version).toBeUndefined();
  });
});

describe("contract deprecation", () => {
  const deprecatedContract = {
    ...researchContract,
    deprecated: true,
    deprecatedMessage: "Use research-v2 instead",
    supersededBy: "research-v2",
  };

  it("listDeprecatedContracts returns only deprecated contracts", () => {
    const cfg = makeCfg([
      {
        id: "agent-a",
        a2a: {
          contracts: {
            research: researchContract,
            "old-research": deprecatedContract,
          },
        },
      },
    ]);

    const deprecated = listDeprecatedContracts(cfg);
    expect(deprecated).toHaveLength(1);
    expect(deprecated[0].contractName).toBe("old-research");
  });

  it("listDeprecatedContracts returns empty when no deprecated contracts", () => {
    const cfg = makeCfg([
      {
        id: "agent-a",
        a2a: { contracts: { research: researchContract } },
      },
    ]);

    expect(listDeprecatedContracts(cfg)).toHaveLength(0);
  });

  it("validateContractInput emits deprecation warnings", () => {
    const result = validateContractInput(deprecatedContract, { query: "test" });
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain("Use research-v2 instead");
    expect(result.warnings).toContain('Use "research-v2" instead.');
  });

  it("validateContractInput emits default deprecation message when none specified", () => {
    const contract = { ...researchContract, deprecated: true };
    const result = validateContractInput(contract, { query: "test" });
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain("This contract is deprecated.");
  });

  it("validateContractOutput emits deprecation warnings", () => {
    const result = validateContractOutput(deprecatedContract, {
      findings: "result",
      sources: ["a"],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings[0]).toBe("Use research-v2 instead");
  });

  it("non-deprecated contract returns no warnings", () => {
    const result = validateContractInput(researchContract, { query: "test" });
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("deprecated contract with invalid input returns both errors and warnings", () => {
    const result = validateContractInput(deprecatedContract, {});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
