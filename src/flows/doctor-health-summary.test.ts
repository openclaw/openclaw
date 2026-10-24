import { describe, expect, it, vi } from "vitest";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import {
  createDoctorHealthContribution,
  createDoctorHealthFindingBuffer,
  collectDoctorHealthResultWarnings,
  renderStructuredHealthFindings,
  showDoctorHealthSummary,
} from "./doctor-health-contribution.js";

const { debug } = vi.hoisted(() => ({ debug: vi.fn() }));
// mock-isolation: inspect diagnostic retention without writing the user's log files.
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => ({ debug }) }));

function context(shouldRepair = false): DoctorHealthFlowContext {
  debug.mockClear();
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

  it("retains startup warning receipts after the shared summary queue is drained", () => {
    const ctx = context();
    const { buffer, reportFindings } = createDoctorHealthFindingBuffer(ctx.runtime);
    const rawWarning = "Original migration advisory";
    reportFindings(
      [
        {
          checkId: "example/startup",
          severity: "warning",
          message: "Startup advisory",
          category: "recommended",
        },
      ],
      [rawWarning],
    );
    ctx.healthFindings = buffer.healthFindings;
    showDoctorHealthSummary(ctx);
    expect(buffer.healthFindings).toEqual([]);
    reportFindings([
      { checkId: "example/deferred", severity: "warning", message: "Deferred capture advisory" },
    ]);
    expect(ctx.healthFindings).toBe(buffer.healthFindings);
    expect(
      collectDoctorHealthResultWarnings({
        startupWarnings: buffer.updateWarnings,
      }),
    ).toEqual([rawWarning, "example/deferred: Deferred capture advisory"]);
  });

  it("shows actionable current problems and logs complete background findings", () => {
    const ctx = context();
    const sharedFindings: NonNullable<DoctorHealthFlowContext["healthFindings"]> = [];
    ctx.healthFindings = sharedFindings;
    const findings = [
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
        checkId: "example/healthy",
        severity: "info",
        category: "fix-now",
        message: "Gateway is healthy.",
      },
      {
        checkId: "example/current",
        severity: "error",
        category: "historical",
        message: "Gateway cannot start.",
        path: "gateway.mode",
        fixHint: "Configure Gateway mode.",
      },
      {
        checkId: "example/actionable",
        severity: "warning",
        message: "Credentials expired.",
        fixHint: "Sign in again.",
      },
      {
        checkId: "example/maintainer",
        severity: "error",
        category: "recommended",
        message: "Required plugin failed.",
        fixHint: "Report this failure to the plugin maintainer.",
      },
    ] as const;
    renderStructuredHealthFindings(ctx, findings);
    showDoctorHealthSummary(ctx);
    const output = vi.mocked(ctx.runtime.log).mock.calls.flat().join("\n");
    expect(output).toContain("Fix now:");
    expect(output).toContain("Credentials expired.");
    expect(output).toContain("Next step: Sign in again.");
    expect(output).toContain("Location: gateway.mode");
    expect(ctx.runtime.error).toHaveBeenCalledWith("- Gateway cannot start.");
    expect(ctx.runtime.error).toHaveBeenCalledWith("- Required plugin failed.");
    for (const message of [
      "Original archive retained.",
      "Optional setup improves completion.",
      "Gateway is healthy.",
      "Historical recovery notices:",
      "Recommended improvements:",
    ]) {
      expect(output).not.toContain(message);
    }
    for (const finding of findings) {
      expect(debug).toHaveBeenCalledWith("Doctor finding", {
        ...finding,
        consoleMessage: JSON.stringify(finding),
      });
    }
    expect(output).not.toContain("[warning]");
    showDoctorHealthSummary(ctx);
    expect(ctx.runtime.error).toHaveBeenCalledTimes(2);
    expect(debug).toHaveBeenCalledTimes(findings.length);
    expect(ctx.healthFindings).toBe(sharedFindings);
    expect(sharedFindings).toEqual([]);
  });
});
