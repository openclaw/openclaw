import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";

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

it.each([
  { args: [], enabled: undefined, code: 0 },
  { args: ["--desktop-sharing"], enabled: true, code: 143 },
  { args: ["--no-desktop-sharing"], enabled: false, code: 0 },
])(
  "starts with desktop preference $enabled and finalizes exit $code",
  async ({ args, enabled, code }) => {
    const { defaultRuntime } = await import("../runtime.js");
    const { requestExitAfterOneShotOutput } = await import("../cli/one-shot-exit.js");
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {});
    const { getCliPluginInvocationResources } = await import("../cli/runtime-cleanup-scope.js");
    const cleanupStarted = createDeferred();
    const releaseCleanup = createDeferred();
    const cleanup = vi.fn(async () => {
      cleanupStarted.resolve();
      await releaseCleanup.promise;
    });
    process.argv.push(...args);
    fixture.worker.mockImplementation(async () => {
      const resources = getCliPluginInvocationResources();
      if (!resources) {
        throw new Error("worker entry did not establish its cleanup owner");
      }
      resources.adopt({ release: cleanup });
      process.exitCode = code;
      requestExitAfterOneShotOutput();
    });

    const entry = import("./mac-worker-entry.js");
    try {
      await awaitGateBeforeSettlement(
        cleanupStarted.promise,
        entry,
        "worker entry completed before releasing its resources",
      );
      expect(exit).not.toHaveBeenCalled();
    } finally {
      releaseCleanup.resolve();
      await entry;
    }

    expect(fixture.worker).toHaveBeenCalledExactlyOnceWith({ desktopSharingEnabled: enabled });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(code);
    expect(exit).not.toHaveBeenCalled();
  },
);

it("reports startup failure and finalizes an unsuccessful exit", async () => {
  const { defaultRuntime } = await import("../runtime.js");
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {});
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  fixture.bootstrap.mockRejectedValue(new Error("worker bootstrap failed"));

  await import("./mac-worker-entry.js");

  expect(fixture.worker).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith("worker bootstrap failed\n");
  expect(process.exitCode).toBe(1);
  expect(exit).not.toHaveBeenCalled();
});
