import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { createUpdateProgress } from "../cli/update-cli/progress.js";
import { resolveUpdateResultNextAction } from "../cli/update-cli/update-recovery-guidance.js";
import type { SpawnResult } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import * as diskSpace from "./disk-space.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import { renderUpdateRunReport, updateRunReportInputFromResult } from "./update-run-report.js";
import type { UpdateStepResult } from "./update-step-result.js";

export class FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(pid: number) {
    super();
    this.pid = pid;
    this.once("close", (code: number | null, signal?: NodeJS.Signals | null) => {
      this.exitCode = code;
      this.signalCode = signal ?? null;
    });
  }
}

export function createCanarySnapshotResult(
  input: string,
  databasePath?: string,
  warnings: string[] = [],
): SpawnResult {
  const request: unknown = JSON.parse(input);
  return {
    code: 0,
    stdout: JSON.stringify(
      isRecord(request) && request.mode === "inventory"
        ? {
            databases: databasePath ? [[databasePath, { spellings: [databasePath] }]] : [],
            pluginBytes: 0,
            pluginPlan: "plugin-copy-plan.json",
            warnings,
          }
        : { versions: [], pluginPaths: {} },
    ),
    stderr: "",
    signal: null,
    killed: false,
    cleanup: "normal",
    termination: "exit",
  };
}

type CanaryCommandFixture = {
  pluginInventory: unknown;
  pluginErrors: boolean;
  runtimeContract: unknown;
  runtimeError: boolean;
  lintReport: { ok: boolean; checksRun: number; findings: unknown[]; warnings: unknown[] };
};

export function completeCanaryCommand(
  child: FakeChild,
  args: string[],
  readFixture: () => CanaryCommandFixture,
) {
  queueMicrotask(() => {
    const { pluginInventory, pluginErrors, runtimeContract, runtimeError, lintReport } =
      readFixture();
    if (args.includes("plugins")) {
      child.stdout.write(
        JSON.stringify(
          pluginInventory ?? {
            plugins: [],
            diagnostics: pluginErrors ? [{ level: "error", message: "incompatible plugin" }] : [],
          },
        ),
      );
    }
    if (args.includes("--check")) {
      child.stdout.write(JSON.stringify(runtimeContract));
    }
    if (args.includes("--lint")) {
      child.stdout.write(JSON.stringify(lintReport));
    }
    child.emit(
      "close",
      (runtimeError && args.includes("--check")) || (!lintReport.ok && args.includes("--lint"))
        ? 1
        : 0,
    );
  });
}

export function stubHealthyGateway() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ status: "started", ready: true })),
  );
}

/** The last canary check; verified temporary-copy removal is recorded after it. */
export function canaryOutcomeStep(steps: UpdateStepResult[]) {
  return steps.findLast((step) => !(step.name.endsWith("-cleanup") && step.exitCode === 0));
}

export function renderSteps(steps: UpdateStepResult[]) {
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  const presentation = createUpdateProgress(true);
  onTestFinished(() => {
    presentation.dispose();
    log.mockRestore();
  });
  for (const [index, step] of steps.entries()) {
    presentation.progress.onStepComplete?.({ ...step, index, total: steps.length });
  }
  return log.mock.calls.flat().join("\n");
}

export function registerCanarySnapshotCapacityTests({
  canaryStateOptions,
  getRoot,
  mocks,
}: {
  canaryStateOptions: () => Parameters<typeof validateUpdateCandidateCanary>[0];
  getRoot: () => string;
  mocks: { snapshot: ReturnType<typeof vi.fn>; spawn: ReturnType<typeof vi.fn> };
}) {
  it("records a typed capacity refusal before notifying the snapshot failure", async () => {
    const capacity = vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
      targetPath,
      checkedPath: targetPath,
      availableBytes: 0,
      totalBytes: 1024,
    }));
    const onStep = vi.fn();
    try {
      const env = { TMPDIR: "/synthetic/tmp" };
      const result = await validateUpdateCandidateCanary({ ...canaryStateOptions(), env, onStep });
      expect(result).toMatchObject({
        status: "error",
        phase: "snapshot",
        reason: "candidate-snapshot-failed",
      });
      const updateResult = { ...result, mode: "git" as const, root: getRoot() };
      const nextAction = resolveUpdateResultNextAction({
        result: updateResult,
        verifiedServingVersion: "2026.10.5-beta.2",
        env,
      });
      const report = renderUpdateRunReport(updateRunReportInputFromResult(updateResult), {
        nextAction,
      });
      expect(report.headline).toContain("OpenClaw update failed: candidate-snapshot-failed");
      expect(report.markdown).toContain(
        "Fix candidate-snapshot-failed then run `openclaw update` again.",
      );
      const failed = canaryOutcomeStep(result.steps);
      expect(failed).toMatchObject({
        name: "candidate-state-snapshot",
        exitCode: 1,
        snapshotCapacity: {
          reason: "snapshot-capacity-insufficient",
          selection: null,
        },
      });
      expect(
        failed?.snapshotCapacity?.candidates.map((candidate) => candidate.availableBytes),
      ).toEqual([0, 0, 0]);
      expect(onStep).toHaveBeenCalledExactlyOnceWith(failed);
      expect(mocks.snapshot).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    } finally {
      capacity.mockRestore();
    }
  });
}
