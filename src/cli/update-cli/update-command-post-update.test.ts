import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  restart: vi.fn(async () => undefined),
  restoreWindowsAutoStart: vi.fn(async () => true),
  writeSentinel: vi.fn(async () => undefined),
}));

vi.mock("./progress.js", () => ({ printResult: vi.fn() }));
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  maybeRestartServiceAfterFailedMutableUpdate: mocks.restart,
  restoreWindowsTaskAutoStartOrExit: mocks.restoreWindowsAutoStart,
}));
vi.mock("./update-command-post-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-post-core.js")>()),
  writeControlPlaneUpdateRestartSentinelBestEffort: mocks.writeSentinel,
}));

import { finishUpdate } from "./update-command-post-update.js";

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];

function failedResult(recovery: UpdateRunResult["recovery"]): UpdateRunResult {
  return {
    status: "error",
    mode: "git",
    reason: "doctor-failed",
    recovery,
    steps: [],
    durationMs: 1,
  };
}

async function finishFailedUpdate(result: UpdateRunResult): Promise<void> {
  await finishUpdate({
    result,
    opts: {},
    showProgress: false,
    preManagedServiceStop: { stopped: true, serviceEnv: {} },
    controlPlaneUpdateSentinelMeta: undefined,
  } as unknown as FinishUpdateParams);
}

async function finishSkippedUpdate(reason: string): Promise<void> {
  await finishUpdate({
    result: {
      status: "skipped",
      mode: reason === "dirty" ? "git" : "unknown",
      reason,
      steps: [],
      durationMs: 1,
    },
    opts: {},
    showProgress: false,
    controlPlaneUpdateSentinelMeta: undefined,
  } as unknown as FinishUpdateParams);
}

describe("skipped update exit status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  });

  it("exits nonzero when local changes block a Git update", async () => {
    await finishSkippedUpdate("dirty");

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Update blocked: local files are edited"),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps a non-Git install skip successful", async () => {
    await finishSkippedUpdate("not-git-install");

    expect(defaultRuntime.exit).toHaveBeenCalledWith(0);
  });
});

describe("failed Git update recovery restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  });

  it("restarts a managed Gateway after verified rollback recovery", async () => {
    await finishFailedUpdate(failedResult({ serviceRestartSafe: true }));

    expect(mocks.restart).toHaveBeenCalledOnce();
    expect(mocks.restart).toHaveBeenCalledWith(
      expect.objectContaining({ packageReplacementVerified: false }),
    );
  });

  it("leaves a managed Gateway stopped after unverified rollback recovery", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);

    await finishFailedUpdate(
      failedResult({ serviceRestartSafe: false, reason: "runtime-verification-failed" }),
    );

    expect(mocks.restart).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Managed gateway remains stopped"));
  });

  it("does not claim a verified package replacement on Git failures", async () => {
    await finishFailedUpdate(failedResult({ serviceRestartSafe: true }));

    expect(mocks.restart.mock.calls[0]?.[0]).toMatchObject({
      packageReplacementVerified: false,
    });
  });
});

describe("failed package update recovery provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  });

  it("threads a verified package replacement into failed-update recovery", async () => {
    await finishUpdate({
      result: {
        status: "error",
        mode: "npm",
        reason: "doctor-failed",
        steps: [
          { name: "global update", command: "npm", cwd: "/", durationMs: 1, exitCode: 0 },
          { name: "openclaw doctor", command: "doctor", cwd: "/", durationMs: 1, exitCode: 1 },
        ],
        packageReplacementVerified: true,
        durationMs: 1,
      },
      opts: {},
      showProgress: false,
      preManagedServiceStop: { stopped: true, serviceEnv: {} },
      controlPlaneUpdateSentinelMeta: undefined,
    } as unknown as FinishUpdateParams);

    expect(mocks.restart).toHaveBeenCalledWith(
      expect.objectContaining({ packageReplacementVerified: true }),
    );
  });

  it("keeps pre-swap package failures on the guarded restart only", async () => {
    await finishUpdate({
      result: {
        status: "error",
        mode: "npm",
        reason: "global-install-failed",
        steps: [{ name: "global update", command: "npm", cwd: "/", durationMs: 1, exitCode: 1 }],
        packageReplacementVerified: false,
        durationMs: 1,
      },
      opts: {},
      showProgress: false,
      preManagedServiceStop: { stopped: true, serviceEnv: {} },
      controlPlaneUpdateSentinelMeta: undefined,
    } as unknown as FinishUpdateParams);

    expect(mocks.restart).toHaveBeenCalledWith(
      expect.objectContaining({ packageReplacementVerified: false }),
    );
  });
});
