import { describe, expect, it, vi } from "vitest";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import { createDoctorHealthFlowContext } from "./doctor-health-context.test-support.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import {
  createDoctorHealthContribution,
  createDoctorHealthFindingBuffer,
  collectDoctorHealthResultWarnings,
  renderStructuredHealthFindings,
  showDoctorHealthSummary,
} from "./doctor-health-contribution.js";
import type { HealthFinding } from "./health-checks.js";

const { debug } = vi.hoisted(() => ({ debug: vi.fn() }));
// mock-isolation: inspect diagnostic retention without writing the user's log files.
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => ({ debug }) }));

function context(shouldRepair = false): DoctorHealthFlowContext {
  debug.mockClear();
  const ctx = createDoctorHealthFlowContext();
  ctx.prompter = createDoctorPrompter({
    runtime: ctx.runtime,
    options: { nonInteractive: true, repair: shouldRepair },
  });
  return ctx;
}

function finding(
  id: string,
  severity: HealthFinding["severity"],
  message: string,
  extra: Partial<HealthFinding> = {},
): HealthFinding {
  return { checkId: `example/${id}`, severity, message, ...extra };
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
              warnings: ["structured warning"],
            };
          },
        },
      });
      await contribution.run(ctx);
      showDoctorHealthSummary(ctx);
      const output = vi.mocked(ctx.runtime.log).mock.calls.flat().join("\n");
      if (repair) {
        expect(ctx.cfg.gateway?.mode).toBe("local");
        expect(ctx.cfgForPersistence).toEqual({});
        expect(ctx.runtime.error).toHaveBeenCalledWith("structured warning");
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
      [finding("startup", "warning", "Startup advisory", { category: "recommended" })],
      [rawWarning],
    );
    ctx.healthFindings = buffer.healthFindings;
    showDoctorHealthSummary(ctx);
    expect(buffer.healthFindings).toEqual([]);
    reportFindings([finding("deferred", "warning", "Deferred capture advisory")]);
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
      finding("archive", "warning", "Original archive retained.", {
        category: "historical",
        fixHint: "No action needed if conversations are visible.",
      }),
      finding("setup", "warning", "Optional setup improves completion.", {
        category: "recommended",
        fixHint: "Enable completion if wanted.",
      }),
      finding("healthy", "info", "Gateway is healthy.", {
        category: "fix-now",
      }),
      finding("current", "error", "Gateway cannot start.", {
        category: "historical",
        path: "gateway.mode",
        fixHint: "Configure Gateway mode.",
      }),
      finding("actionable", "warning", "Credentials expired.", {
        fixHint: "Sign in again.",
      }),
      finding("maintainer", "error", "Required plugin failed.", {
        category: "recommended",
        fixHint: "Report this failure to the plugin maintainer.",
      }),
    ];
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
    for (const entry of findings) {
      expect(debug).toHaveBeenCalledWith("Doctor finding", {
        ...entry,
        consoleMessage: JSON.stringify(entry),
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
