import { describe, expect, it, vi } from "vitest";
import type { ClawRemovePlan } from "../claws/lifecycle-remove-contract.js";
import type { RuntimeEnv } from "../runtime.js";
import { logClawRemovePlanSummary } from "./claws-cli.plan-console.js";

describe("logClawRemovePlanSummary", () => {
  it("discloses every action and redacts set values", () => {
    const plan: ClawRemovePlan = {
      schemaVersion: "openclaw.clawRemovePlan.v1",
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      planIntegrity: "sha256:remove-plan",
      target: "demo-agent",
      actions: [
        {
          kind: "configReference",
          id: "demo-agent",
          action: "set",
          target: "agents.defaults.fallbacks",
          blocked: false,
          details: { value: ["https://example.test/?token=secret-token"] },
        },
        {
          kind: "workspace",
          id: "demo-agent",
          action: "retain",
          target: "C:\\workspace",
          blocked: true,
          reason: "still referenced",
        },
      ],
      blockers: [],
    };
    const lines: string[] = [];
    const runtime: RuntimeEnv = {
      log: (value) => lines.push(String(value)),
      error: vi.fn(),
      exit: vi.fn(),
    };

    logClawRemovePlanSummary(plan, runtime);

    const output = lines.join("\n");
    expect(output).toContain("Remove actions: 2");
    expect(output).toContain("Plan integrity: sha256:remove-plan");
    expect(output).toContain(
      "configReference agents.defaults.fallbacks: set; status=ready; value=",
    );
    expect(output).toContain(
      "workspace C:\\workspace: retain; status=blocked; reason=still referenced",
    );
    expect(output).not.toContain("secret-token");
  });
});
