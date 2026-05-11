import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetCoreDiagnosticChecksForTest } from "../flows/core-diagnostics.js";
import { clearDiagnosticChecksForTest } from "../flows/diagnostic-registry.js";
import { runLintCli } from "./lint.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("runLintCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDiagnosticChecksForTest();
    resetCoreDiagnosticChecksForTest();
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
      const exitCode = await runLintCli(runtime, {
        json: true,
        severityMin: "error",
      });

      expect(exitCode).toBe(0);
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
      const exitCode = await runLintCli(runtime, {
        severityMin: "error",
      });

      expect(exitCode).toBe(0);
      expect(String(stdout.mock.calls[0]?.[0])).toBe(
        "openclaw lint: ran 5 check(s), 0 finding(s)\n",
      );
      expect(String(stdout.mock.calls[1]?.[0])).toBe("  no findings\n");
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalIsTTY });
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
      const exitCode = await runLintCli(runtime, { json: true });

      expect(exitCode).toBe(1);
      const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
      expect(payload).toMatchObject({
        ok: false,
        checksRun: 1,
        findings: [
          {
            checkId: "core/lint/final-config-validation",
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

  it("rejects invalid severity thresholds", async () => {
    await expect(runLintCli(runtime, { severityMin: "warnng" })).rejects.toThrow(
      "Invalid --severity-min value",
    );
  });
});
