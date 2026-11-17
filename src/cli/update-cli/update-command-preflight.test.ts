import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isUpdateAdmissionAuthorityEnvKey } from "../../infra/update-admission-contract.js";
import { defaultRuntime } from "../../runtime.js";
import { registerUpdateCli } from "../update-cli.js";

const { check } = vi.hoisted(() => ({ check: vi.fn() }));
// mock-isolation: tests receipt mapping without spawning the candidate; the built CLI test covers startup.
vi.mock("../../infra/update-candidate-check.js", () => ({
  checkUpdateCandidate: check,
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
  { status: "ok", expected: "ready", code: 0 },
  { status: "error", expected: "blocked", code: 3 },
] as const)("reports $expected when the candidate check is $status", async (testCase) => {
  check.mockResolvedValue({ status: testCase.status, steps: [] });

  await invoke();

  expect(check).toHaveBeenCalledWith(expect.objectContaining({ requireRuntime: true }));
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      protocol: 1,
      mode: "preflight",
      status: testCase.expected,
      phase: "runtime",
      coverage: "candidate-runtime",
    }),
  );
  expect(process.exitCode).toBe(testCase.code);
});

it("refuses inherited updater authority before inspecting the profile", async () => {
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");

  await invoke();

  expect(check).not.toHaveBeenCalled();
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

it("emits only an unverified receipt when check cleanup fails", async () => {
  check.mockRejectedValue(new Error("Update check process cleanup could not be confirmed."));

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
