import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  bootstrap: vi.fn<() => Promise<void>>(),
  worker: vi.fn<() => Promise<void>>(),
}));
vi.mock("../cli/command-execution-startup.js", () => ({
  ensureCliExecutionBootstrap: fixture.bootstrap,
}));
vi.mock("./worker.js", () => ({ runNodeHostWorker: fixture.worker }));
vi.mock("../cli/dotenv.js", () => ({ loadCliDotEnv: () => {} }));
vi.mock("../infra/runtime-guard.js", () => ({ assertSupportedRuntime: async () => {} }));
vi.mock("../infra/openclaw-exec-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-exec-env.js")>()),
  ensureOpenClawExecMarkerOnProcess: () => {},
}));
vi.mock("../infra/warning-filter.js", () => ({ installProcessWarningFilter: () => {} }));
vi.mock("../logging.js", () => ({ enableConsoleCapture: () => {} }));
vi.mock("../cli/json-output-mode.js", () => ({
  withConsoleLogsRoutedToStderrForJson: (_argv: string[], run: () => Promise<void>) => run(),
}));
// Output-drain tests own pipe timing; this suite proves the real entry reaches its exit owner.
vi.mock("../process/output-drain.js", () => ({ drainProcessOutput: (exit: () => void) => exit() }));

const originalArgv = process.argv;
const originalTitle = process.title;
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  fixture.bootstrap.mockReset().mockResolvedValue();
  fixture.worker.mockReset().mockResolvedValue();
  for (const key of ["VITEST", "VITEST_POOL_ID", "VITEST_WORKER_ID"]) {
    vi.stubEnv(key, undefined);
  }
  process.argv = [
    process.execPath,
    fileURLToPath(new URL("./mac-worker-entry.ts", import.meta.url)),
    "node",
    "worker",
  ];
  process.exitCode = undefined;
});

afterEach(() => {
  process.argv = originalArgv;
  process.title = originalTitle;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([0, 143])("finalizes the worker's requested exit code %s", async (code) => {
  const { defaultRuntime } = await import("../runtime.js");
  const { requestExitAfterOneShotOutput } = await import("../cli/one-shot-exit.js");
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {});
  fixture.worker.mockImplementation(async () => {
    process.exitCode = code;
    requestExitAfterOneShotOutput();
  });

  await import("./mac-worker-entry.js");

  expect(fixture.worker).toHaveBeenCalledOnce();
  expect(exit).toHaveBeenCalledExactlyOnceWith(code);
});

it.each([
  { args: [], enabled: undefined },
  { args: ["--desktop-sharing"], enabled: true },
  { args: ["--no-desktop-sharing"], enabled: false },
])("passes the parsed desktop preference into worker startup: $args", async ({ args, enabled }) => {
  const { defaultRuntime } = await import("../runtime.js");
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {});
  process.argv.push(...args);

  await import("./mac-worker-entry.js");

  expect(fixture.worker).toHaveBeenCalledExactlyOnceWith({ desktopSharingEnabled: enabled });
});

it("reports startup failure and finalizes an unsuccessful exit", async () => {
  const { defaultRuntime } = await import("../runtime.js");
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {});
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  fixture.bootstrap.mockRejectedValue(new Error("worker bootstrap failed"));

  await import("./mac-worker-entry.js");

  expect(fixture.worker).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith("worker bootstrap failed\n");
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
});
