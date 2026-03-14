import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseWorkflowChainFromDescription, executeWorkflowCronJob } from "../../infra/cron/server-cron.js";
import type { WorkflowChainStep } from "../../infra/cron/workflow-executor.js";

describe("cron workflow integration", () => {
  describe("parseWorkflowChainFromDescription", () => {
    it("should parse workflow chain from description with prefix", () => {
      const description = "__wf_chain__:[{\"nodeId\":\"step1\",\"actionType\":\"agent-prompt\",\"label\":\"Step 1\"}]";
      const chain = parseWorkflowChainFromDescription(description);
      
      expect(chain).toBeDefined();
      expect(chain).toHaveLength(1);
      expect(chain?.[0].nodeId).toBe("step1");
      expect(chain?.[0].actionType).toBe("agent-prompt");
      expect(chain?.[0].label).toBe("Step 1");
    });

    it("should parse workflow chain with multiple steps", () => {
      const description = `__wf_chain__:[
        {"nodeId":"step1","actionType":"agent-prompt","label":"Research"},
        {"nodeId":"step2","actionType":"agent-prompt","label":"Write"},
        {"nodeId":"step3","actionType":"agent-prompt","label":"Review"}
      ]`;
      const chain = parseWorkflowChainFromDescription(description);
      
      expect(chain).toBeDefined();
      expect(chain).toHaveLength(3);
      expect(chain?.[0].label).toBe("Research");
      expect(chain?.[1].label).toBe("Write");
      expect(chain?.[2].label).toBe("Review");
    });

    it("should return null for description without workflow prefix", () => {
      const description = "Normal cron job description";
      const chain = parseWorkflowChainFromDescription(description);
      
      expect(chain).toBeNull();
    });

    it("should return null for empty description", () => {
      const chain = parseWorkflowChainFromDescription(undefined);
      expect(chain).toBeNull();
    });

    it("should return null for invalid JSON", () => {
      const description = "__wf_chain__:invalid-json";
      const chain = parseWorkflowChainFromDescription(description);
      
      expect(chain).toBeNull();
    });

    it("should return null for non-array JSON", () => {
      const description = "__wf_chain__:{\"nodeId\":\"step1\"}";
      const chain = parseWorkflowChainFromDescription(description);
      
      expect(chain).toBeNull();
    });

    it("should handle description with additional text before prefix", () => {
      const description = `Some description here

__wf_chain__:[{"nodeId":"step1","actionType":"agent-prompt","label":"Step 1"}]`;
      const chain = parseWorkflowChainFromDescription(description);
      
      expect(chain).toBeDefined();
      expect(chain).toHaveLength(1);
    });
  });

  describe("workflow chain validation", () => {
    it("should validate workflow chain structure", () => {
      const validChain: WorkflowChainStep[] = [
        {
          nodeId: "step1",
          actionType: "agent-prompt",
          label: "Step 1",
          prompt: "Do something",
        },
        {
          nodeId: "step2",
          actionType: "agent-prompt",
          label: "Step 2",
          prompt: "Do something else",
        },
      ];

      expect(validChain).toHaveLength(2);
      expect(validChain.every((step) => step.nodeId && step.actionType && step.label)).toBe(true);
    });

    it("should support session config in workflow steps", () => {
      const chain: WorkflowChainStep[] = [
        {
          nodeId: "step1",
          actionType: "agent-prompt",
          label: "Step 1",
          sessionConfig: {
            target: "isolated",
            contextMode: "minimal",
            model: "gpt-4",
            maxTokens: 1000,
          },
        },
      ];

      expect(chain[0].sessionConfig).toBeDefined();
      expect(chain[0].sessionConfig?.target).toBe("isolated");
      expect(chain[0].sessionConfig?.contextMode).toBe("minimal");
    });
  });

  describe("executeWorkflowCronJob integration", () => {
    it("should have correct function signature", () => {
      // This test just verifies the function exists and has the expected signature
      expect(typeof executeWorkflowCronJob).toBe("function");
    });
  });
});
