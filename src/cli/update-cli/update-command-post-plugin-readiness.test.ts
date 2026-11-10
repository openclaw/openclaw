import { afterEach, expect, it, vi } from "vitest";
import {
  CommandProcessCleanupError,
  recordCommandProcessFailure,
} from "../../process/exec-result.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { createCommandResult as processResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { createPostCorePluginUpdateResult } from "./update-command-plugins-internals.js";
import { applyPostPluginUpdateReadiness } from "./update-command-post-plugin-readiness.js";

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runUtf8CommandWithTimeout: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());
const execute = vi.mocked(runUtf8CommandWithTimeout);
const repair = "Run `openclaw update repair` to retry post-update readiness checks.";

async function inspect(
  outcome: Error | Parameters<typeof processResult>[0],
  status: "ok" | "error" = "ok",
) {
  execute.mockImplementation(() =>
    outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(processResult(outcome)),
  );
  return applyPostPluginUpdateReadiness({
    root: "/synthetic/openclaw",
    entryPath: "/synthetic/openclaw/dist/index.js",
    nodeRunner: process.execPath,
    timeoutMs: 5_000,
    pluginUpdate: createPostCorePluginUpdateResult({ status }),
  });
}

it("redacts caught execution errors before publishing repair warnings", async () => {
  const result = await inspect(new Error("https://example.test/?token=fixture-secret"));
  expect(result).toMatchObject({
    status: "warning",
    doctorLint: { command: "doctor --lint --json --severity-min error" },
    warnings: [{ message: expect.stringContaining("token=<redacted>") }],
  });
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
});

it("defers contention without masking an existing plugin error", async () => {
  const result = await inspect(
    { code: 1, cleanup: "normal", stderr: "database is locked" },
    "error",
  );
  expect(result).toMatchObject({
    status: "error",
    doctorLint: { advisory: { kind: "recoverable-maintenance" } },
    warnings: [
      {
        reason: "doctor-advisory",
        message: expect.stringContaining("database is locked"),
        guidance: [repair],
      },
    ],
  });
  expect(result.failureFacts).toBeUndefined();
});

it.each([
  new CommandProcessCleanupError(),
  recordCommandProcessFailure(new Error("Inspection output failed"), {
    code: 1,
    cleanup: "uncertain",
    termination: "exit",
  }),
  processResult({ cleanup: "uncertain" }),
])("preserves uncertain cleanup without deferring active work (case %#)", async (outcome) => {
  await expect(inspect(outcome)).rejects.toBeInstanceOf(CommandProcessCleanupError);
});

it("keeps budget-deferred inspection receipts advisory when no check ran", async () => {
  const finding = {
    checkId: "core/doctor/lint-inspection",
    severity: "warning",
    errorCode: "update-inspection-deferred",
    message: "Inspection allowance exhausted.",
    fixHint: "Run `openclaw doctor --fix` after activation.",
  };
  expect(
    await inspect({
      cleanup: "normal",
      stdout: JSON.stringify({ ok: true, checksRun: 0, findings: [], warnings: [finding] }),
    }),
  ).toMatchObject({
    status: "warning",
    doctorLint: {
      exitCode: 0,
      doctorLintFindings: [finding],
      advisory: { kind: "recoverable-maintenance" },
    },
    warnings: expect.arrayContaining([
      expect.objectContaining({
        errorCode: "update-inspection-deferred",
        guidance: [finding.fixHint],
      }),
      expect.objectContaining({ guidance: [repair] }),
    ]),
  });
});
