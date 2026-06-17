// Doctor lint tests cover health-check registry integration and lint warning output.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetCoreHealthChecksForTest } from "../flows/doctor-core-checks.js";
import { clearHealthChecksForTest, registerHealthCheck } from "../flows/health-check-registry.js";
import { runDoctorLintCli, runDoctorSelectedRepairCli } from "./doctor-lint.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
  logConfigUpdated: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  replaceConfigFile: mocks.replaceConfigFile,
}));

vi.mock("../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("runDoctorLintCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearHealthChecksForTest();
    resetCoreHealthChecksForTest();
  });

  it("bases exit code on the selected severity threshold", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: "/tmp/openclaw.json",
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        json: true,
        severityMin: "error",
        onlyIds: ["core/doctor/final-config-validation"],
      });

      expect(exitCode).toBe(0);
      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
      expect(String(stdout.mock.calls.at(-1)?.[0])).toContain('"findings":[]');
    } finally {
      stdout.mockRestore();
    }
  });

  it("reports the visible finding count in human output", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: "/tmp/openclaw.json",
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        severityMin: "error",
        onlyIds: ["core/doctor/final-config-validation"],
      });

      expect(exitCode).toBe(0);
      expect(String(stdout.mock.calls[0]?.[0])).toContain("0 finding(s)");
      expect(String(stdout.mock.calls[1]?.[0])).toBe("  no findings\n");
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalIsTTY });
      stdout.mockRestore();
    }
  });

  it("renders plain-English explain output for visible findings", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: "/tmp/openclaw.json",
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        explain: true,
        nonInteractive: true,
        onlyIds: ["core/doctor/gateway-config"],
      });

      const output = stdout.mock.calls.map((call) => String(call[0])).join("");
      expect(exitCode).toBe(1);
      expect(output).toContain("doctor --explain:");
      expect(output).toContain("What happened:");
      expect(output).toContain("Why it matters:");
      expect(output).toContain("Try this:");
      expect(output).toContain("Automatic repair: Not available");
      expect(output).toContain("core/doctor/gateway-config");
    } finally {
      stdout.mockRestore();
    }
  });

  it("emits structured JSON for invalid config snapshots", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
      path: "/tmp/openclaw.json",
      issues: [{ path: "gateway.mode", message: "Required" }],
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, { json: true });

      expect(exitCode).toBe(1);
      const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
      expect(payload).toMatchObject({
        ok: false,
        checksRun: 1,
        findings: [
          {
            checkId: "core/doctor/final-config-validation",
            severity: "error",
            message: "Required",
            path: "gateway.mode",
          },
        ],
      });
      expect(runtime.error).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });

  it("rejects unknown --only health check ids instead of reporting a false-clean run", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: "/tmp/openclaw.json",
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        json: true,
        onlyIds: ["core/doctor/session-locks"],
      });

      expect(exitCode).toBe(1);
      const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
      expect(payload).toMatchObject({
        ok: false,
        checksRun: 0,
        findings: [
          {
            checkId: "core/doctor/lint-selection",
            severity: "error",
            path: "core/doctor/session-locks",
          },
        ],
      });
    } finally {
      stdout.mockRestore();
    }
  });

  it("reports disabled Codex plugin routes through doctor lint", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "gpt-5.5",
            },
          },
        },
      } as unknown as OpenClawConfig,
      path: "/tmp/openclaw.json",
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        json: true,
        onlyIds: ["core/doctor/codex-session-routes"],
      });

      expect(exitCode).toBe(1);
      const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
      expect(payload).toMatchObject({
        ok: false,
        checksRun: 1,
        findings: [
          {
            checkId: "core/doctor/codex-session-routes",
            severity: "warning",
            path: "agents.defaults.model.primary",
            target: "openai/gpt-5.5",
          },
        ],
      });
      expect(payload.findings[0].message).toContain("Codex plugin is disabled by config");
      expect(payload.findings[0].fixHint).toContain("openclaw doctor --fix");
    } finally {
      stdout.mockRestore();
    }
  });

  it("rejects invalid severity thresholds", async () => {
    await expect(runDoctorLintCli(runtime, { severityMin: "warnng" })).rejects.toThrow(
      "Invalid --severity-min value",
    );
  });

  it("prompts explain users for repairable checks and applies focused repair when confirmed", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: "/tmp/openclaw.json",
    });
    registerHealthCheck({
      id: "test/repairable-explain",
      kind: "core",
      description: "repairable explain",
      focusedRepair: true,
      async detect(ctx) {
        return ctx.cfg.gateway?.mode === "local"
          ? []
          : [
              {
                checkId: "test/repairable-explain",
                severity: "warning",
                message: "Gateway mode is missing.",
                path: "gateway.mode",
                fixHint: "Run `openclaw doctor --fix --only test/repairable-explain`.",
              },
            ];
      },
      async repair(ctx) {
        return {
          config: { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, mode: "local" } },
          changes: ["Set gateway.mode to local."],
        };
      },
    });
    const confirmRepairCheck = vi.fn().mockResolvedValue(true);

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        explain: true,
        onlyIds: ["test/repairable-explain"],
        confirmRepairCheck,
      });

      expect(exitCode).toBe(1);
      expect(confirmRepairCheck).toHaveBeenCalledWith({
        checkId: "test/repairable-explain",
        label: "Repairable Explain",
        findings: [
          expect.objectContaining({
            checkId: "test/repairable-explain",
            path: "gateway.mode",
          }),
        ],
      });
      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          nextConfig: expect.objectContaining({
            gateway: expect.objectContaining({ mode: "local" }),
          }),
          afterWrite: { mode: "auto" },
        }),
      );
      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(1);
      const output = stdout.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("Automatic repair: Run openclaw doctor --fix --only");
      expect(output).toContain("doctor --fix --only: 1 change(s)");
    } finally {
      stdout.mockRestore();
    }
  });

  it("does not prompt for explain repairs in non-interactive mode", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: "/tmp/openclaw.json",
    });
    registerHealthCheck({
      id: "test/non-interactive-repairable",
      kind: "core",
      description: "repairable explain",
      focusedRepair: true,
      async detect() {
        return [
          {
            checkId: "test/non-interactive-repairable",
            severity: "warning",
            message: "Needs repair.",
          },
        ];
      },
      async repair() {
        return { changes: ["Ran repair."] };
      },
    });
    const confirmRepairCheck = vi.fn().mockResolvedValue(true);

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runDoctorLintCli(runtime, {
        explain: true,
        nonInteractive: true,
        onlyIds: ["test/non-interactive-repairable"],
        confirmRepairCheck,
      });

      expect(confirmRepairCheck).not.toHaveBeenCalled();
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });

  it("does not advertise repair hooks that are not focused repair capable", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: "/tmp/openclaw.json",
    });
    registerHealthCheck({
      id: "test/legacy-repair-hook",
      kind: "core",
      description: "legacy repair hook",
      async detect() {
        return [
          {
            checkId: "test/legacy-repair-hook",
            severity: "warning",
            message: "Legacy repair owns this finding.",
          },
        ];
      },
      async repair(ctx) {
        return {
          config: { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, mode: "local" } },
          changes: ["Set gateway.mode to local."],
        };
      },
    });
    const confirmRepairCheck = vi.fn().mockResolvedValue(true);

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const explainExitCode = await runDoctorLintCli(runtime, {
        explain: true,
        onlyIds: ["test/legacy-repair-hook"],
        confirmRepairCheck,
      });
      const repairExitCode = await runDoctorSelectedRepairCli(runtime, {
        onlyIds: ["test/legacy-repair-hook"],
      });

      expect(explainExitCode).toBe(1);
      expect(repairExitCode).toBe(1);
      expect(confirmRepairCheck).not.toHaveBeenCalled();
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
      expect(stdout.mock.calls.map((call) => String(call[0])).join("")).toContain(
        "Automatic repair: Not available",
      );
      expect(runtime.error).toHaveBeenCalledWith(
        "Health check test/legacy-repair-hook does not support automatic repair.",
      );
    } finally {
      stdout.mockRestore();
    }
  });

  it("fails focused repair for unknown check ids before writing config", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: "/tmp/openclaw.json",
    });

    const exitCode = await runDoctorSelectedRepairCli(runtime, {
      onlyIds: ["core/doctor/not-real"],
    });

    expect(exitCode).toBe(1);
    expect(runtime.error).toHaveBeenCalledWith(
      "Unknown health check id selected by --only: core/doctor/not-real.",
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("fails focused repair for checks without structured repair", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: "/tmp/openclaw.json",
    });

    const exitCode = await runDoctorSelectedRepairCli(runtime, {
      onlyIds: ["core/doctor/gateway-config"],
    });

    expect(exitCode).toBe(1);
    expect(runtime.error).toHaveBeenCalledWith(
      "Health check core/doctor/gateway-config does not support automatic repair.",
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("fails focused repair when the selected check reports repair warnings", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: "/tmp/openclaw.json",
    });
    registerHealthCheck({
      id: "test/warning-repair",
      kind: "core",
      description: "repair warning",
      focusedRepair: true,
      async detect() {
        return [
          {
            checkId: "test/warning-repair",
            severity: "warning",
            message: "Needs repair.",
          },
        ];
      },
      async repair() {
        return {
          changes: ["Attempted repair."],
          warnings: ["Repair could not verify the result."],
        };
      },
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorSelectedRepairCli(runtime, {
        onlyIds: ["test/warning-repair"],
      });

      expect(exitCode).toBe(1);
      expect(runtime.error).toHaveBeenCalledWith("warning: Repair could not verify the result.");
      expect(runtime.error).toHaveBeenCalledWith(
        "doctor --fix --only: selected check reported warning(s).",
      );
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });
});
