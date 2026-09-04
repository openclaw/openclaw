import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAbortError } from "../../infra/abort-signal.js";
import { executeMutableUpdate } from "./update-command-execution.js";

const mocks = vi.hoisted(() => ({
  packageUpdate: vi.fn(),
  restore: vi.fn(async () => undefined),
  stop: vi.fn(async () => ({ stopped: false, inspected: true, running: false })),
}));
vi.mock("./update-command-package.js", () => ({ runPackageInstallUpdate: mocks.packageUpdate }));
vi.mock("./update-command-managed-context.js", () => ({
  captureOwnedManagedUpdateContext: async () => undefined,
  withOwnedManagedUpdateEnv: async (_env: unknown, run: () => Promise<void>) => run(),
}));
vi.mock("./schema-preflight.js", () => ({
  checkTargetDatabaseSchemas: () => ({ incompatible: [], indeterminate: [] }),
  hasSchemaRefusal: () => false,
  formatSchemaRefusalLines: () => [],
}));
vi.mock("./update-command-service-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-maintenance.js")>()),
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stop,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate: mocks.restore,
  maybeRestartServiceAfterFailedMutableUpdate: mocks.restore,
  shouldBlockMutableUpdateFromGatewayServiceEnv: () => false,
}));

describe("exceptional update failure handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stop.mockResolvedValue({ stopped: false, inspected: true, running: false });
  });

  it.each([
    { started: false, cancelled: false },
    { started: true, cancelled: false },
    { started: true, cancelled: false, stopped: true },
    { started: true, cancelled: true },
  ])(
    "records mutation and cancellation at the execution owner: %j",
    async ({ started, cancelled, stopped = false }) => {
      mocks.stop.mockResolvedValue({ stopped, inspected: true, running: stopped });
      const error = cancelled
        ? createAbortError("operator cancelled")
        : new Error("package replacement failed");
      mocks.packageUpdate.mockImplementationOnce(async ({ progress }) => {
        if (started) {
          progress.onStepStart({
            name: "global update",
            command: "npm install",
            index: 0,
            total: 1,
          });
        }
        throw error;
      });
      const execution = await executeMutableUpdate({
        root: "/synthetic/install",
        installKind: "package",
        updateInstallKind: "package",
        switchToGit: false,
        timeoutMs: 1000,
        updateStepTimeoutMs: 1000,
        startedAt: Date.now(),
        progress: {},
        stop: vi.fn(),
        channel: "stable",
        tag: "latest",
        opts: { json: true, restart: stopped },
        shouldRestart: stopped,
        packageInstallSpec: "openclaw@2026.8.31",
        expectedVersion: "2026.8.31",
        managedServiceRootRedirect: null,
        recoveryState: { triageTarget: { env: {} } },
      });
      expect(execution).toMatchObject({
        mutationStarted: started,
        failure: { cause: error, detail: error.message },
        result: { status: "error", reason: "update-failed" },
      });
      expect(execution?.result.steps[0]?.termination).toBe(cancelled ? "signal" : undefined);
    },
  );
});
