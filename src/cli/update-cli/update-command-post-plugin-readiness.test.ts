import { afterEach, expect, it, vi } from "vitest";
import {
  CommandProcessCleanupError,
  recordCommandProcessFailure,
} from "../../process/exec-result.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { createPostCorePluginUpdateResult } from "./update-command-plugins-internals.js";
import { applyPostPluginUpdateReadiness } from "./update-command-post-plugin-readiness.js";

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runUtf8CommandWithTimeout: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

const params = {
  root: "/synthetic/openclaw",
  entryPath: "/synthetic/openclaw/dist/index.js",
  nodeRunner: process.execPath,
  timeoutMs: 5_000,
  pluginUpdate: createPostCorePluginUpdateResult({ status: "ok" }),
};

it("redacts caught execution errors before publishing repair warnings", async () => {
  vi.mocked(runUtf8CommandWithTimeout).mockRejectedValue(
    new Error("Readiness unavailable https://example.test/diagnostic?token=fixture-secret"),
  );
  const result = await applyPostPluginUpdateReadiness(params);
  expect(result.status).toBe("warning");
  expect(result.warnings?.[0]?.message).toContain("token=<redacted>");
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
});

it.each([
  { code: 1, termination: "exit", signal: null, killed: false },
  { code: 124, termination: "timeout", signal: "SIGTERM", killed: true },
] as const)(
  "defers settled lint contention ($termination) without masking earlier errors",
  async (physical) => {
    vi.mocked(runUtf8CommandWithTimeout).mockResolvedValue({
      ...physical,
      cleanup: "normal",
      stdout: "",
      stderr: "SQLite transaction lock wait failed: database is locked (SQLITE_BUSY)",
    });
    for (const status of ["ok", "error"] as const) {
      const result = await applyPostPluginUpdateReadiness({
        ...params,
        pluginUpdate: { ...params.pluginUpdate, status },
      });
      expect(result.status).toBe(status === "ok" ? "warning" : "error");
      expect(result.failureFacts).toBeUndefined();
      expect(result.warnings).toEqual([
        expect.objectContaining({
          reason: "doctor-advisory",
          message: expect.stringContaining("database is locked"),
          guidance: ["Run `openclaw update repair` to retry post-update readiness checks."],
        }),
      ]);
      expect(result.doctorLint).toMatchObject({
        exitCode: physical.code,
        termination: physical.termination,
        signal: physical.signal,
        killed: physical.killed,
        advisory: { kind: "recoverable-maintenance" },
      });
    }
  },
);

it.each(["canonical", "recorded", "result"] as const)(
  "preserves %s uncertain cleanup instead of deferring potentially active work",
  async (kind) => {
    if (kind === "result") {
      vi.mocked(runUtf8CommandWithTimeout).mockResolvedValue({
        code: 1,
        termination: "exit",
        signal: null,
        killed: true,
        cleanup: "uncertain",
        stdout: "",
        stderr: "Unjoined inspection child",
      });
    } else {
      vi.mocked(runUtf8CommandWithTimeout).mockRejectedValue(
        kind === "canonical"
          ? new CommandProcessCleanupError()
          : recordCommandProcessFailure(new Error("Inspection output failed"), {
              code: 1,
              cleanup: "uncertain",
              termination: "exit",
            }),
      );
    }
    await expect(applyPostPluginUpdateReadiness(params)).rejects.toBeInstanceOf(
      CommandProcessCleanupError,
    );
  },
);

it("keeps budget-deferred inspection receipts advisory when no check ran", async () => {
  const finding = {
    checkId: "core/doctor/lint-inspection",
    severity: "warning",
    errorCode: "update-inspection-deferred",
    message: "Inspection allowance exhausted.",
    fixHint: "Run `openclaw doctor --fix` after activation.",
  };
  vi.mocked(runUtf8CommandWithTimeout).mockResolvedValue({
    code: 0,
    termination: "exit",
    signal: null,
    killed: false,
    cleanup: "normal",
    stderr: "",
    stdout: JSON.stringify({ ok: true, checksRun: 0, findings: [], warnings: [finding] }),
  });
  const result = await applyPostPluginUpdateReadiness(params);
  expect(result.status).toBe("warning");
  expect(result.doctorLint).toMatchObject({
    exitCode: 0,
    doctorLintFindings: [finding],
    advisory: { kind: "recoverable-maintenance" },
  });
  expect(result.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        errorCode: "update-inspection-deferred",
        guidance: [finding.fixHint],
      }),
      expect.objectContaining({
        guidance: ["Run `openclaw update repair` to retry post-update readiness checks."],
      }),
    ]),
  );
});
