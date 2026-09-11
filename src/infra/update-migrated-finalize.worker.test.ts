import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { MigratedUpdateFinalizationInput } from "../cli/update-cli/update-command-migrated-types.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../config/materialize.js";

const mocks = vi.hoisted(() => ({
  finish: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../cli/daemon-cli.js", () => ({ finishUpdateRun: vi.fn() }));
vi.mock("../cli/runtime-cleanup-scope.js", () => ({
  retainCliProcessJobUntilExit: async () => undefined,
  withCliProcessScope: async (operation: () => Promise<void>) => await operation(),
}));
vi.mock("../cli/update-cli/update-command-executor.js", () => ({
  withDelegatedUpdateCommandExecutor: vi.fn(),
}));
vi.mock("../cli/update-cli/update-command-post-update.js", () => ({ finishUpdate: mocks.finish }));
vi.mock("../cli/update-cli/update-command-result.js", () => ({
  formatUpdateFinalizationError: String,
  UpdateCommandFailure: class extends Error {},
}));
vi.mock("../cli/update-cli/update-command-service-maintenance.js", () => ({
  createWindowsTaskAutoStartGuard: vi.fn(),
}));
vi.mock("../cli/update-cli/update-command-windows-task.js", () => ({
  createWindowsTaskAutoStartRecovery: vi.fn(),
}));
vi.mock("../state/openclaw-state-db.js", () => ({ closeOpenClawStateDatabase: mocks.close }));
vi.mock("./update-requester-authority.js", () => ({
  createManagedUpdateRequesterAuthority: vi.fn(),
}));
vi.mock("./update-run-ledger.js", () => ({
  adoptUpdateRun: vi.fn(),
  getUpdateRun: () => ({ runId: "candidate-run", status: "succeeded" }),
  recordUpdateRunStep: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

it("binds migrated worker finalization to its local candidate runtime", async () => {
  const input: MigratedUpdateFinalizationInput = {
    params: {
      root: "/fixture/candidate",
      result: {
        status: "ok",
        mode: "npm",
        root: "/fixture/candidate",
        runId: "candidate-run",
        steps: [],
        durationMs: 0,
      },
      mutationStarted: true,
      installKindChanged: false,
      configSnapshot: {
        path: "/fixture/openclaw.json",
        exists: false,
        raw: null,
        parsed: {},
        sourceConfig: asResolvedSourceConfig({}),
        resolved: asResolvedSourceConfig({}),
        runtimeConfig: asRuntimeConfig({}),
        config: asRuntimeConfig({}),
        valid: true,
        issues: [],
        warnings: [],
        legacyIssues: [],
      },
      requestedChannel: null,
      storedChannel: "stable",
      channel: "stable",
      downgradeRisk: false,
      shouldRestart: false,
      opts: { json: true, run: { runId: "candidate-run", env: {} } },
      controlPlaneUpdateSentinelMeta: null,
      preUpdatePluginInstallRecords: {},
      startedAt: 1,
      updateStepTimeoutMs: 1_000,
      rollbackBlockedReason: "state-migrated-no-rollback",
    },
    bufferedSteps: [],
    resultPath: "/fixture/result.json",
  };
  const completed = createDeferred();
  mocks.close.mockImplementation(() => completed.resolve());
  mocks.finish.mockResolvedValue(input.params.result);
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(() =>
    Readable.from([Buffer.from(JSON.stringify(input))])[Symbol.asyncIterator](),
  );
  const write = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);

  await import("./update-migrated-finalize.worker.js");
  await completed.promise;

  expect(mocks.finish).toHaveBeenCalledExactlyOnceWith(input.params, { candidateRuntime: true });
  expect(write).toHaveBeenCalledExactlyOnceWith(
    input.resultPath,
    JSON.stringify({ result: input.params.result, exitCode: 0, terminalRunId: "candidate-run" }),
    { mode: 0o600 },
  );
});
