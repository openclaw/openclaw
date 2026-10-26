import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";

const fixture = vi.hoisted(() => ({
  bootstrap: vi.fn<() => Promise<void>>(),
  worker: vi.fn<() => Promise<void>>(),
  exit: vi.fn<() => void>(),
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

const originalProcess = { argv: process.argv, title: process.title, exitCode: process.exitCode };

beforeEach(async () => {
  vi.resetModules();
  fixture.bootstrap.mockReset().mockResolvedValue();
  fixture.worker.mockReset().mockResolvedValue();
  fixture.exit.mockReset();
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
  const { defaultRuntime } = await import("../runtime.js");
  vi.spyOn(defaultRuntime, "exit").mockImplementation(fixture.exit);
});

afterEach(() => {
  Object.assign(process, originalProcess);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  expect(fixture.exit).not.toHaveBeenCalled();
});

it("passes the desktop preference and drains resources before finalizing exit", async () => {
  const { requestExitAfterOneShotOutput } = await import("../cli/one-shot-exit.js");
  const { getCliPluginInvocationResources } = await import("../cli/runtime-cleanup-scope.js");
  const cleanupGate = createEnteredGate();
  process.argv.push("--desktop-sharing");
  fixture.worker.mockImplementation(async () => {
    const resources = getCliPluginInvocationResources();
    if (!resources) {
      throw new Error("worker entry did not establish its cleanup owner");
    }
    resources.adopt({ release: cleanupGate.wait });
    process.exitCode = 143;
    requestExitAfterOneShotOutput();
  });

  const entry = import("./mac-worker-entry.js");
  await awaitGateBeforeSettlement(
    cleanupGate.entered,
    entry,
    "worker entry completed before releasing its resources",
  ).finally(async () => {
    cleanupGate.release();
    await entry;
  });

  expect(fixture.worker).toHaveBeenCalledWith({ desktopSharingEnabled: true });
  expect(process.exitCode).toBe(143);
});

it("reports bootstrap failure and finalizes an unsuccessful exit", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  fixture.bootstrap.mockRejectedValue(new Error("worker bootstrap failed"));

  await import("./mac-worker-entry.js");

  expect(fixture.worker).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith("worker bootstrap failed\n");
  expect(process.exitCode).toBe(1);
});
