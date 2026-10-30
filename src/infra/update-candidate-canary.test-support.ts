import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { createUpdateProgress } from "../cli/update-cli/progress.js";
import type { SpawnResult } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as diskSpace from "./disk-space.js";
import { tryListenOnPort } from "./ports-probe.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import type { UpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";
import { buildUpdateRehearsalPathEnv } from "./update-rehearsal-paths.js";
import type { UpdateRunStep } from "./update-run-record.js";
import type { UpdateStepResult } from "./update-step-result.js";

export function holdCanaryProgress(matches: (step: UpdateRunStep) => boolean) {
  const entered = createDeferredCore();
  const receipt = createDeferredCore();
  const onProgress = vi.fn((step: UpdateRunStep) => {
    if (matches(step)) {
      entered.resolve();
      return receipt.promise;
    }
    return undefined;
  });
  return { entered: entered.promise, receipt, onProgress };
}

export async function createCanaryProcessFixture(
  root: string,
  source: string,
): Promise<UpdateCandidateRehearsal> {
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.mkdir(stateDir);
  await fs.writeFile(configPath, "{}");
  await fs.mkdir(path.join(root, "dist", "infra"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"version":"2026.9.5","type":"module"}');
  await fs.writeFile(
    path.join(root, "dist", "infra", "update-migrated-finalize.worker.js"),
    "console.log(JSON.stringify({state: 2, agent: 3}));",
  );
  await fs.writeFile(path.join(root, "dist", "index.js"), source);
  return {
    stateDir,
    configPath,
    workspaceDir: stateDir,
    port: await tryListenOnPort({ port: 0, host: "127.0.0.1" }),
    env: buildUpdateRehearsalPathEnv(stateDir),
    snapshotCapacity: {
      reason: "explicit-tmpdir",
      sqliteBytes: 0,
      pluginBytes: 0,
      requiredBytes: 0,
      candidates: [],
      selection: { kind: "explicit-tmpdir", directory: stateDir },
    },
    cleanupDirectories: [],
    prepareRuntime: async (assertCurrent) => assertCurrent(),
    cleanup: async () => {},
  };
}

/** Real child dispatch fixture; it does not claim compatibility with an installed Bun release. */
export async function createCanaryStartupRuntimeFixture(root: string, incompatible: boolean) {
  const runner = path.join(root, "runtime", "bun");
  const dispatched = path.join(root, "runtime-dispatch.json");
  await fs.mkdir(path.dirname(runner));
  await fs.writeFile(path.join(path.dirname(runner), "package.json"), '{"type":"commonjs"}');
  await fs.writeFile(
    runner,
    `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(dispatched)}, JSON.stringify(args));
if (${JSON.stringify(incompatible)}) {
  process.stderr.write("OpenClaw requires Bun >=1.4.4.\\n");
  process.exit(1);
}
const child = spawn(${JSON.stringify(process.execPath)}, args.filter((arg) => arg !== "--no-install"), { stdio: "inherit" });
child.once("exit", (code) => process.exit(code ?? 1));
`,
    { mode: 0o755 },
  );
  return { runner, dispatched };
}

export class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(public pid: number) {
    super();
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
    const writeIf = (flag: string, output: unknown) => {
      if (args.includes(flag)) {
        child.stdout.write(JSON.stringify(output));
      }
    };
    writeIf(
      "plugins",
      pluginInventory ?? {
        plugins: [],
        diagnostics: pluginErrors ? [{ level: "error", message: "incompatible plugin" }] : [],
      },
    );
    writeIf("--check", runtimeContract);
    writeIf("--lint", lintReport);
    const failed =
      (runtimeError && args.includes("--check")) || (!lintReport.ok && args.includes("--lint"));
    child.emit("close", failed ? 1 : 0);
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

export function registerCanarySnapshotCapacityTests(fixture: {
  canaryStateOptions: () => Parameters<typeof validateUpdateCandidateCanary>[0];
  mocks: { snapshot: ReturnType<typeof vi.fn>; spawn: ReturnType<typeof vi.fn> };
}) {
  const { canaryStateOptions, mocks } = fixture;
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
      const reason = "candidate-snapshot-failed";
      const result = await validateUpdateCandidateCanary({ ...canaryStateOptions(), env, onStep });
      expect(result).toMatchObject({ status: "error", phase: "snapshot", reason });
      const failed = canaryOutcomeStep(result.steps);
      expect(failed).toMatchObject({
        name: "candidate-state-snapshot",
        exitCode: 1,
        snapshotCapacity: {
          reason: "snapshot-capacity-insufficient",
          selection: null,
        },
      });
      expect(onStep).toHaveBeenCalledExactlyOnceWith(failed);
      expect(mocks.snapshot).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    } finally {
      capacity.mockRestore();
    }
  });
}
