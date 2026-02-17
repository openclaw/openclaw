import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  parseA2AMessage,
  findContract,
  validateContractInput,
  listAgentContracts,
  createA2AMessage,
} from "./a2a-contracts.js";
import type { AgentA2AConfig } from "./a2a-contracts.js";
import { buildAgentToAgentContractContext } from "./sessions-send-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCfgWithContracts(
  agents: Array<{
    id: string;
    contracts?: Record<string, { description?: string; input?: object; output?: object }>;
    allowFreeform?: boolean;
  }>,
): OpenClawConfig {
  return {
    agents: {
      list: agents.map((a) => ({
        id: a.id,
        ...(a.contracts || a.allowFreeform !== undefined
          ? {
              a2a: {
                ...(a.contracts ? { contracts: a.contracts } : {}),
                ...(a.allowFreeform !== undefined ? { allowFreeform: a.allowFreeform } : {}),
              },
            }
          : {}),
      })),
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

const summaryContract = {
  description: "Summarize a document",
  input: {
    type: "object",
    properties: {
      text: { type: "string" },
      maxLength: { type: "integer" },
    },
    required: ["text"],
  },
};

// ---------------------------------------------------------------------------
// End-to-end contract validation pipeline
// ---------------------------------------------------------------------------

describe("A2A contract pipeline (send integration)", () => {
  describe("structured message parsing → contract lookup → validation", () => {
    it("accepts valid structured message with matching contract", () => {
      const cfg = makeCfgWithContracts([
        {
          id: "research-bot",
          contracts: { "research.request": researchContract },
        },
      ]);

      // Step 1: parse the message
      const message = JSON.stringify(
        createA2AMessage("research.request", { query: "test query", depth: "deep" }),
      );
      const structured = parseA2AMessage(message);
      expect(structured).not.toBeNull();
      expect(structured!.contract).toBe("research.request");

      // Step 2: find the contract
      const contract = findContract(cfg, "research-bot", structured!.contract);
      expect(contract).toBeDefined();

      // Step 3: validate the payload
      const validation = validateContractInput(contract!.contract, structured!.payload);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("rejects structured message with invalid payload", () => {
      const cfg = makeCfgWithContracts([
        {
          id: "research-bot",
          contracts: { "research.request": researchContract },
        },
      ]);

      const message = JSON.stringify(createA2AMessage("research.request", { depth: "invalid" }));
      const structured = parseA2AMessage(message)!;
      const contract = findContract(cfg, "research-bot", structured.contract)!;
      const validation = validateContractInput(contract.contract, structured.payload);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("input.query: required field missing");
      expect(validation.errors.some((e) => e.includes("must be one of"))).toBe(true);
    });

    it("rejects unknown contract when agent has contracts declared", () => {
      const cfg = makeCfgWithContracts([
        {
          id: "research-bot",
          contracts: { "research.request": researchContract },
        },
      ]);

      const message = JSON.stringify(createA2AMessage("nonexistent.contract", {}));
      const structured = parseA2AMessage(message)!;

      const contract = findContract(cfg, "research-bot", structured.contract);
      expect(contract).toBeUndefined();

      // Agent has contracts → should show available ones
      const available = listAgentContracts(cfg, "research-bot");
      expect(available).toHaveLength(1);
      expect(available[0].contractName).toBe("research.request");
    });

    it("allows structured message when agent has no contracts (best-effort)", () => {
      const cfg = makeCfgWithContracts([{ id: "generic-bot" }]);

      const message = JSON.stringify(createA2AMessage("any.contract", { data: "hello" }));
      const structured = parseA2AMessage(message)!;

      const contract = findContract(cfg, "generic-bot", structured.contract);
      expect(contract).toBeUndefined();

      // No contracts declared → should allow through
      const agentContracts = listAgentContracts(cfg, "generic-bot");
      expect(agentContracts).toHaveLength(0);
    });
  });

  describe("freeform message rejection", () => {
    it("rejects plain text when agent has allowFreeform=false", () => {
      const cfg = makeCfgWithContracts([
        {
          id: "strict-bot",
          contracts: { "research.request": researchContract },
          allowFreeform: false,
        },
      ]);

      const message = "just a plain text message";
      const structured = parseA2AMessage(message);
      expect(structured).toBeNull();

      // Look up agent's a2a config
      const agents = cfg.agents?.list as Array<Record<string, unknown>>;
      const agent = agents.find((a) => a.id === "strict-bot");
      const a2aCfg = agent?.a2a as AgentA2AConfig | undefined;
      expect(a2aCfg?.allowFreeform).toBe(false);

      const available = listAgentContracts(cfg, "strict-bot");
      expect(available).toHaveLength(1);
    });

    it("allows plain text when agent has allowFreeform=true (default)", () => {
      const cfg = makeCfgWithContracts([
        {
          id: "friendly-bot",
          contracts: { "research.request": researchContract },
        },
      ]);

      const message = "just a plain text message";
      const structured = parseA2AMessage(message);
      expect(structured).toBeNull();

      const agents = cfg.agents?.list as Array<Record<string, unknown>>;
      const agent = agents.find((a) => a.id === "friendly-bot");
      const a2aCfg = agent?.a2a as AgentA2AConfig | undefined;
      // allowFreeform defaults to true (undefined treated as true)
      expect(a2aCfg?.allowFreeform).toBeUndefined();
    });
  });

  describe("contract context injection", () => {
    it("builds contract context with output schema", () => {
      const structured = createA2AMessage("research.request", { query: "test" }, "corr-1");
      const context = buildAgentToAgentContractContext({
        structured,
        contract: researchContract,
      });

      expect(context).toContain('Structured A2A contract invocation: "research.request"');
      expect(context).toContain("Submit a research query");
      expect(context).toContain('"query":"test"');
      expect(context).toContain("Correlation ID: corr-1");
      expect(context).toContain("Expected output schema");
      expect(context).toContain('"findings"');
      expect(context).toContain('"sources"');
    });

    it("builds context without output schema when not defined", () => {
      const structured = createA2AMessage("summary.request", { text: "hello" });
      const context = buildAgentToAgentContractContext({
        structured,
        contract: summaryContract,
      });

      expect(context).toContain('Structured A2A contract invocation: "summary.request"');
      expect(context).not.toContain("Expected output schema");
    });

    it("builds context without correlationId when not provided", () => {
      const structured = createA2AMessage("research.request", { query: "test" });
      const context = buildAgentToAgentContractContext({
        structured,
        contract: researchContract,
      });

      expect(context).not.toContain("Correlation ID");
    });
  });

  describe("multi-contract agent discovery", () => {
    it("discovers all contracts across multiple agents", () => {
      const cfg = makeCfgWithContracts([
        {
          id: "research-bot",
          contracts: {
            "research.request": researchContract,
            "summary.request": summaryContract,
          },
        },
        {
          id: "review-bot",
          contracts: {
            "code.review": { description: "Code review" },
          },
        },
      ]);

      // Research bot has 2 contracts
      const researchContracts = listAgentContracts(cfg, "research-bot");
      expect(researchContracts).toHaveLength(2);
      expect(researchContracts.map((c) => c.contractName)).toEqual([
        "research.request",
        "summary.request",
      ]);

      // Review bot has 1 contract
      const reviewContracts = listAgentContracts(cfg, "review-bot");
      expect(reviewContracts).toHaveLength(1);
      expect(reviewContracts[0].contractName).toBe("code.review");

      // Find specific contract
      expect(findContract(cfg, "research-bot", "summary.request")).toBeDefined();
      expect(findContract(cfg, "review-bot", "research.request")).toBeUndefined();
    });
  });

  describe("contract context payload truncation", () => {
    it("truncates large payloads in contract context", () => {
      const largePayload = "x".repeat(5000);
      const structured = createA2AMessage("test.contract", { data: largePayload });
      const contract = {
        description: "test contract",
        input: { type: "object" as const },
      };

      const context = buildAgentToAgentContractContext({ structured, contract });
      expect(context).toContain("(truncated)");
      // Should not contain the full 5000 char payload
      expect(context.length).toBeLessThan(6000);
    });

    it("does not truncate small payloads", () => {
      const structured = createA2AMessage("test.contract", { msg: "hello" });
      const contract = { description: "small" };

      const context = buildAgentToAgentContractContext({ structured, contract });
      expect(context).not.toContain("(truncated)");
      expect(context).toContain('"msg":"hello"');
    });
  });
});
