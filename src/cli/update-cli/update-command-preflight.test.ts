import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isUpdateAdmissionAuthorityEnvKey } from "../../infra/update-admission-contract.js";
import type { CanaryResult } from "../../infra/update-candidate-canary-commands.js";
import { defaultRuntime } from "../../runtime.js";
import { registerUpdateCli } from "../update-cli.js";

const { canary } = vi.hoisted(() => ({ canary: vi.fn() }));
// mock-isolation: tests receipt mapping without spawning the candidate; the built CLI test covers startup.
vi.mock("../../infra/update-candidate-canary.js", () => ({
  validateUpdateCandidateCanary: canary,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const previousExitCode = process.exitCode;

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  const home = dirs.make("update-preflight-");
  for (const key of Object.keys(process.env)) {
    if (isUpdateAdmissionAuthorityEnvKey(key)) {
      vi.stubEnv(key, undefined);
    }
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(home, "state", "openclaw.json"));
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function invoke() {
  const program = new Command().exitOverride();
  registerUpdateCli(program);
  await program.parseAsync(["node", "openclaw", "update", "preflight", "--json"]);
}

it.each([
  { status: "ok", phase: "readiness", exitCode: 0, expected: "ready", code: 0 },
  { status: "error", phase: "config", exitCode: 1, expected: "blocked", code: 3 },
  { status: "ok", phase: "runtime", exitCode: undefined, expected: "unverified", code: 2 },
  { status: "ok", phase: "readiness", exitCode: null, expected: "unverified", code: 2 },
] as const)("reports $expected for $status/$phase/$exitCode", async (testCase) => {
  const result: CanaryResult = {
    ...(testCase.status === "error"
      ? { status: "error", reason: "runtime-verification-failed" }
      : { status: "ok" }),
    phase: testCase.phase,
    durationMs: 1,
    logTail: [],
    steps:
      testCase.exitCode === undefined
        ? []
        : [
            {
              name: "candidate-gateway-startup",
              command: "gateway run",
              cwd: ".",
              durationMs: 1,
              exitCode: testCase.exitCode,
            },
          ],
  };
  canary.mockResolvedValue(result);

  await invoke();

  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      protocol: 1,
      mode: "preflight",
      status: testCase.expected,
      coverage: "isolated-core-startup",
    }),
  );
  expect(process.exitCode).toBe(testCase.code);
});

it("refuses inherited updater authority before inspecting the profile", async () => {
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");

  await invoke();

  expect(canary).not.toHaveBeenCalled();
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      protocol: 1,
      mode: "preflight",
      status: "unverified",
      reason: "preflight-execution-failed",
    }),
  );
  expect(process.exitCode).toBe(2);
});

it("emits only an unverified receipt when canary cleanup fails", async () => {
  canary.mockRejectedValue(new Error("Candidate cleanup could not be verified"));

  await invoke();

  expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "unverified",
      reason: "preflight-execution-failed",
    }),
  );
  expect(process.exitCode).toBe(2);
});
