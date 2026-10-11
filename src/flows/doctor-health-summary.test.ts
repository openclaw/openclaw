import { describe, expect, it, vi } from "vitest";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import {
  createDoctorHealthContribution,
  renderStructuredHealthFindings,
  showDoctorHealthSummary,
} from "./doctor-health-contribution.js";

function context(shouldRepair = false): DoctorHealthFlowContext {
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  return {
    runtime,
    options: {},
    prompter: createDoctorPrompter({
      runtime,
      options: { nonInteractive: true, repair: shouldRepair },
    }),
    cfg: {},
    cfgForPersistence: {},
    configResult: { cfg: {} },
    sourceConfigValid: true,
    configPath: "/example/openclaw.json",
  };
}

describe("Doctor current-state summary", () => {
  it.each([false, true])(
    "reports the verified result after a config repair (repair: %s)",
    async (repair) => {
      const ctx = context(repair);
      const contribution = createDoctorHealthContribution("doctor:example", "Example", {
        healthChecks: {
          description: "Gateway mode is set",
          async detect({ cfg }) {
            return cfg.gateway?.mode
              ? []
              : [
                  {
                    checkId: "core/doctor/example",
                    severity: "warning" as const,
                    message: "Gateway mode is missing.",
                    fixHint: "Configure Gateway mode.",
                  },
                ];
          },
          async repair({ cfg }) {
            return {
              config: { ...cfg, gateway: { mode: "local" as const } },
              changes: ["Configured Gateway mode."],
            };
          },
        },
      });
      await contribution.run(ctx);
      showDoctorHealthSummary(ctx);
      const output = vi.mocked(ctx.runtime.log).mock.calls.flat().join("\n");
      if (repair) {
        expect(ctx.cfg.gateway?.mode).toBe("local");
        expect(ctx.configResult.pendingChangePanels).toContain("Configured Gateway mode.");
        expect(output).not.toContain("Configured Gateway mode.");
        expect(output).not.toContain("Gateway mode is missing.");
        expect(output).not.toContain("Fix now:");
      } else {
        expect(output).toContain("Fix now:");
        expect(output).toContain("Gateway mode is missing.");
        expect(output).toContain("Next step: Configure Gateway mode.");
      }
    },
  );

  it("prioritizes current failures and explains history without diagnostic severity labels", () => {
    const ctx = context();
    const sharedFindings: NonNullable<DoctorHealthFlowContext["healthFindings"]> = [];
    ctx.healthFindings = sharedFindings;
    renderStructuredHealthFindings(ctx, [
      {
        checkId: "example/archive",
        severity: "warning",
        category: "historical",
        message: "Original archive retained.",
        fixHint: "No action needed if conversations are visible.",
      },
      {
        checkId: "example/setup",
        severity: "warning",
        category: "recommended",
        message: "Optional setup improves completion.",
        fixHint: "Enable completion if wanted.",
      },
      {
        checkId: "example/current",
        severity: "error",
        message: "Gateway cannot start.",
        path: "gateway.mode",
        fixHint: "Configure Gateway mode.",
      },
    ]);
    showDoctorHealthSummary(ctx);
    const output = vi.mocked(ctx.runtime.log).mock.calls.flat().join("\n");
    expect(output.indexOf("Fix now:")).toBeLessThan(output.indexOf("Recommended improvements:"));
    expect(output.indexOf("Recommended improvements:")).toBeLessThan(
      output.indexOf("Historical recovery notices:"),
    );
    expect(ctx.runtime.error).toHaveBeenCalledWith("- Gateway cannot start.");
    expect(output).toContain("Location: gateway.mode");
    expect(output).toContain("Next step: No action needed if conversations are visible.");
    expect(output).not.toContain("[warning]");
    expect(output).not.toContain("example/archive");
    showDoctorHealthSummary(ctx);
    expect(ctx.runtime.error).toHaveBeenCalledOnce();
    expect(ctx.healthFindings).toBe(sharedFindings);
    expect(sharedFindings).toEqual([]);
  });
});
