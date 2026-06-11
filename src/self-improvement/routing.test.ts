import { describe, expect, it } from "vitest";
import { resolveSelfImprovementRoute } from "./routing.js";

describe("resolveSelfImprovementRoute", () => {
  it("routes implementation findings to the configured Builder Agent fallback", () => {
    const route = resolveSelfImprovementRoute({
      cfg: { agents: { list: [{ id: "codex" }] } },
      category: "model_routing",
    });

    expect(route).toMatchObject({
      role: "builder",
      targetAgentId: "codex",
      targetAgentLabel: "Builder Agent",
    });
  });

  it("routes smoke failures to QA Test Agent metadata", () => {
    const route = resolveSelfImprovementRoute({
      cfg: { agents: { list: [{ id: "telemetry-evaluation-analyst" }] } },
      category: "smoke_failure",
    });

    expect(route).toMatchObject({
      role: "qa",
      targetAgentId: "telemetry-evaluation-analyst",
      targetAgentLabel: "QA Test Agent",
    });
  });

  it("routes broader improvement categories to the intended owners", () => {
    const cfg = {
      agents: {
        list: [
          { id: "program-manager" },
          { id: "memory-knowledge-curator" },
          { id: "qa-test-agent" },
          { id: "codex" },
        ],
      },
    };

    expect(resolveSelfImprovementRoute({ cfg, category: "agent_minimization" }).role).toBe(
      "program_manager",
    );
    expect(resolveSelfImprovementRoute({ cfg, category: "instruction_adherence" }).role).toBe(
      "memory_curator",
    );
    expect(resolveSelfImprovementRoute({ cfg, category: "risk_prevention" }).role).toBe("qa");
    expect(resolveSelfImprovementRoute({ cfg, category: "efficiency_opportunity" }).role).toBe(
      "builder",
    );
  });
});
