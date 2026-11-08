import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runMainOrRootHelp } from "../../entry.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { withConsoleLogsRoutedToStderrForJson } from "../json-output-mode.js";
import { registerUpdateCli } from "../update-cli.js";
import { updateCommand } from "./update-command.js";

vi.mock("@clack/prompts", () => ({ confirm: async () => true, isCancel: () => false }));
vi.mock("../../../packages/terminal-core/src/prompt-select-styled.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../packages/terminal-core/src/prompt-select-styled.js")
  >()),
  selectStyled: async () => "stable",
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: async () => ({ valid: false }),
}));
vi.mock("../../infra/update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-check.js")>()),
  resolveUpdateInstallIdentity: async () => ({ installKind: "package" }),
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  parseUpdateTimeoutMs: () => undefined,
  resolveUpdateRoot: async () => "/fixture/openclaw",
  resolveGitInstallDir: () => "/fixture/git",
  isEmptyDir: async () => true,
  isGitCheckout: async () => false,
}));
// mock-isolation: Exercise wizard delegation without loading the updater activation, ledger, and runtime-retirement owners.
vi.mock("./update-command.js", () => ({ updateCommand: vi.fn() }));

const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
beforeEach(() => {
  vi.mocked(updateCommand).mockReset();
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "exit");
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (stdinTty) {
    Object.defineProperty(process.stdin, "isTTY", stdinTty);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
});

async function runWizard(json = false) {
  const previousArgv = process.argv;
  process.argv = ["node", "openclaw", "update", ...(json ? ["--json"] : []), "wizard"];
  try {
    await withConsoleLogsRoutedToStderrForJson(
      process.argv,
      () => runRegisteredCli({ register: registerUpdateCli, argv: process.argv.slice(2) }),
      { restoreChanges: true },
    );
  } finally {
    process.argv = previousArgv;
  }
}

it.each([0, 1, 23])("preserves an already-reported delegated exit %s", async (code) => {
  const outcome = new ExitError(code);
  vi.mocked(updateCommand).mockRejectedValueOnce(outcome);
  await expect(runWizard()).rejects.toBe(outcome);
  expect(defaultRuntime.error).not.toHaveBeenCalled();
  expect(defaultRuntime.exit).not.toHaveBeenCalled();
});

it("still reports an unexpected delegated failure", async () => {
  vi.mocked(updateCommand).mockRejectedValueOnce(new Error("update unavailable"));
  await expect(runWizard()).rejects.toEqual(new ExitError(1));
  expect(defaultRuntime.error).toHaveBeenCalledExactlyOnceWith("update unavailable");
  expect(defaultRuntime.exit).toHaveBeenCalledExactlyOnceWith(1);
});

it("routes unexpected delegated failures to the outer JSON error owner", async () => {
  const failure = new Error("update unavailable");
  vi.mocked(updateCommand).mockRejectedValueOnce(failure);
  await expect(runWizard(true)).rejects.toBe(failure);
  expect(defaultRuntime.error).not.toHaveBeenCalled();
  expect(defaultRuntime.exit).not.toHaveBeenCalled();
  expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
});

// Startup discovery is synthetic; the registered wizard, root failure formatter,
// stdout writer, and exit finalization are real. No updater mutation runs.
it.each([false, true])("formats root wizard failure once (JSON: %s)", async (json) => {
  const previousExitCode = process.exitCode;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.mocked(defaultRuntime.writeJson).mockRestore();
  const writeJson = vi.spyOn(defaultRuntime, "writeJson");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(updateCommand).mockRejectedValueOnce(new Error("update unavailable"));
  process.exitCode = undefined;
  const argv = ["node", "openclaw", "update", ...(json ? ["--json"] : []), "wizard"];
  try {
    await withConsoleLogsRoutedToStderrForJson(
      argv,
      () =>
        runMainOrRootHelp(argv, {
          loadRunCli: async () => ({ runCli: async () => runWizard(json) }),
        }),
      { restoreChanges: true },
    );
    expect(process.exitCode).toBe(1);
    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(json ? JSON.parse(output) : output).toEqual(
      json ? { ok: false, error: { type: "cli_error", message: "update unavailable" } } : "",
    );
    expect(writeJson).toHaveBeenCalledTimes(json ? 1 : 0);
    expect(defaultRuntime.error).toHaveBeenCalledTimes(json ? 0 : 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

it.each([false, true])("preserves successful wizard delegation (JSON: %s)", async (json) => {
  vi.mocked(updateCommand).mockResolvedValueOnce(undefined);
  await runWizard(json);
  expect(updateCommand).toHaveBeenCalledExactlyOnceWith({
    runtimeRecoveryEnv: undefined,
    channel: "stable",
    restart: true,
    timeout: undefined,
    acceptCapabilities: false,
  });
  expect(defaultRuntime.error).not.toHaveBeenCalled();
  expect(defaultRuntime.exit).not.toHaveBeenCalled();
  expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
});
