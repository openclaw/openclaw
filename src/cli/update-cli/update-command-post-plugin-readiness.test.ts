import { afterEach, expect, it, vi } from "vitest";
import {
  CommandProcessCleanupError,
  recordCommandProcessFailure,
} from "../../process/exec-result.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { createCommandResult as processResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { createPostCorePluginUpdateResult } from "./update-command-plugins-internals.js";
import { applyPostPluginUpdateChecks } from "./update-command-post-plugin-readiness.js";

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runUtf8CommandWithTimeout: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});
const execute = vi.mocked(runUtf8CommandWithTimeout);
const repair = "Run `openclaw update repair` to retry post-update readiness checks.";

async function inspect(
  outcome: Error | Parameters<typeof processResult>[0],
  status: "ok" | "error" = "ok",
) {
  execute.mockImplementation(() =>
    outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(processResult(outcome)),
  );
  return checks({ pluginUpdate: createPostCorePluginUpdateResult({ status }) });
}

function checks(overrides: Partial<Parameters<typeof applyPostPluginUpdateChecks>[0]> = {}) {
  return applyPostPluginUpdateChecks({
    root: "/synthetic/openclaw",
    entryPath: "/synthetic/openclaw/dist/index.js",
    nodeRunner: process.execPath,
    timeoutMs: 5_000,
    skipConfigValidation: true,
    pluginUpdate: createPostCorePluginUpdateResult({ status: "ok" }),
    ...overrides,
  });
}
const valid = '{"valid":true,"path":"/synthetic/🦞"}\n';
const lint = JSON.stringify({ ok: true, checksRun: 1, findings: [] });

function output(parts: Buffer[], delays: number[] = []) {
  execute.mockImplementation(async (_argv, options) => {
    if (typeof options === "number") {
      throw new Error("Expected process options");
    }
    let accepted = true;
    for (const [index, part] of parts.entries()) {
      if (delays[index]) {
        await vi.advanceTimersByTimeAsync(delays[index]);
      }
      accepted = options.onOutputChunk?.(part, "stdout") !== false && accepted;
    }
    return processResult({
      stdout: Buffer.concat(parts).toString(),
      outputLimitExceeded: !accepted,
    });
  });
}

it("keeps split strict output before lint in one target process", async () => {
  const bytes = Buffer.from(valid);
  const split = bytes.indexOf(Buffer.from("🦞")) + 1;
  output([bytes.subarray(0, split), bytes.subarray(split), Buffer.from(lint)]);
  expect(await checks({ skipConfigValidation: false, candidateRuntime: true })).toMatchObject({
    status: "ok",
  });
  expect(execute).toHaveBeenCalledOnce();
});

it.each([
  [1, '{"valid":false,"error":"Runtime failed"}'],
  [0, ""],
] as const)("refuses incomplete strict validation (exit %s)", async (code, stdout) => {
  execute.mockResolvedValue(processResult({ code, stdout }));
  expect(await checks({ skipConfigValidation: false, candidateRuntime: true })).toMatchObject({
    status: "error",
    reason: "post-plugin-config-validation-execution-failed",
  });
});

it.each(["strict timeout", "lint timeout", "full lint budget", "authority"])(
  "preserves %s at the phase boundary",
  async (phase) => {
    vi.useFakeTimers();
    const refusal = new Error("Update authority revoked");
    const assertCurrent = vi.fn(() => {
      if (phase === "authority" && assertCurrent.mock.calls.length === 2) {
        throw refusal;
      }
    });
    output(
      [Buffer.from(valid), Buffer.from(lint)],
      [phase === "strict timeout" ? 11 : 9, phase === "lint timeout" ? 11 : 9],
    );
    const result = checks({ candidateRuntime: true, timeoutMs: 10, assertCurrent });
    if (phase === "authority") {
      await expect(result).rejects.toBe(refusal);
    } else {
      expect((await result).status).toBe(
        phase === "strict timeout" ? "error" : phase === "lint timeout" ? "warning" : "ok",
      );
    }
  },
);

it.each(["strict", "lint", "independent"])("bounds %s output by phase", async (phase) => {
  const large = "x".repeat((phase === "independent" ? 3 : 4) * 1024 * 1024);
  const first =
    phase === "strict"
      ? large + "x"
      : JSON.stringify({ valid: true, padding: phase === "independent" ? large : "" }) + "\n";
  const second =
    phase === "lint"
      ? large + "x"
      : JSON.stringify({
          ok: true,
          checksRun: 1,
          findings: [],
          padding: phase === "independent" ? large : "",
        });
  output([Buffer.from(first), Buffer.from(second)]);
  expect((await checks({ candidateRuntime: true })).status).toBe(
    phase === "strict" ? "error" : phase === "lint" ? "warning" : "ok",
  );
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

it.each(["ok", "error"] as const)(
  "keeps deferred inspection advisory without masking %s",
  async (status) => {
    const finding = {
      checkId: "core/doctor/lint-inspection",
      severity: "warning",
      errorCode: "update-inspection-deferred",
      message: "Inspection allowance exhausted.",
      fixHint: "Run `openclaw doctor --fix` after activation.",
    };
    expect(
      await inspect(
        {
          cleanup: "normal",
          stdout: JSON.stringify({ ok: true, checksRun: 0, findings: [], warnings: [finding] }),
        },
        status,
      ),
    ).toMatchObject({
      status: status === "error" ? "error" : "warning",
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
  },
);
